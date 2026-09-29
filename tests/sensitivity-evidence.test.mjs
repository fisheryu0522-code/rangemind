import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {solveRiverGame} from '../lib/river-engine.mjs';
import {runSensitivity} from '../lib/sensitivity.mjs';
import {reconstructSensitivityEvidence} from '../lib/sensitivity-evidence.mjs';
import {buildSensitivityDebrief} from '../lib/sensitivity-debrief.mjs';
import {solveSettings} from '../lib/solve-settings.mjs';
const scenario={title:'Stored hypothesis evidence',board:'Ks7h2d9c3s',pot:10,toAct:0,hero:'AcKd',heroSeat:0,players:[{id:'h',name:'Hero',position:'BB',stack:20,range:'AcKd,AhQh'},{id:'v',name:'Opponent',position:'BTN',stack:20,range:'KhQd:0.8,QcJc:0.4'}]},settings={sizes:[50],raiseSizes:[50],maxRaises:1,iterations:3000,accuracy:.05,checkEvery:100};
async function fixture(){
 const baseline=await solveRiverGame({...scenario,...settings}),sourceJobId=crypto.randomUUID(),jobs=new Map(),results=new Map(),input={scenario,settings:solveSettings(baseline.input),player:1,subset:'QcJc',combo:'AcKd',scales:[.25,.5,1],nodePath:[]};
 jobs.set(sourceJobId,{id:sourceJobId,status:'complete',scenario,settings:input.settings});results.set(sourceJobId,baseline);
 const result=await runSensitivity({...input,baseline},{saveVariant:async({result,scenario,scale})=>{if(scale===1)return sourceJobId;const id=crypto.randomUUID();jobs.set(id,{id,status:'complete',scenario,settings:solveSettings(result.input)});results.set(id,result);return id;}});
 return {record:{id:crypto.randomUUID(),status:'complete',sourceJobId,input,result},jobs,results,getJob:id=>{if(!jobs.has(id))throw Error('Missing saved job');return jobs.get(id);},getResult:id=>{if(!results.has(id))throw Error('Missing complete policy');return results.get(id);}};
}
test('sensitivity summaries are reconstructed from saved strategies, never from edited displayed EV or quality flags',async()=>{
 const f=await fixture(),expected=structuredClone(f.record.result.rows);
 for(const row of f.record.result.rows){row.actions.forEach(a=>{a.ev=999;a.loss=0;});row.quality.targetReached=true;row.diagnostics.nashConvPctPot=0;}
 // Restore the actual tree diagnostic after deliberately mutating a shared
 // in-memory summary object; on disk these are separate serialized artifacts.
 for(const row of expected)f.results.get(row.jobId).diagnostics=structuredClone(row.diagnostics);
 const rebuilt=await reconstructSensitivityEvidence(f.record,f);assert.deepEqual(rebuilt.rows.map(r=>r.actions),expected.map(r=>r.actions));assert.equal(rebuilt.evidence.recomputedStrategy,false);
 const summary=buildSensitivityDebrief(rebuilt,{toleranceBB:.1});assert.equal(summary.rows.length,3);assert.equal(summary.toleranceBB,.1);
});
test('a missing saved strategy cannot be certified by a restored experiment summary',async()=>{
 const f=await fixture();f.results.delete(f.record.result.rows[0].jobId);await assert.rejects(reconstructSensitivityEvidence(f.record,f),/Missing complete policy/);
});
test('swapping saved variants or redirecting baseline IDs fails the original range hypothesis binding',async()=>{
 const f=await fixture(),a=f.record.result.rows[0],b=f.record.result.rows[1];a.jobId=b.jobId;await assert.rejects(reconstructSensitivityEvidence(f.record,f),/范围|模型|参数/);
 const clean=await fixture();clean.record.result.rows.at(-1).jobId=clean.record.result.rows[0].jobId;await assert.rejects(reconstructSensitivityEvidence(clean.record,clean),/原始参考/);
 const incomplete=await fixture();incomplete.record.status='interrupted';await assert.rejects(reconstructSensitivityEvidence(incomplete.record,incomplete),/完整/);
});
