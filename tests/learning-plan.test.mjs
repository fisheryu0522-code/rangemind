import test from 'node:test';
import assert from 'node:assert/strict';
import {createStudyProject,applyStudyProjectEvent,summarizeStudyProject,collectLearningEvidence,buildLearningPlan,referenceEvidenceQuality} from '../lib/learning-plan.mjs';
import {getLesson,gradeAttempt} from '../lib/curriculum.mjs';
import {solveRiverGame} from '../lib/river-engine.mjs';
import {gradeRangeConstruction} from '../lib/strategy-construction.mjs';

const T=Date.parse('2026-09-28T00:00:00Z'),H=3600000,D=24*H,iso=t=>new Date(t).toISOString();
const quality={mode:'exact',residual:.02,target:.1,targetReached:true,provisional:false};
const project=()=>createStudyProject({question:'较差顶对不再跟加注时，我的价值加注计划应如何改变？',source:{kind:'manual'},assumptions:{facts:['河牌没有后续公共牌'],hypotheses:['较差牌跟加注的概率由输入指定']}},{id:'p',now:T});
const event=(p,e,h=0,extra={})=>applyStudyProjectEvent(p,e,{eventId:'e'+p.events.length,now:T+h*H,...extra});
const prediction={kind:'prediction',statement:'只降低较差成牌继续频率，预期加注净 EV 下降。',variable:'较差成牌跟注频率',expectedDirection:'decrease',confidence:80,reportedExposure:'unseen'};
const evidence={kind:'evidence',source:{kind:'lesson',id:'raise-value-100'},summary:'给定响应下，额外价值来自较差牌继续。',userAssessment:'supports'};
const conclusion={kind:'conclusion',conditionalRule:'应先确认继续付钱的较差牌。',appliesWhen:'河牌指定响应、没有再加注分支。',exceptions:'加入再加注后需要重新计算整个计划。'};
function atFieldPlan(){let p=event(project(),prediction);p=event(p,evidence,1);p=event(p,conclusion,2);return event(p,{kind:'field-plan',cue:'河牌准备薄价值加注时',check:'说出会继续的较差牌和遇再加注的计划',reviewAfterDays:1},3);}
function course(id='c',hours=0,{lessonId='raise-value-100',correct=false,confidence=95,previous={}}={}){const l=getLesson(lessonId,{reveal:true}),answer=correct?l.answer:l.choices.find(a=>!l.acceptedAnswers.includes(a.id)).id,submission={lessonId,answer,reasonIds:l.correctReasons,confidence};return {...submission,...gradeAttempt(submission,previous,T+hours*H),id,createdAt:iso(T+hours*H)};}
const card=(id,q=quality)=>({id,createdAt:iso(T-D),full:{id:'q'+id,kind:'study-action',combo:'AhKh',quality:q,choices:[{id:'check'},{id:'bet'}],referenceEV:1,actionEV:{check:0,bet:1},evTolerance:.02}});
const study=(id,cardId,hours=0,correct=true,extra={})=>({id,cardId,createdAt:iso(T+hours*H),answer:correct?'bet':'check',correct,confidence:70,...extra});
const range=(id='r',extra={})=>({id,createdAt:iso(T),jobId:'job',weighting:'observed',grade:{source:{nodeId:'n0'},sourceFingerprint:'fingerprint',quality,metrics:{localRegretBB:1.2,referenceDifferenceBB:-1.1,rootEVChangeBB:-.4}},...extra});
function contrastRange(id='contrast'){
 const row=(combo,posteriorWeight,best)=>({combo,posteriorWeight,scoreable:true,editable:true,locked:false,userProbabilities:{check:1,bet_5:0},referenceProbabilities:{check:0,bet_5:1},actionEV:{check:0,bet_5:best},userEV:0,referenceEV:best,localBestEV:best,regretBB:best,weightedRegretBB:posteriorWeight*best});
 const grade={kind:'range-construction-grade',source:{solveId:'job',nodeId:'n0'},sourceFingerprint:'a'.repeat(64),nodeContext:{nodeId:'n0',actorId:'h',board:'2c4d6h8sTc',contributions:[0,0],history:[]},coverage:{complete:true},weighting:'observed',quality,actions:[{id:'check',label:'过牌'},{id:'bet_5',label:'下注 5 BB'}],combos:[row('AcAd',.1,10),row('KcKd',.9,2)],metrics:{localRegretBB:2.8,referenceDifferenceBB:-2.8,rootEVChangeBB:-2.8}};
 return {id,kind:'range-attempt',createdAt:iso(T),jobId:'job',nodeId:'n0',nodePath:[],weighting:'observed',sourceFingerprint:grade.sourceFingerprint,grade,source:{jobId:'job',nodeId:'n0'},reportedExposure:'unseen'};
}
function play(extra={}){return {id:'session',kind:'play-session',status:'complete',createdAt:iso(T),updatedAt:iso(T+H),source:{jobId:'job',quality},decisions:[{id:'decision',nodeId:'n0',path:[],heroCombo:'AhKh',actionId:'call',confidence:90,answeredAt:iso(T+H/2),feedback:{loss:1,selectedEV:2,bestEV:3,acceptedActions:['raise'],quality,referenceKind:'fixed-reference-continuation'}}],...extra};}

