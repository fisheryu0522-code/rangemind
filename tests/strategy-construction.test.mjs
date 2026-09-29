import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareRiverGame,solveRiverGame} from '../lib/river-engine.mjs';
import {solveTurnGame} from '../lib/turn-engine.mjs';
import {solveHUPostflop} from '../lib/hu-postflop.mjs';
import {evaluateHUPolicy} from '../lib/hu-policy-evaluation.mjs';
import {createRangeConstruction,gradeRangeConstruction,evaluateRangeConstruction} from '../lib/strategy-construction.mjs';
const close=(a,b,t=1e-8)=>assert.ok(Math.abs(a-b)<=t,`${a} != ${b}`);
const base={title:'范围构建数学验证',board:'2c4d6h8sTc',pot:10,hero:'AcAd',heroSeat:0,toAct:0,players:[{id:'h',name:'Hero',position:'BB',range:'AcAd,KcKd',stack:20},{id:'v',name:'Villain',position:'BTN',range:'QcQd,JcJd',stack:20}]};
const settings={sizes:[50],raiseSizes:[50],maxRaises:1,allIn:false,iterations:100,checkEvery:100,threads:1};
const build=async(s=base,x={})=>solveRiverGame({...s,...settings,...x});
const path=(result,ids)=>ids.reduce((n,id)=>result.nodes.find(x=>x.id===n.actions.find(a=>a.id===id).childId),result.nodes[0]);
const answer=(q,select)=>({nodeId:q.source.nodeId,weighting:q.weighting,sourceFingerprint:q.sourceFingerprint,assignments:q.combos.filter(c=>c.editable).map(c=>({combo:c.combo,probabilities:select(c,q.actions)}))});
const deterministic=id=>({[id]:1});

test('public range task has no numerical answers and mixed policy grades by EV instead of frequency imitation',async()=>{
 const s={...base,players:[{...base.players[0],range:'AcAd'},{...base.players[1],range:'KcKd'}]},g=prepareRiverGame({...s,...settings}),locks=g.nodes.filter(n=>n.actor===1).map(n=>({nodeId:n.id,actions:deterministic(n.actions.some(a=>a.id==='fold')?'fold':'check')})),r=await build(s,{locks}),q=createRangeConstruction(s,r).publicQuestion;
 for(const c of q.combos){assert.equal('reference' in c,false);assert.equal('referenceProbabilities' in c,false);assert.equal('actionEV' in c,false);assert.equal('ev' in c,false);}
 assert.equal('acceptedAnswers' in q,false);assert.equal('referenceEV' in q,false);
 const check=gradeRangeConstruction(s,r,answer(q,()=>deterministic('check'))),bet=gradeRangeConstruction(s,r,answer(q,()=>deterministic('bet_5'))),mix=gradeRangeConstruction(s,r,answer(q,()=>({check:.17,bet_5:.83})));
 close(check.metrics.localRegretBB,0);close(bet.metrics.localRegretBB,0);close(mix.metrics.localRegretBB,0);close(check.metrics.rangeEV,10);close(bet.metrics.rangeEV,10);assert.notDeepEqual(check.combos[0].userProbabilities,bet.combos[0].userProbabilities);
 close(mix.actions.reduce((s,a)=>s+a.evContribution,0),mix.metrics.rangeEV);
});

test('joint legal reach, not raw independent range weights, grades the whole multiway range',async()=>{
 const s={...base,players:[{...base.players[0],position:'SB'},{...base.players[1],position:'BB',range:'AcQd,QhQs'},{id:'c',name:'C',position:'BTN',range:'JhJs,TdTh',stack:20}]},r=await build(s,{maxRaises:0}),q=createRangeConstruction(s,r).publicQuestion;
 close(q.combos.find(c=>c.combo==='AcAd').posteriorWeight,1/3);close(q.combos.find(c=>c.combo==='KcKd').posteriorWeight,2/3);
 const a=answer(q,c=>deterministic(c.combo==='AcAd'?'check':'bet_5')),grade=gradeRangeConstruction(s,r,a);
 close(grade.actions.find(a=>a.id==='check').userFrequency,1/3);close(grade.actions.find(a=>a.id==='bet_5').userFrequency,2/3);
 assert.deepEqual(grade.actions.find(a=>a.id==='bet_5').range,[{combo:'KcKd',posteriorWeight:1}]);
 close(grade.metrics.rangeEV,grade.combos.reduce((s,c)=>s+c.posteriorWeight*c.userEV,0));
});

