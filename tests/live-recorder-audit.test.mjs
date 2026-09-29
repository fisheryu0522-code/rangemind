import test from 'node:test';
import assert from 'node:assert/strict';
import {parseScenario,replayActions} from '../lib/scenario.mjs';
import {assertInputProvenance,forkInputContext} from '../lib/input-provenance.mjs';
import {createLiveRecorder,applyLiveRecorderAction,replayLiveRecorder,undoLiveRecorderAction,buildLiveRecorderStudy,liveRecorderPositions} from '../lib/live-recorder.mjs';

const near=(a,b)=>assert.ok(Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-6,`${a} != ${b}`);
const config=(stacks={SB:100,BB:100,BTN:100},extra={})=>({unit:'BB',smallBlind:.5,bigBlind:1,players:Object.entries(stacks).map(([position,stack])=>({id:position,position,stack})),hero:{playerId:'BTN',hand:'Ac Kd'},...extra});
const run=(draft,actions)=>actions.reduce((d,a)=>applyLiveRecorderAction(d,typeof a==='string'?{type:a}:a),draft);
const view=draft=>replayLiveRecorder(draft).view;
const player=(v,id)=>v.players.find(p=>p.id===id);
const errors=parsed=>parsed.issues.filter(i=>i.severity==='error');
const flop={type:'street',cards:'Ks7h2d'};
function compareReparse(result,street){
 const other=parseScenario(result.inputContext.raw,{street,unit:result.inputContext.sourceUnit,bigBlind:result.inputContext.sourceBigBlind});
 assert.deepEqual(other.ledger,result.ledger);assert.equal(other.ok,result.parse.ok);
 if(other.scenario){near(other.scenario.pot,result.parse.scenario.pot);assert.deepEqual(other.scenario.players.map(p=>[p.id,p.stack]),result.parse.scenario.players.map(p=>[p.id,p.stack]));assert.equal(other.scenario.board,result.parse.scenario.board);}
 return other;
}
function independentAccounting(draft,result){
 const divisor=draft.unit==='currency'?draft.bigBlind:1,ps=new Map(draft.players.map(p=>[p.id,{stack:p.stack/divisor,bet:0,folded:false}]));let pot=0;
 for(const row of result.ledger){
  near(row.potBefore,pot);let delta=0;
  if(row.type==='street'){for(const p of ps.values())p.bet=0;}
  else{const p=ps.get(row.player);assert.ok(p);const high=Math.max(...[...ps.values()].map(x=>x.bet));
   if(row.type==='fold')p.folded=true;
   else if(row.type==='check')near(p.bet,high);
   else if(row.type==='call'){near(row.amount,Math.min(p.stack,high-p.bet));delta=row.amount;}
   else if(row.type==='post'||row.type==='bet')delta=row.amount;
   else if(row.type==='raiseTo'){assert.ok(row.amount>high);delta=row.amount-p.bet;}
   else if(row.type==='return'){const other=Math.max(...[...ps.entries()].filter(([id])=>id!==row.player).map(([,x])=>x.bet));assert.ok(row.amount<=p.bet-other+1e-6);delta=-row.amount;}
   else assert.fail(`unexpected ledger type ${row.type}`);
   p.stack-=delta;p.bet+=delta;near(row.stackAfter,p.stack);assert.ok(p.stack>=-1e-6);
  }
  pot+=delta;near(row.paid,delta);near(row.potAfter,pot);
 }
 near(pot*divisor,result.view.pot);for(const [id,p] of ps){near(p.stack*divisor,player(result.view,id).stack);assert.equal(p.folded,player(result.view,id).folded);}
 near(pot+[...ps.values()].reduce((s,p)=>s+p.stack,0),draft.players.reduce((s,p)=>s+p.stack/divisor,0));
}

