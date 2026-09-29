import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {solveRiverGame} from '../lib/river-engine.mjs';
import {solveTurnGame} from '../lib/turn-engine.mjs';
import {evaluateHUPolicy} from '../lib/hu-policy-evaluation.mjs';
const close=(a,b,e=1e-8)=>a===null||b===null?assert.equal(a,b):assert.ok(Math.abs(a-b)<=e,`${a} != ${b}`);
const input={board:'Ks7h2h9c3s',pot:20,players:[{id:'a',range:'AcKd,AhQh:0.3,7c7d',stack:30},{id:'b',range:'KcQd,QhJh:0.7,9h9s',stack:20}],sizes:[50],raiseSizes:[50],maxRaises:1,allIn:false,iterations:1000};
const full=r=>({...r,capabilities:{...r.capabilities,fullTree:true}});
function compare(a,b){
  for(const key of ['profileEV','bestResponseEV','gain'])a.diagnostics[key].forEach((v,p)=>close(v,b.diagnostics[key][p]));close(a.diagnostics.nashConv,b.diagnostics.nashConv);
  for(let i=0;i<a.nodes.length;i++){
    const n=a.nodes[i],m=b.nodes[i];close(n.reach,m.reach);if(n.profileEV!==undefined)close(n.profileEV,m.profileEV);
    for(const row of n.combos){const c=m.combos.find(c=>c.combo===row.combo);close(row.ev,c.ev);close(row.reach,c.reach);close(row.counterfactualReach,c.counterfactualReach);row.actionEV.forEach((v,a)=>close(v,c.actionEV[a]));}
    for(let j=0;j<n.actions.length;j++){close(n.actions[j].frequency,m.actions[j].frequency);close(n.actions[j].ev,m.actions[j].ev);if(n.actions[j].selectedEV!==undefined)close(n.actions[j].selectedEV,m.actions[j].selectedEV);}
  }
}
test('independent evaluator reproduces RiverLab per-hand EV, ranges and exact information-set BR',async()=>{
  const r=await solveRiverGame(input),original=structuredClone(r),e=evaluateHUPolicy(full(r));compare(r,e);assert.deepEqual(r,original);assert.equal(e.capabilities.actionEV,true);assert.equal(e.policyEvaluation.exact,true);
});
test('independent evaluator reproduces TurnLab full future strategy and BR with private-card-conditioned chance',async()=>{
  const r=await solveTurnGame({...input,board:'Ks7h2h9c',maxRaises:0,riverMaxRaises:0,iterations:300}),e=evaluateHUPolicy(full(r));compare(r,e);
  const changed=full(structuredClone(r));for(const n of changed.nodes)for(const a of n.actions)a.frequency=.123;const again=evaluateHUPolicy(changed);compare(e,again);
});
test('fixed cap, unreachable own actions and node locks evaluate the fixed policy, not its best response',async()=>{
  const r=await solveRiverGame({...input,rake:5,rakeCap:1,locks:[{nodeId:'n0',actions:{check:1}}]}),e=evaluateHUPolicy(full(r));compare(r,e);close(e.diagnostics.constantSum,19);assert.ok(e.nodes.some(n=>n.combos.some(c=>c.reach===0&&c.counterfactualReach>0)));
});
test('partial trees, missing private policies and unsafe evaluation budgets reject explicitly',async()=>{
  const r=full(await solveRiverGame({...input,iterations:1}));assert.throws(()=>evaluateHUPolicy({...r,capabilities:{fullTree:false}}),/完整/);assert.throws(()=>evaluateHUPolicy({...r,nodes:r.nodes.map((n,i)=>i?n:{...n,outOfScope:true})}),/outOfScope/);assert.throws(()=>evaluateHUPolicy(r,{maxNodeDealVisits:1}),/预算/);
  const missing=structuredClone(r);missing.nodes[0].combos.pop();assert.throws(()=>evaluateHUPolicy(missing),/缺少策略/);
});
test('full shallow-SPR HU flop export has independently verified complete future-street EV and BR',()=>{
  const filename=new URL('../data/pro/jobs/0efe8ce2-6286-45c1-8528-18ae7b9d86fd/result.json',import.meta.url);if(!fs.existsSync(filename))return;
  const r=JSON.parse(fs.readFileSync(filename)),e=evaluateHUPolicy(r);assert.equal(e.nodes.length,31124);assert.equal(e.policyEvaluation.legalHoleDeals,4);assert.ok(e.nodes.filter(n=>n.actor>=0).every(n=>n.combos.every(c=>c.actionEV.every(x=>x===null||Number.isFinite(x)))));close(e.diagnostics.profileEV.reduce((a,b)=>a+b,0),r.input.pot);assert.ok(e.diagnostics.gain.every(x=>x>=0));assert.ok(e.nodes.some(n=>n.street==='flop'&&n.combos.some(c=>c.actionEV.every(Number.isFinite))));
});

