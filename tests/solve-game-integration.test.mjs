import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {solveGame} from '../lib/solve-game.mjs';
import {createStudyQuestion} from '../lib/coach.mjs';

const input={title:'Dispatcher integration only',format:'study',board:'Ks7h2d',hero:'AcKd',heroSeat:0,pot:10,toAct:0,players:[{id:'a',name:'OOP',position:'BB',stack:2,range:'AcKd,AhQh:0.3'},{id:'b',name:'IP',position:'BTN',stack:2,range:'KhQd,QcJc:0.7'}],sizes:[],raiseSizes:[],maxRaises:0,allIn:true,iterations:3,accuracy:.000001,threads:1,maxNodes:100000};

test('central flop dispatch persists independently evaluated full-tree EV and usable study evidence',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pokerlab-dispatch-')),outputFile=path.join(dir,'result.json'),events=[];
  try{
    const result=await solveGame({...input,outputScope:'full'},{outputFile,onProgress:p=>events.push(p)});
    assert.equal(result.capabilities.fullTree,true);assert.equal(result.capabilities.actionEV,true);assert.equal(result.capabilities.studyCards,true);assert.equal(result.capabilities.evBreakdown,false);
    assert.equal(result.policyEvaluation.exact,true);assert.equal(result.diagnostics.independentlyVerified,true);assert.ok(Number.isFinite(result.diagnostics.nashConv));assert.ok(Number.isFinite(result.diagnostics.reportedExploitabilityPctPot));assert.ok(result.diagnostics.nativeReportConsistent);
    assert.ok(Math.abs(result.diagnostics.profileEV.reduce((a,b)=>a+b,0)-input.pot)<1e-8);assert.equal(result.stats.targetReached,result.diagnostics.exploitabilityPctPot<=input.accuracy);assert.equal(result.stats.targetMetric,'independentExploitabilityPctPot');assert.ok(events.some(p=>p.phase==='independent-policy-evaluation'));
    assert.ok(result.nodes.some(n=>n.chance&&n.street==='flop'));assert.ok(result.nodes.some(n=>n.chance&&n.street==='turn'));assert.ok(result.nodes.some(n=>n.actor>=0&&n.street==='river'));
    const node=result.nodes[0],combo=node.combos.find(c=>c.reach>0);assert.ok(combo.actionEV.every(Number.isFinite));const card=createStudyQuestion(input,result,{combo:combo.combo});assert.equal(card.publicQuestion.quality.mode,'exact');assert.ok(Object.values(card.full.actionEV).every(Number.isFinite));assert.equal(card.publicQuestion.actionEV,undefined);
    const saved=JSON.parse(fs.readFileSync(outputFile));assert.equal(saved.capabilities.studyCards,true);assert.equal(saved.policyEvaluation.exact,true);assert.deepEqual(saved.nodes[0].combos[0].actionEV,result.nodes[0].combos[0].actionEV);
  }finally{const absolute=path.resolve(dir);assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(absolute,{recursive:true,force:true});}
});

test('central current-street dispatch never upgrades incomplete output to verified EV or a training answer',async()=>{
  const result=await solveGame({...input,outputScope:'current-street'});
  assert.equal(result.outputScope,'current-street');assert.deepEqual(result.scope.solvedStreets,['flop','turn','river']);assert.deepEqual(result.scope.exportedStreets,['flop']);assert.equal(result.capabilities.fullTree,false);assert.equal(result.capabilities.actionEV,false);assert.equal(result.capabilities.studyCards,false);assert.equal(result.capabilities.evBreakdown,false);assert.equal(result.diagnostics.independentlyVerified,false);assert.equal(result.diagnostics.nashConv,undefined);assert.equal(result.policyEvaluation,undefined);
  assert.ok(result.nodes.some(n=>n.outOfScope&&n.chance&&!n.terminal&&n.actions.length===0));for(const n of result.nodes){assert.ok(n.combos.every(c=>c.actionEV.every(v=>v===null)));assert.ok(n.actions.every(a=>a.ev===null));}
  assert.throws(()=>createStudyQuestion(input,result,{combo:result.nodes[0].combos[0].combo}),/有效行动 EV/);
});