test('own previous action reach changes observed range weights but cancels inside each hand conditional EV',async()=>{
 const s={...base,players:[{...base.players[0],position:'SB'},{...base.players[1],position:'BB',range:'AcQd,QhQs'},{id:'c',name:'C',position:'BTN',range:'JhJs,TdTh',stack:20}]},g=prepareRiverGame({...s,...settings,maxRaises:0}),target=path(g,['check','bet_5','call']);
 const locks=[{nodeId:'n0',combo:'AcAd',actions:{check:.2,bet_5:.8}},{nodeId:'n0',combo:'KcKd',actions:{check:.8,bet_5:.2}},...g.nodes.filter(n=>n.actor===1||n.actor===2).map(n=>({nodeId:n.id,actions:deterministic(n.actions.some(a=>a.id==='bet_5')?'bet_5':n.actions.some(a=>a.id==='call')?'call':'check')}))];
 const r=await build(s,{maxRaises:0,locks}),observed=createRangeConstruction(s,r,{nodeId:target.id}).publicQuestion,cf=createRangeConstruction(s,r,{nodeId:target.id,weighting:'counterfactual'}).publicQuestion;
 close(observed.combos.find(c=>c.combo==='AcAd').posteriorWeight,1/9);close(cf.combos.find(c=>c.combo==='AcAd').posteriorWeight,1/3);
 const a=answer(observed,c=>deterministic(c.combo==='AcAd'?'fold':'call')),b=answer(cf,c=>deterministic(c.combo==='AcAd'?'fold':'call')),actual=gradeRangeConstruction(s,r,a),counterfactual=gradeRangeConstruction(s,r,b);
 assert.notEqual(actual.metrics.localRegretBB,counterfactual.metrics.localRegretBB);close(actual.metrics.rootEVChangeBB,counterfactual.metrics.rootEVChangeBB);
 const verified=await evaluateRangeConstruction(s,r,a);assert.equal(verified.independentEvaluation.status,'complete');close(verified.independentEvaluation.fixedOpponent.changeBB,actual.metrics.rootEVChangeBB,1e-7);
 assert.equal(verified.independentEvaluation.responseExposure.kind,'multiplayer-unilateral-gains');assert.equal(verified.independentEvaluation.responseExposure.userLossBB,null);assert.equal('adaptationCostBB' in verified.independentEvaluation.responseExposure,false);
});

test('zero observed reach requires explicit counterfactual mode; zero opponent reach has no defensible score',async()=>{
 const g=prepareRiverGame({...base,...settings,maxRaises:0}),target=path(g,['check','bet_5']),opp=path(g,['check']),r=await build(base,{maxRaises:0,locks:[{nodeId:'n0',actions:{bet_5:1}},{nodeId:opp.id,actions:{bet_5:1}}]});
 assert.throws(()=>createRangeConstruction(base,r,{nodeId:target.id}),/零到达/);
 const q=createRangeConstruction(base,r,{nodeId:target.id,weighting:'counterfactual'}).publicQuestion,submission=answer(q,()=>deterministic('fold')),grade=gradeRangeConstruction(base,r,submission);close(grade.metrics.rootEVChangeBB,0);assert.equal(q.weighting,'counterfactual');assert.ok(q.combos.every(c=>c.reach===0));
 const checked=await evaluateRangeConstruction(base,r,submission);assert.equal(checked.independentEvaluation.status,'complete');close(checked.independentEvaluation.fixedOpponent.changeBB,0);
 const noOpp=await build(base,{maxRaises:0,locks:[{nodeId:opp.id,actions:{check:1}}]});assert.throws(()=>createRangeConstruction(base,noOpp,{nodeId:target.id,weighting:'counterfactual'}),/没有反事实/);
});