test('project creation is minimal and pure, with immutable source and explicit assumption status',()=>{
 const raw={question:'多人池中身后范围变紧时加注如何变化？',source:{kind:'hand',id:'h',path:['check'],scenarioKey:'v1'}},copy=structuredClone(raw),p=createStudyProject(raw,{id:'p',now:T});assert.deepEqual(raw,copy);assert.equal(p.events.length,0);assert.equal(summarizeStudyProject(p,{now:T}).phase,'prediction');assert.match(p.assumptions.factsMeaning,/不把自由文本/);
 assert.throws(()=>applyStudyProjectEvent({...p,source:{kind:'hand',id:'other'}},prediction,{eventId:'e',now:T}),/来源已改变/);assert.throws(()=>event(p,{kind:'edit',source:{kind:'manual'}}),/不能被改写/);
});

test('predictions retain exposure status and user interpretations never become numerical proof',()=>{
 const p0=project();assert.throws(()=>event(p0,evidence),/先记录预测/);const p1=event(p0,prediction);assert.equal(p1.events[0].blindStatus,'self-reported-unseen');assert.equal(p0.events.length,0);assert.throws(()=>event(p1,{...evidence,source:{kind:'manual'}}),/需要链接/);
 const p2=event(p1,evidence,1),p3=event(p2,prediction,2);assert.equal(p2.events.at(-1).assessmentBy,'user');assert.equal(p3.events.at(-1).blindStatus,'after-known-evidence');assert.equal(summarizeStudyProject(p3,{now:T+2*H}).phase,'evidence');
});

test('field observation distinguishes no opportunity, failure to execute, and profit outcome',()=>{
 const p=atFieldPlan(),s=summarizeStudyProject(p,{now:T+28*H});assert.equal(s.phase,'field-observation');assert.equal(s.actionDue,true);assert.throws(()=>event(p,{kind:'field-observation',encountered:false,executed:true},28),/没有遇到/);
 const none=event(p,{kind:'field-observation',encountered:false},28),n=summarizeStudyProject(none,{now:T+29*H});assert.equal(n.execution.executed,null);assert.equal(n.actionDue,false);assert.equal(n.execution.profitOutcomeScored,false);
 const failed=event(none,{kind:'field-observation',encountered:true,executed:false,note:'当时忘记检查身后范围，记录为未执行。'},53);assert.equal(summarizeStudyProject(failed,{now:T+53*H}).phase,'retest');assert.equal(summarizeStudyProject(failed,{now:T+53*H}).execution.executed,false);
});

