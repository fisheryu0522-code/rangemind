import test from 'node:test';
import assert from 'node:assert/strict';
import {createLiveRecorder,replayLiveRecorder,applyLiveRecorderAction,undoLiveRecorderAction,buildLiveRecorderStudy,liveRecorderPositions} from '../lib/live-recorder.mjs';
import {parseScenario} from '../lib/scenario.mjs';
import {assertInputProvenance} from '../lib/input-provenance.mjs';

const step=(d,a)=>applyLiveRecorderAction(d,typeof a==='string'?{type:a}:a);
const run=(d,actions)=>actions.reduce(step,d);
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);
const action=(type,amount)=>({type,...(amount==null?{}:{amount})});
function liveTurn(){
 let d=createLiveRecorder({title:'1/3 现场疑问',question:'转牌面对大下注，继续范围由哪些条件决定？',hero:{playerId:'SB',hand:'Ah Jh'},players:liveRecorderPositions(6).map(p=>({position:p,id:p,name:p==='HJ'?'观察对象':p,stack:({SB:600,BB:300,UTG:600,HJ:450,CO:600,BTN:900})[p]}))});
 return run(d,['fold',action('raiseTo',15),'fold','call','call','call',{type:'street',cards:'Qh Ts 7h'},'check','check',action('bet',40),'fold',action('raiseTo',130),'fold','call',{type:'street',cards:'2c'},'check',action('bet',150)]);
}

test('new defaults are explicit unscored input material with exact original-currency presentation',()=>{
 const d=createLiveRecorder(),r=replayLiveRecorder(d);assert.equal(d.kind,'live-hand-record');assert.equal(d.unit,'currency');assert.equal(d.bigBlind,3);assert.equal(d.players.length,6);assert.ok(d.players.every(p=>p.stack===300));assert.equal(r.view.pot,4);assert.equal(r.view.players.find(p=>p.id==='SB').stack,299);assert.equal(r.view.toCall,3);assert.equal(r.view.currentActorId,'UTG');assert.equal(r.view.history.length,0);assert.equal(r.inputContext.raw.startsWith('PokerLab现场行动记录 v1'),true);assert.ok(!r.parse.scenario);assert.equal(r.view.issues.length,0);assert.throws(()=>buildLiveRecorderStudy(d),/翻后/);assert.equal(r.grade,undefined);assert.equal(r.score,undefined);
});

test('a complete 1/3 live line rebuilds independently checked money and the exact historical or pending decision before its action',()=>{
 const d=liveTurn(),r=replayLiveRecorder(d),original=JSON.stringify(d);assert.equal(r.view.street,'turn');assert.equal(r.view.pot,470);assert.equal(r.view.currentActorId,'SB');assert.equal(r.view.toCall,150);assert.equal(r.view.players.find(p=>p.id==='SB').stack,455);assert.equal(r.view.players.find(p=>p.id==='HJ').stack,155);assert.equal(r.view.conservation.difference,0);
 assert.equal(r.snapshots.length,2);near(r.snapshots[0].scenario.pot,20);near(r.snapshots[1].scenario.pot,320/3);near(r.snapshots[1].scenario.players.find(p=>p.id==='HJ').stack,305/3);
 const pending=buildLiveRecorderStudy(d);near(pending.scenario.pot,320/3);near(pending.scenario.players.find(p=>p.id==='SB').stack,455/3);assert.equal(pending.target.actorId,'SB');assert.equal(pending.target.mode,'current-decision');assert.equal(pending.targetLedgerIndex,r.ledger.at(-1).index+1);assert.equal(pending.inputContext.studyTarget.ledgerIndex,pending.targetLedgerIndex);assert.equal(pending.question,d.question);assert.ok(pending.scenario.players.every(p=>p.range===''));assert.equal(assertInputProvenance(pending.scenario,pending.inputContext).sourceVerified,true);
 const index=d.actions.findIndex(a=>a.type==='raiseTo'&&a.amount===130),historical=buildLiveRecorderStudy(d,{actionIndex:index});assert.equal(historical.target.mode,'before-action');assert.equal(historical.target.actorId,'SB');assert.equal(historical.scenario.board,'Qh Ts 7h');near(historical.scenario.pot,20);assert.equal(r.ledger.find(a=>a.index===historical.targetLedgerIndex).type,'raiseTo');near(r.ledger.find(a=>a.index===historical.targetLedgerIndex).amount,130/3);assert.equal(JSON.stringify(d),original);
 const turnRoot=buildLiveRecorderStudy(d,{street:'turn'});assert.equal(turnRoot.target.mode,'street-start');assert.equal(r.ledger.find(a=>a.index===turnRoot.targetLedgerIndex).type,'check');assert.equal(turnRoot.scenario.players.find(p=>p.id==='HJ').name,'观察对象');
 assert.deepEqual(pending.decisionContext,{street:'turn',board:'Qh Ts 7h 2c',actorId:'SB',pot:156.66666667,toCall:50,mode:'current-decision',unit:'BB'});
 assert.deepEqual(historical.decisionContext,{street:'flop',board:'Qh Ts 7h',actorId:'SB',pot:33.33333333,toCall:13.33333333,mode:'before-action',unit:'BB'});
 assert.deepEqual(turnRoot.decisionContext,{street:'turn',board:'Qh Ts 7h 2c',actorId:'SB',pot:106.66666667,toCall:0,mode:'street-start',unit:'BB'});
 assert.notEqual(pending.scenario.pot,pending.decisionContext.pot);assert.notEqual(historical.scenario.pot,historical.decisionContext.pot);near(turnRoot.scenario.pot,turnRoot.decisionContext.pot);
});

