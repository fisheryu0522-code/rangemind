import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {exportUserData,createLocalBackup,listLocalBackups,restoreUserData,restoreLocalBackup,backupFile} from '../lib/backup.mjs';
import {solveRiverGame} from '../lib/river-engine.mjs';
import {solveTurnGame,prepareTurnGame} from '../lib/turn-engine.mjs';
import {createRangeConstruction,gradeRangeConstruction,evaluateRangeConstruction} from '../lib/strategy-construction.mjs';
import {createPlaySession,advancePlaySession} from '../lib/play-session.mjs';
import {createStudyProject,applyStudyProjectEvent,summarizeStudyProject,buildLearningPlan} from '../lib/learning-plan.mjs';
import {gradeAttempt} from '../lib/curriculum.mjs';
import {buildResponseWitness} from '../lib/response-witness.mjs';
import {parseScenario,IMPORT_EXAMPLES} from '../lib/scenario.mjs';
import {parseHandHistoryBatch} from '../lib/hand-history-batch.mjs';
import {assertInputProvenance} from '../lib/input-provenance.mjs';

const scenario={title:'备份核验',board:'Ks7h2d9c3s',pot:10,hero:'AcKd',heroSeat:0,toAct:0,players:[{id:'a',name:'A',position:'BB',stack:20,range:'AcKd'},{id:'b',name:'B',position:'BTN',stack:20,range:'AhQh'}]};
const setup=t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pokerlab-backup-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;};
const write=(root,folder,id,value)=>{const dir=path.join(root,'data','pro',folder);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify(value));};
const result=(root,id)=>{const dir=path.join(root,'data','pro','jobs',id);fs.mkdirSync(dir,{recursive:true});const value={engine:'test fixture',nodes:[{id:'n0',terminal:true}],input:scenario};fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(value));return value;};

test('full backup restores dependencies and exact stored results, preserving existing records',t=>{
 const src=setup(t),dst=setup(t),job=crypto.randomUUID(),card=crypto.randomUUID(),caseId=crypto.randomUUID(),attempt=crypto.randomUUID();
 write(src,'jobs',job,{id:job,status:'complete',scenario,processId:999});const original=result(src,job);
 write(src,'cases',caseId,{id:caseId,title:'源案例',scenario,inputContext:{ledger:[{street:'flop',amount:3}]},jobId:job});
 write(src,'study-cards',card,{id:card,jobId:job,full:{answer:'check'},publicQuestion:{options:['check']}});
 write(src,'study-attempts',attempt,{id:attempt,cardId:card,choice:'check'});
 write(dst,'cases',caseId,{id:caseId,title:'用户已修改，不得覆盖',scenario});
 const report=restoreUserData(dst,exportUserData(src,{includeResults:true}));assert.equal(report.skipped,1);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dst,'data/pro/cases',caseId+'.json'))).title,'用户已修改，不得覆盖');
 const restored=JSON.parse(fs.readFileSync(path.join(dst,'data/pro/jobs',job+'.json')));assert.equal(restored.status,'complete');assert.equal(restored.processId,undefined);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dst,'data/pro/jobs',job,'result.json'))),original);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dst,'data/pro/study-attempts',attempt+'.json'))).cardId,card);
 assert.equal(listLocalBackups(dst).length,1);
});

test('metadata-only restore never claims a missing or running solve completed',t=>{
 const src=setup(t),dst=setup(t),id=crypto.randomUUID();write(src,'jobs',id,{id,status:'complete',scenario});
 restoreUserData(dst,exportUserData(src));const job=JSON.parse(fs.readFileSync(path.join(dst,'data/pro/jobs',id+'.json')));assert.equal(job.status,'interrupted');assert.match(job.error,/没有完整求解树/);
});

test('invalid record anywhere rejects restore before any record is imported',t=>{
 const dst=setup(t),id=crypto.randomUUID(),backup={app:'PokerLab',schemaVersion:2,records:{cases:[{id,scenario}],training:[{id:'../../escape',lessonId:'test'}]},results:{}};
 assert.throws(()=>restoreUserData(dst,backup),/无效记录/);assert.equal(fs.existsSync(path.join(dst,'data/pro/cases',id+'.json')),false);
 assert.throws(()=>backupFile(dst,'../../escape'),/无效/);
});

test('compressed local backup is restorable and explicitly reports result coverage',t=>{
 const root=setup(t),id=crypto.randomUUID();write(root,'cases',id,{id,scenario,inputContext:{raw:'原始牌谱'}});
 const backup=createLocalBackup(root);assert.equal(backup.includesResults,true);assert.ok(backup.bytes>0);assert.equal(listLocalBackups(root)[0].name,backup.name);
 fs.unlinkSync(path.join(root,'data/pro/cases',id+'.json'));const restored=restoreLocalBackup(root,backup.name);assert.equal(restored.imported,1);
 assert.equal(JSON.parse(fs.readFileSync(path.join(root,'data/pro/cases',id+'.json'))).inputContext.raw,'原始牌谱');
});

