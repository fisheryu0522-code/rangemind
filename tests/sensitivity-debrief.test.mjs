import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSensitivityDebrief} from '../lib/sensitivity-debrief.mjs';
import {solveRiverGame} from '../lib/river-engine.mjs';
import {runSensitivity} from '../lib/sensitivity.mjs';

const actions=[{id:'check',label:'过牌'},{id:'bet50',label:'下注 50%'}];
const row=(scale,evs,other={})=>({scale,jobId:'model-'+scale,counterfactualReach:.2,observedReach:.1,quality:{targetReached:true,residualPctPot:.01},diagnostics:{nashConvPctPot:.01},actions:actions.map((a,i)=>({...a,ev:evs[i],loss:999,frequency:i?1:0})),...other});
const experiment=rows=>({schemaVersion:1,combo:'AcKd',nodePath:[],player:1,subset:'QcJc',settings:{accuracy:.03},rows,actions:actions.map(a=>({...a,maxRegret:999})),minimaxRegretActions:['incorrect-cached-ranking']});

test('highest EV swaps while both actions remain within the explicit practical tolerance',()=>{
 const input=experiment([row(1,[5,5.006]),row(.5,[5.005,5])]),before=structuredClone(input),report=buildSensitivityDebrief(input,{toleranceBB:.01,actionId:'check'});
 assert.deepEqual(input,before);assert.equal(report.quality.allVerified,true);assert.deepEqual(report.commonActionIds,['check','bet50']);
 assert.deepEqual(report.rows.map(r=>r.scale),[.5,1]);assert.equal(report.intervals[0].highestEVChanged,true);assert.equal(report.intervals[0].practicalSetChanged,false);
 assert.equal(report.selectedAction.usableInAllTested,true);assert.ok(Math.abs(report.selectedAction.maxLossBB-.006)<1e-14);
 assert.deepEqual(report.intervals[0].actionChanges,[]);assert.equal(report.intervals[0].status,'tested-endpoints-only');
 assert.ok(report.limits.some(s=>s.includes('不保证同状态端点')));assert.ok(report.limits.some(s=>s.includes('不是此组合行动 EV')));
});

test('nonmonotone action changes retain every discrete interval and never invent a critical threshold',()=>{
 const report=buildSensitivityDebrief(experiment([row(1,[0,.1]),row(.25,[.1,0]),row(.75,[.1,0]),row(.5,[0,.1])]),{toleranceBB:.02,actionId:'check'});
 assert.deepEqual(report.commonActionIds,[]);assert.deepEqual(report.selectedAction.withinScales,[.25,.75]);assert.deepEqual(report.selectedAction.exceedsScales,[.5,1]);
 assert.equal(report.selectedAction.usableInAllTested,false);assert.equal(report.intervals.length,3);
 for(const interval of report.intervals){assert.equal(interval.status,'refinement-needed');assert.equal(interval.selectedAction.changed,true);assert.equal(interval.criticalScale,undefined);assert.equal(interval.threshold,undefined);}
 assert.deepEqual(report.intervals.map(i=>[i.lowerScale,i.upperScale]),[[.25,.5],[.5,.75],[.75,1]]);
});

test('unknown precision, unmet targets and unobserved or unscoreable rows cannot establish all-model usability',()=>{
 const examples=[
  ['missing-target',r=>{delete r.settings.accuracy;}],
  ['missing-residual',r=>{delete r.rows[1].quality.residualPctPot;delete r.rows[1].diagnostics.nashConvPctPot;}],
  ['target-not-reached',r=>{r.rows[1].quality.targetReached=false;}],
  ['target-not-reached',r=>{r.rows[1].quality.residualPctPot=.1;r.rows[1].diagnostics.nashConvPctPot=.1;}],
  ['missing-counterfactual-reach',r=>{r.rows[1].counterfactualReach=0;}],
  ['unobserved-decision',r=>{r.rows[1].observedReach=0;}],
  ['invalid-action-values',r=>{r.rows[1].actions[0].ev=null;}],
  ['invalid-action-values',r=>{r.rows[1].actions.pop();}],
  ['invalid-action-values',r=>{r.rows[1].actions[1].id='raise-unavailable';}],
  ['explicitly-unscoreable',r=>{r.rows[1].scoreable=false;}]
 ];
 for(const [reason,edit] of examples){
  const input=experiment([row(.5,[2,1]),row(1,[2,1])]);edit(input);const report=buildSensitivityDebrief(input,{toleranceBB:.1});
  assert.equal(report.quality.allVerified,false,reason);assert.deepEqual(report.commonActionIds,[],reason);assert.equal(report.actions[0].status,'unverified',reason);assert.equal(report.actions[0].usableInAllTested,null,reason);
  assert.ok(report.rows[1].quality.reasonCodes.includes(reason),reason);assert.ok(report.rows[1].quality.reasons.length,reason);assert.equal(report.intervals[0].highestEVChanged,null,reason);assert.equal(report.intervals[0].practicalSetChanged,null,reason);
 }
});