const shortBlindHistory=`PokerStars Hand #20260928ShortBlind: Hold'em No Limit ($0.50/$1 USD) - 2026/09/28 12:00:00 ET
Table 'Short blind boundary' 3-max Seat #3 is the button
Seat 1: Small ($100 in chips)
Seat 2: Short ($0.50 in chips)
Seat 3: Hero ($100 in chips)
Small: posts small blind $0.50
Short: posts big blind $0.50 and is all-in
*** HOLE CARDS ***
Dealt to Hero [Ac Kd]
Hero: calls $0.50
Small: checks
*** FLOP *** [Ks 7h 2d]
Small: checks
Hero: checks
*** TURN *** [Ks 7h 2d] [9c]
Small: checks
Hero: checks
*** RIVER *** [Ks 7h 2d 9c] [3s]
Small: checks
Hero: checks
*** SHOW DOWN ***
Hero collected $1.50 from pot
*** SUMMARY ***
Total pot $1.50 | Rake $0`;

test('a short posted BB cannot turn a wrong half-BB call into verified original-hand provenance',()=>{
 // Robert's Rules v11, Section 14.2: a short forced BB does not lower the
 // nominal preflop bring-in. This recorder/import boundary deliberately refuses
 // the unsupported structure instead of reconstructing a half-BB common pot.
 // https://www.oresteen.com/Poker/roberts-rules-of-poker-version-11-fullsize.pdf
 const parsed=parseScenario(shortBlindHistory);assert.equal(parsed.ok,false);
 assert.ok(parsed.issues.some(i=>i.code==='short_blind_unsupported'&&i.severity==='error'));
 if(parsed.scenario)assert.throws(()=>assertInputProvenance(parsed.scenario,{raw:shortBlindHistory,issues:[]}));
});

test('short forced blind in natural live text remains an explicit unsupported input',()=>{
 const raw='三人桌现金局，SB/BB 为 0.5/1 BB。BTN 100 BB，SB 100 BB，BB 0.5 BB。BTN 加注到 2 BB，SB 跟注。翻牌 Ks 7h 2d。我在 BTN，持 Ac Kd。',parsed=parseScenario(raw);
 assert.equal(parsed.ok,false);assert.ok(parsed.issues.some(i=>i.code==='short_blind_unsupported'&&i.severity==='error'));
 if(parsed.scenario)assert.throws(()=>assertInputProvenance(parsed.scenario,{raw,issues:[],sourceUnit:'BB'}));
});

test('official cumulative short-all-in example preserves each player separate reopening threshold',()=>{
 // 2026 Poker TDA Rule 49 illustration 1 / 1-A. Posting a blind is distinct
 // from voluntary action, while callers have their own last faced wager.
 // https://www.pokertda.com/view-poker-tda-rules/
 const initial={pot:10,board:'Ks7h2d',street:'flop',players:[{id:'a',name:'A',position:'SB',stack:100},{id:'b',name:'B',position:'BB',stack:1.25},{id:'c',name:'C',position:'UTG',stack:100},{id:'d',name:'D',position:'CO',stack:2},{id:'e',name:'E',position:'BTN',stack:100}]},actions=[{type:'bet',player:'a',amount:1},{type:'raiseTo',player:'b',amount:1.25},{type:'call',player:'c',amount:1.25},{type:'raiseTo',player:'d',amount:2},{type:'call',player:'e',amount:2}];
 assert.equal(replayActions(initial,[...actions,{type:'raiseTo',player:'a',amount:3}],{enforceOrder:true}).ok,true);
 assert.throws(()=>replayActions(initial,[...actions,{type:'call',player:'a',amount:1},{type:'raiseTo',player:'c',amount:3}],{enforceOrder:true}),/重新开放/);
});