test('old, mismatched, self-reported and future attempts cannot complete a research retest',()=>{
 let p=event(atFieldPlan(),{kind:'field-observation',encountered:true,executed:true,note:'已按计划检查，盈利结果未用于评分。'},28);const e={kind:'retest',source:{kind:'course-attempt',id:'a'},createdAt:iso(T+30*H),correct:true};
 const unknown=event(p,e,30);assert.equal(summarizeStudyProject(unknown,{now:T+30*H}).phase,'retest');assert.equal(unknown.events.at(-1).verification,'unverified-timing');
 assert.throws(()=>event(p,e,30,{resolvedRetest:{sourceKind:'course-attempt',sourceId:'a',createdAt:iso(T+H)}}),/旧作答/);assert.throws(()=>event(p,e,30,{resolvedRetest:{sourceKind:'course-attempt',sourceId:'b',createdAt:iso(T+29*H)}}),/不一致/);assert.throws(()=>event(p,e,30,{resolvedRetest:{sourceKind:'course-attempt',sourceId:'a',createdAt:iso(T+31*H)}}),/时间无效/);
 p=event(p,e,30,{resolvedRetest:{sourceKind:'course-attempt',sourceId:'a',createdAt:iso(T+29*H)}});const final=summarizeStudyProject(p,{now:T+30*H});assert.equal(final.phase,'complete');assert.equal(final.countsTowardMastery,false);
});

test('revising a prediction and conclusion requires fresh evidence, field plan and retest identity',()=>{
 let p=atFieldPlan();p=event(p,prediction,4);assert.equal(summarizeStudyProject(p,{now:T+4*H}).phase,'evidence');p=event(p,evidence,5);assert.equal(summarizeStudyProject(p,{now:T+5*H}).phase,'conclusion');p=event(p,conclusion,6);assert.equal(summarizeStudyProject(p,{now:T+6*H}).phase,'field-plan');
});

test('event and source boundaries reject invalid confidence, IDs, time and closed edits',()=>{
 const p=project();assert.throws(()=>event(p,{...prediction,confidence:101}),/0–100/);assert.throws(()=>event(p,prediction,-1),/不能早于/);const pred=event(p,prediction);assert.throws(()=>applyStudyProjectEvent(pred,evidence,{eventId:'e0',now:T+H}),/重复/);const closed=event(pred,{kind:'close'},1);assert.equal(summarizeStudyProject(closed,{now:T+H}).phase,'closed');assert.throws(()=>event(closed,prediction,2),/已关闭/);assert.throws(()=>createStudyProject({question:'x',source:{kind:'play-decision',id:'d'}},{id:'p',now:T}),/sessionId/);
});

test('zero data gives a neutral baseline, never fabricated leaks or population statistics',()=>{
 const p=buildLearningPlan({}, {now:T});assert.equal(p.needsBaseline,true);assert.equal(p.evidenceSummary.all.accuracy,null);assert.equal(p.recommendations.length,1);assert.equal(p.recommendations[0].kind,'baseline');assert.equal(p.recommendations[0].basis.sampleCount,0);assert.equal(p.recommendations[0].target.assessment,true);
});

test('course evidence is recomputed; corrupt scores and orphan lessons cannot create due recommendations',()=>{
 const valid=course(),bad={...course('bad'),correct:true},orphan={...course('orphan'),lessonId:'not-a-lesson'},data={courseAttempts:[bad,valid,orphan]},r=collectLearningEvidence(data,{now:T+D});assert.equal(r.records.length,1);assert.equal(r.ignored.length,2);assert.equal(r.records[0].lossBB,55);assert.equal(r.records[0].correct,false);
 const empty=buildLearningPlan({courseAttempts:[bad,orphan]},{now:T+D});assert.equal(empty.recommendations.some(x=>x.kind==='review'),false);assert.equal(empty.needsBaseline,true);
});

test('short-gap correct retries cannot erase initial diagnostic evidence; delayed success can update it',()=>{
 const first=course('first',0),retry=course('retry',.1,{correct:true,confidence:95,previous:first});let data={courseAttempts:[retry,first]};let r=buildLearningPlan(data,{now:T+H});assert.equal(r.evidenceSummary.firstExposure.accuracy,0);assert.equal(r.evidenceSummary.shortGapPractice.accuracy,1);assert.equal(r.recommendations[0].kind,'investigate');assert.equal(r.recommendations[0].observed.highConfidence,true);
 const delayed=course('delayed',24.1,{correct:true,confidence:95,previous:retry});r=buildLearningPlan({courseAttempts:[delayed,...data.courseAttempts]},{now:T+25*H});assert.equal(r.evidenceSummary.delayedRetrieval.accuracy,1);assert.equal(r.recommendations.some(x=>x.kind==='investigate'),false);assert.equal(r.recommendations.some(x=>x.kind==='transfer-check'),true);
});

