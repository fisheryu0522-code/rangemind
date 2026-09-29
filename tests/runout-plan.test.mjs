import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {prepareTurnGame,solveTurnGame} from '../lib/turn-engine.mjs';
import {cards,cardText,range} from '../lib/poker.mjs';
import {listRunoutPlans,buildRunoutPlan} from '../lib/runout-plan.mjs';
import {evaluateHUPolicy} from '../lib/hu-policy-evaluation.mjs';
const close=(a,b,epsilon=1e-9)=>assert.ok(Math.abs(a-b)<=epsilon,`${a} != ${b}`);
const input={title:'多人的下一街条件分布',board:'Ks7h2h9c',pot:20,toAct:0,heroSeat:0,hero:'AcKd',players:[{id:'a',name:'Hero',position:'SB',range:'AcKd,AhQh:30%',stack:30},{id:'b',name:'B',position:'BB',range:'KcQd,QhJh:70%',stack:30},{id:'c',name:'C',position:'BTN',range:'9h9s,JhTh',stack:20}],sizes:[50],raiseSizes:[50],riverSizes:[50],riverRaiseSizes:[50],maxRaises:0,riverMaxRaises:0,allIn:false,iterations:80,accuracy:.5};
test('check-through future-card probabilities and EV equal direct legal deal enumeration',async()=>{
 const s={...input,sizes:[],riverSizes:[],iterations:1},g=prepareTurnGame(s),r=await solveTurnGame(s),sources=listRunoutPlans(s,r);assert.equal(sources.sources.length,1);
 for(const focusCombo of [undefined,'AcKd','AhQh']){
  const report=buildRunoutPlan(s,r,{chancePath:sources.sources[0].path,focusCombo}),focus=focusCombo?range(focusCombo).live[0].label:null,deals=g.deals.filter(d=>!focus||g.combinations[0][d.hands[0]].combo===focus),total=deals.reduce((s,d)=>s+d.weight,0),expected=new Map();
  for(const d of deals)expected.set(cardText(d.river),(expected.get(cardText(d.river))??0)+d.weight/total);
  assert.equal(report.rows.length,48);close(report.summary.probabilitySum,1);for(const row of report.rows)close(row.probability,expected.get(row.card)??0);
  if(!focusCombo)close(report.summary.weightedReferenceEV,r.diagnostics.profileEV[0]);else assert.equal(report.rows.filter(x=>x.status==='blocked-by-focus').length,2);
 }
});
test('after turn bet/fold/call, posterior runouts include folded private cards and own historical action',async()=>{
 const g=prepareTurnGame(input),r=await solveTurnGame(input),route=['bet_10','fold','call'],m=new Map(r.nodes.map(n=>[n.id,n]));let cursor=m.get('n0');const steps=[];for(const id of route){const index=cursor.actions.findIndex(a=>a.id===id);assert.ok(index>=0);steps.push({node:cursor,index});cursor=m.get(cursor.actions[index].childId);}
 assert.ok(cursor.chance);assert.ok(cursor.reach>0);const report=buildRunoutPlan(input,r,{chancePath:route,focusCombo:'AcKd'}),index=g.combinations[0].findIndex(x=>x.combo===range('AcKd').live[0].label),weights=[];
 for(const d of g.deals){if(d.hands[0]!==index)continue;let w=d.weight;for(const step of steps){const label=g.combinations[step.node.actor][d.hands[step.node.actor]].combo,row=step.node.combos.find(c=>c.combo===label);w*=row.probabilities[step.index];}weights.push({d,w});}
 const total=weights.reduce((s,x)=>s+x.w,0),expected=new Map();for(const {d,w} of weights)expected.set(cardText(d.river),(expected.get(cardText(d.river))??0)+w/total);
 for(const row of report.rows)close(row.probability,expected.get(row.card)??0);close(report.summary.probabilitySum,1);
 // Uniform over 46 unobserved cards would ignore the other ranges and folds.
 assert.ok(report.rows.some(row=>row.probability>0&&Math.abs(row.probability-1/46)>1e-4));
 const available=report.rows.find(row=>row.status==='available'),node=m.get(available.nodeId),focus=node.combos.find(c=>c.combo===range('AcKd').live[0].label);available.actions.forEach((a,i)=>{close(a.ev,focus.actionEV[i]);close(a.frequency,focus.probabilities[i]);});
});
test('range action values mean forcing the same range, rather than conditioning on action-selected hands',async()=>{
 const r=await solveTurnGame(input),source=listRunoutPlans(input,r).sources.find(s=>JSON.stringify(s.path)==='["check","check","check"]'),report=buildRunoutPlan(input,r,{chancePath:source.path});
 for(const row of report.rows.filter(x=>x.status==='available')){const n=r.nodes.find(n=>n.id===row.nodeId);for(let i=0;i<row.actions.length;i++){close(row.actions[i].ev,n.actions[i].ev);close(row.actions[i].frequency,n.actions[i].frequency);}assert.equal(row.bestEV,null);assert.equal(row.nearBestActions,null);}
});
test('invalid, blocked, partial and inconsistent sources reject instead of inventing future probabilities',async()=>{
 const r=await solveTurnGame({...input,iterations:1}),source=listRunoutPlans(input,r).sources.find(s=>s.reach>0),options={chancePath:source.path};
 assert.throws(()=>buildRunoutPlan(input,r,{chancePath:[]}),/不是河牌发牌前/);
 assert.throws(()=>buildRunoutPlan(input,r,{...options,focusCombo:'KsAs'}),/公共牌冲突/);
 assert.throws(()=>buildRunoutPlan(input,r,{...options,focusCombo:'2c3c'}),/不属于/);
 assert.throws(()=>listRunoutPlans(input,{...r,capabilities:{fullTree:false}}),/完整/);
 const bad=structuredClone(r),chance=bad.nodes.find(n=>n.id===source.nodeId);chance.actions.pop();assert.throws(()=>buildRunoutPlan(input,bad,options),/未守恒/);
 const zero=structuredClone(r);zero.nodes.find(n=>n.id===source.nodeId).reach=0;assert.throws(()=>buildRunoutPlan(input,zero,options),/零到达/);
});
test('complete HU flop exports retain exact river aggregation from an observed turn line',()=>{
 const file=new URL('../data/pro/jobs/0efe8ce2-6286-45c1-8528-18ae7b9d86fd/result.json',import.meta.url);if(!fs.existsSync(file))return;
 const result=evaluateHUPolicy(JSON.parse(fs.readFileSync(file))),sources=listRunoutPlans(result.input,result),source=sources.sources.find(s=>s.reach>0);assert.ok(source);const report=buildRunoutPlan(result.input,result,{chancePath:source.path});close(report.summary.probabilitySum,1);assert.ok(report.rows.some(r=>r.status==='available'));assert.equal(report.context.actorSeat,source.actorSeat);
});

