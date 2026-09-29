import test from 'node:test';
import assert from 'node:assert/strict';
import {cards,range,rankHand} from '../lib/poker.mjs';
import {raiseExperiment,riverResponseExperiment,posteriorRangeExperiment,sidePotLayers,listLessons,getLesson,gradeAttempt,scheduleReview,buildTrainingSummary,validateCurriculum,listGuidedLessons,getGuidedLesson} from '../lib/curriculum.mjs';
import {buildCoachReport,createStudyQuestion,gradeStudyQuestion} from '../lib/coach.mjs';

test('curriculum is complete and public lessons do not leak answers',()=>{
  assert.equal(validateCurriculum().ok,true);assert.ok(listLessons().length>=16);
  for(const summary of listLessons()){const l=getLesson(summary.id);for(const key of ['answer','acceptedAnswers','correctReasons','actionEV','explanation','evidence'])assert.equal(key in l,false,`${l.id}: ${key}`);const full=getLesson(summary.id,{reveal:true});const g=gradeAttempt({lessonId:l.id,answer:full.answer,reasonIds:full.correctReasons,confidence:80});assert.equal(g.correct,true);assert.equal(g.score,100);}
});
test('raise EV exact enumeration reproduces stated model and crossover',()=>{
  const high=raiseExperiment({worseCall:1}),low=raiseExperiment({worseCall:0}),cross=raiseExperiment({worseCall:.5625});
  assert.equal(high.total,32);assert.equal(high.equity,23/32);assert.equal(high.callEV,41.875);assert.equal(high.raiseEV,55);assert.equal(low.raiseEV,25);assert.equal(cross.raiseEV,cross.callEV);assert.equal(low.equity,high.equity);assert.equal(high.rows.length,32);assert.equal(high.groups.reduce((s,g)=>s+g.raiseContribution,0),55);
});
test('wrong action gets model loss, flawed reasons cannot earn a perfect score',()=>{
  const wrong=gradeAttempt({lessonId:'raise-value-100',answer:'call',reasonIds:['worse-continues','response-model'],confidence:95}, {}, Date.UTC(2026,8,28));assert.equal(wrong.loss,13.125);assert.equal(wrong.correct,false);assert.equal(wrong.calibration.highConfidenceError,true);assert.equal(wrong.review.intervalDays,.25);
  const rightWrongReason=gradeAttempt({lessonId:'raise-value-100',answer:'raise',reasonIds:['equity-only'],confidence:90});assert.equal(rightWrongReason.correct,true);assert.equal(rightWrongReason.score,70);assert.equal(rightWrongReason.reasoningScore,0);
  assert.throws(()=>gradeAttempt({lessonId:'raise-value-100',answer:'raise',reasonIds:[],confidence:90}),/理由/);
});
test('selecting every reason does not game the reasoning score',()=>{
  const l=getLesson('raise-value-100');const g=gradeAttempt({lessonId:l.id,answer:'raise',reasonIds:l.reasonChoices.map(r=>r.id),confidence:80});assert.equal(g.reasoningScore,0);assert.equal(g.score,70);
});
test('blocker lesson numbers independently match evaluator enumeration',()=>{
  const b=cards('Qs 9h 2h 3c 7d'),text='99,77,22,AhKh,AhJh,AhTh,KhJh,KcJc';
  const ev=htext=>{const h=cards(htext),r=range(text,[...b,...h]),hr=rankHand([...b,...h]);return r.live.reduce((s,c)=>s+(hr>rankHand([...b,...c.cards])?1:0),0)/r.count*100-30;};
  assert.ok(Math.abs(ev('AcQd')-(5/14*100-30))<1e-10);assert.ok(Math.abs(ev('AhQd')-(2/11*100-30))<1e-10);
});
test('review rules prioritize high-confidence errors and progress successful retrieval',()=>{
  const now=Date.UTC(2026,8,28);const first=scheduleReview({correct:true,score:100,confidence:90},{},now);assert.equal(first.intervalDays,1);const next=scheduleReview({correct:true,score:100,confidence:90},first,now+86400000);assert.equal(next.intervalDays,3);const lapse=scheduleReview({correct:false,score:0,confidence:95},next,now);assert.equal(lapse.streak,0);assert.equal(lapse.intervalDays,.25);
});
test('training summary keeps variants distinct from base lesson completion',()=>{
  const now=Date.UTC(2026,8,28),a=gradeAttempt({lessonId:'raise-value-100',answer:'raise',reasonIds:['worse-continues','response-model'],confidence:90},{},now),b=gradeAttempt({lessonId:'raise-value-0',answer:'call',reasonIds:['worse-continues','response-model'],confidence:80},{},now);
  const s=buildTrainingSummary([a,b],now+2*86400000);assert.equal(s.attempts,2);assert.equal(s.completedLessons,2);assert.equal(s.due.length,2);assert.equal(s.skills[0].variants.length,1);assert.equal(s.skills[0].accuracy,1);
});
test('evidence coach never invents numeric engine results',()=>{
  const s={pot:40,board:'Ks 7h 2h 9c 3s',hero:'AcKd',heroSeat:1,players:[{name:'A'},{name:'Hero'},{name:'C'}]};
  const r=buildCoachReport(s,{players:[]});assert.equal(r.evidence.length,2);assert.ok(r.limitations.some(x=>x.includes('没有可引用')));assert.ok(r.limitations.some(x=>x.includes('多人')));
});
test('personal solve cards honor EV tolerance, hide answers, keep source',()=>{
  const s={title:'Study',hero:'AcKd',players:[{name:'Hero'}]},result={id:'solve1',engine:'test',nodes:[{id:'n0',actions:[{id:'c',label:'Call'},{id:'r',label:'Raise'}],combos:[{combo:'KdAc',reach:1,probabilities:[.9,.1],actionEV:[4,4.01]}]}]};
  const q=createStudyQuestion(s,result,{evTolerance:.02});assert.equal('actionEV' in q.publicQuestion,false);assert.deepEqual(q.full.acceptedAnswers,['c','r']);const g=gradeStudyQuestion(q.full,{answer:'c',confidence:80,reason:'response'});assert.equal(g.correct,true);assert.ok(Math.abs(g.loss-.01)<1e-12);assert.equal(g.reasonScore,null);assert.equal(g.source.solveId,'solve1');
});
test('three-bet response plan changes the optimal initial action in exact model',()=>{
  const x=getLesson('raise-transfer-reraise-fold',{reveal:true}),y=getLesson('raise-transfer-reraise-call',{reveal:true});assert.equal(x.actionEV.raise,31);assert.equal(x.answer,'call');assert.equal(y.actionEV.raise,46.375);assert.equal(y.answer,'raise');
});
test('posterior range variants respond to actual card removal',()=>{
  const x=getLesson('range-transfer-1',{reveal:true}),y=getLesson('range-transfer-2',{reveal:true});assert.ok(Math.abs(x.evidence.at(-1).value-6/16.4)<1e-12);assert.ok(Math.abs(y.evidence.at(-1).value-6/14)<1e-12);assert.ok(y.evidence.at(-1).value>x.evidence.at(-1).value);
});
test('side-pot layers independently match discrete chip layers and refunds',()=>{
  for(let i=1;i<=150;i++){
    const contributions=[i%30+1,(i*7)%50+1,(i*13)%80+1,(i*3)%60+1],r=sidePotLayers(contributions),expected=[];let refund=0;
    for(let level=1;level<=Math.max(...contributions);level++){const contributors=contributions.map((n,k)=>n>=level?k:-1).filter(k=>k>=0);if(contributors.length===1)refund++;else expected.push(contributors.length);}
    assert.equal(r.total,expected.reduce((a,b)=>a+b,0));assert.equal(r.returned,refund);assert.equal(r.conserved,true);
  }
  const folded=sidePotLayers([30,80,80],[false,true,false]);assert.deepEqual(folded.pots.map(p=>p.eligible),[[0,2],[2]]);assert.deepEqual(folded.pots.map(p=>p.amount),[90,100]);
});
test('generated curriculum has substantial family transfer coverage and connected guided routes',()=>{
  assert.equal(listLessons().length,54);for(const family of ['river-value-raise','card-removal','weighted-range','multiway-branches','multiway-pots'])assert.ok(listLessons().filter(l=>l.family===family&&l.trainingRole==='transfer').length>=6);for(const route of listGuidedLessons()){const r=getGuidedLesson(route.id);assert.ok(r.steps.length>=6);for(const step of r.steps.filter(s=>s.lessonId))assert.doesNotThrow(()=>getLesson(step.lessonId));}
});
test('latest review is chosen chronologically, regardless of file listing order',()=>{
  const full=getLesson('raise-value-100',{reveal:true}),input={lessonId:full.id,answer:full.answer,reasonIds:full.correctReasons,confidence:90},old=gradeAttempt(input,{},Date.UTC(2026,8,20)),newer=gradeAttempt(input,old,Date.UTC(2026,8,28));assert.equal(newer.review.intervalDays,3);const s=buildTrainingSummary([newer,old],Date.UTC(2026,8,29));assert.equal(s.due.some(l=>l.id===full.id),false);assert.equal(s.upcoming.find(l=>l.id===full.id).dueAt,newer.review.dueAt);
});
test('study question retains actual deep node and sampled-reference qualification',()=>{
  const scenario={title:'Deep',hero:'AcKd',heroSeat:0,players:[{id:'a',name:'A'},{id:'b',name:'B'}]},result={id:'x',chance:{mode:'sampled',exact:false},input:{accuracy:.5},diagnostics:{optimizationResidualPctPot:1},validation:{holdout:{nashConvPctPot:2}},nodes:[{id:'n0',actor:0,actions:[{id:'b',type:'bet',label:'下注 5',childId:'n1',amount:5,to:5}]},{id:'n1',parentId:'n0',actor:1,actorId:'b',pot:15,toCall:5,contributions:[5,0],folded:[false,false],actions:[{id:'f',label:'弃牌'},{id:'c',label:'跟注'}],combos:[{combo:'QhQd',reach:1,probabilities:[.2,.8],actionEV:[0,2]}]}]};
  const q=createStudyQuestion(scenario,result,{nodeId:'n1',combo:'QhQd'});assert.equal(q.publicQuestion.nodeContext.actorSeat,1);assert.equal(q.publicQuestion.nodeContext.pot,15);assert.equal(q.publicQuestion.nodeContext.history[0].label,'下注 5');assert.equal(q.publicQuestion.quality.mode,'sampled');assert.equal(q.publicQuestion.quality.targetReached,false);assert.equal(q.publicQuestion.quality.countsTowardMastery,false);assert.equal(q.publicQuestion.source.holdout.nashConvPctPot,2);assert.equal(q.full.evTolerance,.02);
});
test('locked actors cannot generate misleading unrestricted best-action questions',()=>{
  const s={board:'Ks7h2h9c3s',hero:'AcKd',players:[{name:'H'}]},r={nodes:[{id:'n0',actor:0,actions:[{id:'c',label:'Check'},{id:'b',label:'Bet'}],combos:[{combo:'AcKd',locked:true,reach:1,probabilities:[1,0],actionEV:[1,2]}]}]};assert.throws(()=>createStudyQuestion(s,r),/被锁定/);
});
test('chance node is a public card event and river training uses the river board',()=>{
  const s={title:'Turn',board:'Ks7h2h9c',hero:'AcKd',heroSeat:0,pot:10,players:[{id:'h',name:'Hero'},{id:'v',name:'V'}]},r={nodes:[{id:'n0',actor:-2,chance:true,board:'Ks7h2h9c',street:'turn',actions:[{id:'river_3s',type:'deal',label:'3s',childId:'n1'}]},{id:'n1',parentId:'n0',actor:0,actorId:'h',board:'Ks7h2h9c3s',street:'river',pot:20,toCall:0,contributions:[5,5],streetContributions:[0,0],actions:[{id:'c',label:'Check'}],combos:[{combo:'AcKd',reach:1,probabilities:[1],actionEV:[4]}]}]};
  const report=buildCoachReport(s,r);assert.ok(report.headline.includes('发牌'));assert.equal(report.questions.length,0);assert.throws(()=>createStudyQuestion(s,r),/发牌节点/);const q=createStudyQuestion(s,r,{nodeId:'n1'});assert.equal(q.publicQuestion.nodeContext.board,'Ks7h2h9c3s');assert.equal(q.publicQuestion.nodeContext.street,'river');assert.equal(q.publicQuestion.scenario.board,'Ks7h2h9c');assert.equal(q.publicQuestion.nodeContext.history[0].actorSeat,null);assert.equal(q.publicQuestion.nodeContext.history[0].label,'发牌 3s');
});