test('confidence feedback separates first, delayed and short exposure; low confidence correct receives follow-up',()=>{
 const a=course('a',0,{correct:true,confidence:20}),b=course('b',20,{correct:true,confidence:95,previous:a}),c=course('c',44,{correct:true,confidence:40,previous:b}),r=buildLearningPlan({courseAttempts:[c,a,b]},{now:T+45*H});assert.ok(Math.abs(r.evidenceSummary.firstExposure.brier-.64)<1e-12);assert.ok(Math.abs(r.evidenceSummary.delayedRetrieval.brier-.36)<1e-12);assert.equal(r.evidenceSummary.shortGapPractice.judged,1);assert.equal(r.recommendations.some(x=>x.kind==='confidence-check'),true);
});

test('references need numeric exact quality; sampled and historical provisional cards remain research only',()=>{
 assert.equal(referenceEvidenceQuality({mode:'exact',targetReached:true}).eligible,false);assert.equal(referenceEvidenceQuality(null,null).eligible,false);assert.equal(referenceEvidenceQuality({...quality,residual:1}).eligible,false);assert.equal(referenceEvidenceQuality(quality,{chance:{exact:false}}).eligible,false);
 const cs=[card('good'),card('sample',{...quality,mode:'sampled'}),card('history')],as=[study('a','good'),study('b','sample',0,false),study('c','history',0,false,{quality:{...quality,targetReached:false}})],r=buildLearningPlan({studyCards:cs,studyAttempts:as},{now:T+H});assert.equal(r.evidenceSummary.all.judged,1);assert.equal(r.evidenceSummary.all.provisional,2);assert.equal(r.recommendations.some(x=>x.kind==='investigate'),false);
});

test('separate unknown-source cards with identical combos do not collapse their identity',()=>{
 const r=collectLearningEvidence({studyCards:[card('a'),card('b')],studyAttempts:[study('x','a'),study('y','b',1)]},{now:T+H});assert.equal(new Set(r.records.map(x=>x.taskKey)).size,2);assert.ok(r.records.every(x=>x.evidenceRole==='first-exposure'));
});

test('range prescriptions separate fixed-opponent regret from heads-up adaptation cost',()=>{
 const a=range('r',{independentEvaluation:{status:'complete',fixedOpponent:{changeBB:-2.9},responseExposure:{kind:'heads-up-security',adaptationCostBB:17}}}),r=buildLearningPlan({rangeAttempts:[a]},{now:T+H}),entry=r.recommendations.find(x=>x.kind==='range-audit');assert.match(entry.why,/1.2 BB/);assert.match(entry.why,/17 BB/);assert.match(entry.why,/两者回答不同问题/);assert.equal(r.evidenceSummary.all.judged,0);assert.equal(r.needsBaseline,true);
});

test('multiplayer deviation gains are not attributed to user loss; counterfactual weights excluded',()=>{
 const multi=range('multi',{independentEvaluation:{status:'complete',responseExposure:{kind:'multiplayer-unilateral-gains',players:[{submittedGainBB:100}],userLossBB:null}}}),r=buildLearningPlan({rangeAttempts:[multi]},{now:T+H});assert.match(r.recommendations.find(x=>x.kind==='range-audit').why,/不是你的损失/);const cf=buildLearningPlan({rangeAttempts:[range('cf',{weighting:'counterfactual'})]},{now:T+H});assert.equal(cf.recommendations.some(x=>x.kind==='range-audit'),false);assert.equal(cf.recommendations.some(x=>x.kind==='verify-reference'),true);
});

test('only finished play decisions enter diagnostics, use actual answer time and never sum street losses',()=>{
 const s=play(),r=collectLearningEvidence({playSessions:[s]},{now:T+2*H});assert.equal(r.records.length,1);assert.equal(r.records[0].createdAt,s.decisions[0].answeredAt);assert.equal(r.records[0].timeResolution,'decision');assert.match(r.records[0].lossMeaning,/不能跨街相加/);assert.equal(r.records[0].correct,false);assert.equal(r.records[0].hasRecordedPlan,false);
 const running=collectLearningEvidence({playSessions:[play({status:'playing'})]},{now:T+2*H});assert.equal(running.records.length,0);const corrupt=play();corrupt.decisions[0].feedback.loss=5;assert.equal(collectLearningEvidence({playSessions:[corrupt]},{now:T+2*H}).records.length,0);
});

