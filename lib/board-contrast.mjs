import crypto from 'node:crypto';
import {cards,cardText,range,category,CATEGORIES} from './poker.mjs';
import {assertSolutionScenario} from './solution-identity.mjs';
import {solveSettings} from './solve-settings.mjs';
const canon=s=>cards(s,[2]).sort((a,b)=>a-b).map(cardText).join(''),finite=Number.isFinite;
const fingerprint=r=>crypto.createHash('sha256').update(JSON.stringify(r)).digest('hex');
export function assertBoardContrast(before,after){
 const a=cards(before.board,[3,4,5]),b=cards(after.board,[3,4,5]);
 if(a.length!==b.length||a.filter((c,i)=>c!==b[i]).length!==1)throw Error('换牌实验每次仅替换同一街的一张公共牌，位置顺序保持不变。');
 const fields=['pot','heroSeat','toAct','rake','rakeCap'];for(const k of fields)if((before[k]??0)!==(after[k]??0))throw Error('换牌实验不能同时改变底池、位置或抽水。');
 if(canonMaybe(before.hero)!==canonMaybe(after.hero)||before.players.length!==after.players.length)throw Error('换牌实验必须保留相同玩家与 Hero 手牌。');
 before.players.forEach((p,i)=>{const q=after.players[i];for(const k of ['id','position','stack','range'])if(p[k]!==q[k])throw Error('换牌实验必须保留原始范围、筹码与座位；牌面导致的组合移除由引擎计算。');});
 const index=a.findIndex((c,i)=>c!==b[i]);return {index,from:cardText(a[index]),to:cardText(b[index])};
}
const canonMaybe=s=>s?canon(s):'';
function nodeAt(r,path){const map=new Map(r.nodes.map(n=>[n.id,n]));let n=map.get('n0');for(const id of path){const action=n?.actions?.find(a=>a.id===id);n=map.get(action?.childId);if(!n)throw Error('这条行动路径在某一牌面下不存在，不能用最近节点替代。');}if(!n||n.actor<0||n.terminal||n.chance||n.outOfScope)throw Error('请选择两边都已完整导出的玩家决策节点。');return n;}
function nodeRows(n){
 const values=n.combos??[],mass=values.reduce((s,c)=>s+(finite(c.reach)&&c.reach>0?c.reach:0),0);return {mass,rows:new Map(values.map(c=>[canon(c.combo),{...c,weight:mass>0&&finite(c.reach)&&c.reach>0?c.reach/mass:0}]))};
}
function quality(result){const target=result.input?.accuracy,residual=result.diagnostics?.optimizationResidualPctPot??result.diagnostics?.nashConvPctPot;return {target:finite(target)?target:null,residual:finite(residual)?residual:null,targetReached:finite(target)&&finite(residual)&&residual<=target,meaning:'参考策略的树内残差；不是逐组合 EV 或频率变化的误差界。'};}
/** A baseline-dependent accounting identity separates common-hand policy
 * changes from changing reach weights. It is not a causal identification. */