test('restoration rejects mismatched mathematical models before writing any case, while range archives preserve weights',t=>{
 const src=setup(t),dst=setup(t),job=crypto.randomUUID(),caseId=crypto.randomUUID(),rangeId=crypto.randomUUID();write(src,'jobs',job,{id:job,status:'complete',scenario});result(src,job);write(src,'cases',caseId,{id:caseId,scenario});write(src,'ranges',rangeId,{id:rangeId,title:'手动范围假设',range:'AKs:25%,AhKh:75%',format:'live',position:'BTN',source:'用户范围假设',notes:'范围来源保留',createdAt:'2026-09-28T00:00:00Z',updatedAt:'2026-09-28T00:00:00Z',archived:true});
 const backup=exportUserData(src,{includeResults:true});backup.results[job].input.pot++;assert.throws(()=>restoreUserData(dst,backup),/底池.*不一致/);assert.equal(fs.existsSync(path.join(dst,'data/pro/cases',caseId+'.json')),false);backup.results[job].input.pot--;restoreUserData(dst,backup);const r=JSON.parse(fs.readFileSync(path.join(dst,'data/pro/ranges',rangeId+'.json')));assert.equal(r.range,'AKs:25%,AhKh:75%');assert.equal(r.weighted,1.5);assert.equal(r.archived,true);assert.equal(r.createdAt,'2026-09-28T00:00:00Z');
});

test('a backup tree cannot be attached to an existing same-ID job with a different preserved model',t=>{
 const src=setup(t),dst=setup(t),id=crypto.randomUUID();write(src,'jobs',id,{id,status:'complete',scenario});result(src,id);write(dst,'jobs',id,{id,status:'interrupted',scenario:{...scenario,pot:999}});
 assert.throws(()=>restoreUserData(dst,exportUserData(src,{includeResults:true})),/底池.*不一致/);
 assert.equal(fs.existsSync(path.join(dst,'data/pro/jobs',id,'result.json')),false);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dst,'data/pro/jobs',id+'.json'))).scenario.pot,999);
});

let modelPromise;
const actualModel=()=>modelPromise??=solveRiverGame({...scenario,sizes:[50],raiseSizes:[],allIn:false,maxRaises:0,iterations:100,averagingDelay:0,accuracy:.1});
const load=(root,folder,id)=>JSON.parse(fs.readFileSync(path.join(root,'data','pro',folder,id+'.json'),'utf8'));
async function newFixture(t){
 const src=setup(t),r=structuredClone(await actualModel()),job=crypto.randomUUID(),attemptId=crypto.randomUUID(),now=Date.parse('2026-09-28T00:00:00Z');
 write(src,'jobs',job,{id:job,status:'complete',scenario,settings:r.input});fs.mkdirSync(path.join(src,'data/pro/jobs',job),{recursive:true});fs.writeFileSync(path.join(src,'data/pro/jobs',job,'result.json'),JSON.stringify(r));
 const question=createRangeConstruction(scenario,r).publicQuestion,submission={sourceFingerprint:question.sourceFingerprint,nodeId:'n0',weighting:'observed',assignments:question.combos.filter(c=>c.editable).map(c=>({combo:c.combo,probabilities:question.actions.map((_,i)=>i===0?1:0)}))},grade=gradeRangeConstruction(scenario,r,submission);
 const attempt={id:attemptId,kind:'range-attempt',jobId:job,createdAt:new Date(now).toISOString(),nodeId:'n0',nodePath:[],sourceFingerprint:grade.sourceFingerprint,weighting:'observed',reportedExposure:'seen',confidence:80,reason:'指定条件下先保留 check 范围',submission,grade,quality:grade.quality,source:{jobId:job,title:scenario.title,nodeId:'n0'},projectId:null,evaluationId:null};write(src,'range-attempts',attempt.id,attempt);
 const playing=createPlaySession(scenario,r,{jobId:job,focusCombo:scenario.hero},{id:crypto.randomUUID(),seed:7,now});write(src,'play-sessions',playing.id,playing);
 let complete=createPlaySession(scenario,r,{jobId:job,focusCombo:scenario.hero},{id:crypto.randomUUID(),seed:7,now});for(let i=0;i<20&&complete.status==='playing';i++){const node=r.nodes.find(n=>n.id===complete.currentNodeId);complete=advancePlaySession(complete,r,{decisionId:complete.decision.id,actionId:node.actions[0].id,confidence:90,reason:'按可见信息判断'},{now:now+(i+1)*1000});}assert.equal(complete.status,'complete');write(src,'play-sessions',complete.id,complete);
 let p=createStudyProject({question:'只改变当前范围分工会如何影响后续响应？',source:{kind:'range-attempt',id:attempt.id,jobId:job}},{id:crypto.randomUUID(),now});
 const push=(event,h)=>p=applyStudyProjectEvent(p,event,{eventId:crypto.randomUUID(),now:now+h*3600000});push({kind:'prediction',statement:'把更多强牌留在过牌，原始过牌范围的组成应改变。',confidence:70,reportedExposure:'seen'},1);push({kind:'evidence',source:{kind:'range-attempt',id:attempt.id,jobId:job},summary:'原始与提交范围按同一固定对手模型比较。',userAssessment:'inconclusive'},2);push({kind:'conclusion',conditionalRule:'仅能在固定后续策略条件下解释局部 EV。',appliesWhen:'使用本次完整源树',exceptions:'对手调整或其他街策略改变后重新评估'},3);write(src,'study-projects',p.id,p);
 return {src,r,job,attempt,playing,complete,project:p,submission,now};
}