test('new recommendations preserve one action per target and factual plan gaps, not mental-state diagnoses',()=>{
 const p=atFieldPlan(),raw={projects:[p],playSessions:[play()],courseAttempts:[course()]},snapshot=structuredClone(raw),r=buildLearningPlan(raw,{now:T+30*H,limit:10});assert.deepEqual(raw,snapshot);assert.equal(r.recommendations[0].kind,'continue-project');assert.equal(new Set(r.recommendations.map(x=>x.target.kind+':'+x.target.id)).size,r.recommendations.length);const plan=r.recommendations.find(x=>x.kind==='plan-audit');assert.ok(!plan||/不能证明/.test(plan.why));assert.equal(r.evidenceSummary.countsTowardMastery,false);
});

test('invalid dates, duplicate IDs, future records and bad project fingerprints are visible exclusions',()=>{
 const a=course(),r=buildLearningPlan({courseAttempts:[a,a,{...course('future'),createdAt:iso(T+D)},{...course('bad-time'),createdAt:'bad'}],projects:[{...project(),source:{kind:'manual',title:'tampered'}}]},{now:T+H});assert.equal(r.evidenceSummary.all.records,1);assert.equal(r.ignored.records.length,3);assert.equal(r.ignored.projects.length,1);assert.throws(()=>buildLearningPlan({}, {now:'broken'}),/时间/);assert.throws(()=>buildLearningPlan({}, {limit:0}),/1–10/);
});

test('a correct action with wrong reason receives an observable reasoning probe, not a guessed mental diagnosis',()=>{
 const submission={lessonId:'raise-value-100',answer:'raise',reasonIds:['equity-only'],confidence:90},a={id:'reason',createdAt:iso(T),...submission,...gradeAttempt(submission,{},T)},r=buildLearningPlan({courseAttempts:[a]},{now:T+H});const probe=r.recommendations.find(x=>x.kind==='reason-check');assert.ok(probe);assert.equal(r.recommendations.some(x=>x.kind==='investigate'),false);assert.equal(probe.diagnosis,'observed-reason-selection-difference');assert.match(probe.why,/不能据此断定/);
});

test('a rejected duplicate cannot re-enter through the review scheduler by sharing an accepted ID',()=>{
 const a=course('same',0,{correct:true,confidence:90}),bad={...a,createdAt:iso(T+H),correct:false,review:{...a.review,dueAt:iso(T),priority:'high'}},r=buildLearningPlan({courseAttempts:[a,bad]},{now:T+2*H});assert.equal(r.evidenceSummary.all.records,1);assert.equal(r.recommendations.some(x=>x.kind==='review'),false);assert.equal(r.ignored.records.length,1);
});

test('declared answer exposure is research practice, never a first independent baseline or definitive leak',()=>{
 const a={...course(),reportedExposure:'seen'},r=buildLearningPlan({courseAttempts:[a],playSessions:[play({reportedExposure:'seen'})],rangeAttempts:[range('r',{reportedExposure:'seen'})]},{now:T+2*H,limit:10});assert.equal(r.evidenceSummary.firstExposure.records,0);assert.equal(r.evidenceSummary.exposedPractice.records,3);assert.equal(r.needsBaseline,true);assert.equal(r.recommendations.some(x=>x.kind==='investigate'),false);assert.equal(r.recommendations.some(x=>x.kind==='range-audit'),true);
});

test('missing-reference restored history is preserved but cannot become a trusted range diagnosis',()=>{
 const r=buildLearningPlan({rangeAttempts:[range('r',{referenceAvailable:false,integrity:{referenceVerified:false,reason:'source-result-missing'}})]},{now:T+H});assert.equal(r.evidenceSummary.all.records,1);assert.equal(r.evidenceSummary.all.provisional,1);assert.ok(r.recommendations.some(x=>x.kind==='verify-reference'));assert.ok(!r.recommendations.some(x=>x.kind==='range-audit'));
});

