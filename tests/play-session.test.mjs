import test from 'node:test';
import assert from 'node:assert/strict';
import {cards,range} from '../lib/poker.mjs';
import {solveRiverGame,prepareRiverGame} from '../lib/river-engine.mjs';
import {solveTurnGame,prepareTurnGame} from '../lib/turn-engine.mjs';
import {solveHUPostflop} from '../lib/hu-postflop.mjs';
import {evaluateHUPolicy} from '../lib/hu-policy-evaluation.mjs';
import {createPlaySession,advancePlaySession,finishPlaySession,publicPlaySession} from '../lib/play-session.mjs';
const scene=(board='2c3d7h9sJc')=>({title:'Continuous training integrity',unit:'BB',board,pot:12,toAct:0,heroSeat:0,hero:'AsAh',rake:0,rakeCap:0,players:[{id:'a',name:'Hero',position:'BB',stack:20,range:'AsAh:0.3,AcKc:0.7'},{id:'b',name:'Opponent',position:'BTN',stack:20,range:'AsKd:0.4,QcQd:0.6'}]});
const simple=s=>({...s,sizes:[],raiseSizes:[],riverSizes:[],riverRaiseSizes:[],allIn:false,maxRaises:0,riverMaxRaises:0,iterations:2,averagingDelay:0,accuracy:.1,maxNodes:10000});
const solve=async s=>s.board.length===8?solveTurnGame(simple(s)):solveRiverGame(simple(s));
const pick=(s,r,actionId='check',extra={})=>advancePlaySession(s,r,{decisionId:s.decision.id,actionId,confidence:80,...extra},{now:Date.parse(s.updatedAt)+1000});

test('private joint dealing follows weighted collision-conditioned priors, not sequential renormalization',async()=>{
 const s=scene(),r=await solve(s),counts=new Map(),n=16000;
 for(let i=0;i<n;i++){const session=createPlaySession(s,r,{jobId:'test'},{seed:Math.imul(i+1,2654435761)>>>0}),k=session.privateHands.map(h=>h.sort((a,b)=>a-b).join(',')).join('|');counts.set(k,(counts.get(k)||0)+1);}
 const rs=s.players.map(p=>range(p.range,cards(s.board)).live),expected=[];let mass=0;
 for(const a of rs[0])for(const b of rs[1])if(!a.cards.some(c=>b.cards.includes(c))){const w=a.weight*b.weight;mass+=w;expected.push({k:[a,b].map(c=>c.cards.join(',')).join('|'),w});}
 assert.equal(counts.size,expected.length);for(const {k,w} of expected)assert.ok(Math.abs((counts.get(k)||0)/n-w/mass)<.02,`${k} distribution mismatch`);
});

test('blind public state hides private dealing, future streets and strategy answers until submission/finish',async()=>{
 const s=scene('2c3d7h9s'),r=await solve(s);let session=createPlaySession(s,r,{jobId:'test',focusCombo:'AsAh'},{seed:19});let view=publicPlaySession(session,r);
 assert.equal(view.board.length,8);assert.equal(view.hero.combo,'AhAs');assert.equal(view.review,undefined);assert.equal(view.sourceFingerprint,undefined);assert.equal(view.randomState,undefined);assert.equal(view.privateHands,undefined);assert.equal(view.summary,undefined);
 assert.ok(view.decision.actions.every(a=>a.ev===undefined&&a.frequency===undefined));assert.equal(view.source.quality.mode,'exact');
 session=pick(session,r);view=publicPlaySession(session,r);assert.equal(view.board.length,10);assert.equal(view.review,undefined);assert.equal(view.lastFeedback,undefined);
 const fullCards=[...cards(view.board),...session.privateHands.flat()];assert.equal(new Set(fullCards).size,fullCards.length);
 session=pick(session,r);view=publicPlaySession(session,r);assert.equal(view.status,'complete');assert.equal(view.review.decisions.length,2);assert.ok(view.review.decisions.every(d=>d.feedback.loss===0));assert.equal(view.review.outcome.showdown,true);
 assert.ok(Math.abs(view.review.outcome.net.reduce((a,b)=>a+b,0)-12)<1e-8);assert.equal(view.review.outcome.players.filter(p=>p.cards).length,2);
});

