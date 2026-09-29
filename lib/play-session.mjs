import crypto from 'node:crypto';
import {cards,cardText,range,rankHand} from './poker.mjs';
import {assertSolutionScenario} from './solution-identity.mjs';
import {fixedCappedRake} from './river-rake.mjs';

export const PLAY_SESSION_VERSION=1;
const memo=new WeakMap(),finite=Number.isFinite,copy=value=>structuredClone(value);
const key=hand=>cards(hand,[2]).sort((a,b)=>a-b).join(',');
const text=hand=>hand.map(cardText).join('');
const timestamp=now=>new Date(now??Date.now()).toISOString();
const cleanText=(value,max=4000)=>String(value??'').trim().slice(0,max);
const planOf=value=>({valueTargets:cleanText(value?.valueTargets),bluffTargets:cleanText(value?.bluffTargets),changeTriggers:cleanText(value?.changeTriggers)});

function model(result,refresh=false){
 if(memo.has(result)&&!refresh)return memo.get(result);
 if(!Array.isArray(result?.nodes)||!result.nodes.length)throw Error('缺少完整策略树。');
 if(result.capabilities?.fullTree===false||result.outputScope==='current-street')throw Error('连续练习需要完整未来街策略，当前结果只导出了本街。');
 if(result.chance?.exact!==true||result.stats?.chanceSampling===true)throw Error('连续练习当前只支持完整机会枚举的参考模型。');
 if(result.capabilities?.actionEV===false)throw Error('当前参考尚无独立核验的行动 EV，不能提供连续决策评分。');
 if(result.nodes.some(n=>n.outOfScope))throw Error('连续练习需要完整未来街策略，结果含未导出的后续边界。');
 const fingerprint=crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex');
 if(memo.get(result)?.fingerprint===fingerprint)return memo.get(result);
 const byId=new Map(result.nodes.map(n=>[n.id,n])),rows=new Map();
 if(byId.size!==result.nodes.length||!byId.has('n0'))throw Error('策略节点编号不完整。');
 const value={byId,rows,fingerprint,validatedRows:new WeakSet()};memo.set(result,value);return value;
}
function rowFor(m,node,hand){
 if(!m.rows.has(node.id)){
  const rows=new Map();for(const row of node.combos??[]){const k=key(row.combo);if(rows.has(k))throw Error('完整策略节点含重复私牌组合。');rows.set(k,row);}m.rows.set(node.id,rows);
 }
 const row=m.rows.get(node.id).get(key(text(hand)));
 if(row&&!m.validatedRows.has(row)){
  if(!Array.isArray(row.probabilities)||row.probabilities.length!==node.actions.length||row.probabilities.some(p=>!finite(p)||p<0||p>1)||Math.abs(row.probabilities.reduce((s,p)=>s+p,0)-1)>1e-6)throw Error('完整策略的组合行动概率缺失、无效或未归一。');
  m.validatedRows.add(row);
 }
 return row;
}
function walk(m,route=[]){
 if(!Array.isArray(route)||route.length>150)throw Error('练习起点路径格式无效。');
 let node=m.byId.get('n0');const history=[];
 for(const id of route){const action=node.actions?.find(a=>a.id===id);if(!action||!m.byId.has(action.childId))throw Error('练习起点不在这份完整策略树中。');history.push({node,action});node=m.byId.get(action.childId);}
 return {node,history};
}
function random(state){let x=state.randomState>>>0;x^=x<<13;x^=x>>>17;x^=x<<5;state.randomState=x>>>0;return (state.randomState+.5)/4294967296;}
function draw(weights,state){const sum=weights.reduce((s,w)=>s+w,0);if(!(sum>0)||weights.some(w=>!finite(w)||w<0))throw Error('参考策略概率无效。');let u=random(state)*sum;for(let i=0;i<weights.length;i++){u-=weights[i];if(u<0)return i;}return weights.length-1;}

/** Each player's past action likelihood multiplies that player's prior.
 * All private hands are then drawn independently and the ENTIRE joint draw is
 * rejected on any collision. This is not sequentially renormalized dealing. */