test('new training records round-trip against a real complete strategy with source and decision feedback intact',async t=>{
 const f=await newFixture(t),dst=setup(t),backup=exportUserData(f.src,{includeResults:true});assert.equal(backup.records['play-sessions'].length,2);assert.equal(backup.records['range-attempts'].length,1);assert.equal(backup.records['study-projects'].length,1);assert.ok(backup.results[f.job]);restoreUserData(dst,backup);
 const a=load(dst,'range-attempts',f.attempt.id),p=load(dst,'play-sessions',f.playing.id),done=load(dst,'play-sessions',f.complete.id),project=load(dst,'study-projects',f.project.id);assert.equal(a.integrity.referenceVerified,true);assert.equal(a.reportedExposure,'seen');assert.equal(p.status,'playing');assert.deepEqual(p.privateHands,f.playing.privateHands);assert.deepEqual(done.decisions,f.complete.decisions);assert.equal(done.integrity.referenceVerified,true);assert.equal(project.sourceFingerprint,f.project.sourceFingerprint);assert.equal(project.integrity.referenceVerified,true);assert.equal(project.events.length,3);
 const repeat=restoreUserData(dst,backup);assert.ok(repeat.skipped>=5);assert.equal(repeat.imported,0);
});

test('metadata-only backup keeps historical work but interrupts practice and does not invent verified reference quality',async t=>{
 const f=await newFixture(t),dst=setup(t);restoreUserData(dst,exportUserData(f.src));const a=load(dst,'range-attempts',f.attempt.id),p=load(dst,'play-sessions',f.playing.id),done=load(dst,'play-sessions',f.complete.id);assert.equal(a.referenceAvailable,false);assert.equal(a.integrity.referenceVerified,false);assert.deepEqual(a.grade,f.attempt.grade);assert.equal(p.status,'interrupted');assert.equal(p.previousStatus,'playing');assert.equal(p.recoverable,false);assert.equal(p.decision,null);assert.deepEqual(p.privateHands,f.playing.privateHands);assert.equal(done.previousStatus,'complete');assert.deepEqual(done.decisions,f.complete.decisions);
 const plan=buildLearningPlan({rangeAttempts:[a],playSessions:[p,done]},{now:f.now+86400000});assert.equal(plan.evidenceSummary.all.records,1);assert.equal(plan.evidenceSummary.all.provisional,1);assert.ok(plan.recommendations.some(x=>x.kind==='verify-reference'));
});

test('tampered range grades and omitted play decisions reject the entire import before any writes',async t=>{
 const f=await newFixture(t),original=exportUserData(f.src,{includeResults:true});
 for(const mutate of [b=>b.records['range-attempts'][0].grade.metrics.localRegretBB++,b=>b.records['range-attempts'][0].submission.assignments[0].probabilities=[0,1],b=>b.records['play-sessions'].find(s=>s.status==='complete').decisions.splice(0,1),b=>b.records['play-sessions'].find(s=>s.status==='complete').decisions[0].feedback.selectedEV+=1]){
  const dst=setup(t),b=structuredClone(original);mutate(b);assert.throws(()=>restoreUserData(dst,b),/不一致|原始参考|遗漏/);assert.equal(fs.existsSync(path.join(dst,'data','pro')),false);assert.equal(fs.existsSync(path.join(dst,'data','backups')),false);
 }
});

test('same mathematical input but different preserved policy cannot be attached to incoming practice or range records',async t=>{
 const f=await newFixture(t),dst=setup(t);write(dst,'jobs',f.job,{id:f.job,status:'complete',scenario,settings:f.r.input});const changed=structuredClone(f.r);changed.nodes[0].combos[0].probabilities=[.123,.877];fs.mkdirSync(path.join(dst,'data/pro/jobs',f.job),{recursive:true});fs.writeFileSync(path.join(dst,'data/pro/jobs',f.job,'result.json'),JSON.stringify(changed));
 assert.throws(()=>restoreUserData(dst,exportUserData(f.src,{includeResults:true})),/参考策略|原始参考|策略指纹/);assert.equal(fs.existsSync(path.join(dst,'data/pro/range-attempts',f.attempt.id+'.json')),false);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dst,'data/pro/jobs',f.job,'result.json'))),changed);
});

test('missing source job rejects new training references rather than manufacturing a different scenario',async t=>{
 const f=await newFixture(t),b=exportUserData(f.src);b.records.jobs=[];assert.throws(()=>restoreUserData(setup(t),b),/缺少源求解记录/);
});

