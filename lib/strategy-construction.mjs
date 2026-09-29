import {createHash} from 'node:crypto';
import {cards,cardText,range,category,CATEGORIES} from './poker.mjs';
import {assertSolutionScenario} from './solution-identity.mjs';
import {solveRiverGame} from './river-engine.mjs';
import {solveTurnGame} from './turn-engine.mjs';
import {evaluateHUPolicy} from './hu-policy-evaluation.mjs';

export const STRATEGY_CONSTRUCTION_VERSION='1.0.0';
const finite=Number.isFinite,canon=c=>cards(c,[2]).sort((a,b)=>a-b).map(cardText).join('');
const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const clone=x=>structuredClone(x);
const own=(x,k)=>Object.hasOwn(x,k);

function probabilities(value,actions,label){
 let p;
 if(Array.isArray(value)){if(value.length!==actions.length)throw Error(`${label} 的概率数量与合法动作不一致。`);p=value.slice();}
 else if(value&&typeof value==='object'){
  if(Object.keys(value).some(k=>!actions.some(a=>a.id===k)))throw Error(`${label} 包含不在当前树内的动作。`);
  p=actions.map(a=>own(value,a.id)?value[a.id]:0);
 }else throw Error(`${label} 需要完整的行动概率。`);
 if(p.some(v=>!finite(v)||v<0||v>1))throw Error(`${label} 的行动概率必须为 0–1 的数字。`);
 const sum=p.reduce((s,v)=>s+v,0);if(Math.abs(sum-1)>1e-8)throw Error(`${label} 的行动概率合计必须为 100%。`);
 return p.map(v=>v/sum);
}
const probabilityMap=(values,actions)=>Object.fromEntries(actions.map((a,i)=>[a.id,values[i]]));
function isLocked(result,node,row){
 if(row.locked===true)return true;
 return (result.input?.locks??[]).some(l=>{
  if(l.nodeId!==node.id&&l.node!==Number(node.id.replace(/^n/,'')))return false;
  if(l.combo===undefined||l.combo===null||l.combo===-1)return true;
  try{return canon(l.combo)===row.combo;}catch{return false;}
 });
}
function quality(result){
 const d=result.diagnostics??{},residual=finite(d.optimizationResidualPctPot)?d.optimizationResidualPctPot:finite(d.nashConvPctPot)?d.nashConvPctPot:null,target=finite(result.input?.accuracy)?result.input.accuracy:null;
 const targetReached=residual!==null&&target!==null?residual<=target:null;
 return {mode:'exact',residual,residualUnit:'起点底池百分数',target,targetReached,provisional:targetReached!==true,countsTowardMastery:false,meaning:'此评分是给定参考对手及后续策略的条件收益比较；全局残差不是逐组合 EV 误差上界，频率不同本身不计错。'};
}
function contextOf(scenario,result,node){
 const byId=new Map(result.nodes.map(n=>[n.id,n])),history=[],seen=new Set();let cursor=node;
 while(cursor.parentId!=null){
  if(seen.has(cursor.id))throw Error('策略树父路径包含循环。');seen.add(cursor.id);
  const parent=byId.get(cursor.parentId),action=parent?.actions?.find(a=>a.childId===cursor.id);if(!parent||!action)throw Error('策略树父路径不完整。');
  const deal=parent.chance===true||action.type==='deal';history.unshift({nodeId:parent.id,actorSeat:deal?null:parent.actor,actorId:deal?null:scenario.players[parent.actor]?.id,actorName:deal?'发牌':scenario.players[parent.actor]?.name,label:deal?`发牌 ${action.label}`:action.label,type:action.type,board:parent.board??scenario.board,amount:action.amount??0,to:action.to??0});cursor=parent;
 }
 return {nodeId:node.id,actorSeat:node.actor,actorId:scenario.players[node.actor].id,actorName:scenario.players[node.actor].name,board:node.board??scenario.board,street:node.street??({3:'flop',4:'turn',5:'river'})[cards(node.board??scenario.board).length],pot:node.pot,toCall:node.toCall,contributions:node.contributions??null,streetContributions:node.streetContributions??null,folded:node.folded??null,history,evOrigin:'当前节点之后的净收益；之前投入为沉没成本。'};
}
function prepare(scenario,result,{nodeId='n0',weighting='observed'}={}){
 assertSolutionScenario(scenario,result);
 if(result.chance?.exact!==true||result.chance?.mode==='sampled')throw Error('整段范围训练只接受完整机会枚举的参考结果。');
 if(result.capabilities?.actionEV===false||result.capabilities?.fullTree===false||result.nodes.some(n=>n.outOfScope))throw Error('参考结果缺少完整后续策略或可信行动 EV，不能构建范围评分。');
 if(!['observed','counterfactual'].includes(weighting))throw Error('范围评分权重只能是 observed 或显式 counterfactual。');
 const node=result.nodes.find(n=>n.id===nodeId);if(!node||node.actor<0||node.terminal||node.chance||!node.actions?.length)throw Error('请选择真实玩家的决策节点。');
 if(new Set(node.actions.map(a=>a.id)).size!==node.actions.length)throw Error('策略节点含重复动作。');
 const currentBoard=cards(node.board??scenario.board),rootRange=range(scenario.players[node.actor].range,cards(scenario.board)).live,allowed=new Map(rootRange.map(c=>[c.label,c])),seen=new Set();
 const rows=(node.combos??[]).map(row=>{
  const combo=canon(row.combo);if(seen.has(combo)||!allowed.has(combo))throw Error('节点范围存在重复或起点范围外组合。');seen.add(combo);
  if(!finite(row.reach)||row.reach<0||!finite(row.counterfactualReach)||row.counterfactualReach<0||row.reach>row.counterfactualReach*(1+1e-10)+Number.MIN_VALUE)throw Error('节点组合缺少有效的联合/反事实到达质量。');
  const blocked=cards(combo).some(c=>currentBoard.includes(c));if(blocked&&(row.reach>0||row.counterfactualReach>0))throw Error('当前公共牌阻断的组合却有正到达质量。');
  const mass=weighting==='observed'?row.reach:row.counterfactualReach,reference=probabilities(row.probabilities,node.actions,`${combo} 参考策略`),locked=isLocked(result,node,{...row,combo});
  const scoreable=mass>0&&!blocked;
  if(scoreable&&(!Array.isArray(row.actionEV)||row.actionEV.length!==node.actions.length||row.actionEV.some(v=>!finite(v))))throw Error(`${combo} 有评分权重却缺少完整行动 EV，不能跳过未知收益评分。`);
  return {combo,inputWeight:allowed.get(combo).weight,reach:row.reach,counterfactualReach:row.counterfactualReach,mass,scoreable,editable:scoreable&&!locked,locked,reference,actionEV:row.actionEV,reason:blocked?'blocked-by-board':!scoreable?(row.counterfactualReach>0?'zero-observed-reach':'zero-counterfactual-reach'):locked?'fixed-policy-constraint':null,madeHandCategory:blocked?null:CATEGORIES[category([...currentBoard,...cards(combo)])]};
 });
 for(const c of rootRange)if(!c.cards.some(k=>currentBoard.includes(k))&&!seen.has(c.label))throw Error(`节点缺少合法范围组合 ${c.label}，不能把缺失记录当成零到达。`);
 const observedMass=rows.reduce((s,r)=>s+r.reach,0),mass=rows.reduce((s,r)=>s+r.mass,0);
 if(!finite(node.reach)||Math.abs(observedMass-node.reach)>1e-8*Math.max(observedMass,node.reach,Number.MIN_VALUE))throw Error('节点到达质量与组合联合质量之和不一致。');
 if(!(mass>0))throw Error(weighting==='observed'?'此节点在参考策略下零到达；不能假装存在真实条件范围。可显式选择反事实研究。':'此节点没有反事实可用范围，无法给出行动评分。');
 if(!rows.some(r=>r.editable))throw Error('该节点没有可自由分配的正权重组合。');
 for(const row of rows)row.posteriorWeight=row.mass/mass;
 const context=contextOf(scenario,result,node),fingerprint=createHash('sha256').update(JSON.stringify({version:STRATEGY_CONSTRUCTION_VERSION,input:result.input,engine:result.engine,implementationVersion:result.implementationVersion,nodeId,weighting,actions:node.actions.map(a=>({id:a.id,type:a.type,to:a.to,amount:a.amount,childId:a.childId})),rows:rows.map(r=>({combo:r.combo,reach:r.reach,cf:r.counterfactualReach,locked:r.locked,reference:r.reference,actionEV:r.actionEV}))})).digest('hex');
 return {scenario,result,node,rows,mass,observedMass,weighting,context,fingerprint,quality:quality(result),source:{solveId:result.id??null,nodeId,actorSeat:node.actor,engine:result.engine??null,implementationVersion:result.implementationVersion??null,mathematicalModel:'完整机会枚举、固定参考对手与后续策略、当前有限行动树'}};
}
function limits(weighting){return [
 '本地评分只改变当前节点的整段范围分配；其他玩家与所有后续决策保持参考策略。不能把参考混合频率当作唯一正确答案。',
 '允许任意合法概率混合；同 EV 的不同混合策略得到相同收益评分。微小收益差仍受输入假设、有限尺寸树与参考残差影响。',
 '行动后的范围分布只描述自己的组合；不能把多个玩家的边际范围相乘来忽略牌张互斥。成牌类别不是价值/诈唬标签，也不是范围保护的评分。',
 weighting==='observed'?'评分按当前节点真实联合到达质量归一；零到达组合不参与此题。':'显式反事实研究：移除了当前行动玩家之前的行动概率，保留联合机会及其他玩家到达质量。它不等于真实当前到达范围。',
 '不能把多个节点相对旧参考的局部损失直接相加来代表整套新策略的收益；多街计划须整体固定策略评估。'
 ];}