test('raise decisions use full legal actions and locked combinations are premises, not unavoidable grading losses',async()=>{
 const g=prepareRiverGame({...base,...settings}),target=path(g,['bet_5']),r=await build(base,{locks:[{nodeId:target.id,combo:'QcQd',actions:{fold:1}}]}),q=createRangeConstruction(base,r,{nodeId:target.id}).publicQuestion;
 assert.ok(q.actions.some(a=>a.type==='raise'));const fixed=q.combos.find(c=>c.combo==='QcQd');assert.equal(fixed.locked,true);assert.equal(fixed.editable,false);assert.deepEqual(fixed.fixedProbabilities,probMap(target.actions,'fold'));
 const a=answer(q,(_,actions)=>deterministic(actions.find(a=>a.type==='raise').id)),grade=gradeRangeConstruction(base,r,a),fixedGrade=grade.combos.find(c=>c.combo==='QcQd');close(fixedGrade.regretBB,0);close(fixedGrade.localBestEV,fixedGrade.referenceEV);
 assert.throws(()=>gradeRangeConstruction(base,r,{...a,assignments:[...a.assignments,{combo:'QcQd',probabilities:{call:1}}]}),/可自由/);
});
function probMap(actions,id){return Object.fromEntries(actions.map(a=>[a.id,a.id===id?1:0]));}

test('coverage, invalid mixes, stale reference, sampled and incomplete tree cases refuse plausible-looking scores',async()=>{
 const r=await build(),q=createRangeConstruction(base,r).publicQuestion,a=answer(q,()=>({check:.5,bet_5:.5}));
 for(const assignment of [{...a,assignments:a.assignments.slice(1)},{...a,assignments:[a.assignments[0],a.assignments[0]]},{...a,assignments:a.assignments.map(x=>({...x,probabilities:{check:.5}}))},{...a,assignments:a.assignments.map(x=>({...x,probabilities:{check:1,raise_999:0}}))},{...a,sourceFingerprint:'stale'}])assert.throws(()=>gradeRangeConstruction(base,r,assignment));
 assert.throws(()=>createRangeConstruction(base,{...r,chance:{exact:false}}),/机会/);assert.throws(()=>createRangeConstruction(base,{...r,capabilities:{fullTree:false}}),/完整后续/);
 const bad=structuredClone(r);bad.nodes[0].combos[0].actionEV[0]=null;assert.throws(()=>createRangeConstruction(base,bad),/缺少完整/);
 const changed=structuredClone(base);changed.players[0].range='AhAs';assert.throws(()=>gradeRangeConstruction(changed,r,a),/范围|不一致/);
});

test('turn-to-river tasks exclude future-card blocked combinations and never disclose another future board',async()=>{
 const s={...base,board:'2c4d6h8s',players:[base.players[0],{...base.players[1],range:'QcQd'}]},r=await solveTurnGame({...s,...settings,sizes:[],raiseSizes:[],maxRaises:0,riverSizes:[50],riverRaiseSizes:[],riverMaxRaises:0,iterations:10}),node=path(r,['check','check','river_Ac']),q=createRangeConstruction(s,r,{nodeId:node.id}).publicQuestion;
 assert.equal(q.nodeContext.board,'2c4d6h8sAc');assert.equal(q.combos.find(c=>c.combo==='AcAd').reason,'blocked-by-board');assert.equal(q.combos.find(c=>c.combo==='AcAd').scoreable,false);close(q.combos.find(c=>c.combo==='KcKd').posteriorWeight,1);
 assert.equal(q.nodeContext.history.filter(h=>h.type==='deal').length,1);assert.ok(q.nodeContext.history.slice(0,2).every(h=>h.board==='2c4d6h8s'));
 const a=answer(q,()=>deterministic('bet_5')),evaluated=await evaluateRangeConstruction(s,r,a);assert.equal(evaluated.independentEvaluation.status,'complete');close(evaluated.independentEvaluation.fixedOpponent.changeBB,evaluated.metrics.rootEVChangeBB,1e-7);
});