test('running independent evaluations restore as interrupted and every stale process identity is cleared',async t=>{
 const f=await newFixture(t),id=crypto.randomUUID(),dst=setup(t);write(f.src,'range-evaluations',id,{id,kind:'range-evaluation',attemptId:f.attempt.id,jobId:f.job,status:'running',createdAt:new Date(f.now).toISOString(),processId:111,progress:{phase:'running',processId:222,pid:333}});restoreUserData(dst,exportUserData(f.src,{includeResults:true}));const e=load(dst,'range-evaluations',id);assert.equal(e.status,'interrupted');assert.equal(e.processId,undefined);assert.equal(e.progress.processId,undefined);assert.equal(e.progress.pid,undefined);assert.equal(e.integrity.independentRecomputed,false);
});

test('actual independent evaluation restores only if source grade and best-response arithmetic agree',async t=>{
 const f=await newFixture(t),id=crypto.randomUUID(),evaluation=await evaluateRangeConstruction(scenario,f.r,f.submission);assert.equal(evaluation.independentEvaluation.status,'complete');write(f.src,'range-evaluations',id,{id,kind:'range-evaluation',attemptId:f.attempt.id,jobId:f.job,status:'complete',createdAt:new Date(f.now).toISOString(),result:evaluation});const original=exportUserData(f.src,{includeResults:true}),dst=setup(t);restoreUserData(dst,original);assert.equal(load(dst,'range-evaluations',id).integrity.independentRecomputed,false);
 const bad=structuredClone(original);bad.records['range-evaluations'][0].result.independentEvaluation.submitted.gain[0]++;assert.throws(()=>restoreUserData(setup(t),bad),/偏离收益不一致/);
});

test('study-project replay checks actual retest timing and cannot trust an edited success flag',async t=>{
 const f=await newFixture(t),submission={lessonId:'raise-value-100',answer:'raise',reasonIds:['worse-continues','response-model'],confidence:80},a={id:crypto.randomUUID(),createdAt:new Date(f.now+3600000).toISOString(),...submission,...gradeAttempt(submission,{},f.now+3600000)};write(f.src,'training',a.id,a);const b=exportUserData(f.src,{includeResults:true}),p=b.records['study-projects'][0];p.events.push({id:crypto.randomUUID(),kind:'retest',createdAt:new Date(f.now+5*3600000).toISOString(),source:{kind:'course-attempt',id:a.id},conclusionId:p.events.at(-1).id,verification:'linked-attempt-after-conclusion',correct:true});p.updatedAt=p.events.at(-1).createdAt;assert.throws(()=>restoreUserData(setup(t),b),/旧作答/);
});

test('simulated winnings are independently settled from the private deal and cannot be edited to change the outcome',async t=>{
 const f=await newFixture(t),b=exportUserData(f.src,{includeResults:true}),done=b.records['play-sessions'].find(s=>s.status==='complete');done.outcome.heroNet+=100;const dst=setup(t);assert.throws(()=>restoreUserData(dst,b),/模拟终局结算/);assert.equal(fs.existsSync(path.join(dst,'data','pro')),false);
});

test('imported teaching prose is regenerated from the checked range grade, never trusted as mathematical evidence',async t=>{
 const f=await newFixture(t),backup=exportUserData(f.src,{includeResults:true}),dst=setup(t);backup.records['range-attempts'][0].grade.coaching={headline:'伪造的必胜承诺',focus:[{localRegretBB:-1000}]};restoreUserData(dst,backup);const actual=load(dst,'range-attempts',f.attempt.id);assert.equal(actual.grade.coaching.kind,'range-learning-debrief');assert.notEqual(actual.grade.coaching.headline,'伪造的必胜承诺');assert.ok(actual.grade.coaching.focus.every(f=>f.localRegretBB>=0));
});

test('three-player turn all-in with unequal stacks and fixed capped rake restores a legal runout and conserved settlement',async t=>{
 const s={title:'多人全下备份核验',board:'2c3d7h9s',pot:12,toAct:0,heroSeat:0,hero:'AsAh',rake:5,rakeCap:.3,players:[{id:'a',name:'Hero',position:'SB',stack:4,range:'AsAh'},{id:'b',name:'B',position:'BB',stack:8,range:'KcKd'},{id:'c',name:'C',position:'BTN',stack:12,range:'QhQc'}]},input={...s,sizes:[100],raiseSizes:[],riverSizes:[],riverRaiseSizes:[],maxRaises:0,riverMaxRaises:0,allIn:true,iterations:2,averagingDelay:0,accuracy:.1},p=prepareTurnGame(input),locks=p.nodes.filter(n=>n.actor>0).map(n=>({nodeId:n.id,probabilities:n.actions.map(a=>a.id==='call'||a.id==='check'?1:0)})).filter(l=>l.probabilities.reduce((a,b)=>a+b,0)===1),r=await solveTurnGame({...input,locks}),src=setup(t),dst=setup(t),job=crypto.randomUUID();write(src,'jobs',job,{id:job,status:'complete',scenario:s,settings:r.input});fs.mkdirSync(path.join(src,'data/pro/jobs',job),{recursive:true});fs.writeFileSync(path.join(src,'data/pro/jobs',job,'result.json'),JSON.stringify(r));let session=createPlaySession(s,r,{jobId:job},{id:crypto.randomUUID(),seed:47});const allIn=r.nodes[0].actions.find(a=>a.allIn);assert.ok(allIn);session=advancePlaySession(session,r,{decisionId:session.decision.id,actionId:allIn.id,confidence:70});assert.equal(session.status,'complete');write(src,'play-sessions',session.id,session);restoreUserData(dst,exportUserData(src,{includeResults:true}));const restored=load(dst,'play-sessions',session.id);assert.equal(restored.outcome.board.length,10);assert.equal(restored.outcome.fixedRake,.3);assert.deepEqual(restored.outcome,session.outcome);assert.ok(Math.abs(restored.outcome.net.reduce((a,b)=>a+b,0)-11.7)<1e-8);
});

