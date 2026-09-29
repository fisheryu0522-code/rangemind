import {cards,cardText,range} from './poker.mjs';
import {solveRiverGame} from './river-engine.mjs';
import {assertSolutionScenario,assertRiverSensitivitySettings} from './solution-identity.mjs';
const canonical=s=>cards(s,[2]).sort((a,b)=>a-b).map(cardText).join('');
function locate(result,path){let node=result.nodes[0];const map=new Map(result.nodes.map(n=>[n.id,n]));for(const id of path){const action=node.actions.find(a=>a.id===id);if(!action)throw Error('实验节点路径不在该策略树内。');node=map.get(action.childId);}return node;}
/** Re-solve explicit range hypotheses. No population claim and no implicit
 * probability distribution over the hypotheses is assigned. */
export async function runSensitivity({scenario,settings,baseline,player,subset,scales=[.25,.5,1],nodePath=[],combo},{onProgress=()=>{},signal,solve=solveRiverGame,saveVariant=async()=>null}={}){
 if(cards(scenario.board).length!==5||baseline.chance?.exact!==true)throw Error('范围敏感性实验目前支持完整机会枚举的河牌结果。');
 if(/HUPostflop|TexasSolver/i.test(baseline.engine??'')||baseline.input?.engine==='hu-postflop')throw Error('范围实验目前要求 RiverLab 河牌模型；HU 引擎采用不同的下注取整规则，不能静默切换行动树。');
 assertSolutionScenario(scenario,baseline,{settings:settings??{}});settings=assertRiverSensitivitySettings(settings??{},baseline.input);
 if(!Array.isArray(scales)||scales.length<2||scales.length>5||scales.some(s=>!Number.isFinite(s)||s<=0||s>1)||new Set(scales).size!==scales.length)throw Error('请选择 2–5 个不同的到达权重倍率，大于 0 且不超过 1。');
 const node=locate(baseline,nodePath),target=canonical(combo);
 if(node.actor<0||!node.combos?.some(c=>canonical(c.combo)===target&&c.counterfactualReach>1e-12))throw Error('请选择当前决策节点中可研究的具体手牌。');
 if(!Number.isInteger(player)||player<0||player>=scenario.players.length||player===node.actor)throw Error('请选择当前行动玩家以外的一位对手。');
 const board=cards(scenario.board),original=range(scenario.players[player].range,board).live,selected=new Set(range(subset,board).live.map(c=>canonical(c.label))),affected=original.filter(c=>selected.has(canonical(c.label)));
 if(!affected.length)throw Error('所选牌组与这位对手的当前范围没有交集。');
 const rows=[];
 for(let index=0;index<scales.length;index++){
  if(signal?.aborted)throw Error('范围实验已取消。');
  const scale=scales[index],variant=structuredClone(scenario);variant.players[player].range=original.map(c=>`${c.label}:${Number((c.weight*(selected.has(canonical(c.label))?scale:1)).toPrecision(12))}`).join(',');
  onProgress({phase:'variant',index,total:scales.length,scale});
  const result=scale===1?baseline:await solve({...variant,...settings,maxSeconds:Math.min(settings.maxSeconds??120,120),chanceMode:'exact'},{signal,onProgress:p=>onProgress({...p,variant:index,total:scales.length,scale})});
  const n=locate(result,nodePath),hand=n.combos?.find(c=>canonical(c.combo)===target);if(!hand||!(hand.counterfactualReach>1e-12)||!hand.actionEV.every(Number.isFinite))throw Error('某个范围假设下该手牌没有可核验的行动 EV；未生成不完整对照。');
  if(n.actions.length!==node.actions.length||n.actions.some((a,i)=>a.id!==node.actions[i].id))throw Error('范围实验意外改变了行动集合，不能直接比较。');
  const bestEV=Math.max(...hand.actionEV),jobId=await saveVariant({result,scenario:variant,index,scale});
  rows.push({jobId,scale,range:variant.players[player].range,affectedWeight:affected.reduce((s,c)=>s+c.weight*scale,0),counterfactualReach:hand.counterfactualReach,observedReach:hand.reach,diagnostics:result.diagnostics,algorithm:result.stats?.algorithm??result.input?.algorithm,quality:{targetReached:result.stats?.targetReached??null,residualPctPot:result.diagnostics?.optimizationResidualPctPot??result.diagnostics?.nashConvPctPot,scope:result.chance?.meaning},actions:n.actions.map((a,i)=>({id:a.id,label:a.label,ev:hand.actionEV[i],loss:bestEV-hand.actionEV[i],frequency:hand.probabilities[i]}))});
 }
 const actions=node.actions.map(a=>{const values=rows.map(r=>r.actions.find(x=>x.id===a.id));return {id:a.id,label:a.label,minEV:Math.min(...values.map(x=>x.ev)),maxEV:Math.max(...values.map(x=>x.ev)),maxRegret:Math.max(...values.map(x=>x.loss)),bestInScales:rows.filter((r,i)=>values[i].loss<1e-6).map(r=>r.scale)};});
 const leastWorst=Math.min(...actions.map(a=>a.maxRegret));
 return {schemaVersion:1,createdAt:new Date().toISOString(),scenario,settings,player,playerName:scenario.players[player].name,subset,affectedCombos:affected.map(c=>({combo:c.label,weight:c.weight})),combo:target,nodePath,actor:node.actor,actorName:scenario.players[node.actor].name,nodePot:node.pot,toCall:node.toCall,rows,actions,minimaxRegretActions:actions.filter(a=>a.maxRegret<=leastWorst+1e-8).map(a=>a.id),meaning:'每一行只降低指定对手牌组的起点到达权重，其余输入与行动树保持不变；所有未锁定策略重新优化。每列损失均相对该行最优动作，未对不同范围假设赋予概率。',limits:['这是一组范围假设的敏感性分析，不能据此断言真实对手会这样行动。','最小最大损失仅覆盖本次选取的范围假设，并非全局稳健策略证明。','各行可能有不同均衡选择或数值残差；微小频率变化未必具有实战意义。','调整起点范围权重，不等同于锁定某个节点的跟注或弃牌频率。']};
}