/** The public payload contains beliefs and given constraints, never hidden
 * reference probabilities, action EV, accepted answers or future runouts. */
export function createRangeConstruction(scenario,result,options={}){
 const p=prepare(scenario,result,options),publicQuestion={schemaVersion:1,kind:'range-construction',sourceFingerprint:p.fingerprint,source:p.source,title:`${scenario.title??'我的研究'} · 整段范围构建`,scenario:{title:scenario.title,format:scenario.format,board:scenario.board,pot:scenario.pot,toAct:scenario.toAct,rake:scenario.rake??0,rakeCap:scenario.rakeCap??0,players:scenario.players.map(({id,name,position,range,stack})=>({id,name,position,range,stack}))},nodeContext:p.context,weighting:p.weighting,weights:{normalizer:p.mass,observedNodeReach:p.observedMass,meaning:p.weighting==='observed'?'给定当前公开节点的实际到达组合分布':'显式反事实范围；不等于实际到达分布'},actions:p.node.actions.map(({id,label,type,amount,to,allIn})=>({id,label,type,amount,to,allIn:!!allIn})),combos:p.rows.map(({reference,actionEV,mass,...r})=>({...r,...(r.locked?{fixedProbabilities:probabilityMap(reference,p.node.actions)}:{})})),requirements:{editableCombos:p.rows.filter(r=>r.editable).length,mustCoverEveryEditableCombo:true,probabilitySum:1,zeroWeightCombos:p.rows.filter(r=>!r.scoreable).length},quality:p.quality,prompt:'把每个可编辑组合的 100% 概率分配给合法动作。先构建自己的范围，再比较固定参考对手下的收益；不按与参考频率的距离打分。',limits:limits(p.weighting)};
 return {publicQuestion,source:p.source};
}