test('scores depend on information-set EV, not the particular hidden opponent hand drawn',async()=>{
 const s=scene(),r=await solveRiverGame({...simple(s),sizes:[50],allIn:true,iterations:300}),seen=new Map();
 for(let seed=1;seed<100&&seen.size<2;seed++){const session=createPlaySession(s,r,{focusCombo:'AcKc'},{seed:Math.imul(seed,2654435761)>>>0});const next=pick(session,r,'check');seen.set(session.privateHands[1].join(','),next.decisions[0].feedback);}
 assert.equal(seen.size,2);const values=[...seen.values()];assert.deepEqual(values[0].actions,values[1].actions);assert.equal(values[0].selectedEV,values[1].selectedEV);assert.equal(values[0].loss,values[1].loss);
});

test('starting at a later node conditions each prior on historical actions and public cards',async()=>{
 const s=scene('2c3d7h9s'),r=await solve(s),chance=r.nodes.find(n=>n.chance),river=chance.actions.find(a=>a.label==='Tc'),path=['check','check',river.id];
 const session=createPlaySession(s,r,{startingPath:path,focusCombo:'AsAh'},{seed:18}),view=publicPlaySession(session,r);
 assert.equal(view.board,'2c3d7h9sTc');assert.deepEqual(view.source.startingPath,path);assert.ok(view.history.every(h=>h.beforePractice));assert.ok(session.privateHands.flat().every(c=>!cards(view.board).includes(c)));
 assert.throws(()=>createPlaySession(s,r,{startingPath:['not-in-tree']}),/起点/);
 assert.throws(()=>createPlaySession(s,r,{startingPath:path,focusCombo:'TcTd'}),/没有正到达/);
});

test('timeouts record elapsed time without changing choices; plans retain their predecision versions',async()=>{
 const s=scene('2c3d7h9s'),r=await solve(s),start=Date.parse('2026-09-28T04:00:00Z');let session=createPlaySession(s,r,{timeBudgetSeconds:5,plan:{changeTriggers:'First plan'}},{now:start,seed:17});
 const stale=session.decision.id;session=advancePlaySession(session,r,{decisionId:stale,actionId:'check',confidence:60,plan:{changeTriggers:'Revised before turn action'}},{now:start+8000});
 assert.equal(session.decisions[0].actionId,'check');assert.equal(session.decisions[0].late,true);assert.equal(session.decisions[0].elapsedMs,8000);assert.equal(session.planHistory.length,2);assert.equal(session.planHistory[0].plan.changeTriggers,'First plan');
 assert.throws(()=>advancePlaySession(session,r,{decisionId:stale,actionId:'check',confidence:70}),/决策已更新/);assert.equal(session.decisions.length,1);
 session=finishPlaySession(session,r,{now:start+12000});assert.equal(session.status,'abandoned');assert.equal(session.summary.complete,false);assert.equal(publicPlaySession(session,r).review.outcome,null);
});

test('strategy replacement or incomplete export cannot silently continue an existing hand',async()=>{
 const s=scene(),r=await solve(s),session=createPlaySession(s,r,{}, {seed:2}),changed=structuredClone(r);changed.nodes[0].combos[0].probabilities[0]=.5;
 assert.throws(()=>publicPlaySession(session,changed),/参考策略已经改变/);
 assert.throws(()=>createPlaySession(s,{...r,outputScope:'current-street'}),/只导出/);
 assert.throws(()=>createPlaySession(s,{...r,chance:{exact:false}}),/机会枚举/);
});