test('a zero-reference Hero turn bet can continue to a legal river and restore only with its reconstructed provisional feedback and exposure history',async t=>{
 const s={title:'零频分支恢复',board:'2c3d7h9s',pot:12,toAct:0,heroSeat:0,hero:'AsAh',players:[{id:'a',name:'Hero',position:'BB',stack:20,range:'AsAh'},{id:'b',name:'Villain',position:'BTN',stack:20,range:'KcKd'}]},input={...s,sizes:[50],raiseSizes:[],riverSizes:[],riverRaiseSizes:[],maxRaises:0,riverMaxRaises:0,allIn:false,iterations:2,averagingDelay:0,accuracy:100},original=await solveTurnGame(input),locks=original.nodes.filter(n=>n.actor>=0).flatMap(n=>n.combos.map(c=>({nodeId:n.id,combo:c.combo,probabilities:n.actions.map(a=>a.id==='check'||a.id==='call'?1:0)}))),r=await solveTurnGame({...original.input,locks,evaluationOnly:true,iterations:1});
 // Import an independently evaluated complete fixed policy as an unconstrained
 // study reference. The original zero-frequency Hero bet remains legal.
 r.input={...original.input,locks:[]};for(const n of r.nodes)for(const c of n.combos??[])c.locked=false;
 const src=setup(t),job=crypto.randomUUID();write(src,'jobs',job,{id:job,status:'complete',scenario:s,settings:r.input});fs.mkdirSync(path.join(src,'data/pro/jobs',job),{recursive:true});fs.writeFileSync(path.join(src,'data/pro/jobs',job,'result.json'),JSON.stringify(r));let session=createPlaySession(s,r,{jobId:job,reportedExposure:'seen'},{id:crypto.randomUUID(),seed:14});const bet=r.nodes[0].actions.find(a=>a.type==='bet');session=advancePlaySession(session,r,{decisionId:session.decision.id,actionId:bet.id,confidence:70});assert.equal(session.status,'playing');assert.equal(session.decisions[0].feedback.referenceKind,'fixed-reference-continuation');assert.equal(session.decisions[0].feedback.quality.provisional,session.source.quality.provisional);assert.equal(session.decisions[0].feedback.nextContinuationWarning.childNodeId,bet.childId);assert.equal(session.decision.reportedExposure,'unknown');assert.ok(session.referenceWarnings.some(w=>w.reason==='zero-or-missing-opponent-counterfactual-reach'));write(src,'play-sessions',session.id,session);
 const mid=setup(t);restoreUserData(mid,exportUserData(src,{includeResults:true}));assert.deepEqual(load(mid,'play-sessions',session.id).referenceWarnings,session.referenceWarnings);
 session=advancePlaySession(session,r,{decisionId:session.decision.id,actionId:'check',confidence:80});assert.equal(session.status,'complete');assert.equal(session.decisions[1].feedback.referenceKind,'off-reference-fixed-continuation');assert.equal(session.decisions[1].reportedExposure,'unknown');assert.equal(session.decisions[1].feedback.quality.provisional,true);write(src,'play-sessions',session.id,session);const complete=exportUserData(src,{includeResults:true}),dst=setup(t);restoreUserData(dst,complete);assert.deepEqual(load(dst,'play-sessions',session.id).decisions,session.decisions);
 for(const mutate of [p=>p.referenceWarnings=[],p=>p.decisions[1].feedback.quality.provisional=false,p=>p.decisions[1].reportedExposure='seen',p=>p.source.startingNodeId='n999',p=>delete p.decisions[0].feedback.nextContinuationWarning,p=>p.decisions[0].feedback.nextContinuationWarning.childNodeId='n999']){const b=structuredClone(complete);mutate(b.records['play-sessions'][0]);const rejected=setup(t);assert.throws(()=>restoreUserData(rejected,b),/不一致|格式无效/);assert.equal(fs.existsSync(path.join(rejected,'data','pro')),false);}
});

