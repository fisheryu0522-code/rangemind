import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareGPURiverGame,solveGPURiverGame} from '../lib/gpu-river-cfr.mjs';
import {prepareRiverGame,solveRiverGame} from '../lib/river-engine.mjs';
import {range,cards} from '../lib/poker.mjs';

const runGPU=process.env.POKERLAB_TEST_GPU_CFR==='1';
const base={board:'2c4d6h8sTc',pot:10,players:[{id:'a',range:'AcAd,QcQd:0.6',stack:15},{id:'b',range:'KcKd,JcJh:0.3',stack:10}],sizes:[50],raiseSizes:[50],maxRaises:1,allIn:true,iterations:10,averagingDelay:0,threads:1,algorithm:'cfr-plus'};
const near=(a,b,e=1e-8)=>assert.ok(Math.abs(a-b)<e,`${a} differs from ${b}`);
function compare(gpu,cpu){
  assert.equal(gpu.nodes.length,cpu.nodes.length);assert.equal(gpu.stats.iterations,cpu.stats.iterations);
  let maximum=0;for(let n=0;n<cpu.nodes.length;n++)for(let c=0;c<cpu.nodes[n].combos.length;c++){
    const g=gpu.nodes[n].combos[c],r=cpu.nodes[n].combos[c];assert.equal(g.combo,r.combo);assert.equal(g.locked,r.locked);
    r.probabilities.forEach((x,a)=>{maximum=Math.max(maximum,Math.abs(x-g.probabilities[a]));near(x,g.probabilities[a],1e-8);if(r.actionEV[a]===null)assert.equal(g.actionEV[a],null);else near(g.actionEV[a],r.actionEV[a],1e-7);});
  }
  cpu.diagnostics.profileEV.forEach((v,p)=>near(v,gpu.diagnostics.profileEV[p],1e-7));near(gpu.diagnostics.nashConv,cpu.diagnostics.nashConv,1e-7);
  assert.equal(gpu.diagnostics.constrainedResidualUsed,false);assert.equal(gpu.chance.exact,true);assert.ok(gpu.qualityVerified);return maximum;
}

test('GPU experimental model rejects unsupported chance, rake, algorithm and memory requests',()=>{
  assert.throws(()=>prepareGPURiverGame({...base,chanceMode:'sampled'}),/完整/);
  assert.throws(()=>prepareGPURiverGame({...base,rake:5}),/抽水/);
  assert.throws(()=>prepareGPURiverGame({...base,algorithm:'fictional'}),/CFR/);
  assert.throws(()=>prepareGPURiverGame({...base,gpuMemoryBytes:0}),/显存/);
  const p=prepareGPURiverGame({...base,algorithm:undefined});assert.equal(p.algorithm,'alternating-cfr-plus');assert.equal(p.chance.exact,true);
});

test('tested 3p100 / 285-node model fits GPU visit budget without relaxing CPU or memory budgets',()=>{
  const board='Ks7h2d9c3s',pool=range('22+,A2s+,K2s+,Q5s+,J7s+,T7s+,96s+,85s+,75s,65s,54s,ATo+,KJo+,QJo',cards(board)).live;
  const s={board,pot:20,players:[100,80,50].map((stack,p)=>({id:`p${p}`,stack,range:Array.from({length:100},(_,i)=>pool[(Math.floor(i*pool.length/100)+p*13)%pool.length].label+(i%5===0?':0.35':'')).join(',')})),sizes:[50],raiseSizes:[50],maxRaises:2,allIn:true,iterations:1000,algorithm:'alternating-cfr-plus',gpuMemoryBytes:8000000000};
  const prepared=prepareGPURiverGame(s);assert.equal(prepared.deals.length,714318);assert.equal(prepared.nodes.length,285);assert.equal(prepared.estimatedNodeVisits,610741890000);assert.ok(prepared.gpuEstimate.bytes<8e9);assert.equal(prepared.input.maxNodeVisits,1e12);
  assert.throws(()=>prepareRiverGame(s),/节点访问/);assert.throws(()=>prepareGPURiverGame({...s,gpuMemoryBytes:4e9}),/显存|工作区/);assert.throws(()=>prepareGPURiverGame({...s,maxNodeVisits:2e11}),/节点访问/);
});