test('focus conditioning cannot renormalize over missing chance branches or missing private rows',async()=>{
 const s={...input,sizes:[],riverSizes:[],iterations:1},r=await solveTurnGame(s),source=listRunoutPlans(s,r).sources[0],options={chancePath:source.path,focusCombo:'AcKd'},report=buildRunoutPlan(s,r,options),available=report.rows.find(row=>row.status==='available');
 const missingBranch=structuredClone(r),chance=missingBranch.nodes.find(n=>n.id===source.nodeId);chance.actions=chance.actions.filter(a=>a.childId!==available.nodeId);
 assert.throws(()=>buildRunoutPlan(s,missingBranch,options),/质量.*未守恒|质量.*不一致/);
 const missingRow=structuredClone(r),node=missingRow.nodes.find(n=>n.id===available.nodeId);node.combos=node.combos.filter(c=>c.combo!==range('AcKd').live[0].label);
 assert.throws(()=>buildRunoutPlan(s,missingRow,options),/质量.*不一致/);
});

test('tiny positive histories still require relative conservation and no hidden partial-tree boundary',async()=>{
 const s={...input,sizes:[],riverSizes:[],iterations:1},r=await solveTurnGame(s),source=listRunoutPlans(s,r).sources[0],options={chancePath:source.path,focusCombo:'AcKd'},scaled=structuredClone(r);
 for(const n of scaled.nodes){n.reach*=1e-40;for(const c of n.combos??[])c.reach*=1e-40;}
 const normal=buildRunoutPlan(s,r,options),tiny=buildRunoutPlan(s,scaled,options);tiny.rows.forEach((row,i)=>close(row.probability,normal.rows[i].probability));
 scaled.nodes.find(n=>n.id===source.nodeId).actions.pop();assert.throws(()=>buildRunoutPlan(s,scaled,options),/质量.*未守恒/);
 const partial=structuredClone(r);partial.nodes.at(-1).outOfScope=true;assert.throws(()=>listRunoutPlans(s,partial),/完整|未导出/);
});
