import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCoachReport} from '../lib/coach.mjs';
import {generateLocalCoach,localCoachStatus} from '../lib/local-coach.mjs';
const scenario={board:'Ks 7h 2h 9c 3s',pot:40,hero:'Ac Kd',heroSeat:1,players:[{id:'sb',name:'SB',position:'SB',stack:80,range:'77'},{id:'bb',name:'BB',position:'BB',stack:100,range:'AKo'},{id:'btn',name:'BTN',position:'BTN',stack:120,range:'99'}]};
const result={nodes:[{id:'n0',board:scenario.board,actor:0,actorId:'sb',pot:40,toCall:0,reach:1,actions:[{id:'check',label:'过牌',type:'check',frequency:1,ev:8},{id:'bet_20',label:'下注 20 BB',type:'bet',frequency:0,ev:3}],combos:[{combo:'7c7d',reach:1,probabilities:[1,0],actionEV:[8,3]}]}]};
test('a requested Hero combination is not replaced by the current opponent aggregate range EV',async()=>{
 const report=buildCoachReport(scenario,result,{kind:'strategy',focusCombo:scenario.hero});assert.equal(report.context.current.actorSeat,0);assert.equal(report.context.current.focusEvidence.status,'unavailable');assert.equal(report.context.current.focusEvidence.actionEVAvailable,false);
 const before=localCoachStatus(),output=await generateLocalCoach({report,question:'这手牌该怎样打？',scenario});assert.equal(output.grounding,'deterministic');assert.match(output.warning,/当前行动者|聚焦牌/);assert.equal(localCoachStatus().running,before.running);
});
test('available current-actor combinations explicitly distinguish their EV from aggregate evidence',()=>{
 const report=buildCoachReport(scenario,result,{kind:'strategy',focusCombo:'7c7d'});assert.equal(report.context.current.focusEvidence.status,'available');assert.equal(report.context.current.focusEvidence.actionEVAvailable,true);assert.equal(report.context.current.focusEvidence.actorSeat,0);assert.equal(report.context.current.focusEvidence.reach,1);
});
test('terminal and chance nodes do not run a language model to invent player decisions',async()=>{
 for(const kind of ['chance','terminal']){const report={headline:'没有玩家决策',context:{current:{[kind]:true}},sections:[],evidence:[],limitations:[]};const output=await generateLocalCoach({report,question:'应该加注吗？',scenario});assert.equal(output.grounding,'deterministic');assert.match(output.warning,/没有玩家决定/);}
});