test('FP64 GPU and serial CPU average strategies match at iterations 1, 2, 5, 20', {skip:!runGPU},async()=>{
  for(const iterations of [1,2,5,20]){const s={...base,iterations},gpu=await solveGPURiverGame(s),cpu=await solveRiverGame(s);compare(gpu,cpu);assert.equal(gpu.stats.averagedIterations,iterations);}
});

test('three-player GPU strategy preserves exact blockers, weighted ranges and unequal side pots', {skip:!runGPU},async()=>{
  const s={...base,players:[{id:'a',range:'AcAd,QcQd:0.3',stack:20},{id:'b',range:'KcKd,AcQd:0.25',stack:12},{id:'c',range:'JcJh,KdQd:0.6',stack:5}],iterations:25,averagingDelay:3};
  const gpu=await solveGPURiverGame(s),cpu=await solveRiverGame(s);compare(gpu,cpu);near(gpu.diagnostics.profileEV.reduce((a,b)=>a+b,0),s.pot);
});

test('GPU DCFR discounts and quadratic delayed averaging match CPU', {skip:!runGPU},async()=>{
  const s={...base,iterations:30,averagingDelay:5,algorithm:'dcfr'};compare(await solveGPURiverGame(s),await solveRiverGame(s));
});

test('GPU alternating player passes and post-round averaging match serial CPU', {skip:!runGPU},async()=>{
  for(const iterations of [1,2,10,30]){const s={...base,players:[...base.players,{id:'c',range:'9c9d,5c5d:0.4',stack:7}],iterations,averagingDelay:Math.min(3,iterations-1),algorithm:'alternating-cfr-plus'};const gpu=await solveGPURiverGame(s),cpu=await solveRiverGame(s);compare(gpu,cpu);assert.equal(gpu.stats.playerUpdatePasses,iterations*3);}
});

test('GPU node locks remain locked without using trivial constrained residual as quality', {skip:!runGPU},async()=>{
  const g=prepareRiverGame(base),root=g.nodes[0],lock={nodeId:'n0',probabilities:root.actions.map((_,i)=>i===0?1:0)},s={...base,locks:[lock],iterations:20};
  const gpu=await solveGPURiverGame(s),cpu=await solveRiverGame(s);compare(gpu,cpu);assert.ok(gpu.nodes[0].combos.every(c=>c.locked));assert.ok(gpu.nodes.filter(n=>n.actor>=0&&n.id!=='n0').some(n=>n.combos.some(c=>!c.locked)));assert.equal(gpu.diagnostics.constrainedNashConv,undefined);
});

test('GPU fixed rake already capped at root is charged once and agrees with CPU', {skip:!runGPU},async()=>{
  const s={...base,rake:5,rakeCap:.5,iterations:20,algorithm:'alternating-cfr-plus'};const gpu=await solveGPURiverGame(s),cpu=await solveRiverGame(s);compare(gpu,cpu);near(gpu.diagnostics.profileEV.reduce((a,b)=>a+b,0),9.5);near(gpu.diagnostics.constantSum,9.5);assert.equal(gpu.rakeModel.type,'fixed-cap-reached-at-root');
  assert.throws(()=>prepareGPURiverGame({...s,rakeCap:1}),/尚未达到/);
});

test('GPU final target is truthful and both managed child processes expose their PID', {skip:!runGPU},async()=>{
  const events=[],s={...base,algorithm:undefined,iterations:5,accuracy:100};const r=await solveGPURiverGame(s,{onProgress:p=>events.push(p)});
  assert.equal(r.stats.targetReached,r.diagnostics.nashConvPctPot<=100);assert.equal(r.stats.adaptiveStopping,false);assert.equal(r.stopReason,'iteration_limit');assert.ok(events.some(p=>p.phase==='running'&&Number.isInteger(p.processId)));assert.ok(events.some(p=>p.phase==='cpu-independent-verification'&&Number.isInteger(p.processId)));assert.equal(r.stats.iterations,5);
  const lifecycle=events.filter(p=>'processId' in p);assert.equal(lifecycle.length,4);assert.ok(Number.isInteger(lifecycle[0].processId));assert.equal(lifecycle[1].processId,null);assert.ok(Number.isInteger(lifecycle[2].processId));assert.equal(lifecycle[3].processId,null);
});