function samplePrivateHands(scenario,result,m,origin,heroSeat,focusCombo,state){
 const rootBoard=cards(scenario.board),known=cards(origin.node.board||scenario.board),focus=focusCombo?key(focusCombo):null;
 const candidates=scenario.players.map((p,seat)=>{
  const ownHistory=origin.history.filter(h=>h.node.actor===seat);
  const values=range(p.range,rootBoard).live.filter(c=>!c.cards.some(card=>known.includes(card))&&(!focus||seat!==heroSeat||key(c.label)===focus)).map(c=>{
   let logWeight=Math.log(c.weight);for(const {node,action} of ownHistory){const row=rowFor(m,node,c.cards);if(!row)throw Error('历史节点缺少合法私牌的完整策略，不能把缺失数据当成零概率剔除。');const index=node.actions.findIndex(a=>a.id===action.id),probability=row.probabilities[index];if(!(probability>0))return null;logWeight+=Math.log(probability);}return {...c,logWeight};
  }).filter(Boolean);
  if(!values.length)throw Error(`${p.position||p.name} 在指定历史和已知牌条件下没有正到达组合；请换起点或手牌。`);
  const max=Math.max(...values.map(c=>c.logWeight));values.forEach(c=>{c.sampleWeight=Math.exp(c.logWeight-max);});return values;
 });
 const weights=candidates.map(items=>items.map(c=>c.sampleWeight));
 for(let attempt=0;attempt<100000;attempt++){
  const used=new Set(known),hands=[];let valid=true;
  for(let p=0;p<candidates.length;p++){const hand=candidates[p][draw(weights[p],state)].cards;if(hand.some(c=>used.has(c))){valid=false;break;}hands.push([...hand]);hand.forEach(c=>used.add(c));}
  if(valid)return hands;
 }
 throw Error('这些范围在当前历史下严重互相阻断，未能在抽牌预算内获得合法联合发牌；没有改用偏置抽牌。');
}
function qualityOf(result){
 const residual=result.diagnostics?.optimizationResidualPctPot??result.diagnostics?.nashConvPctPot??null,target=result.input?.accuracy??null;
 const targetReached=finite(residual)&&finite(target)?residual<=target:null;
 return {mode:'exact',residual,target,targetReached,provisional:targetReached!==true,countsTowardMastery:false,note:'逐决策 EV 条件于可见信息和完整对手范围，沿用参考后续策略；全局残差不是每个组合的误差上界。'};
}
function checkedSession(session,result){
 if(session?.schemaVersion!==PLAY_SESSION_VERSION||session.kind!=='play-session')throw Error('连续练习记录格式无效。');
 // Verify at the public operation boundary. Inner traversal reuses the same
 // verified model; an in-place policy/EV edit must not bypass a WeakMap cache.
 const m=model(result,true);if(session.sourceFingerprint!==m.fingerprint)throw Error('参考策略已经改变，不能继续用旧发牌状态评分。请新建一轮练习。');
 assertSolutionScenario(session.scenario,result);return m;
}
function historyEntry(node,action,scenario,path,extra={}){
 const dealing=node.chance===true||node.actor===-2;
 return {type:dealing?'deal':action.type,actorSeat:dealing?null:node.actor,actorName:dealing?'发牌':scenario.players[node.actor].name,label:action.label||action.id,amount:action.amount??0,to:action.to??0,board:node.board||scenario.board,actionId:action.id,path:[...path],...extra};
}
function follow(session,node,action,extra={}){
 session.history.push(historyEntry(node,action,session.scenario,session.path,extra));session.path.push(action.id);session.currentNodeId=action.childId;
}
function warnReference(session,node,reason){
 session.referenceWarnings??=[];
 if(!session.referenceWarnings.some(w=>w.nodeId===node.id&&w.reason===reason))session.referenceWarnings.push({nodeId:node.id,path:[...session.path],board:node.board??session.scenario.board,actorSeat:node.actor,reason,note:'此后沿用导出的固定参考策略；零到达分支的行为不应被当成稳定的均衡续打。'});
}
function locked(result,node,row,hand){
 if(row?.locked===true)return true;
 return (result.input?.locks??[]).some(l=>{if(l.nodeId!==node.id&&l.node!==Number(node.id.slice(1)))return false;if(l.combo===undefined||l.combo===null||l.combo===-1)return true;try{return key(l.combo)===key(text(hand));}catch{return false;}});
}