test('1/3 currency money is converted once; later fold refund never rewrites earlier study roots',()=>{
 let d=createLiveRecorder(config({SB:300,BB:240,BTN:360},{unit:'currency',smallBlind:1,bigBlind:3}));near(view(d).pot,4);assert.equal(view(d).currentActorId,'BTN');near(view(d).toCall,3);near(view(d).minRaiseTo,6);
 d=run(d,[{type:'raiseTo',amount:9}]);near(view(d).toCall,8);near(view(d).minRaiseTo,15);
 d=run(d,['call','call',flop]);let r=replayLiveRecorder(d);near(r.view.pot,27);near(r.parse.scenario.pot,9);assert.deepEqual(r.parse.scenario.players.map(p=>p.stack),[97,77,117]);assert.equal(r.view.currentActorId,'SB');compareReparse(r,'flop');
 const flopRoot=structuredClone(r.parse.scenario),beforeBet=d.actions.length;
 d=run(d,[{type:'bet',amount:9},'fold','call',{type:'street',cards:'9c'}]);r=replayLiveRecorder(d,{street:'turn'});near(r.view.pot,45);near(r.parse.scenario.pot,15);assert.deepEqual(r.parse.scenario.players.map(p=>p.stack),[94,114]);compareReparse(r,'turn');
 const beforeFinal=d,turnRoot=structuredClone(r.parse.scenario);d=run(d,[{type:'bet',amount:100},'fold']);r=replayLiveRecorder(d,{street:'turn'});assert.equal(r.view.handComplete,true);near(r.view.pot,45);near(player(r.view,'SB').stack,282);assert.deepEqual(r.parse.scenario,turnRoot);assert.deepEqual(replayLiveRecorder(d,{street:'flop'}).parse.scenario,flopRoot);
 const refund=r.ledger.find(a=>a.type==='return');assert.ok(refund);near(refund.amount,100/3);near(refund.paid,-100/3);compareReparse(r,'turn');
 const historical=buildLiveRecorderStudy(d,{actionIndex:beforeBet});near(historical.scenario.pot,9);assert.equal(historical.target.mode,'before-action');assert.equal(historical.target.actorId,'SB');assert.equal(historical.inputContext.ledger[historical.targetLedgerIndex].type,'bet');near(historical.inputContext.ledger[historical.targetLedgerIndex].amount,3);
 d=undoLiveRecorderAction(d);r=replayLiveRecorder(d);assert.equal(r.view.currentActorId,'BTN');near(r.view.pot,145);near(r.view.toCall,100);assert.ok(!r.ledger.some(a=>a.type==='return'));
 d=undoLiveRecorderAction(d);assert.deepEqual(d,beforeFinal);near(view(d).pot,45);near(view(d).conservation.difference,0);
});

test('blind-only fold refunds are derived and undo restores the actual pending SB decision',()=>{
 const d=createLiveRecorder(config()),first=run(d,['fold']),done=run(first,['fold']),r=replayLiveRecorder(done);assert.equal(r.view.handComplete,true);near(r.view.pot,1);near(player(r.view,'BB').stack,99.5);near(player(r.view,'SB').stack,99.5);
 assert.equal(r.ledger.at(-1).type,'return');near(r.ledger.at(-1).amount,.5);assert.deepEqual(undoLiveRecorderAction(done),first);const restored=view(first);near(restored.pot,1.5);assert.equal(restored.currentActorId,'SB');near(restored.toCall,.5);
 assert.throws(()=>applyLiveRecorderAction(done,flop),/结束/);assert.throws(()=>buildLiveRecorderStudy(done,{actionIndex:0}),/翻后/);
});

test('heads-up button posts SB and acts first preflop, BB acts first on every new street',()=>{
 let d=createLiveRecorder(config({BB:100,BTN:100}));assert.equal(view(d).currentActorId,'BTN');near(player(view(d),'BTN').streetBet,.5);near(player(view(d),'BB').streetBet,1);
 d=run(d,['call']);assert.equal(view(d).currentActorId,'BB');assert.equal(view(d).canCheck,true);assert.equal(view(d).canRaise,true);
 d=run(d,['check',flop]);let r=replayLiveRecorder(d);assert.equal(r.view.currentActorId,'BB');near(r.view.pot,2);assert.deepEqual(errors(r.parse),[]);compareReparse(r,'flop');
 d=run(d,['check','check',{type:'street',cards:'9c'}]);assert.equal(view(d).currentActorId,'BB');near(buildLiveRecorderStudy(d).scenario.pot,2);
});

test('all nine players must have their actual preflop option, including the unraised BB',()=>{
 const positions=liveRecorderPositions(9);let d=createLiveRecorder(config(Object.fromEntries(positions.map(p=>[p,100]))));
 for(const p of ['UTG','UTG+1','UTG+2','LJ','HJ','CO','BTN','SB']){assert.equal(view(d).currentActorId,p);d=run(d,['call']);}
 assert.equal(view(d).currentActorId,'BB');assert.equal(view(d).roundComplete,false);assert.throws(()=>applyLiveRecorderAction(d,flop),/未完成|提前/);
 d=run(d,['check',flop]);assert.equal(view(d).currentActorId,'SB');near(view(d).pot,9);assert.deepEqual(errors(replayLiveRecorder(d).parse),[]);
});

