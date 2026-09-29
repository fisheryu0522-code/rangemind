import test from 'node:test';
import assert from 'node:assert/strict';
import {explainDecision} from '../lib/decision-explanation.mjs';
import {prepareRiverGame,solveRiverGame} from '../lib/river-engine.mjs';
import {solveTurnGame} from '../lib/turn-engine.mjs';
import {cards} from '../lib/poker.mjs';

const near=(a,b,e=1e-7)=>assert.ok(Math.abs(a-b)<e,`${a} differs from ${b}`);
const next=(r,n,type)=>{const a=n.actions.find(a=>a.id===type||a.type===type);assert.ok(a,`${type} missing from ${n.id}`);return r.nodes.find(x=>x.id===a.childId);};
function checkAccounting(report){
  near(report.maxDifference,0,1e-5);
  for(const a of report.actions){near(a.probabilitySum,1);near(a.responses.reduce((s,r)=>s+r.probability,0),1);near(a.outcomes.reduce((s,r)=>s+r.probability,0),1);near(a.responses.reduce((s,r)=>s+r.evContribution,0),a.ev);near(a.outcomes.reduce((s,r)=>s+r.evContribution,0),a.ev);for(const r of [...a.responses,...a.outcomes])if(r.conditionalEV!==null)near(r.probability*r.conditionalEV,r.evContribution);}
  for(const c of report.comparisons){near(c.outcomes.reduce((s,o)=>s+o.difference,0),c.evDifference);near(c.alternative.ev-c.baseline.ev,c.evDifference);}
}

test('folded player cards and fold likelihood both condition the current hero action EV',async()=>{
  const s={board:'2c4d6h8sTc',pot:10,hero:'QhQs',heroSeat:2,toAct:0,players:[{id:'a',name:'Bettor',range:'AcAd,JcJh',stack:20},{id:'b',name:'Folder',range:'AcKd,5c5d',stack:20},{id:'c',name:'Hero',range:'QhQs',stack:20}],sizes:[50],raiseSizes:[],maxRaises:0,allIn:false,iterations:2};
  const g=prepareRiverGame(s),b=next(g,g.nodes[0],'bet'),c=next(g,b,'fold');
  const locks=[{nodeId:'n0',actions:{bet_5:1}},{nodeId:b.id,combo:'AcKd',actions:{fold:1}},{nodeId:b.id,combo:'5c5d',actions:{fold:.25,call:.75}}];
  const r=await solveRiverGame({...s,locks}),report=explainDecision(s,r,{nodeId:c.id,combo:s.hero});checkAccounting(report);
  // Legal weighted tuples after Folder folds: AA+55 has weight .25;
  // JJ+AcKd and JJ+55 have weights 1 and .25. QQ wins 5/6, not 1/2.
  near(report.actions.find(a=>a.type==='call').ev,20*5/6-5);near(report.actions.find(a=>a.type==='fold').ev,0);
});

test('counterfactual reach supports own zero-probability earlier action without inventing observed reach',async()=>{
  const s={board:'2c4d6h8sTc',pot:10,hero:'AcAd',heroSeat:0,toAct:0,players:[{id:'a',name:'Hero',range:'AcAd',stack:30},{id:'b',name:'Villain',range:'KcKd',stack:30}],sizes:[50],raiseSizes:[50],maxRaises:1,allIn:false,iterations:2};
  const g=prepareRiverGame(s),b=next(g,g.nodes[0],'bet'),h=next(g,b,'raise');
  const r=await solveRiverGame({...s,locks:[{nodeId:'n0',actions:{check:1}},{nodeId:b.id,actions:{raise_15:1}}]});
  const n=r.nodes.find(x=>x.id===h.id);near(n.combos[0].reach,0);assert.ok(n.combos[0].counterfactualReach>0);
  const report=explainDecision(s,r,{nodeId:h.id,combo:s.hero});checkAccounting(report);near(report.observedReach,0);near(report.actions.find(a=>a.type==='call').ev,30);
});

test('zero-probability opponent prefix is rejected instead of normalized into an answer',async()=>{
  const s={board:'2c4d6h8sTc',pot:10,hero:'QhQs',heroSeat:2,toAct:0,players:[{id:'a',name:'A',range:'AcAd',stack:20},{id:'b',name:'B',range:'KcKd',stack:20},{id:'c',name:'Hero',range:'QhQs',stack:20}],sizes:[50],raiseSizes:[],maxRaises:0,allIn:false,iterations:2};
  const g=prepareRiverGame(s),b=next(g,g.nodes[0],'bet'),c=next(g,b,'fold');const r=await solveRiverGame({...s,locks:[{nodeId:'n0',actions:{bet_5:1}},{nodeId:b.id,actions:{call:1}}]});
  assert.throws(()=>explainDecision(s,r,{nodeId:c.id,combo:s.hero}),/到达权重|条件发牌/);
});

