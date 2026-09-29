import crypto from 'node:crypto';
import {cards,cardText} from './poker.mjs';
import {gradeRangeConstruction} from './strategy-construction.mjs';
import {evaluateHUPolicy} from './hu-policy-evaluation.mjs';

const canon=combo=>cards(combo,[2]).sort((a,b)=>a-b).map(cardText).join('');
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function routes(nodes){
 const byId=new Map(nodes.map(n=>[n.id,n])),memo=new Map();
 const route=node=>{if(memo.has(node.id))return memo.get(node.id);const parent=byId.get(node.parentId);if(!parent)return [];const edge=parent.actions.find(a=>a.childId===node.id);if(!edge)throw Error('反制见证的原节点路径不完整。');const path=[...route(parent),edge.id];memo.set(node.id,path);return path;};
 return nodeId=>route(byId.get(nodeId));
}

/** Produce a concrete information-set-consistent response, then evaluate that
 * complete policy independently. The performance-difference identity attributes
 * the response gain using BR occupancy and the OLD fixed-response action values.
 * Rows can be negative: changing an early action can enable a profitable later
 * change. They are a decomposition of this one witness, not separable leaks or
 * a prescription to optimize each row independently.
 */
export function buildResponseWitness(scenario,source,submission,{independentEvaluation,jobId=null,maxNodes=30000,maxHoleDeals=10000,maxNodeDealVisits=5000000,maxSeconds=15,signal,onProgress=()=>{}}={}){
 const started=performance.now();
 if(scenario.players.length!==2)throw Error('具体反制路径见证目前只核验双人完整树；多人仍分别报告单边偏离空间。');
 const grade=gradeRangeConstruction(scenario,source,submission),user=grade.nodeContext.actorSeat,opponent=1-user;
 const modified=structuredClone(source),node=modified.nodes.find(n=>n.id===grade.source.nodeId),patch=new Map(grade.combos.filter(r=>r.editable).map(r=>[canon(r.combo),r.userProbabilities]));
 for(const row of node.combos){const p=patch.get(canon(row.combo));if(p)row.probabilities=node.actions.map(a=>p[a.id]);}
 modified.capabilities={...modified.capabilities,fullTree:true};
 const remaining=()=>{if(signal?.aborted)throw Error('反制路径核验已取消。');const left=maxSeconds-(performance.now()-started)/1000;if(left<=0)throw Error('具体反制路径超过时间预算，独立整体评估仍然有效。');return left;};
 const options=()=>({maxNodes,maxHoleDeals,maxNodeDealVisits,maxSeconds:remaining(),signal,onProgress});
 const baseline=evaluateHUPolicy(modified,{...options(),captureBestResponse:true,mutate:true});
 const choices=baseline.bestResponsePolicies[opponent],choiceMap=new Map(choices.map(c=>[c.nodeId+':'+canon(c.combo),c]));
 const witness=structuredClone(baseline);
 for(const n of witness.nodes)if(n.actor===opponent)for(const row of n.combos){const choice=choiceMap.get(n.id+':'+canon(row.combo));if(!choice)throw Error('最佳响应缺少完整信息集政策。');row.probabilities=n.actions.map((_,a)=>a===choice.actionIndex?1:0);}
 const realized=evaluateHUPolicy(witness,{...options(),computeBestResponse:false,mutate:true});
 const fixed=baseline.diagnostics.profileEV,responded=realized.diagnostics.profileEV,target=baseline.diagnostics.bestResponseEV[opponent],tolerance=1e-7*Math.max(1,scenario.pot);
 if(Math.abs(responded[opponent]-target)>tolerance)throw Error('导出的具体反制政策未实现独立最佳响应价值，见证未发布。');
 if(independentEvaluation){
  const d=independentEvaluation.submitted;
  if(independentEvaluation.status!=='complete'||!d||!Array.isArray(d.profileEV)||!Array.isArray(d.bestResponseEV)||!finite(d.bestResponseEV[opponent])||Math.abs(d.bestResponseEV[opponent]-target)>tolerance||fixed.some((v,p)=>!finite(d.profileEV[p])||Math.abs(v-d.profileEV[p])>tolerance))throw Error('反制见证与原独立整体评估不是同一政策价值，结果未发布。');
 }
 const baseNodes=new Map(baseline.nodes.map(n=>[n.id,n])),route=routes(source.nodes),rows=[],nodes=[];let contribution=0;
 const originalNodes=new Map(source.nodes.map(n=>[n.id,n]));
 const history=nodeId=>{let n=source.nodes.find(n=>n.parentId==null);return route(nodeId).map(id=>{const a=n.actions.find(a=>a.id===id),entry={actorName:n.actor>=0?scenario.players[n.actor].name:'公共发牌',actorSeat:n.actor,actionId:a.id,label:a.label,board:n.board??scenario.board,type:a.type??(n.chance?'deal':undefined),amount:a.amount,to:a.to};n=originalNodes.get(a.childId);return entry;});};
 for(const n of realized.nodes)if(n.actor===opponent){
  const old=baseNodes.get(n.id),oldRows=new Map(old.combos.map(r=>[canon(r.combo),r])),nodeRows=[];
  for(const r of n.combos){
   if(!(r.reach>0))continue;const before=oldRows.get(canon(r.combo)),choice=choiceMap.get(n.id+':'+canon(r.combo));
   if(!before||!before.actionEV.every(finite)||!finite(before.ev))throw Error('到达反制信息集缺少固定后续策略行动值。');
   const currentDifference=before.actionEV[choice.actionIndex]-before.ev,weighted=currentDifference*r.reach;
   contribution+=weighted;
   const row={nodeId:n.id,path:route(n.id),history:history(n.id),board:n.board??source.input.board,combo:r.combo,witnessReach:r.reach,referenceProbabilities:[...before.probabilities],responseActionId:choice.actionId,responseActionLabel:n.actions[choice.actionIndex].label,actions:n.actions.map((a,i)=>({id:a.id,label:a.label,referenceProbability:before.probabilities[i],responseProbability:i===choice.actionIndex?1:0,fixedContinuationEV:before.actionEV[i],bestResponseContinuationEV:choice.continuationEV?.[i]??null})),fixedContinuationAdvantageBB:currentDifference,rootGainContributionBB:weighted};
   rows.push(row);nodeRows.push(row);
  }
  if(nodeRows.length){const mass=nodeRows.reduce((sum,r)=>sum+r.witnessReach,0);nodes.push({nodeId:n.id,path:route(n.id),history:history(n.id),board:n.board??source.input.board,pot:n.pot,toCall:n.toCall??0,witnessReach:mass,rootGainContributionBB:nodeRows.reduce((sum,r)=>sum+r.rootGainContributionBB,0),actions:n.actions.map((a,i)=>({id:a.id,label:a.label,referenceAtWitnessReach:nodeRows.reduce((sum,r)=>sum+r.witnessReach*r.referenceProbabilities[i],0)/mass,responseFrequency:nodeRows.reduce((sum,r)=>sum+r.witnessReach*(r.responseActionId===a.id?1:0),0)/mass})),topCombos:nodeRows.sort((a,b)=>Math.abs(b.rootGainContributionBB)-Math.abs(a.rootGainContributionBB)).slice(0,8)});}
 }
 const gain=responded[opponent]-fixed[opponent],identityError=Math.abs(contribution-gain);
 if(identityError>tolerance)throw Error('反制路径收益贡献不能重建完整策略收益变化，解释未发布。');
 const positive=rows.filter(r=>r.rootGainContributionBB>0).reduce((s,r)=>s+r.rootGainContributionBB,0),negative=rows.filter(r=>r.rootGainContributionBB<0).reduce((s,r)=>s+r.rootGainContributionBB,0);
 nodes.sort((a,b)=>Math.abs(b.rootGainContributionBB)-Math.abs(a.rootGainContributionBB));rows.sort((a,b)=>Math.abs(b.rootGainContributionBB)-Math.abs(a.rootGainContributionBB));
 return {status:'complete',kind:'heads-up-best-response-witness',version:1,sourceFingerprint:grade.sourceFingerprint,source:{jobId,nodeId:grade.source.nodeId,userSeat:user,opponentSeat:opponent},opponent:{seat:opponent,name:scenario.players[opponent].name,position:scenario.players[opponent].position},policyHash:hash(choices.map(({nodeId,combo,actionId})=>({nodeId,combo,actionId}))),values:{fixedPolicyEV:fixed,witnessPolicyEV:responded,bestResponseEV:target,opponentGainBB:gain,userEVChangeBB:responded[user]-fixed[user],rootGainContributionBB:contribution,positiveContributionBB:positive,negativeContributionBB:negative},verification:{responseRealizationDifferenceBB:Math.abs(responded[opponent]-target),gainDecompositionDifferenceBB:identityError,informationSetConsistent:true,clairvoyant:false,allRespondingDecisionsIncluded:true,constrainedResidualUsed:false},nodes:nodes.slice(0,12),topCombos:rows.slice(0,24),counts:{respondingNodes:nodes.length,reachableInformationSets:rows.length,shownNodes:Math.min(12,nodes.length),shownCombos:Math.min(24,rows.length)},stats:{seconds:(performance.now()-started)/1000,legalHoleDeals:baseline.policyEvaluation.legalHoleDeals,nodeDealVisits:baseline.policyEvaluation.nodeDealVisits+realized.policyEvaluation.nodeDealVisits},meaning:'固定你整套策略（本题外维持参考），允许对手在所有其信息集改变打法，给出一套最佳响应。每个决定只知道自己的底牌与公开历史。用该响应的真实到达质量，分解它相对原固定对手策略增加的收益；所有信息集贡献相加等于完整起点收益差。',limits:['这是提交后整套策略的总反制空间，包含原参考残差，不等于这次修改新增加的损失。','这是一套可核验的反制见证，不是唯一反制、新的均衡策略或真实对手会采用的打法。','具体动作价值分两种后续：原固定对手后续与最佳响应后续。单个节点贡献可能为负，不能逐行独立优化或把绝对值相加。','节点内的原频率按这套反制产生的到达范围加权，不能当作原策略的公开节点总体频率。','展示只截取影响较大的节点与组合；完整加总包含所有实际到达的对手信息集，亦包含负贡献。','仅对所给完整有限树、范围与抽水模型成立；未证明遗漏尺寸下安全，也不把此值换算成实战 bb/100。']};
}