test('a zero-frequency terminal fold preserves its real model correction and never manufactures future-path uncertainty on restore',async t=>{
 const s={title:'零频弃牌仍可纠错',board:'2c3d7h9sJc',pot:12,toAct:0,heroSeat:1,hero:'AsAh',players:[{id:'a',name:'Villain',position:'BB',stack:20,range:'KcKd'},{id:'b',name:'Hero',position:'BTN',stack:20,range:'AsAh'}]},r=await solveRiverGame({...s,sizes:[50],raiseSizes:[],maxRaises:0,allIn:false,iterations:1000,averagingDelay:50,accuracy:.1,locks:[{nodeId:'n0',actions:{bet_6:1}}]}),src=setup(t),job=crypto.randomUUID();
 write(src,'jobs',job,{id:job,status:'complete',scenario:s,settings:r.input});fs.mkdirSync(path.join(src,'data/pro/jobs',job),{recursive:true});fs.writeFileSync(path.join(src,'data/pro/jobs',job,'result.json'),JSON.stringify(r));
 let session=createPlaySession(s,r,{jobId:job},{id:crypto.randomUUID(),seed:37});session=advancePlaySession(session,r,{decisionId:session.decision.id,actionId:'fold',confidence:95});
 const feedback=session.decisions[0].feedback;assert.equal(session.status,'complete');assert.equal(feedback.selectedReferenceProbability,0);assert.equal(feedback.selectedEV,0);assert.equal(feedback.loss,18);assert.equal(feedback.quality.provisional,false);assert.equal(feedback.referenceKind,'fixed-reference-continuation');assert.deepEqual(session.referenceWarnings,[]);assert.equal(feedback.nextContinuationWarning,undefined);
 write(src,'play-sessions',session.id,session);const original=exportUserData(src,{includeResults:true}),dst=setup(t);restoreUserData(dst,original);assert.deepEqual(load(dst,'play-sessions',session.id).decisions,session.decisions);
 const plan=buildLearningPlan({playSessions:[load(dst,'play-sessions',session.id)]},{now:Date.now()+1000});assert.ok(plan.recommendations.some(r=>r.kind==='investigate'&&r.observed.localModelLossBB===18));
 for(const mutate of [p=>p.decisions[0].feedback.quality.provisional=true,p=>p.decisions[0].feedback.nextContinuationWarning={reason:'hero-selected-zero-reference-action',childNodeId:p.currentNodeId}]){const bad=structuredClone(original);mutate(bad.records['play-sessions'][0]);const target=setup(t);assert.throws(()=>restoreUserData(target,bad),/不一致/);assert.equal(fs.existsSync(path.join(target,'data','pro')),false);}
});

test('project retests use the actual completed session time, while missing strategy dependencies preserve history without verified completion',async t=>{
 const f=await newFixture(t),H=3600000;let session=createPlaySession(scenario,f.r,{jobId:f.job},{id:crypto.randomUUID(),seed:7,now:f.now+H});
 for(let i=0;i<20&&session.status==='playing';i++){const node=f.r.nodes.find(n=>n.id===session.currentNodeId);session=advancePlaySession(session,f.r,{decisionId:session.decision.id,actionId:node.actions[0].id,confidence:75},{now:f.now+4*H+i*1000});}
 assert.equal(session.status,'complete');assert.ok(session.decisions.length);write(f.src,'play-sessions',session.id,session);
 const projects=[];
 for(const kind of ['play-session','play-decision']){
  const source=kind==='play-session'?{kind,id:session.id}:{kind,id:session.decisions[0].id,sessionId:session.id},attemptedAt=kind==='play-session'?session.completedAt:session.decisions[0].answeredAt;
  let p=createStudyProject({question:'研究后的新决策是否支持原条件判断？',source:{kind:'manual'}},{id:crypto.randomUUID(),now:f.now});
  const push=(e,h,resolvedRetest)=>p=applyStudyProjectEvent(p,e,{eventId:crypto.randomUUID(),now:f.now+h*H,resolvedRetest});
  push({kind:'prediction',statement:'条件不变时，先检查对手继续范围。',confidence:70},.1);
  push({kind:'evidence',source:{kind:'lesson',id:'raise-value-100'},summary:'明确题目给定的继续范围。',userAssessment:'inconclusive'},2);
  push({kind:'conclusion',conditionalRule:'使用固定响应模型时先列出继续范围。',appliesWhen:'范围和后续策略固定',exceptions:'实际响应或尺寸改变时重查'},3);
  push({kind:'field-plan',cue:'面对同类价值判断',check:'列出较差继续与更强响应'},3.2);
  push({kind:'field-observation',encountered:true,executed:true,note:'记录实际检查，不按本手输赢评分。'},3.5);
  push({kind:'retest',source,note:'这次作答晚于结论；不自动认定为24小时迁移。'},5,{sourceKind:kind,sourceId:source.id,sessionId:source.sessionId,createdAt:attemptedAt,timeResolution:kind==='play-session'?'session':'attempt'});
  assert.equal(summarizeStudyProject(p).phase,'complete');write(f.src,'study-projects',p.id,p);projects.push(p);
 }
 const complete=exportUserData(f.src,{includeResults:true}),dst=setup(t);restoreUserData(dst,complete);
 for(const p of projects){const restored=load(dst,'study-projects',p.id),last=restored.events.at(-1);assert.equal(restored.integrity.referenceVerified,true);assert.equal(last.attemptedAt,p.events.at(-1).attemptedAt);assert.equal(last.timeResolution,p.events.at(-1).timeResolution);assert.equal(last.verification,'linked-attempt-after-conclusion');assert.equal(summarizeStudyProject(restored).phase,'complete');}
 const legacy=structuredClone(complete);delete legacy.records['play-sessions'].find(s=>s.id===session.id).completedAt;const fallback=setup(t);restoreUserData(fallback,legacy);assert.equal(load(fallback,'study-projects',projects[0].id).events.at(-1).attemptedAt,session.updatedAt);
 const metadata=setup(t);restoreUserData(metadata,exportUserData(f.src));assert.equal(load(metadata,'play-sessions',session.id).status,'interrupted');
 for(const p of projects){const restored=load(metadata,'study-projects',p.id),last=restored.events.at(-1);assert.equal(restored.events.length,p.events.length);assert.equal(restored.integrity.referenceVerified,false);assert.ok(restored.integrity.unresolvedSources.some(s=>s.id===last.source.id&&s.reason==='source-reference-unverified'));assert.equal(last.verification,'unverified-timing');assert.equal(last.historicalAttemptedAt,p.events.at(-1).attemptedAt);assert.equal(last.restoration.referenceVerified,false);assert.equal(summarizeStudyProject(restored).phase,'retest');}
 const bad=structuredClone(complete);bad.records['play-sessions'].find(s=>s.id===session.id).completedAt=new Date(f.now-1).toISOString();const rejected=setup(t);assert.throws(()=>restoreUserData(rejected,bad),/完成时间/);assert.equal(fs.existsSync(path.join(rejected,'data','pro')),false);
});