/** Terminal settlement keeps uncalled refunds separate from contested pots. */
function settle(session,node,result){
 const board=cards(node.board||session.scenario.board),alive=session.scenario.players.map((_,i)=>i).filter(i=>!node.folded[i]);
 if(!alive.length)throw Error('终局没有未弃牌玩家。');
 const used=new Set([...board,...session.privateHands.flat()]);
 if(alive.length>1)while(board.length<5){const available=Array.from({length:52},(_,i)=>i).filter(c=>!used.has(c));const card=available[Math.floor(random(session)*available.length)];board.push(card);used.add(card);}
 const contributions=node.contributions.map(Number),fixedRake=fixedCappedRake(session.scenario,Number(session.scenario.pot)).fixedRake,payout=contributions.map(()=>0),refunds=contributions.map(()=>0),pots=[];
 const ranks=alive.length>1?session.privateHands.map(hand=>rankHand([...board,...hand])):null;
 const award=(amount,eligible,label)=>{if(amount<=1e-10)return;if(!eligible.length)throw Error('边池没有合资格玩家。');const best=alive.length===1?null:Math.max(...eligible.map(p=>ranks[p]));const winners=alive.length===1?eligible:eligible.filter(p=>ranks[p]===best);for(const p of winners)payout[p]+=amount/winners.length;pots.push({label,amount,eligible,winners});};
 award(session.scenario.pot-fixedRake,alive,'街起点共同底池');
 let previous=0;for(const cap of [...new Set(contributions.filter(x=>x>0))].sort((a,b)=>a-b)){
  const contributors=contributions.map((x,i)=>x>=cap-1e-8?i:-1).filter(i=>i>=0),amount=(cap-previous)*contributors.length;previous=cap;
  if(contributors.length===1){refunds[contributors[0]]+=amount;payout[contributors[0]]+=amount;}
  else award(amount,contributors.filter(i=>!node.folded[i]),pots.length?'后续投入形成的底池':'底池');
 }
 const rootNet=payout.map((x,i)=>x-contributions[i]),net=payout.map((x,i)=>x-(contributions[i]-session.startContributions[i]));
 if(Math.abs(rootNet.reduce((s,x)=>s+x,0)-(session.scenario.pot-fixedRake))>1e-5)throw Error('模拟终局筹码没有守恒。');
 return {kind:'simulated-terminal',board:text(board),showdown:alive.length>1,heroNet:net[session.source.heroSeat],origin:'本次练习起点之后的实际模拟收支；已在起点投入的筹码视为沉没成本。',payout,net,uncalledRefunds:refunds,pots,fixedRake,players:session.scenario.players.map((p,i)=>({seat:i,name:p.name,position:p.position,folded:node.folded[i],cards:i===session.source.heroSeat||alive.length>1&&!node.folded[i]?text(session.privateHands[i]):null,net:net[i]})),note:'这是一组随机私牌与公共牌下的模拟结果，不用于判定决策正确，也不用于估计实战胜率。'};
}
function progress(session,result,now){
 const m=model(result);
 for(let guard=0;guard<250;guard++){
  const node=m.byId.get(session.currentNodeId);if(!node)throw Error('策略后续节点缺失。');
  if(node.terminal||node.actor===-1){session.status='complete';session.completedAt=timestamp(now);session.decision=null;session.outcome=settle(session,node,result);return;}
  if(node.chance||node.actor===-2){
   if(node.outOfScope)throw Error('连续练习不能进入没有导出策略的未来街。');
   const board=cards(node.board||session.scenario.board),used=new Set([...board,...session.privateHands.flat()]),legal=node.actions.filter(a=>Number.isInteger(a.card)&&a.card>=0&&a.card<52&&!used.has(a.card));
   if(legal.length!==52-used.size||new Set(legal.map(a=>a.card)).size!==legal.length)throw Error('未来公共牌分支不完整或重复，不能进行无偏连续练习。');
   const action=legal[Math.floor(random(session)*legal.length)],child=m.byId.get(action.childId);if(!child||cards(child.board).join(',')!==[...board,action.card].join(','))throw Error('发牌动作与后续节点公共牌不一致。');follow(session,node,action);continue;
  }
  const hand=session.privateHands[node.actor],row=rowFor(m,node,hand);if(!row?.probabilities||row.probabilities.length!==node.actions.length)throw Error('该合法私牌缺少对手后续策略。');
  if(node.actor===session.source.heroSeat&&!locked(result,node,row,hand)){
   session.decision={id:crypto.randomUUID(),nodeId:node.id,path:[...session.path],actorSeat:node.actor,startedAt:timestamp(now),timeBudgetSeconds:session.timeBudgetSeconds,reportedExposure:node.id===session.source.startingNodeId?(session.source.reportedExposure??'unknown'):'unknown'};return;
  }
  if(!(finite(row.counterfactualReach)&&row.counterfactualReach>0)){
   // On an observed reference path the sampled legal hand must have positive
   // counterfactual mass. Treat a violation as bad source data, never as a
   // hidden-card-dependent reason to change the student's feedback quality.
   if(!session.referenceWarnings?.length)throw Error('正到达参考路径出现缺失或零反事实到达的自动策略，源结果不一致；未生成依赖抽中对手底牌的评分。');
   warnReference(session,node,'zero-or-missing-opponent-counterfactual-reach');
  }
  const action=node.actions[draw(row.probabilities,session)];follow(session,node,action,{constrained:node.actor===session.source.heroSeat});
 }
 throw Error('连续练习超过最大行动深度，请核对策略树。');
}
export function createPlaySession(scenario,result,options={},context={}){
 assertSolutionScenario(scenario,result);const m=model(result,true),heroSeat=Number(options.heroSeat??scenario.heroSeat??0);
 if(!Number.isInteger(heroSeat)||heroSeat<0||heroSeat>=scenario.players.length)throw Error('请选择合法的练习位置。');
 const startingPath=options.startingPath??[],origin=walk(m,startingPath);
 if(origin.node.terminal||origin.node.actor<0)throw Error('请选择真实玩家决策作为练习起点。');
 if(origin.node.folded?.[heroSeat]||scenario.players[heroSeat].stack-(origin.node.contributions?.[heroSeat]??0)<=0)throw Error('所选玩家在练习起点已弃牌或没有可用筹码。');
 if(!(origin.node.reach>0))throw Error('练习起点在参考策略下没有正到达概率，不能伪造条件发牌。');
 const feedbackMode=options.feedbackMode??'end';if(!['end','immediate'].includes(feedbackMode))throw Error('反馈模式无效。');
 const reportedExposure=options.reportedExposure??'unknown';if(!['unseen','seen','unknown'].includes(reportedExposure))throw Error('此前是否看过策略需为 unseen、seen 或 unknown；该记录仅为自报，不是未经提示的能力认证。');
 const timeBudgetSeconds=options.timeBudgetSeconds??null;if(timeBudgetSeconds!==null&&(!finite(timeBudgetSeconds)||timeBudgetSeconds<5||timeBudgetSeconds>600))throw Error('思考计时需为 5–600 秒，或关闭。');
 const now=context.now??Date.now(),id=context.id??crypto.randomUUID();
 const session={schemaVersion:PLAY_SESSION_VERSION,kind:'play-session',id,status:'playing',revision:0,createdAt:timestamp(now),updatedAt:timestamp(now),source:{jobId:String(options.jobId??''),title:scenario.title||'私人模型连续练习',engine:result.engine,startingPath:[...startingPath],heroSeat,quality:qualityOf(result),focusCombo:options.focusCombo?text(cards(options.focusCombo,[2])):'',projectId:options.projectId??null},sourceFingerprint:m.fingerprint,scenario:copy(scenario),feedbackMode,timeBudgetSeconds,plan:planOf(options.plan),parentId:options.parentId??null,randomState:(context.seed??crypto.randomBytes(4).readUInt32LE(0))>>>0||1,privateHands:null,currentNodeId:origin.node.id,path:[...startingPath],startContributions:[...(origin.node.contributions??scenario.players.map(()=>0))],history:origin.history.map(({node,action},i)=>historyEntry(node,action,scenario,startingPath.slice(0,i),{beforePractice:true})),decisions:[],decision:null};
 Object.assign(session.source,{startingNodeId:origin.node.id,reportedExposure,exposureEvidence:'self-report'});
 session.referenceWarnings=[];session.planHistory=Object.values(session.plan).some(Boolean)?[{createdAt:timestamp(now),nodeId:origin.node.id,board:origin.node.board,plan:copy(session.plan)}]:[];
 session.privateHands=samplePrivateHands(scenario,result,m,origin,heroSeat,options.focusCombo,session);progress(session,result,now);session.summary=summarizePlaySession(session);return session;
}
export function advancePlaySession(original,result,answer={},context={}){
 const m=checkedSession(original,result);if(original.status!=='playing'||!original.decision)throw Error('这轮练习已经结束。');
 if(answer.decisionId!==original.decision.id)throw Error('决策已更新，请恢复当前练习后再选择；没有重复记录这个动作。');
 if(!finite(answer.confidence)||answer.confidence<0||answer.confidence>100)throw Error('信心需为 0–100。');
 const session=copy(original),node=m.byId.get(session.currentNodeId),index=node.actions.findIndex(a=>a.id===answer.actionId);if(index<0)throw Error('该动作不在当前策略树内。');
 const now=context.now??Date.now(),hand=session.privateHands[session.source.heroSeat],row=rowFor(m,node,hand),action=node.actions[index],actionEV=row?.actionEV;
 const scoreable=Array.isArray(actionEV)&&actionEV.length===node.actions.length&&actionEV.every(finite)&&finite(row.counterfactualReach)&&row.counterfactualReach>0;
 const selectedReferenceProbability=row?.probabilities?.[index]??null,offReference=(session.referenceWarnings?.length??0)>0||row?.reach===0;
 const child=m.byId.get(action.childId);if(!child)throw Error('策略后续节点缺失。');
 const entersZeroFrequencyContinuation=selectedReferenceProbability===0&&!child.terminal&&child.actor!==-1;
 const elapsedMs=Math.max(0,now-Date.parse(session.decision.startedAt)),best=scoreable?Math.max(...actionEV):null,loss=scoreable?Math.max(0,best-actionEV[index]):null;
 const feedback=scoreable?{loss,lossUnit:'BB',selectedEV:actionEV[index],bestEV:best,acceptedActions:node.actions.filter((_,i)=>best-actionEV[i]<=.02).map(a=>a.id),evTolerance:.02,actions:node.actions.map((a,i)=>({id:a.id,label:a.label,ev:actionEV[i],frequency:row.probabilities[i]})),referenceKind:offReference?'off-reference-fixed-continuation':'fixed-reference-continuation',quality:{...session.source.quality,...(offReference?{provisional:true}:{})},selectedReferenceProbability,observedReach:row.reach,counterfactualReach:row.counterfactualReach,note:offReference?'该动作或此前路径在参考中零频，后续可能包含零反事实到达的响应。数值仍是导出固定策略下的条件 EV，不是稳定均衡续打或逐节点精度保证；不使用本轮抽中的对手底牌评分。':'以当时可见信息和完整对手范围评分，不使用本轮抽中的对手底牌。假定此动作后的自己与对手均沿用参考策略。'}:{loss:null,quality:{...session.source.quality,provisional:true},referenceKind:'unavailable',selectedReferenceProbability,note:'这个反事实路径没有足够的可核验条件 EV，不生成伪分数。'};
 if(entersZeroFrequencyContinuation)feedback.nextContinuationWarning={reason:'hero-selected-zero-reference-action',childNodeId:child.id,note:'本次动作在该手牌参考策略中为零频。当前评分仍是固定策略条件对照；此后沿导出策略继续，并将后续决策标为探索，不能当作针对新分配重新求解的均衡续打。'};
 if(answer.plan!==undefined){const nextPlan=planOf(answer.plan);if(JSON.stringify(nextPlan)!==JSON.stringify(session.plan)){session.planHistory??=[];session.planHistory.push({createdAt:timestamp(now),nodeId:node.id,board:node.board,plan:copy(nextPlan)});}session.plan=nextPlan;}
 session.decisions.push({...session.decision,createdAt:timestamp(now),board:node.board||session.scenario.board,heroCombo:text(hand),actionId:action.id,actionLabel:action.label,confidence:answer.confidence,reason:cleanText(answer.reason,5000),planAtDecision:copy(session.plan),elapsedMs,late:session.timeBudgetSeconds!==null&&elapsedMs>session.timeBudgetSeconds*1000,answeredAt:timestamp(now),feedback});
 if(entersZeroFrequencyContinuation)warnReference(session,node,'hero-selected-zero-reference-action');
 session.decision=null;follow(session,node,action,{heroDecision:true});progress(session,result,now);session.updatedAt=timestamp(now);session.revision++;session.summary=summarizePlaySession(session);return session;
}
export function finishPlaySession(original,result,context={}){
 checkedSession(original,result);if(original.status!=='playing')return copy(original);const session=copy(original);session.status='abandoned';session.decision=null;session.updatedAt=timestamp(context.now);session.revision++;session.summary=summarizePlaySession(session);return session;
}
export function summarizePlaySession(session){
 const scored=session.decisions.filter(d=>finite(d.feedback?.loss));return {decisions:session.decisions.length,scoredDecisions:scored.length,highConfidenceErrors:scored.filter(d=>d.feedback.loss>(d.feedback.evTolerance??.02)&&d.confidence>=80).length,maxLocalLoss:scored.length?Math.max(...scored.map(d=>d.feedback.loss)):null,meanLocalLoss:scored.length?scored.reduce((s,d)=>s+d.feedback.loss,0)/scored.length:null,lateDecisions:session.decisions.filter(d=>d.late).length,complete:session.status==='complete',countsTowardMastery:false,interpretation:'每项损失是固定参考后续策略下的局部决策对照。均值是练习描述，不能把这些损失相加当作整局策略损失，也不能换算为实战 bb/100。'};
}
export function publicPlaySession(session,result){
 const m=checkedSession(session,result),node=m.byId.get(session.currentNodeId),heroSeat=session.source.heroSeat,done=session.status!=='playing',board=done&&session.outcome?session.outcome.board:node.board||session.scenario.board;
 const view={id:session.id,kind:session.kind,status:session.status,revision:session.revision,source:copy(session.source),createdAt:session.createdAt,updatedAt:session.updatedAt,completedAt:session.completedAt??null,parentId:session.parentId,feedbackMode:session.feedbackMode,timeBudgetSeconds:session.timeBudgetSeconds,hero:{seat:heroSeat,combo:text(session.privateHands[heroSeat])},board,street:({3:'flop',4:'turn',5:'river'})[cards(board).length],pot:node.pot,toCall:node.toCall,players:session.scenario.players.map((p,i)=>({id:p.id,name:p.name,position:p.position,startingStack:p.stack,range:p.range,remaining:Math.max(0,p.stack-(node.contributions?.[i]??0)),contributed:node.contributions?.[i]??0,streetContributed:node.streetContributions?.[i]??0,folded:node.folded?.[i]??false,hero:i===heroSeat})),history:copy(session.history),plan:copy(session.plan),decision:session.decision?{...copy(session.decision),board:node.board||session.scenario.board,street:node.street,toCall:node.toCall,actions:node.actions.map(({id,label,type,amount,to,allIn})=>({id,label,type,amount,to,allIn:!!allIn}))}:null};
 if(done){view.summary=copy(session.summary);view.review={decisions:copy(session.decisions),outcome:copy(session.outcome??null),plan:copy(session.plan),planHistory:copy(session.planHistory??[]),referenceWarnings:copy(session.referenceWarnings??[]),interpretation:session.summary.interpretation};}
 else{view.progress={answered:session.decisions.length};if(session.feedbackMode==='immediate'&&session.decisions.length)view.lastFeedback=copy(session.decisions.at(-1));}
 return view;
}