test('same-day correct repetitions cannot inflate the course interval or retrieval streak',()=>{
 const now=Date.UTC(2026,8,28),full=getLesson('raise-value-100',{reveal:true}),input={lessonId:full.id,answer:full.answer,reasonIds:full.correctReasons,confidence:90};let prior=gradeAttempt(input,{},now);
 for(let i=1;i<=50;i++){prior=gradeAttempt(input,prior,now+i*60000);assert.equal(prior.review.intervalDays,1);assert.equal(prior.review.streak,1);assert.equal(prior.review.evidenceType,'short-gap-practice');}
 const delayed=gradeAttempt(input,prior,now+50*60000+86400000);assert.equal(delayed.review.intervalDays,3);assert.equal(delayed.review.evidenceType,'delayed-retrieval');
});
test('immediate success cannot erase an error review and early delayed reviews do not rush the ladder',()=>{
 const now=Date.UTC(2026,8,28),bad=scheduleReview({correct:false,score:0,confidence:95},{},now),quick=scheduleReview({correct:true,score:100,confidence:90},bad,now+1000);assert.equal(quick.pendingRepair,true);assert.equal(quick.priority,'high');assert.equal(quick.dueAt,bad.dueAt);assert.equal(quick.intervalDays,.25);
 const shortReview=scheduleReview({correct:true,score:100,confidence:90},quick,now+6*3600000);assert.equal(shortReview.pendingRepair,false);assert.equal(shortReview.intervalDays,1);assert.equal(shortReview.streak,0);assert.equal(shortReview.evidenceType,'short-gap-practice');
 const first=scheduleReview({correct:true,score:100,confidence:90},{},now),dayOne=scheduleReview({correct:true,score:100,confidence:90},first,now+86400000),early=scheduleReview({correct:true,score:100,confidence:90},dayOne,now+2*86400000);assert.equal(early.intervalDays,3);assert.equal(early.streak,dayOne.streak);assert.equal(early.dueAt,dayOne.dueAt);
});
test('course summary separates first exposure, 24-hour delayed retrieval and short-gap confidence',()=>{
 const now=Date.UTC(2026,8,28),lessonId='raise-value-100',record=(id,h,correct,confidence)=>({id,lessonId,createdAt:new Date(now+h*3600000).toISOString(),correct,confidence,reasoningScore:correct?100:0,loss:correct?0:10}),rows=[record('first',0,false,90),record('fast',20,true,90),record('delayed',44,true,80)];
 const result=buildTrainingSummary(rows.toReversed(),new Date(now+45*3600000)),e=result.learningEvidence;assert.equal(e.firstExposure.attempts,1);assert.equal(e.firstExposure.accuracy,0);assert.ok(Math.abs(e.firstExposure.brier-.81)<1e-12);assert.equal(e.shortGapPractice.attempts,1);assert.equal(e.delayedRetrieval.attempts,1);assert.equal(e.delayedRetrieval.accuracy,1);assert.match(e.delayedRule,/24/);assert.equal(result.skills[0].learningEvidence.firstExposure.correct,0);assert.equal(result.skills[0].learningEvidence.shortGapPractice.correct,1);assert.deepEqual(buildTrainingSummary(rows,new Date(now+45*3600000)),result);
});
test('unknown, duplicated and future course records cannot inflate evidence; absent old confidence is not zero',()=>{
 const now=Date.UTC(2026,8,28),old={id:'old',lessonId:'raise-value-100',correct:true,review:{lastReviewedAt:new Date(now).toISOString()}};const result=buildTrainingSummary([old,{...old},{...old,id:'orphan',lessonId:'missing'},{...old,id:'future',createdAt:new Date(now+86400000).toISOString()},{...old,id:'broken',createdAt:'bad'}],now);assert.equal(result.totalAttempts,1);assert.equal(result.learningEvidence.firstExposure.brier,null);assert.equal(result.learningEvidence.firstExposure.confidenceSamples,0);assert.equal(result.ignored.duplicate,1);assert.equal(result.ignored.unknownLesson,1);assert.equal(result.ignored.future,1);assert.equal(result.ignored.invalid,1);assert.equal(result.skills[0].brier,null);
});
