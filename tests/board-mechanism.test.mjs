import test from 'node:test';
import assert from 'node:assert/strict';
import {solveRiverGame} from '../lib/river-engine.mjs';
import {compareBoards} from '../lib/board-contrast.mjs';
import {explainDecision} from '../lib/decision-explanation.mjs';
import {compareBoardMechanism} from '../lib/board-mechanism.mjs';
test('card-change teaching distinguishes EV movement from action advantage using complete terminal contribution identities',async()=>{
 const s={title:'Mechanism',board:'Ks7h2d9c3s',pot:20,toAct:0,hero:'AcKd',heroSeat:0,players:[{id:'a',position:'BB',name:'BB',stack:40,range:'AcKd,AhQh,7c7d,QcJc'},{id:'b',position:'BTN',name:'BTN',stack:40,range:'KhQd,QsQd,7s7d,AcJc'}]},b={...s,board:'Ks7h2d9cQc'},settings={sizes:[50],raiseSizes:[50],maxRaises:1,iterations:2000,checkEvery:100,accuracy:.05};
 const ra=await solveRiverGame({...s,...settings}),rb=await solveRiverGame({...b,...settings}),report=compareBoards(s,ra,b,rb,{combo:'AcKd'}),da=explainDecision(s,ra,{combo:'AcKd'}),db=explainDecision(b,rb,{combo:'AcKd'}),r=compareBoardMechanism(report,da,db);
 assert.equal(r.baseline.id,'check');assert.equal(r.combo,report.focus.combo);for(const a of r.actions){assert.ok(Math.abs(a.outcomes.reduce((s,x)=>s+x.deltaContribution,0)-a.deltaEV)<1e-9);assert.ok(Math.abs(a.outcomes.reduce((s,x)=>s+x.deltaAdvantage,0)-a.deltaAdvantage)<1e-9);}assert.ok(r.verification.maximumActionEVError<1e-9);
 const tampered=structuredClone(db);tampered.actions[0].outcomes[0].evContribution+=1;assert.throws(()=>compareBoardMechanism(report,da,tampered),/守恒/);assert.throws(()=>compareBoardMechanism(report,da,db,{baselineActionId:'made-up'}),/基准/);
 const wrong=structuredClone(report);wrong.focus.combo='7c7d';assert.throws(()=>compareBoardMechanism(wrong,da,db),/同组合/);
});