test('recorded cumulative short jams reopen only players facing a full additional increment',()=>{
 let d=createLiveRecorder(config({SB:101,BB:2.25,UTG:101,CO:3,BTN:101}));d=run(d,['call','call','call','call','check',flop,{type:'bet',amount:1},'allIn','call','allIn','call']);
 let v=view(d);assert.equal(v.currentActorId,'SB');assert.equal(v.canRaise,true);near(v.minRaiseTo,3);near(v.toCall,1);assert.throws(()=>applyLiveRecorderAction(d,{type:'raiseTo',amount:2.5}),/至少|较小/);
 const raised=run(d,[{type:'raiseTo',amount:3}]);assert.equal(view(raised).currentActorId,'UTG');assert.equal(view(raised).canRaise,true);
 d=run(d,['call']);v=view(d);assert.equal(v.currentActorId,'UTG');near(v.toCall,.75);assert.equal(v.canRaise,false);assert.equal(v.canAllIn,false);assert.throws(()=>applyLiveRecorderAction(d,{type:'raiseTo',amount:3}),/加注权|开放/);
 d=run(d,['call']);assert.equal(view(d).roundComplete,true);near(view(d).pot,14.25);near(view(d).conservation.difference,0);
});

test('short opening all-in: unacted player minimum is call plus 1BB, earlier checker cannot re-raise',()=>{
 let d=createLiveRecorder(config({SB:101,BB:1.5,BTN:101}));d=run(d,['call','call','check',flop,'check','allIn']);let v=view(d);assert.equal(v.currentActorId,'BTN');near(v.toCall,.5);near(v.minRaiseTo,1.5);assert.equal(v.canRaise,true);
 assert.throws(()=>applyLiveRecorderAction(d,{type:'raiseTo',amount:1}),/至少|较小/);assert.equal(view(run(d,[{type:'raiseTo',amount:1.5}])).currentActorId,'SB');
 d=run(d,['call']);v=view(d);assert.equal(v.currentActorId,'SB');assert.equal(v.canRaise,false);assert.equal(v.canAllIn,false);d=run(d,['call',{type:'street',cards:'9c'}]);
 const turn=replayLiveRecorder(d,{street:'turn'});near(turn.parse.scenario.pot,4.5);assert.equal(turn.parse.scenario.preexistingSidePot,undefined);assert.deepEqual(errors(turn.parse),[]);assert.doesNotThrow(()=>buildLiveRecorderStudy(d,{street:'turn'}));
 d=run(d,[{type:'bet',amount:2},'call',{type:'street',cards:'3s'}]);const river=replayLiveRecorder(d,{street:'river'});near(river.view.pot,8.5);assert.equal(river.parse.scenario.preexistingSidePot,true);assert.ok(errors(river.parse).some(i=>i.code==='preexisting_sidepot'));assert.throws(()=>buildLiveRecorderStudy(d,{street:'river'}),/边池|参池|投入/);
});

test('three unequal all-ins return only unmatched excess and preserve main/side-pot blocking',()=>{
 let d=createLiveRecorder(config({SB:50,BB:100,BTN:20}));d=run(d,['allIn','call','allIn']);let v=view(d);assert.equal(v.currentActorId,'SB');near(v.toCall,30);assert.equal(v.canRaise,false);assert.equal(v.canAllIn,true);
 d=run(d,['call']);let r=replayLiveRecorder(d);near(r.view.pot,120);near(player(r.view,'BB').stack,50);near(r.ledger.at(-1).amount,50);assert.equal(r.ledger.at(-1).type,'return');assert.equal(r.view.currentActorId,null);assert.equal(r.view.canRaise,false);assert.equal(r.view.nextStreet,'flop');
 d=run(d,[flop]);r=replayLiveRecorder(d);assert.equal(r.parse.scenario.preexistingSidePot,true);assert.equal(r.view.nextStreet,'turn');assert.throws(()=>buildLiveRecorderStudy(d,{street:'flop'}),/边池|参池|投入/);
 d=run(d,[{type:'street',cards:'9c'},{type:'street',cards:'3s'}]);r=replayLiveRecorder(d);assert.equal(r.view.handComplete,true);near(r.view.pot,120);near(r.view.conservation.difference,0);assert.equal(r.ledger.filter(a=>a.type==='return').length,1);compareReparse(r,'flop');
});