test('independent heads-up exposure is a constant-sum security value, not frequency distance or constrained zero residual',async()=>{
 const r=await build(),q=createRangeConstruction(base,r).publicQuestion,grade=await evaluateRangeConstruction(base,r,answer(q,()=>deterministic('check'))),e=grade.independentEvaluation;
 assert.equal(e.status,'complete');assert.equal(e.responseExposure.kind,'heads-up-security');close(e.responseExposure.submittedSecurityEV,10-e.submitted.bestResponseEV[1]);close(e.responseExposure.adaptationCostBB,e.submitted.gain[1]);close(e.fixedOpponent.changeBB,grade.metrics.rootEVChangeBB);assert.equal(e.verification.constrainedResidualUsed,false);assert.equal(e.submitted.bestResponseIgnoresLocks,true);
 const raw=await solveHUPostflop({...base,...settings,engine:'hu-postflop',algorithm:'dcfr',iterations:20,outputScope:'full'}),hu=evaluateHUPolicy(raw),hq=createRangeConstruction(base,hu).publicQuestion,hg=await evaluateRangeConstruction(base,hu,answer(hq,()=>deterministic('check')));assert.equal(hg.independentEvaluation.status,'complete');close(hg.independentEvaluation.fixedOpponent.changeBB,hg.metrics.rootEVChangeBB,1e-7);
});

test('budget failure preserves only local score, while inconsistent reference EV never passes independent verification',async()=>{
 const r=await build(),q=createRangeConstruction(base,r).publicQuestion,a=answer(q,()=>deterministic('check')),limited=await evaluateRangeConstruction(base,r,a,{maxNodes:1});assert.equal(limited.independentEvaluation.status,'unavailable');assert.ok(Number.isFinite(limited.metrics.localRegretBB));assert.equal('responseExposure' in limited.independentEvaluation,false);
 const wrong=structuredClone(r);wrong.nodes[0].combos[0].actionEV[0]+=1;const wq=createRangeConstruction(base,wrong).publicQuestion;await assert.rejects(evaluateRangeConstruction(base,wrong,answer(wq,()=>deterministic('check'))),/参考行动 EV.*不一致/);
 const controller=new AbortController();controller.abort();await assert.rejects(evaluateRangeConstruction(base,r,a,{signal:controller.signal}),/取消/);
});

test('capped fee remains constant-sum in security EV and call/raise losses exclude previously invested chips',async()=>{
 const s={...base,rake:5,rakeCap:.5},r=await build(s),target=path(r,['bet_5']),q=createRangeConstruction(s,r,{nodeId:target.id}).publicQuestion;
 const graded=await evaluateRangeConstruction(s,r,answer(q,()=>({fold:.2,call:.3,raise_15:.5}))),e=graded.independentEvaluation;
 assert.equal(e.status,'complete');close(e.submitted.profileEV.reduce((a,b)=>a+b,0),9.5);close(e.responseExposure.submittedSecurityEV,9.5-e.submitted.bestResponseEV[0]);close(e.fixedOpponent.changeBB,graded.metrics.rootEVChangeBB);
 for(const c of graded.combos)if(c.scoreable)close(c.actionEV.fold,0);
});

test('tiny positive joint reach is normalized as a range, never silently equated with zero',async()=>{
 const g=prepareRiverGame({...base,...settings,maxRaises:0}),opp=path(g,['check']),target=path(g,['check','bet_5']),r=await build(base,{maxRaises:0,locks:[{nodeId:'n0',actions:{check:1e-18,bet_5:1}},{nodeId:opp.id,actions:{bet_5:1}}]});
 const q=createRangeConstruction(base,r,{nodeId:target.id}).publicQuestion;assert.ok(q.weights.observedNodeReach>0&&q.weights.observedNodeReach<1e-15);close(q.combos.reduce((s,c)=>s+c.posteriorWeight,0),1);assert.equal(q.requirements.editableCombos,2);
 const wrong=structuredClone(r);wrong.nodes.find(n=>n.id===target.id).reach=0;assert.throws(()=>createRangeConstruction(base,wrong,{nodeId:target.id}),/到达质量.*不一致/);
});
