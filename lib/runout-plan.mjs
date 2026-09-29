import {cards,cardText} from './poker.mjs';
import {assertSolutionScenario} from './solution-identity.mjs';

const finite=Number.isFinite,canon=s=>cards(s,[2]).sort((a,b)=>a-b).map(cardText).join('');
const boardText=s=>cards(s).map(cardText).join('');
// Tiny but positive histories are still valid conditioning events. An absolute
// epsilon would silently accept the loss of their entire probability mass.
const sameMass=(a,b)=>Math.abs(a-b)<=1e-7*Math.max(a,b);
function tree(scenario,result){
 assertSolutionScenario(scenario,result);
 if(result.chance?.exact!==true||result.stats?.chanceSampling===true||result.capabilities?.fullTree===false||result.capabilities?.actionEV===false||result.outputScope==='current-street'||!Array.isArray(result.nodes)||result.nodes.some(n=>n.outOfScope))throw Error('下一街计划需要完整机会枚举及后续行动 EV，当前导出不满足条件或含未导出的未来边界。');
 const nodes=new Map(result.nodes.map(n=>[n.id,n]));
 if(nodes.size!==result.nodes.length||!nodes.has('n0'))throw Error('完整公开树的节点编号缺失或重复。');
 const route=id=>{let node=nodes.get(id);const path=[],seen=new Set();while(node?.parentId!=null){if(seen.has(node.id))throw Error('公开路径包含循环。');seen.add(node.id);const parent=nodes.get(node.parentId),action=parent?.actions.find(a=>a.childId===node.id);if(!action)throw Error('公开树的父路径缺失。');path.unshift(action.id);node=parent;}return path;};
 return {nodes,route};
}
function quality(result){const d=result.diagnostics??{},residual=finite(d.optimizationResidualPctPot)?d.optimizationResidualPctPot:finite(d.nashConvPctPot)?d.nashConvPctPot:null,target=finite(result.input.accuracy)?result.input.accuracy:null;return {mode:'exact',residual,target,targetReached:residual!==null&&target!==null&&residual<=target,provisional:residual===null||target===null||residual>target,meaning:'完整机会模型中的参考策略；起点残差不是每张未来牌或每个组合的误差上界。'};}
function chanceDescription(scenario,m,node){
 const children=node.actions.map(a=>m.nodes.get(a.childId));
 if(!node.chance||cards(node.board??scenario.board).length!==4||!children.length||children.some(n=>!n||n.actor<0||cards(n.board??'').length!==5)||new Set(children.map(n=>n.actor)).size!==1)return null;
 const actor=children[0].actor;
 const route=m.route(node.id),history=[];let cursor=m.nodes.get('n0');
 for(const id of route){const action=cursor.actions.find(a=>a.id===id);history.push({nodeId:cursor.id,actorSeat:cursor.actor>=0?cursor.actor:null,actorName:cursor.actor>=0?scenario.players[cursor.actor].name:'发牌',label:action.label,type:action.type,board:cursor.board??scenario.board,amount:action.amount??0,to:action.to??0});cursor=m.nodes.get(action.childId);}
 return {nodeId:node.id,path:route,history,board:boardText(node.board??scenario.board),pot:node.pot,reach:node.reach,actorSeat:actor,actorName:scenario.players[actor].name,actorPosition:scenario.players[actor].position,riverBranches:children.length,contributions:node.contributions,folded:node.folded};
}
export function listRunoutPlans(scenario,result){
 const m=tree(scenario,result),nodes=result.nodes.filter(n=>n.chance).map(n=>chanceDescription(scenario,m,n)).filter(Boolean);
 return {kind:'runout-plan-sources',sources:nodes,quality:quality(result),limits:['比较同一个已确定转牌行动线之后的河牌；不把不同底池或不同历史的节点拼起来。','当前对照的是河牌第一位行动玩家，不模拟其他玩家先作答后的不同条件。']};
}
export function buildRunoutPlan(scenario,result,{chancePath,focusCombo}={}){
 const m=tree(scenario,result);if(!Array.isArray(chancePath)||chancePath.length>150||chancePath.some(a=>typeof a!=='string'||a.length>200))throw Error('请选择一个真实的转牌结束发牌节点。');
 let chance=m.nodes.get('n0');for(const id of chancePath){const action=chance?.actions.find(a=>a.id===id);chance=action&&m.nodes.get(action.childId);if(!chance)throw Error('下一街对照的公开路径不存在。');}
 const context=chanceDescription(scenario,m,chance);if(!context)throw Error('这个节点不是河牌发牌前、且各分支都有同一位玩家首先行动的节点。');
 if(!(finite(chance.reach)&&chance.reach>0))throw Error('该转牌行动线在参考策略中零到达，不能伪造观察条件下的未来牌概率。');
 const focus=focusCombo?canon(focusCombo):null,known=focus?cards(focus):[],board=cards(context.board),boardSet=new Set(board);
 if(known.some(c=>boardSet.has(c)))throw Error('聚焦手牌与当前公共牌冲突。');
 const children=chance.actions.map(a=>({action:a,node:m.nodes.get(a.childId)})),universe=new Map();
 // Check the full conditioning event BEFORE selecting a private hand. Otherwise
 // a missing branch/row would be disguised by renormalizing the remaining hand
 // mass in focus mode and would bias both card probabilities and the EV sum.
 const childMass=children.reduce((sum,{node})=>{if(!finite(node.reach)||node.reach<0)throw Error('河牌公开节点到达质量无效。');return sum+node.reach;},0);
 if(!sameMass(childMass,chance.reach))throw Error('公开发牌分支到达质量未守恒，结果未发布。');
 for(const {node} of children){
  const seen=new Set(),publicCards=new Set(cards(node.board));let mass=0;
  for(const row of node.combos??[]){
   const combo=canon(row.combo);if(seen.has(combo))throw Error('河牌范围组合重复，不能重复计算概率质量。');seen.add(combo);
   if(!finite(row.reach)||row.reach<0)throw Error('河牌范围组合到达质量无效。');
   if(row.reach>0&&cards(combo).some(c=>publicCards.has(c)))throw Error('正到达河牌组合与公共牌冲突。');
   mass+=row.reach;if(!universe.has(combo))universe.set(combo,{combo,reach:0});universe.get(combo).reach+=row.reach;
  }
  if(!sameMass(mass,node.reach))throw Error('河牌范围组合质量与公开节点不一致，结果未发布。');
 }
 if(focus&&!universe.has(focus))throw Error('这手牌不属于河牌行动玩家的起点范围。');
 const totalMass=focus?universe.get(focus).reach:childMass;
 if(!(finite(totalMass)&&totalMass>0))throw Error('这手牌在指定转牌路径下没有正到达概率，不能计算观察条件的河牌分布。');
 const byCard=new Map();
 for(const {action,node} of children){const nextBoard=cards(node.board),river=nextBoard.find(c=>!boardSet.has(c));if(river===undefined||nextBoard.length!==board.length+1||board.some(c=>!nextBoard.includes(c))||byCard.has(river))throw Error('河牌公开分支重复或牌面不一致。');byCard.set(river,{action,node});}
 const rows=[];
 for(let river=0;river<52;river++){
  if(boardSet.has(river))continue;const item=byCard.get(river),base={card:cardText(river),board:context.board+cardText(river),cardId:river};
  if(known.includes(river)){rows.push({...base,status:'blocked-by-focus',probability:0,nodePath:null,actions:[],note:'这张牌在已知手牌中，不可能成为河牌。'});continue;}
  if(!item){rows.push({...base,status:'no-legal-joint-deal',probability:0,nodePath:null,actions:[],note:'给定原始范围不存在同时合法的联合发牌分支。'});continue;}
  const {action,node}=item,allRows=node.combos??[],selected=focus?allRows.filter(r=>canon(r.combo)===focus):allRows,mass=selected.reduce((s,r)=>s+(finite(r.reach)&&r.reach>0?r.reach:0),0),nodePath=[...chancePath,action.id];
  if(!mass){rows.push({...base,status:'zero-observed-reach',probability:0,nodeId:node.id,nodePath,actions:[],note:'当前手牌/范围在这条已知行动线与河牌条件下没有实际到达质量；不发布条件 EV。'});continue;}
  let referenceEV=0;
  const values=node.actions.map(a=>({id:a.id,label:a.label,type:a.type,amount:a.amount,to:a.to,allIn:!!a.allIn,frequency:0,ev:0}));
  for(const row of selected){if(!(row.reach>0))continue;
   if(!Array.isArray(row.actionEV)||row.actionEV.length!==values.length||row.actionEV.some(v=>!finite(v))||!Array.isArray(row.probabilities)||row.probabilities.length!==values.length||row.probabilities.some(v=>!finite(v)||v<0)||Math.abs(row.probabilities.reduce((a,b)=>a+b,0)-1)>1e-8)throw Error('某个正到达河牌组合缺少可核验行动 EV 或合法概率。');
   const w=row.reach/mass;for(let i=0;i<values.length;i++){values[i].frequency+=w*row.probabilities[i];values[i].ev+=w*row.actionEV[i];referenceEV+=w*row.probabilities[i]*row.actionEV[i];}
  }
  const bestEV=focus?Math.max(...values.map(a=>a.ev)):null;
  rows.push({...base,status:'available',probability:mass/totalMass,nodeId:node.id,nodePath,pot:node.pot,actorSeat:node.actor,observedMass:mass,actions:values,referenceEV,bestEV,nearBestActions:focus?values.filter(a=>bestEV-a.ev<=.02).map(a=>a.id):null,aggressionFrequency:values.filter(a=>['bet','raise'].includes(a.type)).reduce((s,a)=>s+a.frequency,0),evMeaning:focus?'固定此手牌在河牌节点选择该动作，之后全部参考策略继续。':'强制当前条件范围每个组合都采取此动作时的平均 EV；不是原策略选该动作后的选中范围 EV，也不是自由逐组合最佳策略。'});
 }
 const probabilitySum=rows.reduce((s,r)=>s+r.probability,0);if(Math.abs(probabilitySum-1)>1e-8)throw Error('条件河牌概率未归一，结果未发布。');
 const available=rows.filter(r=>r.status==='available'),weighted=key=>available.reduce((s,r)=>s+r.probability*r[key],0);
 return {kind:'runout-plan',version:1,source:{engine:result.engine,chanceNodeId:chance.id,chancePath:[...chancePath],actorSeat:context.actorSeat,focusCombo:focus},context,conditioning:focus?'known-private-combo':'whole-reaching-range',focusCombo:focus,availableCombos:[...universe.values()].map(r=>({combo:r.combo,conditionalWeight:r.reach/chance.reach,observedMass:r.reach})).sort((a,b)=>b.observedMass-a.observedMass),rows,summary:{possibleCards:available.length,probabilitySum,weightedReferenceEV:weighted('referenceEV'),weightedAggressionFrequency:weighted('aggressionFrequency'),evOrigin:'从这个河牌决策节点向后；转牌已投入筹码是沉没成本。',meaning:'只在同一个发牌前条件下加权。它不等于转牌某个动作的完整 EV，也不评价实战出现率。'},quality:quality(result),limits:['公共牌概率来自全体私牌互斥与已知转牌行动后的联合到达质量。不能假定每张未见牌一律等概率，也不能把各玩家边际范围直接相乘。','聚焦手牌是条件观察；它没有把对手策略改成知道你的手牌。','当前对照的是河牌第一位行动玩家的同层节点。策略不同还可能受阻断、范围构成和剩余筹码共同影响；文字牌面标签不自动构成因果解释。','未达参考残差目标时仍可研究计算结果，不能把微小 EV 差视为可靠行动规则。']};
}