test('recorder rejects malformed sequence and unsupported structures without mutating the accepted draft',()=>{
 const d=createLiveRecorder(config()),before=JSON.stringify(d);
 for(const action of [{type:'call',playerId:'SB'},{type:'call',amount:2},{type:'check'},{type:'collect',amount:100},{type:'return',amount:1},{type:'fold',amount:2},flop])assert.throws(()=>applyLiveRecorderAction(d,action));assert.equal(JSON.stringify(d),before);
 const complete=run(d,['call','call','check']);assert.throws(()=>applyLiveRecorderAction(complete,{type:'street',street:'turn',cards:'Ks7h2d9c'}),/依次|跳过/);assert.throws(()=>applyLiveRecorderAction(complete,{type:'street',cards:'Ac7h2d'}),/冲突/);
 const onFlop=run(complete,[flop]);assert.throws(()=>applyLiveRecorderAction(onFlop,{type:'street',cards:'9c'}),/未完成|提前/);
 for(const extra of [{ante:1},{straddle:2},{rake:5},{unit:'BB',bigBlind:3},{board:'Ks7h2d'}])assert.throws(()=>createLiveRecorder(config(undefined,extra)));
 assert.throws(()=>createLiveRecorder(config({SB:100,BB:.5,BTN:100})),e=>e.code==='short_blind_unsupported');
});

test('quarter-dollar game with odd-cent stacks preserves a short call and exact side-pot eligibility',()=>{
 let d=createLiveRecorder(config({SB:2.37,BB:4.19,BTN:6.01},{unit:'currency',smallBlind:.1,bigBlind:.25}));
 d=run(d,[{type:'raiseTo',amount:.75},'call','call',flop]);let r=replayLiveRecorder(d);near(r.view.pot,2.25);near(r.parse.scenario.pot,9);near(player(r.view,'SB').stack,1.62);compareReparse(r,'flop');
 d=run(d,[{type:'bet',amount:.5},'call',{type:'raiseTo',amount:2}]);let v=view(d);assert.equal(v.currentActorId,'SB');near(v.toCall,1.12);near(v.fullToCall,1.5);assert.equal(v.canRaise,false);assert.equal(v.canAllIn,true);
 d=run(d,['allIn','call',{type:'street',cards:'9c'}]);r=replayLiveRecorder(d,{street:'turn'});near(r.view.pot,7.87);near(r.parse.scenario.pot,31.48);near(player(r.view,'SB').stack,0);near(player(r.view,'BB').stack,1.44);near(player(r.view,'BTN').stack,3.26);near(r.view.conservation.initialTotal,12.57);near(r.view.conservation.finalTotal,12.57);
 const short=r.ledger.find(a=>a.player==='SB'&&a.type==='call'&&Math.abs(a.amount-4.48)<1e-7);assert.ok(short);near(short.stackAfter,0);assert.equal(r.ledger.filter(a=>a.type==='return').length,0);assert.equal(r.parse.scenario.preexistingSidePot,true);compareReparse(r,'turn');
});

const foldedHeroHistory=`PokerStars Hand #20260928KnownFold: Hold'em No Limit ($0.50/$1 USD) - 2026/09/28 12:00:00 ET
Table 'Known folded cards' 3-max Seat #3 is the button
Seat 1: Small ($100 in chips)
Seat 2: Big ($100 in chips)
Seat 3: Hero ($100 in chips)
Small: posts small blind $0.50
Big: posts big blind $1
*** HOLE CARDS ***
Dealt to Hero [Ac Kd]
Hero: calls $1
Small: calls $0.50
Big: checks
*** FLOP *** [Ks 7h 2d]
Small: bets $1
Big: calls $1
Hero: folds
*** TURN *** [Ks 7h 2d] [9c]
Small: checks
Big: checks
*** RIVER *** [Ks 7h 2d 9c] [3s]
Small: checks
Big: checks
*** SHOW DOWN ***
Small collected $5 from pot
*** SUMMARY ***
Total pot $5 | Rake $0`;