test('all-in before the river draws a legal runout and conserves unequal stacks and refunds',async()=>{
 const s=scene('2c3d7h9s');s.players[0].range='AsAh';s.players[1].range='KcKd';s.players[0].stack=8;s.players[1].stack=20;
 const input={...simple(s),sizes:[100],allIn:true,iterations:100},p=prepareTurnGame(input),locks=p.nodes.filter(n=>n.actor===1).map(n=>({nodeId:n.id,probabilities:n.actions.map(a=>a.id==='call'||a.id==='check'?1:0)})).filter(l=>l.probabilities.reduce((a,b)=>a+b,0)===1),r=await solveTurnGame({...input,locks});
 let session=createPlaySession(s,r,{}, {seed:727});const allIn=r.nodes[0].actions.find(a=>a.allIn);assert.ok(allIn);session=pick(session,r,allIn.id);
 assert.equal(session.status,'complete');assert.equal(session.outcome.board.length,10);assert.equal(new Set([...cards(session.outcome.board),...session.privateHands.flat()]).size,9);assert.ok(Math.abs(session.outcome.net.reduce((a,b)=>a+b,0)-12)<1e-8);assert.equal(session.outcome.players[1].net>=-8,true);
});

test('a terminal fold does not expose the winning opponent private cards',async()=>{
 const s=scene(),input={...simple(s),sizes:[50],allIn:false,iterations:200},p=prepareRiverGame(input),root=p.nodes[0],bet=root.actions.find(a=>a.type==='bet'),r=await solveRiverGame({...input,locks:[{nodeId:'n0',probabilities:root.actions.map(a=>a.id===bet.id?1:0)}]});
 let session=createPlaySession(s,r,{heroSeat:1},{seed:11});assert.equal(session.decision.actorSeat,1);session=pick(session,r,'fold');const view=publicPlaySession(session,r);
 assert.equal(view.review.outcome.showdown,false);assert.equal(view.review.outcome.players[0].cards,null);assert.ok(view.review.outcome.players[1].cards);assert.equal(view.review.decisions[0].feedback.selectedEV,0);
});

test('in-place strategy edits cannot pass a cached session fingerprint',async()=>{
 const s=scene(),r=await solve(s),session=createPlaySession(s,r,{}, {seed:2});r.nodes[0].combos[0].actionEV[0]+=5;
 assert.throws(()=>publicPlaySession(session,r),/参考策略已经改变/);
});

test('a zero-reference nonterminal choice flags future continuation separately from the current fixed-policy comparison',async()=>{
 const s=scene(),r=await solveRiverGame({...simple(s),sizes:[50],allIn:false,iterations:2});
 // This is a valid complete fixed policy. All Hero root hands check; after a
 // Hero bet, Villain folds. The user may still select the legal zero-prob bet.
 const root=r.nodes[0],bet=root.actions.find(a=>a.type==='bet');for(const row of root.combos)row.probabilities=root.actions.map(a=>a.id==='check'?1:0);
 const reply=r.nodes.find(n=>n.id===bet.childId);for(const row of reply.combos)row.probabilities=reply.actions.map(a=>a.id==='fold'?1:0);
 // Recompute values/reaches for this fixed policy so no stale EV is used.
 const locks=r.nodes.filter(n=>n.actor>=0).flatMap(n=>n.combos.map(c=>({nodeId:n.id,combo:c.combo,probabilities:c.probabilities}))),evaluated=await solveRiverGame({...r.input,evaluationOnly:true,locks,iterations:1,averagingDelay:0});
 evaluated.input={...r.input,locks:[]};for(const n of evaluated.nodes)for(const c of n.combos??[])c.locked=false;
 let session=createPlaySession(s,evaluated,{feedbackMode:'end',focusCombo:'AcKc'},{seed:100}),before=publicPlaySession(session,evaluated);assert.equal(before.referenceWarnings,undefined);
 session=pick(session,evaluated,bet.id);const feedback=session.decisions[0].feedback;assert.equal(feedback.referenceKind,'fixed-reference-continuation');assert.equal(feedback.quality.provisional,session.source.quality.provisional);assert.ok(Number.isFinite(feedback.loss));assert.equal(feedback.selectedReferenceProbability,0);assert.equal(feedback.nextContinuationWarning.reason,'hero-selected-zero-reference-action');
 const view=publicPlaySession(session,evaluated);assert.ok(view.review.referenceWarnings.length>0);assert.equal(view.review.outcome.players[1].cards,null);
});

