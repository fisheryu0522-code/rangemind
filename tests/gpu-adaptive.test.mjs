import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepareGPURiverGame,solveGPURiverGame} from '../lib/gpu-river-cfr.mjs';
const enabled=process.env.POKERLAB_TEST_GPU_CFR==='1';
const base={board:'2c4d6h8sTc',pot:10,players:[{id:'a',range:'AcAd,QcQd:0.6',stack:15},{id:'b',range:'KcKd,JcJh:0.3',stack:10}],sizes:[50],raiseSizes:[50],maxRaises:1,allIn:true,iterations:18,averagingDelay:2,threads:1,algorithm:'alternating-cfr-plus',accuracy:0,maxSeconds:30};
const close=(a,b,e=1e-9)=>assert.ok(Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=e,`${a} != ${b}`);
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
function temp(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pokerlab-adaptive-test-'));return {dir,clean(){assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('pokerlab-adaptive-test-'));fs.rmSync(dir,{recursive:true,force:true});}};}
function assertClosed(events){const ids=[...new Set(events.map(e=>e.processId).filter(Number.isInteger))];assert.ok(ids.length);for(const pid of ids)assert.equal(alive(pid),false,`orphan PID ${pid}`);assert.deepEqual(events.filter(e=>Array.isArray(e.processIds)).at(-1).processIds,[]);}
function badLockedModel(extra={}){
 const raw={...base,players:[{id:'a',range:'AcAd',stack:20},{id:'b',range:'KcKd',stack:20}],averagingDelay:0,...extra},p=prepareGPURiverGame(raw);
 return {...raw,locks:p.nodes.filter(n=>n.actor>=0).map(n=>({nodeId:n.id,actions:{[n.actions.some(a=>a.id==='check')?'check':n.actor===1?'call':'fold']:1}}))};
}

test('adaptive precision requires an explicit target and cannot disable independent verification',async()=>{
 assert.throws(()=>prepareGPURiverGame({...base,adaptivePrecision:'yes'}),/布尔/);
 assert.throws(()=>prepareGPURiverGame({...base,adaptivePrecision:true,accuracy:undefined}),/accuracy/);
 assert.throws(()=>prepareGPURiverGame({...base,adaptivePrecision:true,adaptiveCheckEvery:0}),/adaptiveCheckEvery/);
 await assert.rejects(solveGPURiverGame({...base,adaptivePrecision:true},{verify:false}),/不能关闭/);
});

test('CFR+, DCFR and alternating CFR+ retain the exact same regret/average trajectory across checkpoints',{skip:!enabled},async()=>{
 for(const algorithm of ['cfr-plus','dcfr','alternating-cfr-plus']){
  const raw={...base,algorithm,captureIterations:[4,8,18]},fixed=await solveGPURiverGame(raw),events=[],adaptive=await solveGPURiverGame({...raw,adaptivePrecision:true,adaptiveCheckEvery:4},{onProgress:e=>events.push(e)});
  assert.equal(adaptive.stats.iterations,18);assert.equal(adaptive.stopReason,'iteration_limit');assert.equal(adaptive.stats.targetReached,false);assert.ok(adaptive.precisionChecks.length>=2);assert.deepEqual(adaptive.gpu.snapshots,fixed.gpu.snapshots);
  for(let n=0;n<fixed.nodes.length;n++)for(let c=0;c<fixed.nodes[n].combos.length;c++)adaptive.nodes[n].combos[c].probabilities.forEach((v,a)=>close(v,fixed.nodes[n].combos[c].probabilities[a],1e-12));
  fixed.diagnostics.profileEV.forEach((v,p)=>close(v,adaptive.diagnostics.profileEV[p],1e-12));close(fixed.diagnostics.nashConv,adaptive.diagnostics.nashConv,1e-12);
  assert.ok(events.some(e=>e.processIds?.length===2));assertClosed(events);assert.equal(adaptive.stats.iterationsExecuted,18);assert.equal(adaptive.checkpointBinding.iteration,18);
 }
});

test('a loose real BR target stops at the first post-delay checkpoint and fixed mode remains compatible',{skip:!enabled},async()=>{
 const r=await solveGPURiverGame({...base,iterations:200,accuracy:100,adaptivePrecision:true,adaptiveCheckEvery:1,averagingDelay:10});
 assert.equal(r.stats.iterations,11);assert.equal(r.stopReason,'accuracy_target');assert.equal(r.stats.adaptiveStopping,true);assert.equal(r.stats.targetReached,true);assert.equal(r.precisionChecks.length,1);assert.equal(r.diagnostics.bestResponseIgnoresLocks,true);assert.equal(r.diagnostics.constrainedResidualUsed,false);assert.equal(r.diagnostics.residualForStopping,'independent_unrestricted_nashConvPctPot');
 assert.ok(r.diagnostics.nashConv>0);assert.equal(r.checkpointBinding.policySHA256,r.precisionChecks[0].policySHA256);assert.equal(r.checkpointBinding.inputSHA256,r.precisionChecks[0].inputSHA256);
 const fixed=await solveGPURiverGame({...base,iterations:5,averagingDelay:0,accuracy:100,adaptivePrecision:false});assert.equal(fixed.stats.iterations,5);assert.equal(fixed.stats.adaptiveStopping,false);assert.equal(fixed.stopReason,'iteration_limit');
});

test('original locks and capped fee never substitute full-lock constrained zero for stopping residual',{skip:!enabled},async()=>{
 const raw=badLockedModel({iterations:30,rake:5,rakeCap:.5}),r=await solveGPURiverGame({...raw,adaptivePrecision:true,adaptiveCheckEvery:5});
 assert.equal(r.stats.iterations,30);assert.equal(r.stats.targetReached,false);assert.equal(r.stopReason,'iteration_limit');assert.ok(r.diagnostics.nashConv>1);assert.ok(r.precisionChecks.every(c=>c.nashConv>1&&c.constrainedResidualUsed===false));close(r.diagnostics.profileEV.reduce((a,b)=>a+b,0),9.5);assert.ok(r.nodes[0].combos.every(c=>c.locked));
});

test('user cancellation during training, paused checkpoint and overlapping CPU verification drains all owned PIDs',{skip:!enabled},async()=>{
 for(const phase of ['gpu-training','gpu-checkpoint','cpu-independent-verification','precision-check-complete']){
  const controller=new AbortController(),events=[],t=temp(),outputFile=path.join(t.dir,'must-not-publish.json');let cancelled=false;
  try{
   await assert.rejects(solveGPURiverGame({...base,iterations:100000,adaptivePrecision:true,adaptiveCheckEvery:50},{workDir:t.dir,outputFile,signal:controller.signal,onProgress:e=>{events.push(e);if(!cancelled&&e.phase===phase&&(phase!=='cpu-independent-verification'||Number.isInteger(e.processId))){cancelled=true;controller.abort();}}}),/取消/);
   assert.equal(cancelled,true);assert.equal(fs.existsSync(outputFile),false);assertClosed(events);if(phase==='cpu-independent-verification')assert.ok(events.some(e=>e.processIds?.length===2));
  }finally{t.clean();}
 }
 const next=await solveGPURiverGame({...base,iterations:5,averagingDelay:0,accuracy:100,adaptivePrecision:true,adaptiveCheckEvery:3});assert.equal(next.stopReason,'accuracy_target');
});

test('modified checkpoint content cannot be verified under its old policy hash',{skip:!enabled},async()=>{
 const t=temp(),events=[];let touched=false;try{
  await assert.rejects(solveGPURiverGame({...base,adaptivePrecision:true,adaptiveCheckEvery:4},{workDir:t.dir,onProgress:e=>{events.push(e);if(e.phase==='gpu-checkpoint'&&!touched){touched=true;const dir=fs.readdirSync(t.dir).find(n=>n.startsWith('checkpoints-')),file=path.join(t.dir,dir,`checkpoint-${e.checkpoint}.json`),p=JSON.parse(fs.readFileSync(file));p.inputSHA256='0'.repeat(64);fs.writeFileSync(file,JSON.stringify(p));}}}),/摘要不一致/);
  assert.equal(touched,true);assertClosed(events);
 }finally{t.clean();}
});

test('a wall-clock budget may publish only the last completed independent checkpoint, never an unverified tail',{skip:!enabled},async()=>{
 const events=[],raw=badLockedModel({iterations:100000,maxSeconds:1.2}),r=await solveGPURiverGame({...raw,adaptivePrecision:true,adaptiveCheckEvery:5},{onProgress:e=>events.push(e)});
 assert.equal(r.stopReason,'time_limit');assert.equal(r.stats.targetReached,false);assert.ok(r.stats.iterations<raw.iterations);assert.equal(r.stats.iterations,r.precisionChecks.at(-1).iteration);assert.equal(r.checkpointBinding.policySHA256,r.precisionChecks.at(-1).policySHA256);assert.equal(r.stats.precisionChecks,r.precisionChecks.length);assert.ok(r.stats.iterationsExecutedAtLeast>=r.stats.iterations);assertClosed(events);
});