test('cancelling and cleanup-required jobs, experiments and evaluations restore interrupted without any nested process identity',async t=>{
 const f=await newFixture(t),base=exportUserData(f.src,{includeResults:true});
 for(const status of ['running','queued','preparing','cancelling','cleanup-required']){
  const b=structuredClone(base),dst=setup(t),evalId=crypto.randomUUID(),experimentId=crypto.randomUUID(),processes={processId:1,processIds:[2,3],exitedProcessId:4,exitedProcessIds:[5],workerPid:6,nativePid:7,pid:8,pids:[9]};
  Object.assign(b.records.jobs[0],{status,...processes,progress:{phase:status,...processes},log:[{phase:'running',...processes}]});
  b.records.experiments=[{id:experimentId,sourceJobId:f.job,status,input:{scenario},...processes,progress:{phase:status,...processes}}];
  b.records['range-evaluations']=[{id:evalId,kind:'range-evaluation',attemptId:f.attempt.id,jobId:f.job,status,createdAt:new Date(f.now).toISOString(),...processes,progress:{phase:status,...processes}}];
  restoreUserData(dst,b);
  for(const [folder,id] of [['jobs',f.job],['experiments',experimentId],['range-evaluations',evalId]]){const record=load(dst,folder,id);assert.equal(record.status,'interrupted');assert.doesNotMatch(JSON.stringify(record),/"(?:processIds?|exitedProcessIds?|pids?|workerPid|nativePid)"/);assert.match(record.error,/恢复|重新/);}
 }
});

test('even a genuine complete response witness is unpublished on restore and injected witness claims cannot survive',async t=>{
 const f=await newFixture(t),evaluation=await evaluateRangeConstruction(scenario,f.r,f.submission),witness=buildResponseWitness(scenario,f.r,f.submission,{independentEvaluation:evaluation.independentEvaluation,jobId:f.job});
 assert.equal(witness.status,'complete');assert.ok(witness.verification.informationSetConsistent);evaluation.responseWitness=witness;
 const id=crypto.randomUUID();write(f.src,'range-evaluations',id,{id,kind:'range-evaluation',attemptId:f.attempt.id,jobId:f.job,status:'complete',createdAt:new Date(f.now).toISOString(),result:evaluation});
 for(const includeResults of [true,false]){
  const b=exportUserData(f.src,{includeResults}),dst=setup(t),fake={status:'complete',verification:{informationSetConsistent:true},meaning:'伪造的已核验教学解释',values:{opponentGainBB:999999}};
  b.records['range-attempts'][0].grade.responseWitness=fake;b.records['range-evaluations'][0].responseWitness=fake;b.records['range-evaluations'][0].result.independentEvaluation.responseWitness=fake;
  restoreUserData(dst,b);const attempt=load(dst,'range-attempts',f.attempt.id),e=load(dst,'range-evaluations',id);
  for(const w of [attempt.grade.responseWitness,e.responseWitness,e.result.responseWitness,e.result.independentEvaluation.responseWitness]){assert.equal(w.status,'unavailable');assert.equal(w.requiresIndependentEvaluation,true);assert.equal(w.values,undefined);assert.equal(w.verification,undefined);assert.equal(w.meaning,undefined);assert.match(w.reason,/重新/);}
  assert.doesNotMatch(JSON.stringify([attempt,e]),/伪造的已核验教学解释|"opponentGainBB":999999/);assert.equal(e.integrity.independentRecomputed,false);
 }
});

