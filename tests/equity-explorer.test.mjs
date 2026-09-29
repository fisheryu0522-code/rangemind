import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareEquityExplorer,runEquityExplorer,equityDistribution} from '../lib/equity-explorer.mjs';
const players=[{id:'bb',position:'BB',range:'AsAd,KhKd'},{id:'btn',position:'BTN',range:'QhQd,JhJd'}];
test('equity stages require explicit ranges and do not infer a solver range from open or 5bet labels',()=>{
 const input=prepareEquityExplorer({board:'2c 3c 4h',stages:[{label:'5bet',players}]});assert.equal(input.stages[0].players[0].range,players[0].range);assert.match(input.meaning,/未求解翻前/);
 assert.throws(()=>prepareEquityExplorer({board:'',stages:[{label:'open',players:[{range:''},{range:'AA'}]}]}),/范围|range|empty/i);
 assert.throws(()=>prepareEquityExplorer({board:'As 3h 2d',stages:[{players:[{range:'AsAd'},{range:'KhKd'}]}]}),/范围|牌|移除/);
 assert.throws(()=>prepareEquityExplorer({board:'2h 3d 4c',stages:[{players}],runoutStageId:'missing'}),/有效阶段/);
});
test('exact river and stage curves preserve equity accounting and invariance to position names',async()=>{
 const r=await runEquityExplorer({board:'2c 3c 4h 8d 9s',includeStreetTrail:false,engine:'cpu',stages:[{id:'open',players},{id:'threebet',players:players.map(p=>({...p,position:p.id==='bb'?'UTG':'CO'}))}]});
 assert.equal(r.rows.length,2);assert.deepEqual(r.rows[0].players.map(p=>p.equity),r.rows[1].players.map(p=>p.equity));assert.equal(r.rows[0].exact,true);
 for(const row of r.rows)for(const p of row.players)assert.ok(Math.abs(p.distribution.weightedMean-p.equity)<1e-12);
});
test('CPU preflop stage models draw five legal community cards and report sampling uncertainty',async()=>{
 const r=await runEquityExplorer({board:'',samples:10000,engine:'cpu',stages:[{players:[{id:'a',range:'AsAd'},{id:'b',range:'AcAh'}]}]});
 assert.equal(r.rows.length,1);const row=r.rows[0];assert.equal(row.street,'preflop');assert.equal(row.exact,false);assert.equal(row.samples,10000);assert.ok(row.players.every(p=>p.ci>0&&p.ciLow<.5&&p.ciHigh>.5));assert.ok(Math.abs(row.players.reduce((s,p)=>s+p.equity,0)-1)<1e-10);
});
test('all next-card models exclude impossible cards and use legal joint-hand probabilities',async()=>{
 const r=await runEquityExplorer({board:'2c 3c 4h 8d',samples:10000,engine:'cpu',includeStreetTrail:false,runoutStageId:'s',stages:[{id:'s',players:[{id:'a',range:'AsAd'},{id:'b',range:'KhKd'}]}]});
 const next=r.rows.filter(x=>x.kind==='next-card'&&x.status==='complete'),unavailable=r.rows.filter(x=>x.status==='unavailable');assert.equal(next.length,44);assert.equal(unavailable.length,4);assert.equal(new Set(next.map(x=>x.card)).size,44);assert.ok(next.every(x=>x.exact&&Math.abs(x.nextCardProbability-1/44)<1e-12));assert.ok(Math.abs(next.reduce((s,x)=>s+x.nextCardProbability,0)-1)<1e-12);
});
test('an aborted exploration publishes no partial curves',async()=>{const c=new AbortController();c.abort();await assert.rejects(runEquityExplorer({board:'2c 3c 4h 8d 9s',includeStreetTrail:false,stages:[{players}]},{signal:c.signal}),/取消/);});
test('GPU preflop and multiple-board batch agree with a symmetric hand model', {skip:process.env.POKERLAB_TEST_GPU!=='1'},async()=>{
 const r=await runEquityExplorer({board:'2c 3c 4h',samples:100000,engine:'gpu',stages:[{players:[{id:'a',range:'AsAd'},{id:'b',range:'AcAh'}]}]});
 assert.equal(r.rows.length,2);for(const row of r.rows){assert.match(row.engine,/CUDA|NVIDIA/i);assert.equal(row.samples,100000);assert.ok(Math.abs(row.players.reduce((s,p)=>s+p.equity,0)-1)<1e-9);}const pre=r.rows.find(x=>x.street==='preflop');assert.ok(pre.players.every(p=>p.ciLow<.5&&p.ciHigh>.5));
});
