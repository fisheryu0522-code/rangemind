import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createProAPI} from '../lib/pro-server.mjs';
import {solveRiverGame} from '../lib/river-engine.mjs';
import {normalizeScenario} from '../lib/scenario.mjs';
import {solveSettings} from '../lib/solve-settings.mjs';

test('all public result paths reject a changed mathematical model, including a previously cached result',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pokerlab-api-binding-')),id=crypto.randomUUID();
 const scenario=normalizeScenario({title:'API binding',board:'Ks7h2d9c3s',pot:10,toAct:0,hero:'AcKd',heroSeat:0,players:[{id:'a',name:'A',position:'BB',stack:20,range:'AcKd'},{id:'b',name:'B',position:'BTN',stack:20,range:'AhQh'}],rake:0,rakeCap:0});
 const result=await solveRiverGame({...scenario,sizes:[50],raiseSizes:[50],iterations:20,accuracy:.1});
 const api=createProAPI({root,json:(res,value)=>{res.value=value;},body:async req=>req.payload});
 t.after(()=>{api.shutdown();const checked=path.resolve(root);assert.ok(checked.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(checked,{recursive:true,force:true});});
 const dir=path.join(root,'data/pro/jobs',id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result));
 const jobFile=path.join(root,'data/pro/jobs',id+'.json'),job={id,status:'complete',scenario,settings:solveSettings(result.input)};fs.writeFileSync(jobFile,JSON.stringify(job));
 const call=async(route,payload={},method='POST')=>{const res={};await api.handler({method,payload},res,new URL(route,'http://localhost'));return res.value;};
 const original=await call(`/api/pro/jobs/${id}/node`);assert.equal(original.node.id,'n0');
 job.scenario.pot=11;fs.writeFileSync(jobFile,JSON.stringify(job));
 for(const action of ['node','explain','observed-path'])await assert.rejects(call(`/api/pro/jobs/${id}/${action}`,{combo:'AcKd'}),/底池.*不一致/);
 await assert.rejects(call(`/api/pro/jobs/${id}/download`,{},'GET'),/底池.*不一致/);
 await assert.rejects(call('/api/pro/coach',{jobId:id,scenario:job.scenario,combo:'AcKd',localModel:false}),/底池.*不一致/);
 await assert.rejects(call('/api/pro/training/from-solve',{jobId:id,combo:'AcKd'}),/底池.*不一致/);
 assert.equal(fs.readdirSync(path.join(root,'data/pro/study-cards')).length,0);
});

test('replacing a saved policy invalidates result and explanation caches even for the same input',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pokerlab-policy-cache-')),id=crypto.randomUUID();
 const scenario=normalizeScenario({title:'Policy cache',board:'Ks7h2d9c3s',pot:10,toAct:0,hero:'AcKd',heroSeat:0,players:[{id:'a',name:'A',position:'BB',stack:20,range:'AcKd'},{id:'b',name:'B',position:'BTN',stack:20,range:'AhQh'}],rake:0,rakeCap:0});
 const result=await solveRiverGame({...scenario,sizes:[50],raiseSizes:[50],iterations:20,accuracy:.1});
 const api=createProAPI({root,json:(res,value)=>{res.value=value;},body:async req=>req.payload});
 t.after(async()=>{await api.shutdown();const checked=path.resolve(root);assert.ok(checked.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(checked,{recursive:true,force:true});});
 const dir=path.join(root,'data/pro/jobs',id),file=path.join(dir,'result.json');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(file,JSON.stringify(result));fs.writeFileSync(path.join(root,'data/pro/jobs',id+'.json'),JSON.stringify({id,status:'complete',scenario,settings:solveSettings(result.input)}));
 const call=async action=>{const res={};await api.handler({method:'POST',payload:{combo:scenario.hero}},res,new URL(`/api/pro/jobs/${id}/${action}`,'http://localhost'));return res.value;};
 await call('node');await call('explain');
 result.nodes[0].combos[0].actionEV[0]+=5;fs.writeFileSync(file,JSON.stringify(result));
 const refreshed=await call('node');assert.equal(refreshed.node.combos[0].actionEV[0],result.nodes[0].combos[0].actionEV[0]);
 await assert.rejects(call('explain'),/独立收益拆解与求解器不一致/);
 fs.unlinkSync(file);await assert.rejects(call('node'),/尚未准备好/);
});