test('restored input provenance is rederived from raw text and trusted inbox records, never an imported verified flag',t=>{
 const src=setup(t),raw=IMPORT_EXAMPLES.find(e=>e.id==='stars-example').text.replace('PokerStars Hand #20260928001','Poker Hand #HDRESTORE'),hand={...parseHandHistoryBatch(raw).hands[0],id:crypto.randomUUID()},parsed=parseScenario(raw,{bigBlind:1}),caseId=crypto.randomUUID(),forkId=crypto.randomUUID();
 write(src,'hands',hand.id,hand);write(src,'cases',caseId,{id:caseId,scenario:parsed.scenario,inputContext:{raw,sourceHandId:hand.id,issues:[],ledger:[{amount:10000}],checked:true},inputProvenance:{sourceVerified:true,meaning:'盲信客户端'}});
 write(src,'cases',forkId,{id:forkId,scenario:{...parsed.scenario,pot:40},inputContext:{raw,sourceHandId:hand.id,provenance:{kind:'hypothetical-fork',reason:'研究不同底池假设'}},inputProvenance:{kind:'reparsed-source',sourceVerified:true}});
 const backup=exportUserData(src),dst=setup(t);restoreUserData(dst,backup);const c=load(dst,'cases',caseId),fork=load(dst,'cases',forkId);
 assert.equal(c.inputProvenance.kind,'reparsed-source');assert.equal(c.inputProvenance.sourceVerified,true);assert.equal(c.inputContext.sourceBigBlind,.25);assert.deepEqual(c.inputContext.ledger,parsed.ledger);assert.equal(c.inputContext.checked,undefined);assert.equal(c.inputProvenance.meaning,undefined);assert.equal(fork.inputProvenance.kind,'hypothetical-fork');assert.equal(fork.inputProvenance.sourceVerified,false);assert.equal(fork.inputContext.provenance.reason,'研究不同底池假设');
 // Existing local records win. A conflicting existing source cannot be replaced
 // by a client's convenient backup copy to preserve a verified label.
 const conflict=setup(t);write(conflict,'hands',hand.id,{...hand,raw:raw.replace('$3','$4')});restoreUserData(conflict,backup);const unmatched=load(conflict,'cases',caseId);assert.equal(unmatched.inputProvenance.sourceVerified,false);assert.equal(unmatched.inputProvenance.kind,'unverified-legacy');assert.equal(unmatched.inputContext.raw,raw);
});

test('old drafts and solved models with unresolved or missing source text survive restore only as unverified history',t=>{
 const src=setup(t),raw='六人桌现金局，SB/BB 为 0.5/1 BB。BTN 100 BB，SB 100 BB，BB 100 BB。其他人弃牌。BTN 加注到 3 BB，SB 跟注，BB 弃牌。翻牌 Qh Ts 7h，SB 过牌，BTN 下注 6 BB，SB 加注 18 BB。我在 SB，持 Ah Jh。',parsed=parseScenario(raw),draft=crypto.randomUUID(),job=crypto.randomUUID(),legacy=crypto.randomUUID(),manual=crypto.randomUUID(),source=crypto.randomUUID(),ctx={raw,issues:[],checked:true,verified:true};
 const s={...parsed.scenario,players:parsed.scenario.players.map((p,i)=>({...p,range:p.position==='SB'?'AhJh':'AcAd'}))};
 write(src,'cases',draft,{id:draft,scenario:parsed.scenario,inputContext:ctx,inputProvenance:{sourceVerified:true}});write(src,'cases',legacy,{id:legacy,scenario:{...scenario,inputContext:{ledger:[{amount:1}]}},inputProvenance:{sourceVerified:true}});write(src,'cases',manual,{id:manual,scenario,inputProvenance:{sourceVerified:true}});write(src,'cases',source,{id:source,scenario:parsed.scenario,inputContext:{raw,sourceHandId:crypto.randomUUID()},inputProvenance:{sourceVerified:true}});
 write(src,'jobs',job,{id:job,status:'complete',scenario:s,inputContext:ctx,inputProvenance:{sourceVerified:true}});const dir=path.join(src,'data/pro/jobs',job);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({engine:'preserved historical model',input:s,nodes:[{id:'n0',terminal:true}]}));
 const dst=setup(t);restoreUserData(dst,exportUserData(src,{includeResults:true}));
 for(const [folder,id] of [['cases',draft],['cases',legacy],['cases',source],['jobs',job]]){const entry=load(dst,folder,id);assert.equal(entry.inputProvenance.sourceVerified,false);assert.equal(entry.inputProvenance.kind,'unverified-legacy');assert.match(entry.inputProvenance.assumptions.join(' '),/不代表/);assert.throws(()=>assertInputProvenance(entry.scenario,entry.inputContext));}
 assert.equal(load(dst,'jobs',job).status,'complete');assert.ok(fs.existsSync(path.join(dst,'data/pro/jobs',job,'result.json')));assert.equal(load(dst,'cases',manual).inputProvenance.kind,'manual-model');assert.equal(load(dst,'cases',manual).inputProvenance.sourceVerified,false);assert.equal(load(dst,'cases',draft).inputContext.checked,undefined);
});