/** A one-node policy change is linear in that node's action values. Full reach
 * (including own historical reach) is the correct weight for actual play.
 * For a fixed private hand, own reach is constant across compatible hidden
 * deals and cancels from its conditional action EV. */
export function gradeRangeConstruction(scenario,result,submission={}){
 const p=prepare(scenario,result,submission);
 if(submission.sourceFingerprint!==undefined&&submission.sourceFingerprint!==p.fingerprint)throw Error('参考策略或题目权重已改变，请重新打开范围题，不能复用旧提交。');
 if(!Array.isArray(submission.assignments))throw Error('请为整段可编辑范围提供行动概率。');
 const assigned=new Map(),byCombo=new Map(p.rows.map(r=>[r.combo,r]));
 for(const entry of submission.assignments){const combo=canon(entry.combo),row=byCombo.get(combo);if(assigned.has(combo))throw Error(`组合 ${combo} 重复提交。`);if(!row?.editable)throw Error(`组合 ${combo} 不属于可自由评分范围。`);assigned.set(combo,probabilities(entry.probabilities??entry.actions,p.node.actions,combo));}
 const missing=p.rows.filter(r=>r.editable&&!assigned.has(r.combo));if(missing.length)throw Error(`范围尚未完成：${missing.length} 个可编辑组合未分配（例如 ${missing[0].combo}）。`);
 const combos=p.rows.map(row=>{
  const user=assigned.get(row.combo)??row.reference;
  if(!row.scoreable)return {combo:row.combo,posteriorWeight:0,reach:row.reach,counterfactualReach:row.counterfactualReach,scoreable:false,editable:false,locked:row.locked,reason:row.reason,userProbabilities:probabilityMap(user,p.node.actions),referenceProbabilities:probabilityMap(row.reference,p.node.actions),madeHandCategory:row.madeHandCategory,actionEV:null,userEV:null,referenceEV:null,localBestEV:null,regretBB:null,weightedRegretBB:0};
  const userEV=dot(user,row.actionEV),referenceEV=dot(row.reference,row.actionEV),localBestEV=row.locked?referenceEV:Math.max(...row.actionEV),regretBB=Math.max(0,localBestEV-userEV);
  return {combo:row.combo,posteriorWeight:row.posteriorWeight,reach:row.reach,counterfactualReach:row.counterfactualReach,scoreable:true,editable:row.editable,locked:row.locked,reason:row.reason,madeHandCategory:row.madeHandCategory,userProbabilities:probabilityMap(user,p.node.actions),referenceProbabilities:probabilityMap(row.reference,p.node.actions),actionEV:probabilityMap(row.actionEV,p.node.actions),userEV,referenceEV,localBestEV,regretBB,weightedRegretBB:row.posteriorWeight*regretBB,referenceDifferenceBB:userEV-referenceEV};
 });
 const actions=p.node.actions.map((a,index)=>{
  let userFrequency=0,referenceFrequency=0,userValue=0,referenceValue=0;const userRange=[],referenceRange=[],classes=new Map();
  for(const row of combos){if(!row.scoreable)continue;const u=row.posteriorWeight*row.userProbabilities[a.id],r=row.posteriorWeight*row.referenceProbabilities[a.id];userFrequency+=u;referenceFrequency+=r;userValue+=u*row.actionEV[a.id];referenceValue+=r*row.actionEV[a.id];userRange.push({combo:row.combo,mass:u});referenceRange.push({combo:row.combo,mass:r});const g=classes.get(row.madeHandCategory)??{category:row.madeHandCategory,userMass:0,referenceMass:0};g.userMass+=u;g.referenceMass+=r;classes.set(g.category,g);}
  const normalized=(rows,mass)=>rows.filter(r=>r.mass>0).map(r=>({combo:r.combo,posteriorWeight:r.mass/mass}));
  return {id:a.id,label:a.label,type:a.type,amount:a.amount,to:a.to,userFrequency,referenceFrequency,userSelectedEV:userFrequency>0?userValue/userFrequency:null,referenceSelectedEV:referenceFrequency>0?referenceValue/referenceFrequency:null,evContribution:userValue,referenceEVContribution:referenceValue,range:normalized(userRange,userFrequency),referenceRange:normalized(referenceRange,referenceFrequency),madeHands:[...classes.values()].map(g=>({category:g.category,userProbability:userFrequency>0?g.userMass/userFrequency:null,referenceProbability:referenceFrequency>0?g.referenceMass/referenceFrequency:null})),meaning:'selectedEV 条件于选择此动作的不同组合，不可跨动作直接比较；收益贡献可相加为整段策略 EV。'};
 });
 const total=key=>combos.reduce((s,r)=>s+(r.scoreable?r.posteriorWeight*r[key]:0),0),rangeEV=total('userEV'),referenceEV=total('referenceEV'),localBestEV=total('localBestEV'),rootEVChangeBB=combos.reduce((s,r)=>s+(r.scoreable?r.reach*(r.userEV-r.referenceEV):0),0);
 return {schemaVersion:1,kind:'range-construction-grade',createdAt:new Date().toISOString(),sourceFingerprint:p.fingerprint,source:p.source,nodeContext:p.context,weighting:p.weighting,coverage:{editableCombos:p.rows.filter(r=>r.editable).length,assignedCombos:assigned.size,scoredCombos:combos.filter(r=>r.scoreable).length,zeroWeightCombos:combos.filter(r=>!r.scoreable).length,complete:true},metrics:{rangeEV,referenceEV,localBestEV,localRegretBB:combos.reduce((s,r)=>s+r.weightedRegretBB,0),referenceDifferenceBB:total('referenceDifferenceBB'),rootEVChangeBB,observedNodeReach:p.observedMass,units:'BB',rootChangeMeaning:'只改变此节点，保持全部其它策略时的起点期望收益变化；使用绝对联合到达质量。',scoreMeaning:'局部最佳合法分配收益 − 用户混合收益；锁定组合保持给定策略。与参考频率的距离不计分。'},combos,actions,quality:p.quality,limits:limits(p.weighting)};
}

