import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createProAPI} from '../lib/pro-server.mjs';
import {normalizeScenario} from '../lib/scenario.mjs';
import {solveRiverGame} from '../lib/river-engine.mjs';
import {solveSettings} from '../lib/solve-settings.mjs';

const scenario=normalizeScenario({title:'真实隔离模型',board:'2c3d7h9sJc',pot:12,toAct:0,hero:'AcKc',heroSeat:0,players:[{id:'a',name:'Hero',position:'BB',stack:20,range:'AsAh:30%,AcKc:70%'},{id:'b',name:'Opponent',position:'BTN',stack:20,range:'AsKd:40%,QcQd:60%'}],rake:0,rakeCap:0});
const result=await solveRiverGame({...scenario,sizes:[50],raiseSizes:[50],maxRaises:1,iterations:10000,checkEvery:100,accuracy:.1});
function setup(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pokerlab-lab-api-')),id=crypto.randomUUID(),api=createProAPI({root,json:(res,value,status=200)=>{res.value=value;res.status=status;},body:async req=>req.payload??{}});
 const write=(folder,record)=>{const dir=path.join(root,'data','pro',folder);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,record.id+'.json'),JSON.stringify(record));};
 const get=(folder,id)=>JSON.parse(fs.readFileSync(path.join(root,'data','pro',folder,id+'.json')));
 write('jobs',{id,status:'complete',scenario,settings:solveSettings(result.input)});fs.mkdirSync(path.join(root,'data','pro','jobs',id),{recursive:true});fs.writeFileSync(path.join(root,'data','pro','jobs',id,'result.json'),JSON.stringify(result));
 t.after(async()=>{api.shutdown();await new Promise(r=>setTimeout(r,100));const checked=path.resolve(root);assert.ok(checked.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(checked,{recursive:true,force:true});});
 const call=async(route,payload,method=payload===undefined?'GET':'POST')=>{const res={};const handled=await api.handler({method,payload},res,new URL(route,'http://localhost'));assert.equal(handled,true,route);return res.value;};
 const question=()=>call('/api/pro/training/range-question',{jobId:id});
 const submit=q=>call('/api/pro/training/range-attempt',{jobId:id,sourceFingerprint:q.sourceFingerprint,confidence:90,assignments:q.publicQuestion.combos.filter(c=>c.editable).map(c=>({combo:c.combo,probabilities:Object.fromEntries(q.publicQuestion.actions.map((a,i)=>[a.id,i===0?1:0]))}))});
 return {root,id,api,call,write,get,question,submit};
}
test('range question withholds reference answers; submissions bind the fingerprint and grade on the server',async t=>{
 const h=setup(t),q=await h.question();assert.ok(q.publicQuestion.combos.length>=2);assert.ok(!JSON.stringify(q).includes('actionEV'));assert.ok(!JSON.stringify(q).includes('referenceProbabilities'));
 const {attempt,grade}=await h.submit(q);assert.equal(attempt.grade.metrics.localRegretBB,grade.metrics.localRegretBB);assert.equal(attempt.confidence,90);assert.equal(attempt.id.length,36);assert.equal((await h.call('/api/pro/training/range-attempts')).length,1);
 await assert.rejects(h.call('/api/pro/training/range-attempt',{jobId:h.id,confidence:100,sourceFingerprint:'0'.repeat(64),assignments:attempt.submission.assignments}),/参考策略/);
 await assert.rejects(h.call('/api/pro/training/range-attempt',{jobId:h.id,confidence:100,assignments:attempt.submission.assignments,grade:{metrics:{localRegretBB:0}}}),/原始范围题/);
 assert.equal(fs.readdirSync(path.join(h.root,'data/pro/range-attempts')).length,1);
});
test('independent range evaluation runs in its own worker, validates complete policy and can be cancelled',async t=>{
 const h=setup(t),{attempt}=await h.submit(await h.question());
 const evaluation=await h.call(`/api/pro/training/range-attempts/${attempt.id}/evaluate`,{});assert.equal(evaluation.status,'running');
 const rejected=await h.call('/api/pro/solve',{scenario,settings:{engine:'riverlab'}});assert.match(rejected.error,/策略任务/);
 let view;for(let i=0;i<150;i++){view=await h.call(`/api/pro/training/range-evaluations/${evaluation.id}`);if(view.status!=='running')break;await new Promise(r=>setTimeout(r,20));}
 assert.equal(view.status,'complete',view.error);assert.equal(view.result.independentEvaluation.status,'complete');assert.ok(view.result.independentEvaluation.verification.rootChangeIdentityDifferenceBB<1e-8);assert.equal(view.result.responseWitness.status,'complete');assert.equal(view.result.responseWitness.source.jobId,h.id);assert.ok(view.result.responseWitness.verification.gainDecompositionDifferenceBB<1e-8);
 const prescription=await h.call('/api/pro/learning-plan'),rangeAdvice=prescription.recommendations.find(x=>x.kind==='range-audit');assert.ok(rangeAdvice,JSON.stringify(prescription));assert.match(rangeAdvice.why,/适应代价/);
 const stored=h.get('range-attempts',attempt.id);assert.equal(stored.grade.independentEvaluation,undefined,'joining the completed evaluation must not rewrite the original submission');
 const actualEvaluation=h.get('range-evaluations',evaluation.id);actualEvaluation.attemptId=crypto.randomUUID();h.write('range-evaluations',actualEvaluation);const wrong=(await h.call('/api/pro/learning-plan')).recommendations.find(x=>x.kind==='range-audit');assert.ok(!wrong.why.includes('适应代价'));actualEvaluation.attemptId=attempt.id;h.write('range-evaluations',actualEvaluation);
 const again=await h.call(`/api/pro/training/range-attempts/${attempt.id}/evaluate`,{}),cancelled=await h.call(`/api/pro/training/range-evaluations/${again.id}/cancel`,{});assert.equal(cancelled.status,'cancelling');await new Promise(r=>setTimeout(r,100));assert.equal((await h.call(`/api/pro/training/range-evaluations/${again.id}`)).status,'cancelled');
});
test('play API is blind across lists and recommendations, resumes safely, and rejects double decisions',async t=>{
 const h=setup(t),s=await h.call('/api/pro/play/sessions',{jobId:h.id,heroSeat:0,focusCombo:'AcKc',feedbackMode:'end'});assert.equal(s.status,'playing');assert.ok(!JSON.stringify(s).includes('actionEV'));assert.ok(!JSON.stringify(s).includes('privateHands'));assert.equal(s.review,undefined);
 const body={decisionId:s.decision.id,actionId:s.decision.actions.find(a=>a.id!=='check')?.id??s.decision.actions[0].id,confidence:70,reason:'先试探后再决定'};
 const results=await Promise.allSettled([h.call(`/api/pro/play/sessions/${s.id}/step`,body),h.call(`/api/pro/play/sessions/${s.id}/step`,body)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(h.get('play-sessions',s.id).decisions.length,1);
 const current=await h.call(`/api/pro/play/sessions/${s.id}`);if(current.status==='playing'){assert.equal(current.summary,undefined);assert.equal((await h.call('/api/pro/play/sessions'))[0].summary,undefined);assert.equal((await h.call('/api/pro/learning-plan')).evidenceSummary.all.records,0);}
 const ended=await h.call(`/api/pro/play/sessions/${s.id}/finish`,{});assert.ok(['complete','abandoned'].includes(ended.status));assert.equal(ended.review.decisions.length,1);
 const next=await h.call(`/api/pro/play/sessions/${s.id}/next`,{});assert.notEqual(next.id,s.id);assert.equal(next.parentId,s.id);
});
test('source model changes invalidate both blind modes even after a cached reference was loaded',async t=>{
 const h=setup(t);await h.question();const session=await h.call('/api/pro/play/sessions',{jobId:h.id,heroSeat:0});const job=h.get('jobs',h.id);job.scenario.pot++;h.write('jobs',job);
 await assert.rejects(h.question(),/底池.*不一致/);await assert.rejects(h.call(`/api/pro/play/sessions/${session.id}`),/底池.*不一致/);
});
test('projects preserve predictions and reject invented references or pre-conclusion retests',async t=>{
 const h=setup(t),old=await h.submit(await h.question());const project=await h.call('/api/pro/study-projects',{question:'范围变宽时能多大尺度诈唬？',source:{kind:'job',id:h.id}}),route=`/api/pro/study-projects/${project.id}/events`;
 assert.equal(project.summary.phase,'prediction');await assert.rejects(h.call(route,{kind:'evidence',source:{kind:'job',id:crypto.randomUUID()},summary:'伪证据',userAssessment:'supports'}),/找不到/);
 await h.call(route,{kind:'prediction',statement:'对手保留更多抓诈唬牌会减少大尺度诈唬',confidence:60,reportedExposure:'unseen'});
 await h.call(route,{kind:'evidence',source:{kind:'range-attempt',id:old.attempt.id},summary:'固定模型的局部范围收益',userAssessment:'inconclusive'});
 await h.call(route,{kind:'conclusion',conditionalRule:'先核对跟注范围再调整',appliesWhen:'同一行动树与投入',exceptions:'不能跨范围先验迁移'});
 await assert.rejects(h.call(route,{kind:'retest',source:{kind:'range-attempt',id:old.attempt.id}}),/结论之后/);
 await h.call(route,{kind:'field-plan',cue:'遇到河牌下注',check:'先说出会跟的更差组合',reviewAfterDays:1});
 await h.call(route,{kind:'field-observation',encountered:true,executed:true,note:'已记录检查步骤'});
 const fresh=await h.submit(await h.question()),retested=await h.call(route,{kind:'retest',source:{kind:'range-attempt',id:fresh.attempt.id},createdAt:'1999-01-01',score:100});
 assert.equal(retested.summary.phase,'complete');assert.equal(retested.events.at(-1).verification,'linked-attempt-after-conclusion');assert.equal(retested.events.at(-1).attemptedAt,fresh.attempt.createdAt);assert.equal(retested.events.at(-1).score,undefined);assert.equal(retested.events[0].statement,'对手保留更多抓诈唬牌会减少大尺度诈唬');
});
test('pending and interrupted play cannot be used to reveal research evidence or count as training',async t=>{
 const h=setup(t),s=await h.call('/api/pro/play/sessions',{jobId:h.id,heroSeat:0});await assert.rejects(h.call('/api/pro/study-projects',{question:'提前偷看',source:{kind:'play-session',id:s.id}}),/先完成或结束/);
 const raw=h.get('play-sessions',s.id);raw.status='interrupted';raw.interruptionReason='完整参考缺失';h.write('play-sessions',raw);
 const view=await h.call(`/api/pro/play/sessions/${s.id}`);assert.equal(view.recoverable,false);assert.equal(view.review,undefined);assert.equal(view.summary,undefined);assert.equal((await h.call('/api/pro/learning-plan')).evidenceSummary.all.records,0);
 await assert.rejects(h.call(`/api/pro/play/sessions/${s.id}/next`,{}),/参考缺失或中断/);
});
