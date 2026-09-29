import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {spawn} from 'node:child_process';
import {once,EventEmitter} from 'node:events';
import {gzipSync} from 'node:zlib';
import {createOwnedProcesses,stopWorkerGracefully} from '../lib/owned-processes.mjs';
import {createProAPI} from '../lib/pro-server.mjs';
import {createTrainingLabAPI} from '../lib/training-lab-api.mjs';
import {normalizeScenario} from '../lib/scenario.mjs';
import {solveRiverGame} from '../lib/river-engine.mjs';
import {solveSettings} from '../lib/solve-settings.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
const rootFor=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'pokerlab-shutdown-audit-'));t.after(()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});return root;};
const waitUntil=async(fn,ms=6000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await sleep(10);}throw Error('timed out waiting for lifecycle condition');};
const scenario=normalizeScenario({title:'Shutdown audit',board:'Ks7h2d9c3s',pot:10,toAct:0,heroSeat:0,hero:'AcKd',players:[{id:'a',name:'BB',position:'BB',stack:10,range:'AcKd,AhQh'},{id:'b',name:'BTN',position:'BTN',stack:10,range:'KcQd,QcJc'}]});
const settings={sizes:[50],raiseSizes:[],maxRaises:0,allIn:false,iterations:5,threads:1};
function call(api,route,payload){const res={};return api.handler({method:payload===undefined?'GET':'POST',payload},res,new URL(route,'http://localhost')).then(()=>res);}
const json=(res,value,status=200)=>Object.assign(res,{value,status});

test('graceful worker shutdown waits for actual exit and drains a second child reported after cancellation',async t=>{
 const worker=new Worker(`const {parentPort}=require('node:worker_threads');const {spawn}=require('node:child_process');const children=[];
 function child(){const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});children.push(c);c.on('spawn',()=>parentPort.postMessage({processIds:children.map(x=>x.pid),phase:'spawned'}));}
 child();parentPort.on('message',m=>{if(m.cancel){child();parentPort.postMessage({phase:'cancel-received'});}});`,{eval:true});
 const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});await once(unrelated,'spawn');const unrelatedClosed=once(unrelated,'close');
 const owned=createOwnedProcesses(),reported=new Set();let exited=false;
 worker.on('message',p=>{owned.observe(worker,p);for(const pid of p.processIds??[])reported.add(pid);});worker.on('exit',()=>{exited=true;});
 t.after(async()=>{await worker.terminate();for(const pid of reported)if(alive(pid))process.kill(pid);unrelated.kill();await unrelatedClosed;});
 await waitUntil(()=>reported.size===1);await stopWorkerGracefully(worker,{graceMs:150});assert.equal(exited,true);assert.equal(worker.threadId,-1);assert.equal(reported.size,2);
 // This worker deliberately did not clean up its children. No late spawn can
 // occur after real exit; both reported children must now be drained together.
 assert.equal(await owned.drain(worker),true);for(const pid of reported)assert.equal(alive(pid),false);assert.equal(alive(unrelated.pid),true);
});

test('cooperative cancellation closes children before worker exit without waiting for the force deadline',async t=>{
 const worker=new Worker(`const {parentPort}=require('node:worker_threads');const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
 c.on('spawn',()=>parentPort.postMessage({processIds:[c.pid]}));parentPort.on('message',m=>{if(m.cancel)c.kill();});c.on('close',()=>{parentPort.postMessage({processIds:[]});parentPort.close();});`,{eval:true});
 const owned=createOwnedProcesses();let childPid;worker.on('message',p=>{owned.observe(worker,p);childPid??=p.processIds[0];});t.after(async()=>{await worker.terminate();if(childPid&&alive(childPid))process.kill(childPid);});
 await waitUntil(()=>!!childPid);const started=Date.now();await stopWorkerGracefully(worker,{graceMs:2000});assert.equal(worker.threadId,-1);assert.ok(Date.now()-started<1800);assert.equal(alive(childPid),false);assert.equal(await owned.drain(worker),true);
 await stopWorkerGracefully(worker,{graceMs:2000});
});