test('later-node dealing includes mixed action likelihoods and private-card collision conditioning',async()=>{
 const s=scene(),input={...simple(s),sizes:[50]},p=prepareRiverGame(input),root=p.nodes[0],bet=root.actions.find(a=>a.type==='bet');
 const locks=[['AsAh',.9],['AcKc',.1]].map(([combo,probability])=>({nodeId:'n0',combo,probabilities:root.actions.map(a=>a.id===bet.id?probability:1-probability)}));
 const r=await solveRiverGame({...input,locks}),counts=new Map(),n=8000;
 for(let i=0;i<n;i++){
  const session=createPlaySession(s,r,{startingPath:[bet.id],heroSeat:1},{seed:Math.imul(i+1,2654435761)>>>0});
  const k=session.privateHands.map(h=>h.join(',')).join('|');counts.set(k,(counts.get(k)||0)+1);
 }
 const combos=s.players.map(p=>range(p.range,cards(s.board)).live),expected=[];let total=0;
 for(const a of combos[0])for(const b of combos[1])if(!a.cards.some(c=>b.cards.includes(c))){
  const likelihood=a.cards.includes(cards('As')[0])?.9:.1,w=a.weight*b.weight*likelihood;total+=w;expected.push({key:[a,b].map(c=>c.cards.join(',')).join('|'),w});
 }
 assert.equal(counts.size,3);for(const item of expected)assert.ok(Math.abs(counts.get(item.key)/n-item.w/total)<.02,`posterior mismatch for ${item.key}`);
 // With AsKd fixed, AsAh is blocked even though it bets nine times as often.
 for(let i=1;i<=20;i++){const session=createPlaySession(s,r,{startingPath:[bet.id],heroSeat:1,focusCombo:'AsKd'},{seed:i});assert.deepEqual(session.privateHands[0],cards('AcKc').sort((a,b)=>a-b));}
 const incomplete=structuredClone(r);incomplete.nodes[0].combos.pop();
 assert.throws(()=>createPlaySession(s,incomplete,{startingPath:[bet.id],heroSeat:1}),/历史节点缺少合法私牌/);
});

test('four-player turn continuation retains folded dead cards and hides all unshown private hands',async()=>{
 const s={...scene('2c3d7h9s'),players:['AsAh,AcAd','KcKd,KhKs','QcQd,QhQs','JdJh,JcJs'].map((range,i)=>({id:String(i),name:`Player ${i}`,position:['SB','BB','CO','BTN'][i],range,stack:12}))};
 const input={...simple(s),sizes:[50],riverSizes:[50],maxNodes:50000},p=prepareTurnGame(input),locks=p.nodes.filter(n=>n.actor>0).map(n=>{
  const id=n.toCall>0?(n.actor===1&&n.street==='turn'?'fold':'call'):'check';return {nodeId:n.id,probabilities:n.actions.map(a=>a.id===id?1:0)};
 });
 const r=await solveTurnGame({...input,locks});let session=createPlaySession(s,r,{focusCombo:'AsAh'},{seed:17});
 assert.equal(publicPlaySession(session,r).board.length,8);session=pick(session,r,'bet_6');let view=publicPlaySession(session,r);
 assert.equal(view.status,'playing');assert.equal(view.street,'river');assert.equal(view.players[1].folded,true);assert.equal(view.history.filter(h=>h.type==='deal').length,1);
 assert.equal(new Set([...cards(view.board),...session.privateHands.flat()]).size,13);assert.equal(view.review,undefined);assert.equal(view.lastFeedback,undefined);
 assert.ok(view.players.every(p=>p.cards===undefined));session=pick(session,r);view=publicPlaySession(session,r);
 assert.equal(view.status,'complete');assert.equal(view.review.decisions.length,2);assert.equal(view.review.outcome.players[1].cards,null);assert.equal(view.review.outcome.players.filter(p=>p.cards).length,3);
 assert.ok(Math.abs(view.review.outcome.net.reduce((a,b)=>a+b,0)-12)<1e-8);
});