test('constrained stopping residual is not confused with unrestricted exploitability and contradictory evidence stays unverified',()=>{
 const input=experiment([row(.5,[1,0]),row(1,[1,0])]);input.settings.locks=[{nodePath:[],combo:'AcKd',probabilities:{check:1,bet50:0}}];
 for(const r of input.rows){r.diagnostics={optimizationResidualPctPot:.01,nashConvPctPot:40};r.quality.targetReached=null;}
 const accepted=buildSensitivityDebrief(input,{toleranceBB:.1});assert.equal(accepted.quality.allVerified,true);assert.equal(accepted.basis.locksPreserved,true);assert.equal(accepted.rows[0].quality.residualPctPot,.01);
 input.rows[0].quality.residualPctPot=0;const inconsistent=buildSensitivityDebrief(input,{toleranceBB:.1});assert.equal(inconsistent.quality.allVerified,false);assert.ok(inconsistent.rows[0].quality.reasonCodes.includes('conflicting-quality'));
 input.rows[0].diagnostics.optimizationResidualPctPot=-1;assert.equal(buildSensitivityDebrief(input,{toleranceBB:.1}).quality.allVerified,false);
});

test('positive but tiny reaches remain legitimate, source frequency and cached losses do not decide usability',()=>{
 const input=experiment([row(.5,[0,3]),row(1,[0,3])]);for(const r of input.rows){r.counterfactualReach=1e-40;r.observedReach=1e-45;r.actions[0].frequency=1;r.actions[1].frequency=0;}
 const report=buildSensitivityDebrief(input,{toleranceBB:0});assert.equal(report.quality.allVerified,true);assert.deepEqual(report.commonActionIds,['bet50']);assert.equal(report.actions[0].maxLossBB,3);assert.equal(report.actions[1].maxLossBB,0);
});

test('tolerance is inclusive and cannot be silently selected from missing, negative or nonnumeric user input',()=>{
 const input=experiment([row(.5,[1,.875]),row(1,[1,.875])]);assert.deepEqual(buildSensitivityDebrief(input,{toleranceBB:.125}).commonActionIds,['check','bet50']);
 for(const toleranceBB of [undefined,null,'0.1',-.1,Infinity,NaN])assert.throws(()=>buildSensitivityDebrief(input,{toleranceBB}),/实践收益容忍/);
 assert.throws(()=>buildSensitivityDebrief(input,{toleranceBB:.1,actionId:'raise'}),/所选动作/);
 const bad=structuredClone(input);bad.rows[1].scale=.5;assert.throws(()=>buildSensitivityDebrief(bad,{toleranceBB:.1}),/倍率/);
});

test('a real three-model river experiment preserves its exact source action EVs and labels every finite-model loss correctly',async()=>{
 const scenario={title:'Sensitivity debrief independent source',board:'Ks7h2d9c3s',pot:10,toAct:0,hero:'AcKd',heroSeat:0,players:[{id:'h',name:'Hero',position:'BB',stack:20,range:'AcKd,AhQh'},{id:'v',name:'Opponent',position:'BTN',stack:20,range:'KhQd:0.8,QcJc:0.4'}]},settings={sizes:[50],raiseSizes:[50],maxRaises:1,iterations:2000,checkEvery:100,accuracy:.05};
 const baseline=await solveRiverGame({...scenario,...settings}),saved=[];
 const input=await runSensitivity({scenario,settings,baseline,player:1,subset:'QcJc',combo:'AcKd',scales:[.25,.5,1]},{saveVariant:async value=>{saved.push(value);return 'real-'+value.scale;}});
 const report=buildSensitivityDebrief(input,{toleranceBB:.02});assert.equal(report.quality.allVerified,true);
 for(const {result,scale} of saved){const source=result.nodes[0].combos.find(c=>c.combo==='KdAc'),r=report.rows.find(r=>r.scale===scale),max=Math.max(...source.actionEV);assert.deepEqual(r.actions.map(a=>a.ev),source.actionEV);for(const [index,action] of r.actions.entries()){assert.equal(action.lossBB,max-source.actionEV[index]);assert.equal(action.numericallyWithinTolerance,action.lossBB<=.02);}assert.equal(r.quality.residualPctPot,result.diagnostics.optimizationResidualPctPot??result.diagnostics.nashConvPctPot);}
 assert.ok(report.actions.every(a=>a.usableInAllTested===report.rows.every(r=>r.withinToleranceActionIds.includes(a.id))));
});
