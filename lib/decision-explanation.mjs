import {cards,cardText,range,rankHand} from './poker.mjs';
import {assertSolutionScenario} from './solution-identity.mjs';
const canon=text=>cards(text,[2]).sort((a,b)=>a-b).map(cardText).join('');
const EPS=1e-12;
const categories={fold:'我在后续弃牌',uncontested:'其余玩家都弃牌',win:'摊牌获得底池份额',tie:'摊牌含平分份额',loss:'摊牌未获得份额'};

/** Independently re-evaluate the reported policy for one exact hand. This is an
 * accounting identity, not a causal explanation or a new equilibrium solve. */
export function explainDecision(scenario,result,{nodeId='n0',combo,maxDeals=100000,maxVisits=20000000}={}){
 assertSolutionScenario(scenario,result);
 if(result.chance?.exact!==true)throw Error('行动收益拆解目前只接受完整机会枚举的结果。');
 const started=performance.now(),nodes=new Map(result.nodes.map(n=>[n.id,n])),node=nodes.get(nodeId);
 if(!node||node.actor<0||node.terminal)throw Error('请选择真实玩家的决策节点。');
 const target=canon(combo||scenario.hero),focus=(node.combos||[]).find(c=>canon(c.combo)===target);
 if(!focus||!(focus.counterfactualReach>EPS))throw Error('这手牌在该节点没有可分析的到达权重。');
 const actor=node.actor,N=scenario.players.length,rootBoard=cards(scenario.board),currentBoard=cards(node.board||scenario.board);
 if(rootBoard.length!==4&&rootBoard.length!==5)throw Error('当前拆解支持河牌及转牌→河牌结果。');
 const ranges=scenario.players.map((p,i)=>i===actor?[{cards:cards(target),label:target,weight:1}]:range(p.range,rootBoard).live);
 for(const rg of ranges){const max=Math.max(...rg.map(c=>c.weight)),total=rg.reduce((s,c)=>s+c.weight/max,0);for(const c of rg)c.weight=(c.weight/max)/total;}
 const rowMaps=new Map(result.nodes.filter(n=>n.actor>=0).map(n=>[n.id,new Map((n.combos||[]).map(c=>[canon(c.combo),c]))]));
 const prefix=[];let cursor=node;while(cursor.parentId){const parent=nodes.get(cursor.parentId),action=parent.actions.find(a=>a.childId===cursor.id);if(!action)throw Error('求解树父子关系不完整。');prefix.unshift({node:parent,action,index:parent.actions.indexOf(action)});cursor=parent;}
 const totals=node.actions.map(a=>({id:a.id,label:a.label,type:a.type,frequency:focus.probabilities[node.actions.indexOf(a)],mass:0,evSum:0,refundSum:0,responses:new Map(),outcomes:new Map()}));
 let visits=0,dealCount=0,positivePosteriorDeals=0,posteriorMass=0;const hands=[],rankCache=new Map();
 const rank=(hand,river)=>{const key=hand.label+':'+river;if(!rankCache.has(key))rankCache.set(key,rankHand([...rootBoard,...(rootBoard.length===4?[river]:[]),...hand.cards]));return rankCache.get(key);};
 function terminal(n,ranks){
  const alive=Array.from({length:N},(_,i)=>i).filter(i=>!n.folded[i]),awards=Array(N).fill(0),refunds=Array(N).fill(0);let hasTie=false;
  const distribute=(amount,eligible)=>{if(!amount||!eligible.length)return;const best=Math.max(...eligible.map(i=>ranks[i])),winners=eligible.filter(i=>ranks[i]===best);for(const i of winners)awards[i]+=amount/winners.length;if(winners.includes(actor)&&winners.length>1)hasTie=true;};
  distribute(scenario.pot-(result.rakeModel?.fixedRake??0),alive);let previous=0;const levels=[...new Set(n.contributions.filter(c=>c>0))].sort((a,b)=>a-b);
  for(const level of levels){const entered=Array.from({length:N},(_,i)=>i).filter(i=>n.contributions[i]>=level-EPS),eligible=entered.filter(i=>!n.folded[i]),amount=(level-previous)*entered.length;if(entered.length===1){awards[entered[0]]+=amount;refunds[entered[0]]+=amount;}else distribute(amount,eligible);previous=level;}
  const value=awards[actor]-n.contributions[actor]+node.contributions[actor];
  const category=n.folded[actor]?'fold':alive.length===1?'uncontested':awards[actor]-refunds[actor]<=EPS?'loss':hasTie?'tie':'win';
  return {value,category,refund:refunds[actor]};
 }
 const getPolicy=(n,seat)=>{const row=rowMaps.get(n.id)?.get(hands[seat].label);if(!row)throw Error('求解结果缺少当前组合的策略。');return row.probabilities;};
 function walk(n,river,ranks,mass,tot,response){
  if(++visits>maxVisits)throw Error('当前逐分支拆解超过访问预算；请先在更小的范围研究。');
  if(n.terminal){const {value,category,refund}=terminal(n,ranks);tot.mass+=mass;tot.evSum+=mass*value;tot.refundSum+=mass*refund;
   const event=tot.outcomes.get(category)||{id:category,label:categories[category],mass:0,evSum:0};event.mass+=mass;event.evSum+=mass*value;tot.outcomes.set(category,event);
   const key=response?.id??'continuation',branch=tot.responses.get(key)||{id:key,label:response?.label??'发牌及后续行动',actor:response?.actor??null,continuation:response?.continuation??null,mass:0,evSum:0};branch.mass+=mass;branch.evSum+=mass*value;tot.responses.set(key,branch);return;
  }
  if(n.chance){const a=n.actions.find(a=>a.card===river);if(!a)throw Error('未来公共牌分支不完整。');walk(nodes.get(a.childId),river,ranks,mass,tot,response);return;}
  const probabilities=getPolicy(n,n.actor);
  n.actions.forEach((a,i)=>{const q=probabilities[i];if(q>0)walk(nodes.get(a.childId),river,ranks,mass*q,tot,response??(n.actor!==actor?{id:n.id+':'+a.id,label:(scenario.players[n.actor].name||scenario.players[n.actor].position)+' '+a.label,actor:n.actor,continuation:(()=>{const child=nodes.get(a.childId);return {kind:child.terminal?'terminal':child.chance?'chance':'decision',actorName:child.actor>=0?(scenario.players[child.actor].name||scenario.players[child.actor].position):null};})()}:null));});
 }
 function evaluate(river,prior){
  if(++dealCount>maxDeals)throw Error('当前条件发牌量超过拆解预算；请缩小范围。');
  let weight=prior;
  for(const h of prefix){if(h.node.chance){if(h.action.card!==river)return;}else if(h.node.actor!==actor){weight*=getPolicy(h.node,h.node.actor)[h.index];if(weight<=0)return;}}
  if(weight<=0)return;positivePosteriorDeals++;posteriorMass+=weight;const ranks=hands.map(h=>rank(h,river));
  for(let i=0;i<node.actions.length;i++)walk(nodes.get(node.actions[i].childId),river,ranks,weight,totals[i],null);
 }
 const enumerate=(seat,used,weight)=>{if(seat===N){if(rootBoard.length===5)evaluate(null,weight);else if(currentBoard.length===5){const river=currentBoard[4];if(!used.has(river))evaluate(river,weight/(52-used.size));}else{const available=52-used.size;for(let river=0;river<52;river++)if(!used.has(river))evaluate(river,weight/available);}return;}
  for(const hand of ranges[seat]){if(hand.cards.some(c=>used.has(c)))continue;hands[seat]=hand;hand.cards.forEach(c=>used.add(c));enumerate(seat+1,used,weight*hand.weight);hand.cards.forEach(c=>used.delete(c));}
 };
 enumerate(0,new Set(rootBoard),1);if(!(posteriorMass>0))throw Error('这个节点没有兼容且有权重的条件发牌。');
 const actions=totals.map((a,i)=>{const row=({mass,evSum,...x})=>({...x,probability:mass/posteriorMass,evContribution:evSum/posteriorMass,conditionalEV:mass>EPS?evSum/mass:null});const ev=a.evSum/posteriorMass,solverEV=focus.actionEV[i];return {id:a.id,label:a.label,type:a.type,frequency:a.frequency,ev,expectedUncalledRefund:a.refundSum/posteriorMass,solverEV,difference:Number.isFinite(solverEV)?ev-solverEV:null,probabilitySum:a.mass/posteriorMass,responses:[...a.responses.values()].map(row).sort((x,y)=>y.probability-x.probability),outcomes:[...a.outcomes.values()].map(row).sort((x,y)=>y.probability-x.probability)};});
 const maxDifference=Math.max(...actions.filter(a=>a.difference!==null).map(a=>Math.abs(a.difference)),0);
 if(maxDifference>1e-5)throw Error(`独立收益拆解与求解器不一致（${maxDifference.toPrecision(3)} BB）；已停止展示，避免给出错误解释。`);
 const baseline=actions.find(a=>a.type==='call')??actions.find(a=>a.type==='check')??actions[0];
 const comparisons=actions.filter(a=>a!==baseline).map(a=>({baseline:{id:baseline.id,label:baseline.label,ev:baseline.ev},alternative:{id:a.id,label:a.label,ev:a.ev},evDifference:a.ev-baseline.ev,outcomes:Object.entries(categories).map(([id,label])=>{const x=baseline.outcomes.find(o=>o.id===id),y=a.outcomes.find(o=>o.id===id);return {id,label,baselineProbability:x?.probability??0,alternativeProbability:y?.probability??0,baselineContribution:x?.evContribution??0,alternativeContribution:y?.evContribution??0,difference:(y?.evContribution??0)-(x?.evContribution??0)};})}));
 return {schemaVersion:1,nodeId,actor,actorName:scenario.players[actor].name,combo:target,board:currentBoard.map(cardText).join(' '),pot:node.pot,toCall:node.toCall,exact:true,reachMode:'counterfactual-to-current-hand',observedReach:focus.reach,conditionalDeals:dealCount,candidateDeals:dealCount,positivePosteriorDeals,rakeModel:result.rakeModel??{fixedRake:0},posteriorMass,visits,milliseconds:performance.now()-started,maxDifference,actions,comparisons,meaning:'在当前具体手牌下固定执行一个动作，后续所有玩家使用已报告策略。各分支概率 × 该分支净 EV 的总和，等于该动作 EV。',limits:['分支概率条件于你的具体手牌与对手先前动作；不能用范围平均响应率替代。','多人底池中，第一位对手弃牌不代表已经拿下底池；分支净 EV 已继续计算身后玩家与再加注。','这是对已求策略的收益账本，不证明因果机制。对手响应改变后必须重新求解。','此前投入是沉没成本；本节点起净收益口径与求解器一致。未跟注退款是退回自己的筹码，不计为摊牌赢得底池，且已包含在净 EV 中，不能再相加。']};
}