test('answer exposure belongs to the decision, not every later street of the same practice hand',()=>{
 const s=play();s.source.reportedExposure='seen';s.source.startingPath=[];s.decisions[0].reportedExposure='seen';const later=structuredClone(s.decisions[0]);later.id='later';later.path=['check','bet','call','deal_2d'];later.nodeId='n100';later.reportedExposure='unknown';s.decisions.push(later);const r=collectLearningEvidence({playSessions:[s]},{now:T+2*H});assert.deepEqual(r.records.map(x=>x.answerExposure),['seen','unknown']);assert.equal(r.records[1].evidenceRole,'first-exposure');
});

test('legacy absent confidence preserves a verifiable answer without manufacturing zero confidence or calibration',()=>{
 const a=course();delete a.confidence;const r=buildLearningPlan({courseAttempts:[a]},{now:T+H});assert.equal(r.evidenceSummary.firstExposure.judged,1);assert.equal(r.evidenceSummary.firstExposure.confidenceSamples,0);assert.equal(r.evidenceSummary.firstExposure.brier,null);assert.equal(r.evidenceSummary.firstExposure.highConfidenceErrors,0);
});

test('a later plan cannot retroactively fill an earlier decision snapshot or hide its review need',()=>{
 const s=play(),plan={valueTargets:'较差顶对',bluffTargets:'未成听牌',changeTriggers:'对手加注时重新检查范围'};
 s.decisions[0].planAtDecision={valueTargets:'',bluffTargets:'',changeTriggers:''};
 s.decisions[0].feedback={...s.decisions[0].feedback,loss:0,selectedEV:3,acceptedActions:['call']};
 const later=structuredClone(s.decisions[0]);later.id='later';later.path=['check','check','deal_2d'];later.nodeId='n100';later.answeredAt=iso(T+.8*H);later.planAtDecision=plan;
 s.decisions.push(later);s.plan=plan;s.planHistory=[{createdAt:later.answeredAt,nodeId:later.nodeId,plan}];
 const rows=collectLearningEvidence({playSessions:[s]},{now:T+2*H}).records;
 assert.deepEqual(rows.map(r=>r.hasRecordedPlan),[false,true]);assert.deepEqual(rows.map(r=>r.planRecordSource),['decision-snapshot','decision-snapshot']);
 const review=buildLearningPlan({playSessions:[s]},{now:T+2*H,limit:10}).recommendations.find(r=>r.kind==='plan-audit');
 assert.ok(review);assert.match(review.why,/至少一次决策/);assert.match(review.why,/之后补写/);
});

test('legacy plans need a contemporary timestamp; a final session plan alone proves no earlier record',()=>{
 const s=play(),plan={valueTargets:'较差顶对'},at=s.decisions[0].answeredAt;s.plan=plan;
 let rows=collectLearningEvidence({playSessions:[s]},{now:T+2*H}).records;assert.equal(rows[0].hasRecordedPlan,false);assert.equal(rows[0].planRecordSource,'unverified-session-plan');
 s.planHistory=[{createdAt:iso(T+.8*H),plan}];rows=collectLearningEvidence({playSessions:[s]},{now:T+2*H}).records;assert.equal(rows[0].hasRecordedPlan,false);
 s.planHistory.unshift({createdAt:iso(T+.1*H),plan});rows=collectLearningEvidence({playSessions:[s]},{now:T+2*H}).records;assert.equal(rows[0].hasRecordedPlan,true);assert.equal(rows[0].planRecordSource,'timestamped-plan-history');assert.equal(s.decisions[0].answeredAt,at);
 delete s.decisions[0].answeredAt;rows=collectLearningEvidence({playSessions:[s]},{now:T+2*H}).records;assert.equal(rows[0].hasRecordedPlan,false);assert.equal(rows[0].timeResolution,'session');
});

test('unavailable or incomplete independent evaluation cannot supply an adaptation diagnosis',()=>{
 for(const status of ['unavailable','running',undefined]){
  const a=range('r',{independentEvaluation:{status,responseExposure:{kind:'heads-up-security',adaptationCostBB:999}}});
  const entry=buildLearningPlan({rangeAttempts:[a]},{now:T+H}).recommendations.find(x=>x.kind==='range-audit');
  assert.doesNotMatch(entry.why,/999/);assert.match(entry.why,/尚不能据此声称整套策略/);
 }
});

