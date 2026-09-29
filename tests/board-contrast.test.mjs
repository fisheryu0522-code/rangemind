import test from 'node:test';
import assert from 'node:assert/strict';
import {solveRiverGame} from '../lib/river-engine.mjs';
import {assertBoardContrast,compareBoards,decomposeFrequency} from '../lib/board-contrast.mjs';
const scenario={title:'Board contrast',board:'Ks7h2d9c3s',pot:20,toAct:0,hero:'AcKd',heroSeat:0,players:[{id:'a',position:'BB',name:'BB',stack:40,range:'AcKd,AhQh,7c7d,QcJc'},{id:'b',position:'BTN',name:'BTN',stack:40,range:'KhQd,QsQd,7s7d,AcJc'}]};
test('a single-card experiment cannot silently change ranges, rake, action origin or known private cards',()=>{
 const alt={...scenario,board:'Ks7h2d9cQc'};assert.deepEqual(assertBoardContrast(scenario,alt),{index:4,from:'3s',to:'Qc'});assert.throws(()=>assertBoardContrast(scenario,{...alt,pot:30}),/底池/);assert.throws(()=>assertBoardContrast(scenario,{...alt,board:'Qs7h2d9cQc'}),/一张/);assert.throws(()=>assertBoardContrast(scenario,{...alt,players:scenario.players.map(p=>({...p,range:'AA'}))}),/原始范围/);
});
test('frequency decomposition distinguishes common policy, reach mix, newly legal and removed combinations',()=>{
 const a={combos:[{combo:'AcKd',reach:6,probabilities:[1]},{combo:'AhQh',reach:4,probabilities:[0]}]},b={combos:[{combo:'AcKd',reach:7,probabilities:[.5]},{combo:'JcTd',reach:3,probabilities:[1]}]},r=decomposeFrequency(a,b,0);
 assert.equal(r.status,'complete');assert.ok(Math.abs(r.delta-.05)<1e-12);assert.ok(Math.abs(r.components.reduce((s,x)=>s+x.value,0)-r.delta)<1e-12);assert.ok(r.components.find(x=>x.id==='common-policy').value<0);assert.equal(r.components.find(x=>x.id==='added').value,.3);
 assert.equal(decomposeFrequency({combos:[{combo:'AcKd',reach:0,probabilities:[1]}]},b,0).status,'unavailable');
});
test('two actual full river solves expose legal-hand changes and per-hand policy/EV without invented causal claims',async()=>{
 const alt={...scenario,board:'Ks7h2d9cQc'},settings={sizes:[50],raiseSizes:[50],maxRaises:1,iterations:2000,checkEvery:100,accuracy:.05},a=await solveRiverGame({...scenario,...settings}),b=await solveRiverGame({...alt,...settings}),r=compareBoards(scenario,a,alt,b,{combo:'AcKd'});
 assert.equal(r.focus.scoreable,true);assert.ok(r.ranges[0].removed.some(x=>x.combo.includes('Qc')));assert.ok(r.actions.every(x=>x.status==='complete'&&Math.abs(x.identityError)<1e-9));assert.match(r.teaching.experiment,/待检验/);
 for(const action of r.focus.actions)assert.ok(Number.isFinite(action.evA)&&Number.isFinite(action.evB)&&action.regretA>=0&&action.regretB>=0);
 assert.equal(compareBoards(scenario,a,alt,b,{combo:'QcJc'}).focus.scoreable,false);
 const changed=await solveRiverGame({...alt,...settings,sizes:[75]});assert.throws(()=>compareBoards(scenario,a,alt,changed),/模板|条件/);
});
