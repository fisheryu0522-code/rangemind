import {cards} from './poker.mjs';
import {assertSolutionScenario} from './solution-identity.mjs';
const same=(a,b)=>Number.isFinite(Number(a))&&Number.isFinite(Number(b))&&Math.abs(Number(a)-Number(b))<1e-5;
const boardKey=s=>cards(s).join(',');
/** Match recorded actions exactly. This is navigation, never a nearest-size
 * approximation or evidence that the entered ranges describe the actual game. */
export function observedPath(scenario,result,context){
 if(context?.provenance?.kind==='hypothetical-fork')throw Error('假设模型不能精确匹配原始牌局行动；请恢复原始局面另做复盘。');
 if(!context||!Array.isArray(context.ledger))throw Error('当前案例没有可重放的行动记录。');
 if(context.issues?.some(x=>x.severity==='error'))throw Error('行动记录仍有未解决的识别错误，请先核对。');
 assertSolutionScenario(scenario,result);
 const street=({3:'flop',4:'turn',5:'river'})[cards(scenario.board).length];
 const start=context.ledger.findIndex(e=>e.type==='street'&&e.street===street&&boardKey(e.board)===boardKey(scenario.board)&&same(e.potBefore,scenario.pot));
 if(start<0)throw Error('当前公共牌或街起点底池与原始记录不一致，请重新载入这条街。');
 const streetRows=[];for(const e of context.ledger.slice(start+1)){if(e.type==='street'||e.street!==street)break;streetRows.push(e);}
 const rows=streetRows.filter(e=>['check','fold','call','bet','raiseTo'].includes(e.type)),requested=context.studyTarget?.ledgerIndex;
 if(requested!=null&&(!Number.isInteger(requested)||requested<0))throw Error('选择的原始决策编号无效。');
 const selected=requested==null?null:rows.find(e=>e.index===requested),pendingIndex=(streetRows.at(-1)?.index??context.ledger[start].index)+1;
 if(requested!=null&&!selected&&requested!==pendingIndex)throw Error('所选决策不属于当前街的已核对行动，请重新选择研究起点。');
 if(!rows.length&&requested==null)throw Error('这条街还没有已记录的决策。');
 const nodes=new Map(result.nodes.map(n=>[n.id,n]));let node=nodes.get('n0'),path=[];const decisions=[];
 const alias=e=>{const exact=scenario.players.findIndex(p=>p.id===e.player);if(exact>=0)return exact;const matches=scenario.players.map((p,i)=>({p,i})).filter(({p})=>[p.name,p.position].filter(Boolean).includes(e.player??e.position));if(matches.length!==1)throw Error('记录中的玩家无法唯一匹配当前座位。');return matches[0].i;};
 for(const e of rows){
  const actor=alias(e);if(node.terminal||node.chance||node.actor!==actor)throw Error(`记录中 ${scenario.players[actor].name} 的行动顺序与求解树不符。`);
  if(!same(node.pot,e.potBefore))throw Error('记录中的行动前底池与求解节点不符。');
  if(e===selected){const target={index:decisions.length,nodeId:node.id,path:[...path],actor,actorName:scenario.players[actor].name,isHero:actor===scenario.heroSeat,pot:node.pot,toCall:node.toCall,ledgerIndex:e.index,recordedType:e.type,recordedAmount:e.amount??null};decisions.push(target);return {street,exactMatch:true,decisions,pending:null,target,endPath:[...path],boundaryMeaning:'只核对到所选行动之前；尚未发生的行动不作为本次决策的前提。',meaning:'记录用于精确定位所选行动前的局面。后续行动未参与路径核验，策略价值仍取决于当前输入范围及模型。'};}
  const type=e.type==='raiseTo'?'raise':e.type;
  const action=node.actions.find(a=>a.type===type&&(['check','fold'].includes(type)||same(e.type==='raiseTo'?a.to:a.amount,e.amount)));
  if(!action)throw Error(`求解树没有记录中的 ${scenario.players[actor].name} ${e.type}${e.amount===undefined?'':' '+e.amount+' BB'}；请将真实尺寸加入建树设置后重算。`);
  const child=nodes.get(action.childId);if(!child)throw Error('实际路径超出本次导出的策略范围。');
  if(!same(child.pot,e.potAfter))throw Error('记录中的行动后底池与求解节点不符。');
  if(e.stackAfter!=null&&!same(scenario.players[actor].stack-child.contributions[actor],e.stackAfter))throw Error('当前剩余筹码与原始记录不符，请恢复该街起点筹码。');
  decisions.push({index:decisions.length,nodeId:node.id,path:[...path],actor,actorName:scenario.players[actor].name,isHero:actor===scenario.heroSeat,recordedAction:action.id,recordedLabel:action.label,pot:node.pot,toCall:node.toCall,ledgerIndex:e.index??null});
  path.push(action.id);node=child;
 }
 const pending=!node.terminal&&!node.chance?{nodeId:node.id,path:[...path],actor:node.actor,actorName:scenario.players[node.actor].name,isHero:node.actor===scenario.heroSeat,pot:node.pot,toCall:node.toCall}:null;
 let target=pending?.isHero?pending:decisions.filter(d=>d.isHero).at(-1)??pending??decisions.at(-1);
 if(requested!=null){if(!pending)throw Error('所选位置已经没有待行动决策，请选择结束前的历史动作。');target={...pending,ledgerIndex:requested};}
 return {street,exactMatch:true,decisions,pending,target,endPath:path,meaning:'记录只用于精确定位。复盘停在已选动作之前；该动作好坏由当前输入范围和求解模型评估。'};
}