test('turn call includes future river and own first river action but groups genuine opponent responses',async()=>{
  const s={board:'Ks7h2h9c',pot:10,hero:'AcKd',heroSeat:0,toAct:0,players:[{id:'a',name:'Hero',range:'AcKd,AhQh',stack:20},{id:'b',name:'Villain',range:'KcQd,QhJh',stack:20}],sizes:[50],raiseSizes:[],riverSizes:[50],riverRaiseSizes:[],maxRaises:0,riverMaxRaises:0,allIn:false,iterations:30};
  const r=await solveTurnGame(s),checked=next(r,r.nodes[0],'check'),hero=next(r,checked,'bet');
  const report=explainDecision(s,r,{nodeId:hero.id,combo:s.hero});checkAccounting(report);const call=report.actions.find(a=>a.type==='call');assert.ok(call.responses.length>0);assert.ok(call.responses.every(response=>response.actor===1));
  const riverNodes=r.nodes.filter(n=>n.street==='river'&&n.actor===0&&!cards(n.board).some(c=>cards(s.hero).includes(c))&&n.combos.some(c=>c.counterfactualReach>1e-8));
  for(const n of [riverNodes[0],riverNodes.at(-1)]){const row=n.combos.find(c=>c.counterfactualReach>1e-8);const deep=explainDecision(s,r,{nodeId:n.id,combo:row.combo});checkAccounting(deep);assert.equal(cards(deep.board).length,5);}
});

test('three-way unequal all-ins preserve side-pot EV and contributions at deep nodes',async()=>{
  const s={board:'2c4d6h8sTc',pot:20,hero:'QcQd',heroSeat:2,toAct:0,players:[{id:'a',name:'Short best',range:'AcAd',stack:5},{id:'b',name:'Middle',range:'KcKd',stack:15},{id:'c',name:'Deep hero',range:'QcQd',stack:30}],sizes:[50],raiseSizes:[50],maxRaises:1,allIn:true,iterations:20,algorithm:'cfr-plus'};
  const r=await solveRiverGame(s);let checked=0;for(const n of r.nodes){if(n.actor<0||n.terminal||checked>=8)continue;const row=n.combos.find(c=>c.counterfactualReach>1e-8);if(!row)continue;checkAccounting(explainDecision(s,r,{nodeId:n.id,combo:row.combo}));checked++;}assert.equal(checked,8);
});

test('fixed capped rake is deducted once from the common pot in independent EV accounting',async()=>{
 const s={board:'2c4d6h8sTc',pot:20,rake:5,rakeCap:1,hero:'AcAd',heroSeat:0,toAct:0,players:[{id:'a',name:'Short',range:'AcAd,AhAs',stack:5},{id:'b',name:'Middle',range:'KcKd,KhKs',stack:15},{id:'c',name:'Deep',range:'QcQd,QhQs',stack:30}],sizes:[50],raiseSizes:[50],maxRaises:1,allIn:true,iterations:100};
 const r=await solveRiverGame(s);assert.equal(r.rakeModel.fixedRake,1);const report=explainDecision(s,r,{combo:s.hero});checkAccounting(report);assert.equal(report.rakeModel.netStartingPot,19);assert.ok(Math.abs(r.diagnostics.profileEV.reduce((a,b)=>a+b,0)-19)<1e-7);
});

test('three-player response metadata retains the next decision after a check or a fold',async()=>{
 const s={board:'2c4d6h8sTc',pot:10,hero:'AcAd',heroSeat:0,toAct:0,players:[{id:'a',name:'SB',range:'AcAd',stack:20},{id:'b',name:'BB',range:'KcKd',stack:20},{id:'c',name:'BTN',range:'QhQs',stack:20}],sizes:[50],raiseSizes:[],maxRaises:0,allIn:false,iterations:2};
 const g=prepareRiverGame(s),checked=next(g,g.nodes[0],'check'),bet=next(g,g.nodes[0],'bet');
 const r=await solveRiverGame({...s,locks:[{nodeId:checked.id,actions:{check:1}},{nodeId:bet.id,actions:{fold:1}}]});
 const d=explainDecision(s,r,{combo:s.hero});checkAccounting(d);
 for(const id of ['check','bet_5'])assert.deepEqual(d.actions.find(a=>a.id===id).responses[0].continuation,{kind:'decision',actorName:'BTN'});
});