export function decomposeFrequency(a,b,actionIndex){
 const A=nodeRows(a),B=nodeRows(b),common=[...A.rows.keys()].filter(k=>B.rows.has(k)),left=[...A.rows.keys()].filter(k=>!B.rows.has(k)),added=[...B.rows.keys()].filter(k=>!A.rows.has(k));
 if(!(A.mass>0&&B.mass>0))return {status:'unavailable',reason:'至少一边节点没有正的实际到达质量。'};
 const read=(row)=>row.probabilities?.[actionIndex];if([...A.rows.values(),...B.rows.values()].some(r=>!finite(read(r))||read(r)<0||read(r)>1))return {status:'unavailable',reason:'原策略行缺少合法行动概率。'};
 const massA=common.reduce((s,k)=>s+A.rows.get(k).weight,0),massB=common.reduce((s,k)=>s+B.rows.get(k).weight,0);
 if(!(massA>0&&massB>0))return {status:'unavailable',reason:'两边没有均有正到达质量的共同组合集。'};
 const meanA=common.reduce((s,k)=>s+A.rows.get(k).weight/massA*read(A.rows.get(k)),0),meanB=common.reduce((s,k)=>s+B.rows.get(k).weight/massB*read(B.rows.get(k)),0);
 const policy=massB*common.reduce((s,k)=>s+B.rows.get(k).weight/massB*(read(B.rows.get(k))-read(A.rows.get(k))),0);
 const reachMix=massB*common.reduce((s,k)=>s+(B.rows.get(k).weight/massB-A.rows.get(k).weight/massA)*read(A.rows.get(k)),0);
 const commonMass=(massB-massA)*meanA,newContribution=added.reduce((s,k)=>s+B.rows.get(k).weight*read(B.rows.get(k)),0),removedContribution=-left.reduce((s,k)=>s+A.rows.get(k).weight*read(A.rows.get(k)),0);
 const frequencyA=[...A.rows.values()].reduce((s,c)=>s+c.weight*read(c),0),frequencyB=[...B.rows.values()].reduce((s,c)=>s+c.weight*read(c),0),sum=policy+reachMix+commonMass+newContribution+removedContribution;
 if(Math.abs(sum-(frequencyB-frequencyA))>1e-9)throw Error('策略频率变化的分解不守恒，未发布归因。');
 return {status:'complete',frequencyA,frequencyB,delta:frequencyB-frequencyA,commonConditionalFrequencyA:meanA,commonConditionalFrequencyB:meanB,commonMassA:massA,commonMassB:massB,components:[{id:'common-policy',label:'共同组合改变自己的行动概率',value:policy},{id:'common-reach',label:'共同组合之间的到达权重变化',value:reachMix},{id:'common-mass',label:'共同组合占全部范围的质量变化',value:commonMass},{id:'added',label:'新出现组合的行动贡献',value:newContribution},{id:'removed',label:'消失组合原有贡献的移除',value:removedContribution}],identityError:sum-(frequencyB-frequencyA),meaning:'以原牌面 A 的共同组合策略为基准，按 B 的质量展开的记账恒等式。分解顺序影响各项归属，不能当作独立因果效应。'};
}
export function compareBoards(scenarioA,resultA,scenarioB,resultB,{nodePath=[],combo=null,toleranceBB=.1}={}){
 const change=assertBoardContrast(scenarioA,scenarioB);assertSolutionScenario(scenarioA,resultA);assertSolutionScenario(scenarioB,resultB);
 if(resultA.chance?.exact!==true||resultB.chance?.exact!==true)throw Error('策略换牌对照需要两边完整机会模型；不能把采样策略伪装为精确同树对照。');
 if(!Array.isArray(nodePath)||nodePath.length>120||nodePath.some(s=>typeof s!=='string'))throw Error('对照路径无效。');
 if(!finite(toleranceBB)||toleranceBB<0)throw Error('实践容忍必须是非负 BB 数值。');
 const settings=r=>{const s=solveSettings(r.input);for(const k of ['iterations','checkEvery','maxSeconds','threads','accuracy','adaptivePrecision','adaptiveCheckEvery','engine','algorithm','averagingDelay','gpuMemoryBytes','maxNodes','maxDeals','maxNodeVisits','maxBytes','maxStrategyCells'])delete s[k];return s;};
 if(JSON.stringify(settings(resultA))!==JSON.stringify(settings(resultB)))throw Error('两边的下注树模板或策略约束不同，不能把差别只归于换牌。');
 const a=nodeAt(resultA,nodePath),b=nodeAt(resultB,nodePath);if(a.actor!==b.actor||a.actions.length!==b.actions.length||a.actions.some((x,i)=>x.id!==b.actions[i].id)||Math.abs(a.pot-b.pot)>1e-8||Math.abs(a.toCall-b.toCall)>1e-8)throw Error('两边不是同一行动条件，无法作单因素策略对照。');
 const A=nodeRows(a),B=nodeRows(b),common=[...A.rows.keys()].filter(k=>B.rows.has(k)),focus=combo?canon(combo):null;
 const actions=a.actions.map((action,i)=>({id:action.id,label:action.label,...decomposeFrequency(a,b,i)}));
 const comparison=common.map(key=>{
  const x=A.rows.get(key),y=B.rows.get(key),scoreable=Array.isArray(x.actionEV)&&Array.isArray(y.actionEV)&&x.actionEV.length===a.actions.length&&y.actionEV.length===b.actions.length&&x.actionEV.every(finite)&&y.actionEV.every(finite)&&x.counterfactualReach>0&&y.counterfactualReach>0;
  const bestA=scoreable?Math.max(...x.actionEV):null,bestB=scoreable?Math.max(...y.actionEV):null;
  return {combo:key,scoreable,weightA:x.weight,weightB:y.weight,observedBoth:x.weight>0&&y.weight>0,madeHandA:CATEGORIES[category([...cards(a.board||scenarioA.board),...cards(key)])],madeHandB:CATEGORIES[category([...cards(b.board||scenarioB.board),...cards(key)])],actions:a.actions.map((ac,i)=>({id:ac.id,label:ac.label,frequencyA:x.probabilities?.[i]??null,frequencyB:y.probabilities?.[i]??null,deltaFrequency:finite(x.probabilities?.[i])&&finite(y.probabilities?.[i])?y.probabilities[i]-x.probabilities[i]:null,evA:scoreable?x.actionEV[i]:null,evB:scoreable?y.actionEV[i]:null,regretA:scoreable?bestA-x.actionEV[i]:null,regretB:scoreable?bestB-y.actionEV[i]:null,withinToleranceA:scoreable?bestA-x.actionEV[i]<=toleranceBB:null,withinToleranceB:scoreable?bestB-y.actionEV[i]<=toleranceBB:null}))};
 });
 const focusResult=focus?comparison.find(c=>c.combo===focus)??{combo:focus,scoreable:false,reason:'该手牌被一边公共牌移除，或不存在于当前行动者的共同范围；不能伪造同组合策略变化。'}:null;
 const ranges=scenarioA.players.map((p,i)=>{const ra=range(p.range,cards(scenarioA.board)).live,rb=range(scenarioB.players[i].range,cards(scenarioB.board)).live,sa=new Set(ra.map(c=>canon(c.label))),sb=new Set(rb.map(c=>canon(c.label)));return {id:p.id,name:p.name,position:p.position,legalA:ra.length,legalB:rb.length,removed:ra.filter(c=>!sb.has(canon(c.label))).map(c=>({combo:c.label,weight:c.weight})),added:rb.filter(c=>!sa.has(canon(c.label))).map(c=>({combo:c.label,weight:c.weight})),meaning:'原研究起点的单个范围合法组合；深节点后验仍受联合撞牌及此前行动影响。'};});
 const qa=quality(resultA),qb=quality(resultB),largest=[...actions].filter(x=>x.status==='complete').sort((x,y)=>Math.abs(y.delta)-Math.abs(x.delta))[0];
 return {schemaVersion:1,kind:'board-contrast-report',change,sourceFingerprints:[fingerprint(resultA),fingerprint(resultB)],nodePath,actor:a.actor,actorName:scenarioA.players[a.actor].name,boardA:a.board||scenarioA.board,boardB:b.board||scenarioB.board,pot:a.pot,toCall:a.toCall,toleranceBB,quality:{before:qa,after:qb,provisional:!qa.targetReached||!qb.targetReached},ranges,actions,combos:comparison,focus:focusResult,teaching:{observation:largest?`总体变化最大的动作是 ${largest.label}。先看共同组合的概率变化，再检查组合增减与到达权重，不把总频率差全部解释为同一手牌改变打法。`:'当前缺少可用的正到达范围，保留条件分析，暂不形成总体频率结论。',discrimination:'只看两边都存在的同一组合：它的可接受动作集合真的改变了，还是近等收益动作之间的频率重新分配？',experiment:'选择一手共同组合，沿同一动作进入两边的对手响应，比较谁弃牌、谁跟注、谁加注。未计算该分支前，只把阻断或范围强弱作为待检验解释。',transfer:'实战先辨别这张牌具体移除了哪些组合、改变了自己的成牌，以及哪些对手响应值得重查；不要背一个脱离范围和行动线的固定频率。'},limits:['这是在固定起点范围、筹码和树模板下重新求解的牌面反事实，不是已经发生牌局的事实重放。','两边均衡选择与数值残差可能不同；频率变化并不自动意味着某个动作变错。','实践容忍由用户设定，不是引擎误差界；全局残差也不是每个组合的 EV 误差上界。','频率分解是有明确基准的记账，未独立识别移牌、牌力和策略适应的因果效应。','多人的单方偏离残差不等于用户自身损失，也不保证一般纳什收敛。']};
}
