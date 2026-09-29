import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {assertSolutionScenario,assertRiverSensitivitySettings} from '../lib/solution-identity.mjs';
import {prepareRiverGame} from '../lib/river-engine.mjs';
import {prepareTurnGame} from '../lib/turn-engine.mjs';
import {prepareHUPostflop} from '../lib/hu-postflop.mjs';
import {runSensitivity} from '../lib/sensitivity.mjs';
const scenario={board:'Ks7h2d9c3s',pot:10,hero:'AcKd',heroSeat:0,toAct:0,players:[{id:'a',position:'BB',name:'A',stack:20,range:'AcKd,AhQh:0.5'},{id:'b',position:'BTN',name:'B',stack:20,range:'KhQd,QcJc:0.4'}]},settings={sizes:[50],raiseSizes:[50],maxRaises:1,allIn:false,iterations:2};

test('saved model binding includes raise settings, all-in choices and locks without tying hero focus or compute budget',()=>{
 const result=prepareRiverGame({...scenario,...settings});assert.doesNotThrow(()=>assertSolutionScenario({...scenario,hero:'AhQh',heroSeat:0,title:'New focus'},result,{settings:{...settings,iterations:2000,threads:1}}));
 for(const change of [{maxRaises:2},{sizes:[100]},{allIn:true},{locks:[{nodeId:'n0',actions:{check:1}}]}])assert.throws(()=>assertSolutionScenario(scenario,result,{settings:{...settings,...change}}),/模型|锁定|尺寸|规则/);
});

test('duplicate node-lock order is material because the last matching lock wins',()=>{
 const locks=[{nodeId:'n0',actions:{check:1}},{nodeId:'n0',actions:{bet_5:1}}],result=prepareRiverGame({...scenario,...settings,locks});
 assert.throws(()=>assertRiverSensitivitySettings({...settings,locks:[...locks].reverse()},result.input),/锁定|模型/);
});

test('turn binding includes future bet/raise tree and the first river actor',()=>{
 const s={...scenario,board:'Ks7h2d9c'},cfg={...settings,maxRaises:0,riverSizes:[50],riverRaiseSizes:[50],riverMaxRaises:0,riverToAct:0},result=prepareTurnGame({...s,...cfg});assert.doesNotThrow(()=>assertSolutionScenario(s,result,{settings:cfg}));
 for(const change of [{riverSizes:[100]},{riverRaiseSizes:[100]},{riverMaxRaises:1},{riverToAct:1}])assert.throws(()=>assertSolutionScenario(s,result,{settings:{...cfg,...change}}),/模型|规则|行动|尺寸/);
});

test('HU model defaults and per-street overrides are not confused with RiverLab or TurnLab',()=>{
 const s={...scenario,board:'Ks7h2d'},cfg={engine:'hu-postflop',sizes:[],raiseSizes:[],maxRaises:0,allIn:true,outputScope:'auto',maxNodes:100000},prepared=prepareHUPostflop({...s,...cfg}),result={input:prepared.input,engine:'HUPostflop · TexasSolver DCFR',outputScope:prepared.settings.outputScope};
 assert.doesNotThrow(()=>assertSolutionScenario(s,result,{settings:cfg}));assert.throws(()=>assertSolutionScenario(s,result,{settings:{...cfg,turnSizes:[50]}}),/模型|尺寸/);
 const river={...scenario,engine:'hu-postflop'},hu=prepareHUPostflop({...river,...settings}),riverResult={input:hu.input,engine:'HUPostflop · TexasSolver DCFR',outputScope:'full'};assert.throws(()=>assertSolutionScenario(scenario,riverResult,{settings:{...settings,engine:'cpu'}}),/引擎|模型/);
});

test('sampled empirical games are bound to their training sample count and seed',()=>{
 const cfg={...settings,chanceMode:'sampled',chanceSamples:100,evaluationSamples:100,seed:42},result=prepareRiverGame({...scenario,...cfg});assert.doesNotThrow(()=>assertSolutionScenario(scenario,result,{settings:cfg}));
 for(const change of [{chanceMode:'exact'},{seed:43},{chanceSamples:101}])assert.throws(()=>assertSolutionScenario(scenario,result,{settings:{...cfg,...change}}),/模型|机会|抽样/);
 const reordered=structuredClone(scenario);reordered.players[0].range='AhQh:0.5,AcKd';assert.throws(()=>assertSolutionScenario(reordered,result,{settings:cfg}),/模型|机会|抽样/);
 // In exact mode range-token order is a harmless notation change.
 assert.doesNotThrow(()=>assertSolutionScenario(reordered,prepareRiverGame({...scenario,...settings}),{settings}));
});

test('unsupported root assumptions and contradictory root/rake metadata cannot bypass binding',()=>{
 const prepared=prepareRiverGame({...scenario,...settings});for(const change of [{preexistingSidePot:true},{deadCards:'AsAd'},{currentBet:5},{unit:'USD'}])assert.throws(()=>assertSolutionScenario({...scenario,...change},prepared),/起点|模型|死牌|单位|边池/);
 const mismatch=structuredClone(prepared);mismatch.nodes[0].pot=11;assert.throws(()=>assertSolutionScenario(scenario,mismatch),/起点|底池|不一致/);
 const fee=structuredClone(prepared);fee.rakeModel.fixedRake=1;assert.throws(()=>assertSolutionScenario(scenario,fee),/抽水|模型|不一致/);
 const missingId=structuredClone(prepared);delete missingId.input.players[0].id;assert.throws(()=>assertSolutionScenario(scenario,missingId),/玩家|顺序|不一致/);
});

test('HU river policies cannot silently become RiverLab range experiments with different chip rounding',async()=>{
 const prepared=prepareHUPostflop({...scenario,...settings,engine:'hu-postflop'}),baseline={input:prepared.input,engine:'HUPostflop · TexasSolver DCFR',chance:{exact:true}};let calls=0;
 await assert.rejects(runSensitivity({scenario,settings,baseline,player:1,subset:'QcJc',combo:scenario.hero},{solve:async()=>{calls++;return baseline;}}),/HU|取整|RiverLab/);assert.equal(calls,0);
});

test('all shipped 27 saved jobs bind to their own scenarios and settings with native family defaults',()=>{
 const root=new URL('../',import.meta.url),read=p=>JSON.parse(fs.readFileSync(new URL(p,root),'utf8')),index=read('data/library/index.json');assert.equal(index.length,27);
 for(const entry of index){const job=read(`data/pro/jobs/${entry.jobId}.json`),result=read(`data/pro/jobs/${entry.jobId}/result.json`);assert.doesNotThrow(()=>assertSolutionScenario(job.scenario,result,{settings:job.settings??{}}),entry.presetId);}
});