test('a contrast brief selects actual weighted range impact, keeps the exact source and never manufactures a user prediction',()=>{
 const a=contrastRange();a.grade.coaching={focus:[{combo:'QhQd',rangeRegretContributionBB:9999}],question:'伪造解释'};const before=structuredClone(a),plan=buildLearningPlan({rangeAttempts:[a]},{now:T+H}),brief=plan.recommendations.find(r=>r.researchBrief)?.researchBrief;
 assert.ok(brief);assert.equal(brief.focus.combo,'KcKd');assert.equal(brief.focus.localRegretBB,2);assert.equal(brief.focus.rangeContributionBB,1.8);assert.deepEqual(brief.target,{kind:'job',id:'job',jobId:'job',nodeId:'n0',path:[],combo:'KcKd',projectId:null});assert.equal(brief.sourceRef.sourceFingerprint,a.sourceFingerprint);assert.equal(brief.origin,'program-suggested-not-user-prediction');assert.equal(brief.alreadyExposed,true);assert.equal(brief.editable,true);assert.equal(brief.prediction,undefined);assert.equal(brief.confidence,undefined);assert.match(brief.readout[1].meaning,/不能.*直接相减/);assert.deepEqual(a,before);
});

test('source mismatch, incomplete navigation, impossible cards and inconsistent grades omit the richer proposal without rewriting history',()=>{
 const corruptions=[a=>delete a.nodePath,a=>a.nodeId='n1',a=>a.grade.nodeContext.nodeId='n1',a=>a.grade.nodeContext.history=[{nodeId:'n0'}],a=>a.sourceFingerprint='b'.repeat(64),a=>a.grade.source.solveId='other',a=>a.source.jobId='other',a=>a.grade.combos[0].weightedRegretBB=100,a=>a.grade.combos[0].userEV=9,a=>a.grade.combos[0].actionEV.bet_5=null,a=>a.grade.combos[0].userProbabilities.extra=.2,a=>a.grade.combos[0].combo='2cAd',a=>a.grade.combos[0].combo='KcKd',a=>a.grade.combos[0].posteriorWeight=.3,a=>a.grade.metrics.localRegretBB=999,a=>a.grade.coverage.complete=false,a=>a.referenceAvailable=false];
 for(const mutate of corruptions){const a=contrastRange();mutate(a);const p=buildLearningPlan({rangeAttempts:[a]},{now:T+H});assert.equal(p.recommendations.some(r=>r.researchBrief),false);assert.equal(p.evidenceSummary.all.records,1);}
 for(const q of [{...quality,mode:'sampled'},{...quality,targetReached:false},{...quality,residual:1},{mode:'exact',targetReached:true}]){const a=contrastRange();a.grade.quality=q;assert.equal(buildLearningPlan({rangeAttempts:[a]},{now:T+H}).recommendations.some(r=>r.researchBrief),false);}
 const cf=contrastRange();cf.weighting=cf.grade.weighting='counterfactual';assert.equal(buildLearningPlan({rangeAttempts:[cf]},{now:T+H}).recommendations.some(r=>r.researchBrief),false);
});

test('the same saved project receives the concrete proposal instead of a duplicate range assignment',()=>{
 const a=contrastRange(),p=createStudyProject({question:'我想检查范围简化是否允许对手调整。',source:{kind:'range-attempt',id:a.id,answerSeen:true}},{id:'existing',now:T});
 let plan=buildLearningPlan({rangeAttempts:[a],projects:[p]},{now:T+H,limit:10});const continuation=plan.recommendations.find(r=>r.target.id===p.id);assert.equal(continuation.kind,'continue-project');assert.equal(continuation.researchBrief.projectId,p.id);assert.equal(continuation.researchBrief.target.projectId,p.id);assert.equal(plan.recommendations.some(r=>r.kind==='range-audit'),false);assert.equal(p.events.length,0);
 const manual=createStudyProject({question:'原来的范围问题',source:{kind:'manual'}},{id:'manual-project',now:T-H});a.projectId=manual.id;plan=buildLearningPlan({rangeAttempts:[a],projects:[manual]},{now:T+H});assert.equal(plan.recommendations.find(r=>r.researchBrief).researchBrief.sourceProjectId,manual.id);
 a.projectId='missing';plan=buildLearningPlan({rangeAttempts:[a]},{now:T+H});assert.equal(plan.recommendations.find(r=>r.researchBrief).researchBrief.projectId,null);assert.equal(plan.recommendations.find(r=>r.researchBrief).researchBrief.sourceProjectId,null);
});