function assertSameTree(source,evaluated){
 if(source.nodes.length!==evaluated.nodes.length)throw Error('独立评估重建了不同的公开策略树，结果未发布。');
 const signature=n=>({id:n.id,parentId:n.parentId??null,actor:n.actor,board:cards(n.board??source.input.board),pot:n.pot,toCall:n.toCall??0,contributions:n.contributions,folded:n.folded,actions:n.actions.map(a=>({id:a.id,childId:a.childId,type:a.type,amount:a.amount??0,to:a.to??0}))});
 const expected=new Map(source.nodes.map(n=>[n.id,JSON.stringify(signature(n))]));for(const n of evaluated.nodes)if(expected.get(n.id)!==JSON.stringify(signature(n)))throw Error('独立评估的行动、资金或牌面树与参考不一致，结果未发布。');
}
function evaluationBudget(source,{maxNodes=50000,maxNodeDealVisits=50000000,maxSeconds=60}={}){
 if(!Number.isInteger(maxNodes)||maxNodes<1||maxNodes>200000||!finite(maxNodeDealVisits)||maxNodeDealVisits<1||maxNodeDealVisits>200000000||!finite(maxSeconds)||maxSeconds<1||maxSeconds>300)throw Error('独立策略核验预算无效。');
 if(source.nodes.length>maxNodes)throw Error('完整策略核验超过节点预算；局部范围收益评分仍然有效。');
 const deals=source.stats?.legalDeals??source.chance?.legalDeals;
 if(finite(deals)){
  const turn=cards(source.input.board).length===4&&!/HUPostflop/.test(source.engine??''),holes=source.chance?.holeDeals;
  const work=turn&&finite(holes)?source.nodes.reduce((s,n)=>s+(cards(n.board??source.input.board).length===5?holes:deals),0):deals*source.nodes.length;
  if(work>maxNodeDealVisits)throw Error('完整策略核验超过节点发牌访问预算；未缩小模型或切换抽样。');
 }
 return {maxNodes,maxNodeDealVisits,maxSeconds};
}
async function evaluateFixed(source,patches,{limits,signal,onProgress,enginePath}={}){
 const controller=new AbortController();let timedOut=false;
 const cancel=()=>controller.abort();if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
 const timer=setTimeout(()=>{timedOut=true;controller.abort();},limits.maxSeconds*1000);
 try{return await evaluateFixedInner(source,patches,{limits,signal:controller.signal,onProgress,enginePath});}
 catch(error){if(timedOut&&!signal?.aborted)throw Error('完整固定策略核验超过时间预算，未发布不完整的反制指标。');throw error;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
async function evaluateFixedInner(source,patches,{limits,signal,onProgress,enginePath}={}){
 const hu=/HUPostflop|TexasSolver/.test(source.engine??'')||source.input.engine==='hu-postflop'||cards(source.input.board).length===3;
 const replacement=new Map(patches.map(p=>[`${p.nodeId}:${p.combo}`,p.probabilities]));
 if(hu){
  const policy=clone(source);for(const node of policy.nodes)if(node.actor>=0)for(const row of node.combos??[]){const patch=replacement.get(`${node.id}:${canon(row.combo)}`);if(patch)row.probabilities=node.actions.map(a=>patch[a.id]);}
  return evaluateHUPolicy(policy,{...limits,maxHoleDeals:10000,computeBestResponse:true,mutate:true,signal,onProgress});
 }
 const locks=[];
 for(const node of source.nodes)if(node.actor>=0)for(const row of node.combos??[]){const key=canon(row.combo),values=replacement.get(`${node.id}:${key}`)??probabilityMap(probabilities(row.probabilities,node.actions,`${node.id}/${key} 参考策略`),node.actions);locks.push({nodeId:node.id,combo:key,actions:values});}
 const raw={...source.input,locks,evaluationOnly:true,iterations:1,averagingDelay:0,checkEvery:1,accuracy:undefined,maxSeconds:limits.maxSeconds,algorithm:'cfr-plus',chanceMode:'exact'};
 const run=cards(raw.board).length===4?solveTurnGame:solveRiverGame;
 let result;try{result=await run(raw,{signal,onProgress,enginePath});}finally{onProgress?.({phase:'process-exited',processId:null});}
 if(result.evaluationOnly!==true||result.stats.iterations!==0)throw Error('独立入口没有保持固定策略，不能使用训练结果代替评估。');
 assertSameTree(source,result);
 return result;
}
function diagnosticSummary(result){
 const d=result.diagnostics,N=result.input.players.length,keys=['profileEV','bestResponseEV','gain'];
 if(keys.some(k=>!Array.isArray(d?.[k])||d[k].length!==N||d[k].some(v=>!finite(v)))||!finite(d.nashConv)||d.bestResponseIgnoresLocks!==true)throw Error('独立评估缺少不受临时策略锁约束的最佳响应证据。');
 return {profileEV:d.profileEV,bestResponseEV:d.bestResponseEV,gain:d.gain,nashConv:d.nashConv,nashConvPctPot:d.nashConvPctPot,constantSum:d.constantSum,verifiedBy:d.verifiedBy,bestResponseIgnoresLocks:true};
}

/** Re-evaluate BOTH complete profiles. Temporary full-policy locks are only an
 * import mechanism: unrestricted BR is the evidence, never constrained zero
 * residual. Opponent gains in multiplayer are not attributed to the user. */
export async function evaluateRangeConstruction(scenario,result,submission={},options={}){
 const grade=gradeRangeConstruction(scenario,result,submission),started=performance.now(),onProgress=options.onProgress??(()=>{}),actor=grade.nodeContext.actorSeat;
 try{
  const budgets=evaluationBudget(result,options),patches=grade.combos.filter(r=>r.editable).map(r=>({nodeId:grade.source.nodeId,combo:r.combo,probabilities:r.userProbabilities}));
  const evaluate=(patches,phase)=>evaluateFixed(result,patches,{limits:budgets,signal:options.signal,enginePath:options.enginePath,onProgress:p=>onProgress({...p,evaluationPhase:phase})});
  if(options.signal?.aborted)throw Error('整段策略独立核验已取消。');
  const baseline=await evaluate([],'reference'),baseNode=baseline.nodes.find(n=>n.id===grade.source.nodeId),baseRows=new Map(baseNode.combos.map(r=>[canon(r.combo),r]));
  let maxActionDifference=0;
  for(const row of grade.combos)if(row.scoreable){const base=baseRows.get(row.combo);if(!base)throw Error('独立评估缺少评分组合。');for(let a=0;a<baseNode.actions.length;a++){const original=row.actionEV[baseNode.actions[a].id],value=base.actionEV[a];if(!finite(value))throw Error('独立评估缺少可核验的条件 EV。');maxActionDifference=Math.max(maxActionDifference,Math.abs(original-value));}}
  if(maxActionDifference>1e-6*Math.max(1,scenario.pot))throw Error('原参考行动 EV 与独立完整策略评估不一致；评分不能发布。');
  const submitted=await evaluate(patches,'submitted'),before=diagnosticSummary(baseline),after=diagnosticSummary(submitted),change=after.profileEV[actor]-before.profileEV[actor],difference=Math.abs(change-grade.metrics.rootEVChangeBB);
  if(difference>1e-7*Math.max(1,scenario.pot))throw Error('局部线性收益与完整策略收益变化不一致；可能存在错误到达分母或不同模型。');
  const fixedOpponent={baselineUserEV:before.profileEV[actor],submittedUserEV:after.profileEV[actor],changeBB:change,expectedChangeFromLocalBB:grade.metrics.rootEVChangeBB,consistencyDifferenceBB:difference,meaning:'全部其它信息集仍使用同一参考策略；只改变本题节点的可编辑组合。此处是研究起点 EV，与节点之后的条件 EV 分开。'};
  let responseExposure;
  if(scenario.players.length===2){
   const opponent=1-actor,sum=Number(scenario.pot)-(result.rakeModel?.fixedRake??0),baselineSecurityEV=sum-before.bestResponseEV[opponent],submittedSecurityEV=sum-after.bestResponseEV[opponent];
   responseExposure={kind:'heads-up-security',opponent,baselineSecurityEV,submittedSecurityEV,securityEVChangeBB:submittedSecurityEV-baselineSecurityEV,baselineAdaptationCostBB:Math.max(0,before.profileEV[actor]-baselineSecurityEV),adaptationCostBB:Math.max(0,after.profileEV[actor]-submittedSecurityEV),meaning:'双人常和模型中，固定用户整套策略，让对手在所有信息集单边最佳响应。安全值是用户在该树内面对这种响应的起点 EV；不是现实未建模尺寸下的保证。'};
  }else responseExposure={kind:'multiplayer-unilateral-gains',players:scenario.players.map((p,i)=>({player:i,playerId:p.id,name:p.name,baselineGainBB:before.gain[i],submittedGainBB:after.gain[i],gainChangeBB:after.gain[i]-before.gain[i]})),userLossBB:null,coalitionModel:false,meaning:'每一行只让该玩家单独偏离，其余玩家固定。某位对手增加的收益可能来自其他玩家；不能把它或 NashConv 归为你的损失，也没有计算多人合谋或同时适应。'};
  return {...grade,independentEvaluation:{status:'complete',userSeat:actor,baseline:before,submitted:after,fixedOpponent,responseExposure,verification:{sourceActionEVMaxDifferenceBB:maxActionDifference,rootChangeIdentityDifferenceBB:difference,constrainedResidualUsed:false,temporaryPolicyLocksOnly:true},stats:{baselineSeconds:baseline.policyEvaluation?.seconds??baseline.stats?.seconds??null,submittedSeconds:submitted.policyEvaluation?.seconds??submitted.stats?.seconds??null,totalSeconds:(performance.now()-started)/1000},limits:['最佳响应允许偏离原先锁定行为；原始节点锁定约束仍保留在本题可编辑范围中。','当前仅改变一个节点的策略。独立评估不是重新求均衡，对手固定收益与允许对手适应的指标必须分开。']}};
 }catch(error){
  if(!options.signal?.aborted&&/预算|耗时|超时/.test(error.message)&&options.strictEvaluation!==true)return {...grade,independentEvaluation:{status:'unavailable',reason:error.message,limits:['完整反制核验尚未完成；保留的仅是固定参考后续策略下的单节点条件收益评分。'],seconds:(performance.now()-started)/1000}};
  throw error;
 }
}
