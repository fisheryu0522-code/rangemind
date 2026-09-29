import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createProAPI} from '../lib/pro-server.mjs';
import {exportUserData,restoreUserData} from '../lib/backup.mjs';
import {replayLiveRecorder} from '../lib/live-recorder.mjs';
import {prepareRiverGame} from '../lib/river-engine.mjs';
import {observedPath} from '../lib/observed-path.mjs';

function setup(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pokerlab-live-api-'));
 const api=createProAPI({root,json:(res,value,status=200)=>Object.assign(res,{value,status}),body:async req=>req.body??{}});
 const call=async(route,body)=>{const res={};await api.handler({method:body===undefined?'GET':'POST',body},res,new URL(route,'http://localhost'));return res.value;};
 t.after(async()=>{await api.shutdown();assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});
 return {root,api,call};
}
const config={unit:'currency',smallBlind:1,bigBlind:3,playerCount:2,stack:300,hero:{playerId:'BTN',hand:'AhKd'}};
async function riverRecord(h){
 let record=await h.call('/api/pro/live-recordings',config);
 for(const action of [{type:'raiseTo',amount:9},{type:'call'},{type:'street',cards:'As 7h 2c'}, {type:'check'},{type:'check'},{type:'street',cards:'9d'},{type:'check'},{type:'check'},{type:'street',cards:'3s'}])record=await h.call(`/api/pro/live-recordings/${record.id}/actions`,{revision:record.revision,action});
 return record;
}
test('manual records persist across reload, use original currency once and reject stale writes',async t=>{
 const h=setup(t),options=await h.call('/api/pro/live-recordings/options');assert.deepEqual(options.positionsByCount[2],['BB','BTN']);assert.equal(options.positionsByCount[9].length,9);
 const record=await riverRecord(h);assert.equal(record.view.pot,18);assert.equal(record.parse.scenario.pot,6);assert.equal(record.view.currentActorId,'BB');
 const route=`/api/pro/live-recordings/${record.id}`,body={revision:record.revision,action:{type:'bet',amount:6}};
 const answers=await Promise.allSettled([h.call(route+'/actions',body),h.call(route+'/actions',body)]);assert.equal(answers.filter(x=>x.status==='fulfilled').length,1);assert.match(answers.find(x=>x.status==='rejected').reason.message,/已更新/);
 const loaded=await h.call(route);assert.equal(loaded.view.pot,24);assert.equal(loaded.view.toCall,6);assert.equal(loaded.revision,record.revision+1);
 const undone=await h.call(route+'/undo',{revision:loaded.revision});assert.equal(undone.view.pot,18);assert.equal(undone.view.currentActorId,'BB');assert.equal(undone.draft.actions.length,record.draft.actions.length);
 assert.equal((await h.call('/api/pro/live-recordings')).total,1);assert.equal(exportUserData(h.root).records['study-attempts'].length,0);assert.equal(exportUserData(h.root).records['range-attempts'].length,0);
});
test('current and historical recording handoffs preserve the exact decision boundary before future actions',async t=>{
 const h=setup(t);let r=await riverRecord(h),route=`/api/pro/live-recordings/${r.id}`;
 const current=await h.call(route+'/study',{revision:r.revision});assert.equal(current.scenario.pot,6);assert.equal(current.scenario.players[0].stack,97);assert.equal(current.inputContext.sourceRecordingId,r.id);assert.equal(current.inputContext.sourceRecordingRevision,r.revision);
 const checked=await h.call('/api/pro/input-provenance',{scenario:current.scenario,inputContext:current.inputContext});assert.equal(checked.sourceVerified,true);
 const scenario=current.scenario;scenario.players[0].range='AcAd';scenario.players[1].range='AhKd';
 const result=prepareRiverGame({...scenario,sizes:[50],raiseSizes:[],maxRaises:0,allIn:false});
 const before=observedPath(scenario,result,checked.inputContext);assert.deepEqual(before.target.path,[]);assert.equal(before.target.actorName,scenario.players[0].name);
 r=await h.call(route+'/actions',{revision:r.revision,action:{type:'bet',amount:6}});
 const pending=await h.call(route+'/study',{revision:r.revision});const exact=prepareRiverGame({...scenario,sizes:[100/3],raiseSizes:[],maxRaises:0,allIn:false});assert.deepEqual(observedPath(scenario,exact,pending.inputContext).target.path,['bet_2']);
 r=await h.call(route+'/actions',{revision:r.revision,action:{type:'call'}});
 const oldSource=await h.call('/api/pro/input-provenance',{scenario:current.scenario,inputContext:current.inputContext});assert.equal(oldSource.sourceVerified,true);assert.equal(oldSource.sourceRef.revision,current.recording.revision);
 const forged=structuredClone(current.inputContext);forged.raw=forged.raw.replace('300 美元','303 美元');await assert.rejects(h.call('/api/pro/input-provenance',{scenario:current.scenario,inputContext:forged}),/指定版本不一致/);
 const historical=await h.call(route+'/study',{revision:r.revision,actionIndex:r.draft.actions.length-2});
 // The later bet size does not belong to this tree, but we study BEFORE it.
 const selected=observedPath(scenario,result,historical.inputContext);assert.deepEqual(selected.target.path,[]);assert.equal(selected.target.recordedAmount,2);assert.equal(selected.target.ledgerIndex,historical.targetLedgerIndex);
 const bad=structuredClone(historical.inputContext);bad.studyTarget.ledgerIndex=999;assert.throws(()=>observedPath(scenario,result,bad),/不属于/);
});
test('recording backups rebuild money, discard forged scores and preserve existing revisions',async t=>{
 const source=setup(t),target=setup(t),r=await riverRecord(source),backup=exportUserData(source.root);assert.equal(backup.records['live-recordings'].length,1);
 backup.records['live-recordings'][0].summary.pot=999;backup.records['live-recordings'][0].grade={mastery:true,score:100};backup.records['live-recordings'][0].view={pot:999};
 restoreUserData(target.root,backup);const restored=exportUserData(target.root).records['live-recordings'][0];assert.equal(restored.summary.pot,18);assert.equal(restored.grade,undefined);assert.equal(restored.view,undefined);assert.equal(replayLiveRecorder(restored.draft).view.pot,18);
 const latest=await target.call(`/api/pro/live-recordings/${r.id}/actions`,{revision:r.revision,action:{type:'bet',amount:6}});restoreUserData(target.root,backup);assert.equal((await target.call(`/api/pro/live-recordings/${r.id}`)).revision,latest.revision);
 const invalid=structuredClone(backup);invalid.records['live-recordings'][0].draft.actions.push({type:'check',playerId:'BTN'});const untouched=setup(t);assert.throws(()=>restoreUserData(untouched.root,invalid),/轮到|行动/);assert.equal(exportUserData(untouched.root).records['live-recordings'].length,0);
});
test('a saved study retains its recorded revision after later actions and a full backup merge',async t=>{
 const source=setup(t),target=setup(t),r=await riverRecord(source),route=`/api/pro/live-recordings/${r.id}`,study=await source.call(route+'/study',{revision:r.revision});
 const saved=await source.call('/api/pro/cases',{scenario:study.scenario,inputContext:study.inputContext});
 await source.call(route+'/actions',{revision:r.revision,action:{type:'bet',amount:6}});
 const backup=exportUserData(source.root);assert.equal(backup.records['live-recordings'][0].studySnapshots.length,1);
 restoreUserData(target.root,backup);const copy=exportUserData(target.root),restored=copy.records.cases.find(x=>x.id===saved.id);assert.equal(restored.inputProvenance.sourceVerified,true);assert.equal(restored.inputProvenance.sourceRef.revision,r.revision);
 const checked=await target.call('/api/pro/input-provenance',{scenario:restored.scenario,inputContext:restored.inputContext});assert.equal(checked.sourceVerified,true);
 const missing=structuredClone(study.inputContext);missing.sourceRecordingId='00000000-0000-0000-0000-000000000000';await assert.rejects(target.call('/api/pro/input-provenance',{scenario:study.scenario,inputContext:missing,recording:copy.records['live-recordings'][0]}),/找不到这个本地/);
 const invalid=structuredClone(backup);invalid.records['live-recordings'][0].studySnapshots[0].draft.actions.push({type:'check',playerId:'BTN'});const empty=setup(t);assert.throws(()=>restoreUserData(empty.root,invalid),/轮到|行动/);assert.equal(exportUserData(empty.root).records.cases.length,0);
});