test('a solve request whose body arrives after shutdown cannot create a late worker or job',async t=>{
 const root=rootFor(t),entered=deferred(),release=deferred();const api=createProAPI({root,json,body:async req=>{entered.resolve();await release.promise;return req.payload;}});
 const request=call(api,'/api/pro/solve',{scenario,settings});request.catch(()=>{});await entered.promise;const closing=api.shutdown();assert.equal(api.shutdown(),closing);await closing;release.resolve();
 const outcome=await request.then(value=>({value}),error=>({error}));
 // If the regression reappears, allow its deliberately tiny CPU job to exit
 // before cleanup so the audit itself never leaves a worker or child behind.
 if(outcome.value?.value?.id)await waitUntil(()=>{const p=path.join(root,'data/pro/jobs',outcome.value.value.id+'.json');return fs.existsSync(p)&&!['running','cancelling'].includes(JSON.parse(fs.readFileSync(p)).status);});
 assert.ok(outcome.error||outcome.value.status===503,'a paused request launched after shutdown completed');assert.equal(fs.readdirSync(path.join(root,'data/pro/jobs')).filter(x=>x.endsWith('.json')).length,0);
 const after=await call(api,'/api/pro/solve',{scenario,settings}).catch(error=>({error}));assert.ok(after.error||after.status===503);
});

test('standalone training-lab shutdown prevents a delayed evaluate body from opening new native work',async t=>{
 const root=rootFor(t),id=crypto.randomUUID(),result=await solveRiverGame({...scenario,...settings}),job={id,status:'complete',scenario,settings:solveSettings(result.input)},entered=deferred(),release=deferred();let delayBody=false;
 const dir=path.join(root,'data/pro/jobs',id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result));
 const api=createTrainingLabAPI({root,json,getJob:()=>job,getResult:()=>result,body:async req=>{if(delayBody){entered.resolve();await release.promise;}return req.payload??{};}});t.after(()=>api.shutdown());
 const q=(await call(api,'/api/pro/training/range-question',{jobId:id})).value;
 const response=await call(api,'/api/pro/training/range-attempt',{jobId:id,sourceFingerprint:q.sourceFingerprint,confidence:50,assignments:q.publicQuestion.combos.filter(c=>c.editable).map(c=>({combo:c.combo,probabilities:Object.fromEntries(q.publicQuestion.actions.map((a,i)=>[a.id,i===0?1:0]))}))});
 delayBody=true;const request=call(api,`/api/pro/training/range-attempts/${response.value.attempt.id}/evaluate`,{});request.catch(()=>{});await entered.promise;await api.shutdown();release.resolve();const outcome=await request.then(value=>({value}),error=>({error}));
 if(outcome.value?.value?.id)await waitUntil(()=>!api.busy);
 assert.ok(outcome.error||outcome.value.status===503,'training-lab opened independent evaluation after it was shut down');assert.equal(fs.readdirSync(path.join(root,'data/pro/range-evaluations')).filter(x=>x.endsWith('.json')).length,0);
});

test('two simultaneous solves reserve only one worker and shutdown settles its durable cancellation before returning',async t=>{
 const root=rootFor(t),api=createProAPI({root,json,body:async req=>req.payload});
 const answers=await Promise.all([call(api,'/api/pro/solve',{scenario,settings:{...settings,iterations:100000,accuracy:0}}),call(api,'/api/pro/solve',{scenario,settings:{...settings,iterations:100000,accuracy:0}})]);
 assert.equal(answers.filter(r=>r.status===200).length,1);assert.equal(answers.filter(r=>r.status===409).length,1);const job=answers.find(r=>r.status===200).value;assert.equal(job.status,'running');
 await api.shutdown();const saved=JSON.parse(fs.readFileSync(path.join(root,'data/pro/jobs',job.id+'.json')));assert.equal(saved.status,'cancelled');assert.equal(saved.result,undefined);
 assert.equal(fs.readdirSync(path.join(root,'data/pro/jobs')).filter(f=>f.endsWith('.json')).length,1);
});

test('a compressed backup finishing upload after shutdown cannot restore late user records',async t=>{
 const root=rootFor(t),caseId=crypto.randomUUID(),api=createProAPI({root,json,body:async req=>req.payload}),req=new EventEmitter(),res={};req.method='POST';
 const request=api.handler(req,res,new URL('/api/pro/backups/import','http://localhost'));request.catch(()=>{});
 await waitUntil(()=>req.listenerCount('end')>0);await api.shutdown();
 const compressed=gzipSync(Buffer.from(JSON.stringify({app:'PokerLab',schemaVersion:2,records:{cases:[{id:caseId,title:'Pending upload',scenario}]},results:{}})));
 req.emit('data',compressed);req.emit('end');await assert.rejects(request,/关闭/);
 assert.equal(fs.existsSync(path.join(root,'data/pro/cases',caseId+'.json')),false);
});