test('genuine unequal-stack side pots, uncalled refunds and a fixed fee settle without double counting',async()=>{
 const s={...scene(),rake:5,rakeCap:.5,players:['AsAh','KcKd','QcQd'].map((range,i)=>({id:String(i),name:`Player ${i}`,position:['SB','BB','BTN'][i],range,stack:i?20:5}))};
 const input={...simple(s),sizes:[50],raiseSizes:[50],allIn:true,maxRaises:1},p=prepareRiverGame(input),root=p.nodes[0],bet=root.actions.find(a=>a.id==='bet_5'),reply=p.nodes.find(n=>n.id===bet.childId),raise=reply.actions.find(a=>a.id==='raise_16');assert.ok(raise);
 for(const lastAction of ['call','fold']){
  const last=p.nodes.find(n=>n.id===raise.childId),locks=[{nodeId:reply.id,actions:{[raise.id]:1}},{nodeId:last.id,actions:{[lastAction]:1}}],r=await solveRiverGame({...input,locks});
  let session=createPlaySession(s,r,{}, {seed:12});session=pick(session,r,bet.id);const out=publicPlaySession(session,r).review.outcome;
  assert.equal(session.status,'complete');assert.equal(out.fixedRake,.5);assert.ok(Math.abs(out.net.reduce((a,b)=>a+b,0)-11.5)<1e-8);
  if(lastAction==='call'){assert.deepEqual(out.net,[21.5,6,-16]);assert.deepEqual(out.uncalledRefunds,[0,0,0]);assert.deepEqual(out.pots.map(p=>p.amount),[11.5,15,22]);}
  else{assert.deepEqual(out.net,[16.5,-5,0]);assert.deepEqual(out.uncalledRefunds,[0,11,0]);assert.equal(out.players[2].cards,null);}
 }
});

test('a practice start after betting treats earlier contributions as sunk cost for fold and terminal cashflow',async()=>{
 const s=scene(),input={...simple(s),sizes:[50],raiseSizes:[50],maxRaises:1},p=prepareRiverGame(input),root=p.nodes[0],bet=root.actions.find(a=>a.id==='bet_6'),reply=p.nodes.find(n=>n.id===bet.childId),raise=reply.actions.find(a=>a.id==='raise_18');assert.ok(raise);
 const r=await solveRiverGame({...input,locks:[{nodeId:root.id,actions:{[bet.id]:1}},{nodeId:reply.id,actions:{[raise.id]:1}}]});
 let session=createPlaySession(s,r,{startingPath:[bet.id,raise.id],heroSeat:0},{seed:211});assert.deepEqual(session.startContributions,[6,18]);session=pick(session,r,'fold');
 const review=publicPlaySession(session,r).review;assert.equal(review.decisions[0].feedback.selectedEV,0);assert.equal(review.outcome.heroNet,0);assert.deepEqual(review.outcome.net,[0,36]);assert.deepEqual(review.outcome.uncalledRefunds,[0,12]);
});

test('a complete native HU flop strategy supports three blind decisions with exact legal future cards',async()=>{
 const s=scene('2c3d7h');s.players[0].range='AsAh';s.players[1].range='KcKd';
 const native=await solveHUPostflop({...simple(s),outputScope:'full',maxNodes:50000,algorithm:'dcfr',threads:2}),r=evaluateHUPolicy(native);let session=createPlaySession(s,r,{}, {seed:1221});
 for(const street of ['flop','turn','river']){const view=publicPlaySession(session,r);assert.equal(view.street,street);assert.equal(view.review,undefined);assert.ok(view.decision.actions.every(a=>a.ev===undefined&&a.frequency===undefined));session=pick(session,r);}
 const review=publicPlaySession(session,r).review;assert.equal(session.status,'complete');assert.equal(review.decisions.length,3);assert.ok(review.decisions.every(d=>d.feedback.loss===0));assert.equal(new Set([...cards(review.outcome.board),...session.privateHands.flat()]).size,9);assert.equal(review.outcome.net.reduce((a,b)=>a+b,0),12);
});