test('known Hero fold blocks only later new-street roots, while the earlier real Hero decision remains verifiable',()=>{
 const earlier=parseScenario(foldedHeroHistory,{street:'flop'}),later=parseScenario(foldedHeroHistory,{street:'turn'});
 assert.equal(earlier.ok,true);assert.equal(earlier.scenario.hasUnsupportedDeadCards,undefined);
 assert.equal(assertInputProvenance(earlier.scenario,{raw:foldedHeroHistory}).sourceVerified,true);
 assert.equal(later.ok,false);assert.equal(later.scenario.hero,'');assert.equal(later.scenario.heroSeat,null);assert.equal(later.scenario.hasUnsupportedDeadCards,true);assert.ok(later.issues.some(i=>i.code==='unsupported_dead_cards'&&i.severity==='error'));
 assert.throws(()=>assertInputProvenance(later.scenario,{raw:foldedHeroHistory,issues:[]}));
 const assumed={...later.scenario};delete assumed.hasUnsupportedDeadCards;
 const fork=assertInputProvenance(assumed,forkInputContext({raw:foldedHeroHistory},{reason:'Explicitly study a fresh turn model without conditioning on the known folded cards.'}));assert.equal(fork.kind,'hypothetical-fork');assert.equal(fork.sourceVerified,false);
});

test('live known fold preserves a previous before-action checkpoint, rejects later root study and never re-deals the dead hand',()=>{
 let d=run(createLiveRecorder(config()),['call','call','check',flop,{type:'bet',amount:1},'call']);const heroDecision=d.actions.length;
 d=run(d,['fold',{type:'street',cards:'9c'}]);const early=replayLiveRecorder(d,{street:'flop'}),late=replayLiveRecorder(d,{street:'turn'});
 assert.equal(early.parse.ok,true);assert.equal(late.parse.ok,false);assert.equal(late.parse.scenario.hasUnsupportedDeadCards,true);assert.equal(late.parse.scenario.heroSeat,null);
 const study=buildLiveRecorderStudy(d,{actionIndex:heroDecision});assert.equal(study.target.actorId,'BTN');assert.equal(study.target.mode,'before-action');near(study.scenario.pot,3);assert.equal(assertInputProvenance(study.scenario,study.inputContext).sourceVerified,true);
 assert.throws(()=>buildLiveRecorderStudy(d,{street:'turn'}),/死牌|弃牌/);
 d=run(d,['check','check']);assert.throws(()=>applyLiveRecorderAction(d,{type:'street',cards:'Ac'}),/冲突/);
});

test('deterministic 2–9-player hands preserve every prefix, independent accounting and reversible user actions',t=>{
 let state=20260928;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};let checked=0,refunds=0,completed=0;
 for(let n=2;n<=9;n++){
  const positions=liveRecorderPositions(n),original=config(Object.fromEntries(positions.map((p,i)=>[p,5+i*3+n])),{hero:{playerId:'BTN',hand:''}});let d=createLiveRecorder(original);
  for(let step=0;step<150;step++){
   const r=replayLiveRecorder(d),v=r.view;independentAccounting(d,r);compareReparse(r);checked++;
   if(v.handComplete){completed++;refunds+=r.ledger.filter(a=>a.type==='return').length;break;}
   let action;
   if(v.roundComplete)action={type:'street',cards:({flop:'Ks7h2d',turn:'9c',river:'3s'})[v.nextStreet]};
   else{const p=random();if(v.toCall>0&&p<.16)action={type:'fold'};else if(v.canAllIn&&p>.93)action={type:'allIn'};else if(v.canRaise&&p<.45)action=v.maxRaiseTo<v.minRaiseTo?{type:'allIn'}:{type:v.canCheck?'bet':'raiseTo',amount:v.minRaiseTo};else action={type:v.canCheck?'check':'call'};}
   const before=structuredClone(d),next=applyLiveRecorderAction(d,action);assert.deepEqual(d,before);assert.deepEqual(undoLiveRecorderAction(next),d);d=next;
  }
 }
 assert.equal(completed,8);assert.ok(checked>70,`only ${checked} prefixes`);assert.ok(refunds>0,'campaign must exercise derived unmatched-bet refunds');
 t.diagnostic(`${completed} completed hands; ${checked} independently accounted/reparsed prefixes; ${refunds} derived refunds.`);
});