test('equal EV alternatives remain a range-balance question and multiplayer readouts do not attribute other players gains to user loss',()=>{
 const a=contrastRange();for(const row of a.grade.combos){row.actionEV={check:row.localBestEV,bet_5:row.localBestEV};row.userEV=row.localBestEV;row.regretBB=row.weightedRegretBB=0;}a.grade.metrics.localRegretBB=0;a.grade.nodeContext.contributions=[0,0,0];
 const b=buildLearningPlan({rangeAttempts:[a]},{now:T+H}).recommendations.find(r=>r.researchBrief).researchBrief;assert.match(b.focusMeaning,/不称为已确认漏洞/);assert.equal(b.focus.candidateActions.length,2);assert.match(b.readout[1].meaning,/不能相加或当成你的损失/);assert.equal(b.countsTowardMastery,undefined);
});

test('at most one prioritized recommendation receives a research brief, without bypassing higher-priority genuine errors',()=>{
 const a=contrastRange('a'),b=contrastRange('b');b.sourceFingerprint=b.grade.sourceFingerprint='b'.repeat(64);b.createdAt=iso(T+H/2);
 const p=buildLearningPlan({rangeAttempts:[a,b]},{now:T+H,limit:10});assert.equal(p.recommendations.filter(r=>r.kind==='range-audit').length,2);assert.equal(p.recommendations.filter(r=>r.researchBrief).length,1);
 const priority=buildLearningPlan({rangeAttempts:[a,b],courseAttempts:[course()]},{now:T+H,limit:1});assert.equal(priority.recommendations[0].kind,'investigate');assert.equal(priority.recommendations[0].researchBrief,undefined);
});

test('a real native solution and computed deep-node grade produce an exactly anchored contrast proposal',async()=>{
 const scenario={title:'实际节点对照',board:'2c4d6h8sTc',pot:10,toAct:0,players:[{id:'h',name:'H',position:'BB',range:'AcAd,KcKd',stack:20},{id:'v',name:'V',position:'BTN',range:'QcQd,JcJd',stack:20}]};
 const result=await solveRiverGame({...scenario,sizes:[50],raiseSizes:[50],maxRaises:0,allIn:false,iterations:1000,accuracy:.1,checkEvery:100,threads:1});
 const first=result.nodes.find(n=>n.id==='n0'),action=first.actions.find(a=>a.type==='check'),node=result.nodes.find(n=>n.id===action.childId);
 const assignments=node.combos.filter(c=>c.reach>0).map(c=>({combo:c.combo,probabilities:{[node.actions[0].id]:1}})),grade=gradeRangeConstruction(scenario,result,{nodeId:node.id,assignments});
 assert.equal(grade.quality.targetReached,true);const a={id:'real',createdAt:iso(T),jobId:'real-job',nodeId:node.id,nodePath:[action.id],sourceFingerprint:grade.sourceFingerprint,weighting:'observed',grade,source:{jobId:'real-job',nodeId:node.id}};
 const brief=buildLearningPlan({rangeAttempts:[a]},{now:T+H}).recommendations.find(r=>r.researchBrief)?.researchBrief;assert.ok(brief);assert.deepEqual(brief.target.path,[action.id]);assert.equal(brief.target.nodeId,node.id);const row=grade.combos.filter(c=>c.editable&&c.scoreable).sort((x,y)=>y.weightedRegretBB-x.weightedRegretBB||y.regretBB-x.regretBB||x.combo.localeCompare(y.combo))[0];assert.equal(brief.focus.combo,row.combo);assert.equal(brief.focus.rangeContributionBB,row.weightedRegretBB);
});