test('self-reported prior strategy exposure belongs to the starting decision, not unseen future streets',async()=>{
 const s=scene('2c3d7h9s'),r=await solve(s);let session=createPlaySession(s,r,{reportedExposure:'seen'},{seed:171});
 assert.equal(session.source.reportedExposure,'seen');assert.equal(session.source.exposureEvidence,'self-report');assert.equal(publicPlaySession(session,r).decision.reportedExposure,'seen');
 session=pick(session,r);assert.equal(session.decisions[0].reportedExposure,'seen');assert.equal(publicPlaySession(session,r).decision.reportedExposure,'unknown');session=pick(session,r);assert.equal(session.decisions[1].reportedExposure,'unknown');
 const next=createPlaySession(s,r,{parentId:session.id},{seed:171});assert.equal(next.source.reportedExposure,'unknown');assert.equal(next.decision.reportedExposure,'unknown');
 assert.throws(()=>createPlaySession(s,r,{reportedExposure:'certified-unseen'}),/仅为自报/);
});

test('a severely losing zero-frequency terminal fold retains trustworthy correction on a normal reference path',async()=>{
 const s=scene();s.players[0].range='KcKd';s.players[1].range='AsAh';s.heroSeat=1;s.hero='AsAh';
 const input={...simple(s),sizes:[50],iterations:1000,averagingDelay:50,locks:[{nodeId:'n0',actions:{bet_6:1}}]},r=await solveRiverGame(input);
 let session=createPlaySession(s,r,{heroSeat:1},{seed:37});const n=r.nodes.find(n=>n.id===session.decision.nodeId),row=n.combos[0],fold=n.actions.findIndex(a=>a.id==='fold');
 assert.equal(row.probabilities[fold],0);assert.equal(session.source.quality.provisional,false);session=pick(session,r,'fold');const feedback=session.decisions[0].feedback;
 assert.equal(feedback.selectedEV,0);assert.equal(feedback.loss,18);assert.equal(feedback.selectedReferenceProbability,0);assert.equal(feedback.referenceKind,'fixed-reference-continuation');assert.equal(feedback.quality.provisional,false);assert.equal(feedback.nextContinuationWarning,undefined);assert.deepEqual(session.referenceWarnings,[]);
});

test('a real zero-frequency turn bet leaves current comparison intact but makes the later river decision exploratory',async()=>{
 const s=scene('2c3d7h9s');s.players[0].range='KcKd';s.players[1].range='AsAh';s.hero='KcKd';
 const input={...simple(s),sizes:[50],riverSizes:[50],iterations:300,averagingDelay:30},p=prepareTurnGame(input),locks=p.nodes.filter(n=>n.actor===1).map(n=>({nodeId:n.id,actions:{[n.toCall>0?'call':'check']:1}})),r=await solveTurnGame({...input,locks});
 const root=r.nodes[0],bet=root.actions.findIndex(a=>a.id==='bet_6');assert.equal(root.combos[0].probabilities[bet],0);
 let session=createPlaySession(s,r,{feedbackMode:'end'},{seed:217});const sourceProvisional=session.source.quality.provisional;session=pick(session,r,'bet_6');
 assert.equal(session.status,'playing');assert.equal(publicPlaySession(session,r).street,'river');assert.equal(publicPlaySession(session,r).lastFeedback,undefined);
 const first=session.decisions[0].feedback;assert.equal(first.referenceKind,'fixed-reference-continuation');assert.equal(first.quality.provisional,sourceProvisional);assert.equal(first.selectedReferenceProbability,0);assert.equal(first.nextContinuationWarning.childNodeId,root.actions[bet].childId);
 session=pick(session,r,'check');const second=session.decisions[1].feedback;assert.equal(second.referenceKind,'off-reference-fixed-continuation');assert.equal(second.quality.provisional,true);assert.ok(Number.isFinite(second.loss));assert.ok(session.referenceWarnings.length>0);
});

test('missing counterfactual mass on an otherwise positive automatic path is a source error, not hidden-hand-dependent feedback',async()=>{
 const s=scene(),r=await solve(s);for(const node of r.nodes.filter(n=>n.actor===1))for(const row of node.combos)row.counterfactualReach=0;
 const session=createPlaySession(s,r,{}, {seed:171});assert.throws(()=>pick(session,r,'check'),/源结果不一致/);
});
