import test from 'node:test';
import assert from 'node:assert/strict';
import {solveRiverGame} from '../lib/river-engine.mjs';
import {solveTurnGame} from '../lib/turn-engine.mjs';
import {createRangeConstruction,evaluateRangeConstruction} from '../lib/strategy-construction.mjs';
import {buildResponseWitness} from '../lib/response-witness.mjs';
import {evaluateHUPolicy} from '../lib/hu-policy-evaluation.mjs';

const model={title:'Response witness',board:'Ks7h2h9c3s',pot:20,toAct:0,heroSeat:0,players:[{id:'a',name:'BB',position:'BB',range:'AcKd,AhQh:0.3,7c7d',stack:30},{id:'b',name:'BTN',position:'BTN',range:'KcQd,QhJh:0.7,9h9s',stack:20}],sizes:[50],raiseSizes:[50],maxRaises:1,allIn:false,iterations:300};
function submit(input,result,nodeId='n0'){
 const q=createRangeConstruction(input,result,{nodeId}).publicQuestion;
 return {nodeId,sourceFingerprint:q.sourceFingerprint,assignments:q.combos.filter(r=>r.editable).map((r,i)=>({combo:r.combo,probabilities:Object.fromEntries(q.actions.map((a,j)=>[a.id,j===i%q.actions.length?1:0]))}))};
}
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);

test('a concrete HU response realizes native unrestricted BR and decomposes every root BB',async()=>{
 const result=await solveRiverGame(model),submission=submit(model,result),grade=await evaluateRangeConstruction(model,result,submission),before=JSON.stringify(result);
 const witness=buildResponseWitness(model,result,submission,{independentEvaluation:grade.independentEvaluation});
 assert.equal(witness.status,'complete');assert.ok(witness.nodes.length>0);assert.equal(witness.sourceFingerprint,submission.sourceFingerprint);
 close(witness.values.opponentGainBB,grade.independentEvaluation.submitted.gain[1]);
 close(witness.values.rootGainContributionBB,witness.values.opponentGainBB);
 close(witness.values.positiveContributionBB+witness.values.negativeContributionBB,witness.values.opponentGainBB);
 close(witness.values.userEVChangeBB,-witness.values.opponentGainBB);
 assert.equal(witness.verification.informationSetConsistent,true);assert.equal(witness.verification.clairvoyant,false);
 for(const node of witness.nodes){close(node.actions.reduce((s,a)=>s+a.responseFrequency,0),1);for(const row of node.topCombos)close(row.actions.reduce((s,a)=>s+a.responseProbability,0),1);}
 assert.equal(JSON.stringify(result),before);
});

test('captured policies retain one action per own-hand information set, never clairvoyant folds',async()=>{
 const raw={...model,board:'KcQd8h6s2c',pot:10,players:[{id:'a',name:'Bettor',position:'BB',range:'AsAh:80%,3d4d:20%',stack:20},{id:'b',name:'Catcher',position:'BTN',range:'JsJh',stack:20}],raiseSizes:[],maxRaises:0};
 const result=await solveRiverGame(raw),submission=submit(raw,result);for(const row of submission.assignments)for(const action of Object.keys(row.probabilities))row.probabilities[action]=action==='bet_5'?1:0;const w=buildResponseWitness(raw,result,submission);
 close(w.values.bestResponseEV,0);assert.notEqual(w.values.bestResponseEV,3);
 const reply=w.nodes.find(n=>n.path.includes('bet_5'));assert.ok(reply);assert.equal(reply.topCombos[0].responseActionId,'fold');
 const captured=evaluateHUPolicy({...result,capabilities:{fullTree:true}},{captureBestResponse:true});
 for(let p=0;p<2;p++)assert.equal(new Set(captured.bestResponsePolicies[p].map(r=>r.nodeId+':'+r.combo)).size,captured.bestResponsePolicies[p].length);
 const ordinary=evaluateHUPolicy(captured,{computeBestResponse:false});assert.equal(ordinary.bestResponsePolicies,undefined);
 assert.throws(()=>evaluateHUPolicy(captured,{computeBestResponse:false,captureBestResponse:true}),/需要启用/);
});

test('turn chance, deep-node changes, unequal stacks and capped rake satisfy the same response identity',async()=>{
 const raw={...model,board:'Ks7h2h9c',rake:5,rakeCap:.5,maxRaises:0,riverMaxRaises:0,iterations:100};
 const result=await solveTurnGame(raw),target=result.nodes.find(n=>n.actor===1&&!n.chance&&n.reach>.01),submission=submit(raw,result,target.id),grade=await evaluateRangeConstruction(raw,result,submission);
 const w=buildResponseWitness(raw,result,submission,{independentEvaluation:grade.independentEvaluation});
 assert.equal(w.source.userSeat,1);assert.equal(w.source.opponentSeat,0);close(w.values.rootGainContributionBB,grade.independentEvaluation.submitted.gain[0]);
 close(w.values.witnessPolicyEV.reduce((a,b)=>a+b,0),raw.pot-.5);
 assert.ok(w.counts.respondingNodes>w.nodes.length);
});

test('reference mismatch, missing policies and insufficient work budgets never publish a witness',async()=>{
 const result=await solveRiverGame(model),submission=submit(model,result);
 assert.throws(()=>buildResponseWitness(model,result,submission,{maxNodeDealVisits:1}),/预算/);
 assert.throws(()=>buildResponseWitness(model,result,submission,{independentEvaluation:{status:'complete',submitted:{profileEV:[0,0],bestResponseEV:[0,0]}}}),/不是同一政策/);
 const changed=structuredClone(result);changed.nodes[0].combos.pop();assert.throws(()=>buildResponseWitness(model,changed,submission),/改变|缺少|不属于/);
 assert.throws(()=>buildResponseWitness({...model,players:[...model.players,model.players[0]]},result,submission),/双人/);
});
