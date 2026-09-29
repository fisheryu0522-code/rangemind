import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {cards,range} from '../lib/poker.mjs';
import {exactMultiRiver,sampleMultiCPU,analyzeMultiAsync,equitySamplingInterval,EQUITY_CI_METHOD} from '../lib/multi-equity.mjs';
import {normalizeScenario} from '../lib/scenario.mjs';
import {createProAPI} from '../lib/pro-server.mjs';
import {listStudyLibrary} from '../lib/study-library.mjs';

const board=cards('2c3d7h9sJc');
const texts=['AsAh:0.2,AsKd:0.4,KcKd:0.8,QcQd','AsAh,AhKd:0.3,QcQd:0.4,JdJh','AsKd:0.7,KhQd,QcQd:0.2,TcTd'];
const ranges=texts.map(t=>range(t,board).live);
const scenario=()=>normalizeScenario({title:'integrity',format:'study',board:'2c3d7h9sJc',pot:20,players:texts.map((text,i)=>({id:'p'+i,name:'P'+i,position:['SB','BB','BTN'][i],stack:100,range:text})),toAct:0,hero:'',heroSeat:null});

test('exact joint probability is invariant to arbitrary common scale per range',()=>{
  const original=exactMultiRiver(ranges,board),scaled=exactMultiRiver(ranges.map((r,i)=>r.map(c=>({...c,weight:c.weight*10**(-100-i*50)}))),board);
  for(let i=0;i<3;i++){assert.ok(Math.abs(original.players[i].equity-scaled.players[i].equity)<1e-13);for(let j=0;j<ranges[i].length;j++)assert.ok(Math.abs(original.players[i].combos[j].reach-scaled.players[i].combos[j].reach)<1e-13);}
  assert.ok(Math.abs(original.players.reduce((s,p)=>s+p.equity,0)-1)<1e-13);assert.ok(original.jointMass>0&&original.jointMass<=1);
});
test('finite-sample uncertainty never claims exactness from zero observed variance',()=>{
  assert.equal(equitySamplingInterval(0,0,0).ci,null);assert.equal(equitySamplingInterval(1,1,1).ci,1);
  const zero=equitySamplingInterval(0,0,10000),one=equitySamplingInterval(10000,10000,10000),expected=7*Math.log(80)/(3*9999);
  assert.ok(Math.abs(zero.ci-expected)<1e-15);assert.ok(zero.ci>0);assert.equal(zero.ciLow,0);assert.equal(one.ciHigh,1);assert.ok(one.ciLow<1);
  const r=sampleMultiCPU([range('AsAh',board).live,range('QcQd,JdJh:0.000001',board).live],board,10000,42);assert.equal(r.ciCoverage,'pointwise');assert.ok(r.players[0].ci>0);
});
test('fractional tie shares use bounded-share sample variance',()=>{
  const r=equitySamplingInterval(1.5,1.25,3),sample=[0,.5,1],mean=.5,variance=sample.reduce((s,v)=>s+(v-mean)**2,0)/2,expected=Math.min(1,Math.sqrt(2*variance*Math.log(80)/3)+7*Math.log(80)/6);assert.equal(r.equity,.5);assert.equal(r.ci,expected);
});
test('asynchronous exact analysis keeps hero/multiway result source coherent',async()=>{
  const s=scenario(),r=await analyzeMultiAsync(s,{engine:'cpu',samples:10000});assert.equal(r.exact,true);assert.deepEqual(r.scenario,s);assert.ok(r.ciMethod.includes('Exact'));assert.equal(r.players.length,3);assert.ok(Math.abs(r.players.reduce((s,p)=>s+p.equity,0)-1)<1e-12);
});
test('every original study preset has a legal jointly compatible hero and honest source',()=>{
  const presets=listStudyLibrary();assert.ok(presets.length>=20);assert.equal(new Set(presets.map(p=>p.id)).size,presets.length);for(const p of presets){assert.doesNotThrow(()=>normalizeScenario(p.scenario),p.id);assert.ok(p.source.includes('教学假设'));assert.equal(p.scenario.rake,0);assert.ok(p.intent&&p.prediction&&p.oneChange);}
});
test('API refuses to attach old analysis to edited scenario',async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pokerlab-integrity-')),root=path.resolve(temp);let payload;
  const api=createProAPI({root,json:(_res,value)=>{payload=value;},body:async req=>req.body});
  try{
    const original=scenario(),id=crypto.randomUUID(),key={board:original.board,pot:original.pot,players:original.players.map(p=>({id:p.id,position:p.position,range:p.range,stack:p.stack})),hero:original.hero,heroSeat:original.heroSeat,toAct:original.toAct,rake:original.rake,rakeCap:original.rakeCap},hash=crypto.createHash('sha256').update(JSON.stringify(key)).digest('hex'),cache='a'.repeat(64)+'.json',dir=path.join(root,'data','pro','analyses');
    fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify({cacheFile:cache,scenarioHash:hash}));fs.writeFileSync(path.join(dir,cache),JSON.stringify({id,scenario:original,exact:true,players:[]}));
    const url=new URL('http://localhost/api/pro/coach');await api.handler({method:'POST',body:{scenario:original,analysisId:id,localModel:false}},{},url);assert.equal(payload.grounding,'deterministic');
    await api.handler({method:'POST',body:{scenario:{...original,title:'renamed'},analysisId:id,localModel:false}},{},url);assert.equal(payload.grounding,'deterministic');
    await assert.rejects(api.handler({method:'POST',body:{scenario:{...original,pot:21},analysisId:id,localModel:false}},{},url),/局面已改变/);
  } finally {api.shutdown();if(root.startsWith(path.resolve(os.tmpdir())+path.sep))fs.rmSync(root,{recursive:true,force:true});}
});
test('GPU joint rejection and empirical Bernstein output agree with exact weighted enumeration',{skip:process.env.POKERLAB_TEST_GPU!=='1'},()=>{
  const input={tasks:[{ranges,board,samples:100000,seed:881991}]},python=(process.env.POKERLAB_PYTHON||'python'),script=fileURLToPath(new URL('../lib/multi_gpu.py',import.meta.url));
  const p=spawnSync(python,[script],{input:JSON.stringify(input),encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:8*1024*1024});assert.equal(p.status,0,p.stderr||p.stdout);const gpu=JSON.parse(p.stdout).results[0],exact=exactMultiRiver(ranges,board);assert.equal(gpu.ciMethod,EQUITY_CI_METHOD);assert.equal(gpu.ciCoverage,'pointwise');assert.ok(Math.abs(gpu.players.reduce((s,p)=>s+p.equity,0)-1)<1e-12);
  for(let i=0;i<3;i++){assert.ok(Math.abs(gpu.players[i].equity-exact.players[i].equity)<=gpu.players[i].ci);for(let j=0;j<ranges[i].length;j++){const a=gpu.players[i].combos[j],b=exact.players[i].combos[j];if(a.samples)assert.ok(Math.abs(a.equity-b.equity)<=a.ci);}}
});