test('own hand prior changes reaches but cancels from that same hand conditional action EV',async()=>{
  const r=full(await solveRiverGame({...input,iterations:200})),a=evaluateHUPolicy(r),changed=structuredClone(r);changed.input.players[0].range='AcKd:0.01,AhQh:0.8,7c7d:0.2';const b=evaluateHUPolicy(changed);
  assert.notEqual(a.nodes[0].combos[0].reach,b.nodes[0].combos[0].reach);for(let i=0;i<a.nodes.length;i++)if(a.nodes[i].actor===0)for(const row of a.nodes[i].combos){const other=b.nodes[i].combos.find(c=>c.combo===row.combo);row.actionEV.forEach((v,a)=>close(v,other.actionEV[a]));}
});

test('turn all-in terminals integrate every unknown river and return unmatched chips intact',async()=>{
  const r=await solveTurnGame({...input,board:'Ks7h2h9c',pot:10,players:input.players.map((p,i)=>({...p,stack:[8,2][i]})),maxRaises:0,riverMaxRaises:0,iterations:200}),e=evaluateHUPolicy(full(r));assert.ok(r.nodes.some(n=>n.terminal&&n.board.length===8&&!n.folded.some(Boolean)));compare(r,e);
});

test('flop all-in early settlement equals explicit two-card chance subtree',()=>{
  const filename=new URL('../data/pro/jobs/0efe8ce2-6286-45c1-8528-18ae7b9d86fd/result.json',import.meta.url);if(!fs.existsSync(filename))return;
  const original=JSON.parse(fs.readFileSync(filename)),a=evaluateHUPolicy(original),copy=structuredClone(original),old=copy.nodes,nodes=[];let collapsed=0;
  function visit(index,parentId=null){const source=old[index],id=nodes.length,node={...source,id:`n${id}`,parentId,actions:[]};nodes.push(node);if(source.chance&&source.contributions.every(v=>v>=2)){Object.assign(node,{terminal:true,chance:false,actor:-1,actorId:null,terminalKind:'showdown'});collapsed++;}else for(const action of source.actions){const child=visit(Number(action.childId.slice(1)),node.id);node.actions.push({...action,childId:`n${child}`});}return id;}visit(0);copy.nodes=nodes;
  assert.ok(collapsed>0);const b=evaluateHUPolicy(copy);for(const key of ['profileEV','bestResponseEV','gain'])a.diagnostics[key].forEach((v,p)=>close(v,b.diagnostics[key][p]));for(let c=0;c<a.nodes[0].combos.length;c++)a.nodes[0].combos[c].actionEV.forEach((v,i)=>close(v,b.nodes[0].combos[c].actionEV[i]));
});

test('missing legal public chance branches reject, while old native report discrepancies remain visible',async()=>{
  const r=full(await solveTurnGame({...input,board:'Ks7h2h9c',maxRaises:0,riverMaxRaises:0,iterations:1})),chance=r.nodes.find(n=>n.chance);chance.actions=chance.actions.filter(a=>a.label!=='2c');assert.throws(()=>evaluateHUPolicy(r),/缺少合法公共牌/);
  const s=full(await solveRiverGame({...input,iterations:1}));s.diagnostics.reportedExploitabilityPctPot=999;const e=evaluateHUPolicy(s);assert.equal(e.diagnostics.nativeReportConsistent,false);assert.ok(e.diagnostics.nativeReportDifferencePctPot>1);
});
