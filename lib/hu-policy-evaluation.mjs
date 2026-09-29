import {cards,cardText,range,rankHand} from './poker.mjs';
import {fixedCappedRake} from './river-rake.mjs';

const canon=text=>cards(text,[2]).sort((a,b)=>a-b).map(cardText).join('');
const finite=x=>Number.isFinite(x);

/** Independently evaluate a COMPLETE fixed heads-up policy tree.
 * Chance is integrated separately for every legal private-card pair. Public
 * aggregate action/chance frequencies from the solver are never used as input.
 * This synchronous CPU operation belongs in a worker, with explicit budgets. */
export function evaluateHUPolicy(source,{maxNodes=100000,maxHoleDeals=10000,maxNodeDealVisits=50000000,maxSeconds=120,computeBestResponse=true,captureBestResponse=false,mutate=false,signal,onProgress=()=>{}}={}){
  const started=Date.now();let visits=0,processed=0,lastProgress=started,showdownRunouts=0;
  if(captureBestResponse&&!computeBestResponse)throw Error('导出最佳响应政策需要启用完整最佳响应计算。');
  const responsePolicies=captureBestResponse?[[],[]]:null;
  if(source?.capabilities?.fullTree!==true)throw Error('独立策略评估必须提供 capabilities.fullTree=true 的完整未来街树。');
  if(!Array.isArray(source.nodes)||!source.nodes.length||source.nodes.length>maxNodes)throw Error('完整策略树超过独立评估节点预算。');
  if(source.nodes.some(n=>n.outOfScope))throw Error('独立策略评估不能接受 outOfScope 导出边界。');
  if(!source.input||source.input.players?.length!==2)throw Error('独立策略评估目前仅支持两人。');
  if(source.chance?.exact===false)throw Error('此评估器只接受完整精确机会模型。');
  const input=source.input,initialBoard=cards(input.board,[3,4,5]),pot=Number(input.pot),fee=fixedCappedRake(input,pot).fixedRake;
  if(!finite(pot)||pot<=0)throw Error('起始底池无效。');
  if(source.rakeModel&&Math.abs((source.rakeModel.fixedRake??0)-fee)>1e-10)throw Error('策略树抽水模型与输入不一致。');
  const ranges=input.players.map(p=>range(p.range,initialBoard).live),indices=ranges.map(r=>new Map(r.map((c,i)=>[c.label,i]))),prior=ranges.map(r=>{const mass=r.reduce((s,c)=>s+c.weight,0);return r.map(c=>c.weight/mass);});
  const deals=[];let normalizer=0;
  for(let a=0;a<ranges[0].length;a++)for(let b=0;b<ranges[1].length;b++){
    const hole=[...ranges[0][a].cards,...ranges[1][b].cards];if(new Set(hole).size!==4)continue;
    if(deals.length>=maxHoleDeals)throw Error('合法联合底牌超过独立评估预算。');
    const weight=prior[0][a]*prior[1][b];normalizer+=weight;deals.push({hands:[a,b],hole,weight,cfWeight:[prior[1][b],prior[0][a]]});
  }
  if(!(normalizer>0))throw Error('没有可同时存在的联合底牌。');
  for(const d of deals){d.weight/=normalizer;d.cfWeight=d.cfWeight.map(x=>x/normalizer);}
  const D=deals.length;
  // This is conservative: public cards remove some pairs before their nodes.
  if(D*source.nodes.length>maxNodeDealVisits)throw Error('策略树 × 合法联合底牌超过独立精确评估访问预算。');
  const result=mutate?source:structuredClone(source),byId=new Map(result.nodes.map((n,i)=>[n.id,i]));
  if(byId.size!==result.nodes.length)throw Error('策略树节点 id 重复。');
  const roots=result.nodes.filter(n=>n.parentId===null);if(roots.length!==1)throw Error('完整策略树必须有且仅有一个根。');
  const meta=result.nodes.map(n=>{
    const board=cards(n.board??(initialBoard.length===5?input.board:''),[3,4,5]);
    if(initialBoard.some((c,i)=>board[i]!==c))throw Error('策略节点公共牌不以初始牌面开头。');
    if(n.actor!==-2&&n.actor!==-1&&n.actor!==0&&n.actor!==1)throw Error('未知玩家节点。');
    if((n.actor===-1)!==!!n.terminal||(n.actor===-2)!==!!n.chance)throw Error('行动、机会或终局节点类型不一致。');
    if(!Array.isArray(n.contributions)||n.contributions.length!==2||n.contributions.some(x=>!finite(x)||x<0)||!Array.isArray(n.folded)||n.folded.length!==2)throw Error('节点投入或弃牌状态缺失。');
    if(!Array.isArray(n.actions)||(n.terminal?n.actions.length!==0:n.actions.length===0))throw Error('完整节点缺少动作或终局仍有后续动作。');
    const policy=n.actor>=0?Array(ranges[n.actor].length).fill(null):null,rowMap=new Map();
    if(n.actor>=0)for(const row of n.combos||[]){
      const hand=canon(row.combo),index=indices[n.actor].get(hand);if(index===undefined||rowMap.has(index))throw Error('策略节点存在范围外或重复组合。');
      const probabilities=row.probabilities;if(!Array.isArray(probabilities)||probabilities.length!==n.actions.length||probabilities.some(x=>!finite(x)||x<0))throw Error('组合策略概率缺失或无效。');
      const sum=probabilities.reduce((s,x)=>s+x,0);if(Math.abs(sum-1)>1e-6)throw Error('组合策略概率之和不为 1。');
      policy[index]=probabilities.map(x=>x/sum);rowMap.set(index,row);
    }
    return {board,policy,rowMap,children:n.actions.map(a=>{const child=byId.get(a.childId);if(child===undefined)throw Error('完整策略树缺少动作子节点。');return child;})};
  });
  const parents=new Int32Array(result.nodes.length).fill(-1),seen=new Set(),rankCache=new Map(),settlementCache=new Map();
  function checkBudget(amount=0){visits+=amount;if(visits>maxNodeDealVisits)throw Error('独立评估超过节点发牌访问预算。');if(signal?.aborted)throw Error('独立策略评估已取消。');if(Date.now()-started>maxSeconds*1000)throw Error('独立策略评估超过时间预算。');if(Date.now()-lastProgress>1000){lastProgress=Date.now();onProgress({phase:'policy-evaluation',processedNodes:processed,publicNodes:result.nodes.length,nodeDealVisits:visits,seconds:(Date.now()-started)/1000});}}
  function showdownEquity(board,d){
    const key=board.slice().sort((a,b)=>a-b).join(':')+'|'+d.hands.join(':');if(settlementCache.has(key))return settlementCache.get(key);
    const used=new Set([...board,...d.hole]),remain=Array.from({length:52},(_,i)=>i).filter(c=>!used.has(c));let wins=0,count=0;
    const compare=complete=>{if(++showdownRunouts>maxNodeDealVisits)throw Error('终局未来牌枚举超过评估预算。');if((showdownRunouts&1023)===0)checkBudget();const ranks=d.hands.map((c,p)=>{const k=complete.slice().sort((a,b)=>a-b).join(':')+'|'+p+':'+c;if(!rankCache.has(k))rankCache.set(k,rankHand([...complete,...ranges[p][c].cards]));return rankCache.get(k);});wins+=ranks[0]===ranks[1]?.5:ranks[0]>ranks[1]?1:0;count++;};
    if(board.length===5)compare(board);else if(board.length===4)for(const c of remain)compare([...board,c]);else for(let a=0;a<remain.length;a++)for(let b=a+1;b<remain.length;b++)compare([...board,remain[a],remain[b]]);
    const e=wins/count;settlementCache.set(key,e);return e;
  }
  function terminalValue(n,board,d){
    const v=n.contributions.map(c=>-c),alive=[0,1].filter(p=>!n.folded[p]);if(!alive.length)throw Error('终局没有可获奖的玩家。');
    const equity=alive.length===2?showdownEquity(board,d):null;
    const award=(amount,eligible)=>{if(amount===0)return;if(eligible.length===1)v[eligible[0]]+=amount;else if(eligible.length===2){v[0]+=amount*equity;v[1]+=amount*(1-equity);}else throw Error('边池没有合法获奖人。');};
    award(pot-fee,alive);let previous=0;
    for(const level of [...new Set(n.contributions)].sort((a,b)=>a-b)){const contributors=[0,1].filter(p=>n.contributions[p]>=level),amount=(level-previous)*contributors.length;award(amount,contributors.length===1?contributors:contributors.filter(p=>!n.folded[p]));previous=level;}
    return v;
  }
  const values=()=>({profile:new Float64Array(D*2),br:computeBestResponse?[new Float64Array(D),new Float64Array(D)]:null});
  function visit(index,ids,reach,chanceFactor){
    checkBudget(ids.length);processed++;if(seen.has(index))throw Error('完整策略树包含循环或共享历史节点。');seen.add(index);
    const n=result.nodes[index],m=meta[index],out=values(),full=new Float64Array(D);let nodeReach=0;
    for(const d of ids){full[d]=deals[d].weight*reach[0][d]*reach[1][d]*chanceFactor;nodeReach+=full[d];}
    n.reach=nodeReach;
    if(n.terminal){
      const award=[0,0];for(const d of ids){const v=terminalValue(n,m.board,deals[d]);for(let p=0;p<2;p++){out.profile[d*2+p]=v[p];if(out.br)out.br[p][d]=v[p];award[p]+=full[d]*(v[p]+n.contributions[p]);}}
      n.expectedAward=award.map(v=>nodeReach>0?v/nodeReach:null);return out;
    }
    if(n.chance){
      if(m.board.length>=5)throw Error('河牌之后出现额外机会节点。');
      const available=52-m.board.length-4,branchCards=new Set();
      for(let a=0;a<n.actions.length;a++){
        const card=n.actions[a].card,child=m.children[a],cm=meta[child];if(!Number.isInteger(card)||card<0||card>=52||m.board.includes(card)||branchCards.has(card))throw Error('公共发牌分支无效或重复。');branchCards.add(card);
        if(cm.board.length!==m.board.length+1||cm.board.at(-1)!==card||m.board.some((c,i)=>cm.board[i]!==c))throw Error('机会子节点公共牌错误。');
        const sub=ids.filter(d=>!deals[d].hole.includes(card));link(child,index);const c=visit(child,sub,reach,chanceFactor/available);
        for(const d of sub)for(let p=0;p<2;p++){out.profile[d*2+p]+=c.profile[d*2+p]/available;if(out.br)out.br[p][d]+=c.br[p][d]/available;}
        n.actions[a].frequency=nodeReach>0?result.nodes[child].reach/nodeReach:null;n.actions[a].ev=null;n.actions[a].selectedEV=null;
      }
      for(const d of ids)for(let card=0;card<52;card++)if(!m.board.includes(card)&&!deals[d].hole.includes(card)&&!branchCards.has(card))throw Error('缺少合法公共牌分支；不能以不完整树评估完整策略。');
      return out;
    }
    const p=n.actor,A=n.actions.length,C=ranges[p].length,cf=new Float64Array(D),denom=new Float64Array(C),joint=new Float64Array(C),ev=new Float64Array(C*A),brTotals=computeBestResponse?new Float64Array(C*A):null,children=[];
    for(const d of ids){const c=deals[d].hands[p];if(!m.policy[c])throw Error(`节点 ${n.id} 的反事实可用组合 ${ranges[p][c].label} 缺少策略，无法独立评估。`);cf[d]=deals[d].cfWeight[p]*reach[1-p][d]*chanceFactor;denom[c]+=cf[d];joint[c]+=full[d];}
    for(let a=0;a<A;a++){
      const child=m.children[a];if(meta[child].board.length!==m.board.length||m.board.some((c,i)=>meta[child].board[i]!==c))throw Error('行动子节点公共牌未经机会节点发生变化。');link(child,index);
      const r=[reach[0],reach[1]];r[p]=Float64Array.from(reach[p]);for(const d of ids)r[p][d]*=m.policy[deals[d].hands[p]][a];const c=visit(child,ids,r,chanceFactor);children.push(c);
      let actionMass=0,forced=0,selected=0;
      for(const d of ids){const hand=deals[d].hands[p],prob=m.policy[hand][a],v=c.profile[d*2+p]+n.contributions[p];ev[hand*A+a]+=cf[d]*v;actionMass+=full[d]*prob;forced+=full[d]*v;selected+=full[d]*prob*v;for(let k=0;k<2;k++)out.profile[d*2+k]+=prob*c.profile[d*2+k];if(out.br){brTotals[hand*A+a]+=cf[d]*c.br[p][d];out.br[1-p][d]+=prob*c.br[1-p][d];}}
      Object.assign(n.actions[a],{frequency:nodeReach>0?actionMass/nodeReach:null,ev:nodeReach>0?forced/nodeReach:null,selectedEV:actionMass>0?selected/actionMass:null});
    }
    for(const [c,row] of m.rowMap){row.weight=ranges[p][c].weight;row.reach=joint[c];row.counterfactualReach=denom[c]*prior[p][c];row.probabilities=m.policy[c];row.actionEV=Array.from({length:A},(_,a)=>denom[c]>0?ev[c*A+a]/denom[c]:null);row.ev=denom[c]>0?row.actionEV.reduce((s,v,a)=>s+v*row.probabilities[a],0):null;}
    n.profileEV=nodeReach>0?n.actions.reduce((s,a)=>s+(a.frequency??0)*(a.selectedEV??0),0):null;
    n.aggregateEVMeaning='action.ev forces the reached hand range to that action; selectedEV conditions on hands taking it. Compare decisions using the same combo actionEV.';
    if(out.br){
      const best=new Int32Array(C);for(let c=0;c<C;c++)for(let a=1;a<A;a++)if(brTotals[c*A+a]>brTotals[c*A+best[c]])best[c]=a;
      for(const d of ids)out.br[p][d]=children[best[deals[d].hands[p]]].br[p][d];
      if(responsePolicies)for(const [c,row] of m.rowMap)responsePolicies[p].push({nodeId:n.id,combo:row.combo,actionId:n.actions[best[c]].id,actionIndex:best[c],counterfactualReach:denom[c]*prior[p][c],continuationEV:denom[c]>0?Array.from({length:A},(_,a)=>brTotals[c*A+a]/denom[c]+n.contributions[p]):null});
    }
    return out;
  }
  function link(child,parent){if(parents[child]!==-1)throw Error('策略树共享节点或包含循环。');parents[child]=parent;if(result.nodes[child].parentId!==result.nodes[parent].id)throw Error('子节点 parentId 与真实行动路径不一致。');}
  const reach=[new Float64Array(D).fill(1),new Float64Array(D).fill(1)],root=byId.get(roots[0].id),v=visit(root,Array.from({length:D},(_,i)=>i),reach,1);
  if(seen.size!==result.nodes.length)throw Error('完整策略树含有根节点无法访问的孤立节点。');
  const profile=[0,0],br=[0,0];for(let d=0;d<D;d++)for(let p=0;p<2;p++){profile[p]+=deals[d].weight*v.profile[d*2+p];if(computeBestResponse)br[p]+=deals[d].weight*v.br[p][d];}
  if(Math.abs(profile[0]+profile[1]-(pot-fee))>1e-7*Math.max(1,pot))throw Error('独立评估资金守恒失败。');
  const diagnostics={...result.diagnostics,source:'PokerLab independent exported-policy evaluator; native reportedExploitabilityPctPot is retained separately',profileEV:profile,constantSum:pot-fee,independentlyVerified:true,verifiedBy:'Independent float64 full-tree policy evaluation with private-card-conditioned exact chance',meaning:'Values evaluate the reported fixed policy; they do not replace it with best-response actions.',bestResponseIgnoresLocks:true};
  for(const key of ['constrainedBestResponseEV','constrainedGain','constrainedNashConv','constrainedNashConvPctPot','optimizationResidualPctPot','residualForStopping','lockInterpretation','bestResponseEV','gain','nashConv','nashConvPctPot','exploitability','exploitabilityPctPot'])delete diagnostics[key];
  if(computeBestResponse){for(let p=0;p<2;p++)if(br[p]<profile[p]-1e-7)throw Error('独立最佳应对价值低于原策略。');const gain=br.map((x,p)=>Math.max(0,x-profile[p])),nashConv=gain[0]+gain[1];Object.assign(diagnostics,{bestResponseEV:br,gain,nashConv,nashConvPctPot:100*nashConv/pot,exploitability:nashConv/2,exploitabilityPctPot:50*nashConv/pot,verifiedBy:'Independent information-set-consistent exact best response over the complete exported fixed policy',definition:'Sum of unilateral information-set best-response gains, using exact private-card-conditioned future chance within this finite tree.'});}
  if(computeBestResponse&&finite(diagnostics.reportedExploitabilityPctPot)){diagnostics.nativeReportDifferencePctPot=Math.abs(diagnostics.reportedExploitabilityPctPot-diagnostics.exploitabilityPctPot);diagnostics.nativeReportConsistent=diagnostics.nativeReportDifferencePctPot<.0001;}
  result.diagnostics=diagnostics;result.capabilities={...result.capabilities,actionEV:true,studyCards:true};
  delete result.bestResponsePolicies;
  if(responsePolicies)result.bestResponsePolicies=responsePolicies;
  const marginals=ranges.map(r=>Array(r.length).fill(0));for(const d of deals)d.hands.forEach((c,p)=>marginals[p][c]+=d.weight);
  result.chance={...result.chance,marginals:input.players.map((p,i)=>({player:i,playerId:p.id,combos:ranges[i].map((c,j)=>({combo:c.label,probability:marginals[i][j],inputWeight:c.weight}))}))};
  result.policyEvaluation={implementation:'PokerLab independent HU policy evaluator v1',exact:true,fullTree:true,computeBestResponse,legalHoleDeals:D,publicNodes:result.nodes.length,nodeDealVisits:visits,showdownRunouts,seconds:(Date.now()-started)/1000,precision:'float64',ownPrior:'Own private-hand prior is removed before conditional action-EV/BR aggregation. Reported counterfactualReach follows the existing joint-chance convention and includes it.',chance:'Each future card has probability 1/(52-currentBoardCards-4) conditional on each compatible private-card pair. Public aggregate chance frequencies are never used as inputs.'};
  result.assumptions=[...(result.assumptions||[]),'Action EV and independent best-response diagnostics evaluate the exported fixed policy in float64, with exact private-card-conditioned future chance.'];
  result.limits=(result.limits||[]).filter(text=>!text.includes('当前接入仅导出策略频率')&&!text.includes('原引擎残差未经本平台独立')).concat(['Independent evaluation is exact for this exported finite action tree and supplied ranges; it does not certify omitted bet sizes, range assumptions, or real-game profits.']);
  return result;
}