test('canonical natural text independently reconstructs every live street even when importer defaults have the wrong money unit',()=>{
 const d=liveTurn(),r=replayLiveRecorder(d);for(const street of ['flop','turn']){const a=replayLiveRecorder(d,{street}).parse,b=parseScenario(r.inputContext.raw,{street,unit:'BB',bigBlind:1});assert.equal(b.ok,true,JSON.stringify(b.issues));assert.equal(b.metadata.inputUnit,'currency');assert.equal(b.metadata.bigBlind,3);assert.equal(a.scenario.pot,b.scenario.pot);assert.deepEqual(a.scenario.players.map(p=>[p.id,p.stack]),b.scenario.players.map(p=>[p.id,p.stack]));assert.deepEqual(a.ledger,b.ledger);assert.deepEqual(a.metadata.conservation,b.metadata.conservation);}
 assert.equal(r.ledger[0].amount,.33333333);assert.equal(r.view.history.find(h=>h.type==='bet').amount,40);assert.ok(!/PokerStars Hand|Poker Hand #/.test(r.inputContext.raw));
});

test('limped hands and preflop-only drafts do not require a fabricated raise or later action to parse',()=>{
 let d=createLiveRecorder({unit:'BB',playerCount:3,hero:{playerId:'BTN',hand:'Ac Kd'}});d=run(d,['call','call','check']);const pre=replayLiveRecorder(d);assert.equal(pre.view.pot,3);assert.equal(pre.view.roundComplete,true);assert.equal(pre.view.nextStreet,'flop');assert.equal(pre.parse.kind,'natural');assert.deepEqual(pre.parse.issues.filter(i=>i.severity==='error').map(i=>i.code),['missing_postflop']);
 d=step(d,{type:'street',cards:'Qs 7h 2d'});const root=buildLiveRecorderStudy(d);assert.equal(root.scenario.pot,3);assert.equal(root.target.actorId,'SB');assert.equal(assertInputProvenance(root.scenario,root.inputContext).sourceVerified,true);assert.equal(root.inputContext.raw.includes('加注'),false);
});

test('undo reconstructs accepted user actions and derived money without mutating historical drafts',()=>{
 const d=liveTurn(),saved=structuredClone(d),prev=undoLiveRecorderAction(d),view=replayLiveRecorder(prev).view;assert.deepEqual(d,saved);assert.equal(prev.actions.length,d.actions.length-1);assert.equal(view.currentActorId,'HJ');assert.equal(view.pot,320);assert.equal(view.toCall,0);const again=step(prev,action('bet',150));assert.deepEqual(replayLiveRecorder(again),replayLiveRecorder(d));
 const twice=undoLiveRecorderAction(prev),third=undoLiveRecorderAction(twice);assert.equal(replayLiveRecorder(twice).view.currentActorId,'SB');assert.equal(replayLiveRecorder(third).view.street,'flop');assert.equal(replayLiveRecorder(third).view.nextStreet,'turn');assert.throws(()=>undoLiveRecorderAction(createLiveRecorder()),/尚无/);
});

test('incompatible study selections and fabricated amounts never silently become a different valid record',()=>{
 const d=liveTurn(),before=JSON.stringify(d);assert.throws(()=>buildLiveRecorderStudy(d,{actionIndex:1}),/翻后/);assert.throws(()=>buildLiveRecorderStudy(d,{actionIndex:6}),/发牌不是/);assert.throws(()=>buildLiveRecorderStudy(d,{actionIndex:11,street:'turn'}),/不属于/);assert.throws(()=>buildLiveRecorderStudy(d,{actionIndex:100}),/不存在/);assert.throws(()=>buildLiveRecorderStudy(d,{street:'river'}),/尚没有/);assert.throws(()=>step(d,{type:'call',amount:149}),/自动计算/);assert.throws(()=>step(d,{type:'call',playerId:'HJ'}),/轮到/);assert.throws(()=>step(d,{type:'check',amount:0}),/不需要金额/);assert.equal(JSON.stringify(d),before);
});

test('unsupported cash precision, nonstandard structure and illegal identity fail before accepting a draft',()=>{
 for(const config of [{unit:'USD'},{unit:'BB',bigBlind:3},{smallBlind:4,bigBlind:3},{bigBlind:.001},{ante:1},{straddle:6},{pot:10},{board:'Ks7h2d'},{street:'turn'},{variant:'PLO'},{playerCount:10},{hero:{playerId:'UTG+8',hand:'AcKd'}},{hero:{playerId:null,hand:'AcKd'}}])assert.throws(()=>createLiveRecorder(config));
 const d=createLiveRecorder({unit:'currency',playerCount:2});assert.throws(()=>step(d,{type:'raiseTo',amount:6.001}),/最多两位/);assert.throws(()=>replayLiveRecorder({...d,actions:Array(301).fill({type:'check'})}),/300/);assert.deepEqual(liveRecorderPositions(2),['BB','BTN']);const p=liveRecorderPositions(6);p[0]='wrong';assert.equal(liveRecorderPositions(6)[0],'SB');
});
