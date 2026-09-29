import test from 'node:test';
import assert from 'node:assert/strict';
import {solveRiverGame} from '../lib/river-engine.mjs';
import {runSensitivity} from '../lib/sensitivity.mjs';
import {range,cards} from '../lib/poker.mjs';
const scenario={title:'范围实验核验',board:'Ks7h2d9c3s',pot:10,toAct:0,hero:'AcKd',heroSeat:0,players:[{id:'h',name:'Hero',position:'BB',stack:20,range:'AcKd,AhQh'},{id:'v',name:'Opponent',position:'BTN',stack:20,range:'KhQd:0.8,QcJc:0.4'}]},settings={sizes:[50],raiseSizes:[50],maxRaises:1,iterations:300,checkEvery:100};
test('range experiment changes only selected weights and compares regret within each real solve',async()=>{
 const baseline=await solveRiverGame({...scenario,...settings}),events=[];
 const result=await runSensitivity({scenario,settings,baseline,player:1,subset:'QcJc',combo:'AcKd',scales:[.25,.5,1]},{onProgress:e=>events.push(e)});
 assert.equal(result.rows.length,3);assert.equal(result.affectedCombos.length,1);assert.ok(events.some(e=>e.phase==='variant'));
 for(const row of result.rows){const weights=new Map(range(row.range,cards(scenario.board)).live.map(c=>[c.label,c.weight]));assert.equal(weights.get('QdKh'),.8);assert.equal(weights.get('JcQc'),.4*row.scale);const best=Math.max(...row.actions.map(a=>a.ev));for(const action of row.actions)assert.ok(Math.abs(action.loss-(best-action.ev))<1e-10);}
 const focus=baseline.nodes[0].combos.find(c=>c.combo==='KdAc');assert.deepEqual(result.rows.at(-1).actions.map(a=>a.ev),focus.actionEV);
 for(const action of result.actions)assert.equal(action.maxRegret,Math.max(...result.rows.map(r=>r.actions.find(a=>a.id===action.id).loss)));
 assert.ok(result.minimaxRegretActions.length>0);assert.equal(scenario.players[1].range,'KhQd:0.8,QcJc:0.4');
});
test('unsupported, empty, self-range and duplicate hypotheses are rejected',async()=>{
 const baseline=await solveRiverGame({...scenario,...settings}),input={scenario,settings,baseline,player:1,subset:'QcJc',combo:'AcKd'};
 await assert.rejects(runSensitivity({...input,player:0}),/对手/);await assert.rejects(runSensitivity({...input,subset:'8c8d'}),/交集/);await assert.rejects(runSensitivity({...input,scales:[.5,.5]}),/不同/);await assert.rejects(runSensitivity({...input,baseline:{...baseline,chance:{exact:false}}}),/完整机会/);
});
