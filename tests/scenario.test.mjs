import test from 'node:test';
import assert from 'node:assert/strict';
import {validateScenario,normalizeScenario,parseScenario,replayActions,IMPORT_EXAMPLES} from '../lib/scenario.mjs';

const base=()=>({title:'test',format:'study',unit:'BB',board:'Ks 7h 2h 9c 3s',hero:'Ac Kd',heroSeat:1,pot:40,toAct:0,players:[{id:'v',name:'V',position:'BB',stack:160,range:'99,77,22,KQ,KJ,AhQh'},{id:'h',name:'H',position:'BTN',stack:160,range:'AcKd'}]});
test('valid scenario preserves explicit BB root and separates focus blockers',()=>{
  const v=validateScenario(base());assert.equal(v.ok,true);assert.equal(v.rangeStats[0].focus.count,26);assert.equal(v.scenario.unit,'BB');assert.equal(v.scenario.players[0].stack,160);
});
test('missing range is never defaulted and strict normalization refuses it',()=>{
  const s=base();s.players[0].range='';assert.equal(validateScenario(s).ok,false);assert.equal(validateScenario(s,{requireRanges:false}).ok,true);assert.equal(validateScenario(s,{requireRanges:false}).scenario.players[0].range,'');assert.throws(()=>normalizeScenario(s),/范围/);
});
test('impossible joint ranges and a hero outside their range are rejected',()=>{
  const s=base();s.players[0].range='AcQd';assert.equal(validateScenario(s).issues.some(x=>x.code==='incompatible_ranges'),true);
  const t=base();t.players[1].range='AhKh';assert.equal(validateScenario(t).issues.some(x=>x.code==='hero_outside_range'),true);
});
test('known card collision, invalid to-act and duplicate IDs reject',()=>{
  const s=base();s.hero='Ks Ac';s.toAct=9;s.players[1].id='v';const r=validateScenario(s);for(const code of ['duplicate_known_card','missing_to_act','duplicate_player_id'])assert.ok(r.issues.some(x=>x.code===code));
});
test('Chinese examples parse with accurate positions and no hidden ranges',()=>{
  const r=parseScenario(IMPORT_EXAMPLES[0].text);assert.equal(r.ok,true);assert.equal(r.ready,true);assert.equal(r.scenario.players.length,3);assert.equal(r.scenario.heroSeat,1);assert.equal(r.scenario.toAct,0);
});
test('currency shorthand converts pot and all stacks consistently',()=>{
  const text='单位：美元\n盲注：1/3\n底池：120\n公共牌：Ks 7h 2h 9c 3s\nHero：BTN Ac Kd\nBB：筹码 480 范围 99,77,22\nBTN（Hero）：筹码 480 范围 AcKd';
  const r=parseScenario(text);assert.equal(r.ok,true);assert.equal(r.scenario.pot,40);assert.equal(r.scenario.players[0].stack,160);assert.equal(r.scenario.players[1].stack,160);
});
test('unit and ambiguous raises are explicit blockers',()=>{
  const noUnit=IMPORT_EXAMPLES[1].text.replace('单位：BB\n','');assert.equal(parseScenario(noUnit).issues.some(x=>x.code==='missing_unit'),true);
  const ambiguous=IMPORT_EXAMPLES[1].text+'\nBB 加注 90';assert.equal(parseScenario(ambiguous).issues.some(x=>x.code==='ambiguous_raise_amount'),true);
});
test('call amount must be incremental, raise-to is total',()=>{
  const initial={pot:40,street:'river',board:'Ks 7h 2h 9c 3s',players:[{id:'a',name:'A',stack:160},{id:'b',name:'B',stack:160}]};
  const a=[{type:'bet',player:'a',amount:30},{type:'raiseTo',player:'b',amount:90},{type:'call',player:'a',amount:60}];
  const r=replayActions(initial,a);assert.equal(r.state.pot,220);assert.deepEqual(r.state.players.map(p=>p.stack),[70,70]);assert.equal(r.conservation.difference,0);
  assert.throws(()=>replayActions(initial,[...a.slice(0,2),{type:'call',player:'a',amount:90}]),/应跟入 60/);
});
test('PokerStars import rebuilds three street roots and conserves every chip',()=>{
  const r=parseScenario(IMPORT_EXAMPLES[2].text);assert.equal(r.ok,true);assert.equal(r.ready,false);assert.equal(r.scenario.pot,9);assert.equal(r.scenario.players.length,3);assert.equal(r.scenario.heroSeat,2);assert.deepEqual(r.snapshots.map(x=>[x.street,x.scenario.pot]),[['flop',9],['turn',21],['river',21]]);assert.equal(r.snapshots[1].scenario.players.length,2);assert.equal(r.metadata.conservation.difference,0);assert.equal(r.ledger.at(-1).potAfter,45);assert.ok(r.scenario.players.every(p=>p.range===''));
  const turn=parseScenario(IMPORT_EXAMPLES[2].text,{street:'turn'});assert.equal(turn.scenario.pot,21);assert.equal(turn.scenario.board,'Ks 7h 2h 9c');
});
test('GG native header is recognized without treating shown hands as ranges',()=>{
  const text=IMPORT_EXAMPLES[2].text.replace(/PokerStars Hand #20260928001/,'Poker Hand #HD123456789').replace("Table 'Training example' 6-max", "Table 'GG test' 6-max");
  const r=parseScenario(text);assert.equal(r.kind,'gg');assert.equal(r.ok,true);assert.equal(r.metadata.bigBlind,.25);assert.ok(r.scenario.players.every(p=>p.range===''));
});
test('uncalled overbet is refunded without losing gross-pot conservation',()=>{
  const r=replayActions({pot:40,street:'river',board:'Ks 7h 2h 9c 3s',players:[{id:'a',name:'A',stack:100},{id:'b',name:'B',stack:100}]},[{type:'bet',player:'a',amount:60},{type:'fold',player:'b'},{type:'return',player:'a',amount:60}]);
  assert.equal(r.state.pot,40);assert.equal(r.state.players[0].stack,100);assert.equal(r.conservation.difference,0);
});
test('short all-in can be called but does not automatically reopen raising',()=>{
  const initial={pot:30,street:'river',board:'Ks 7h 2h 9c 3s',players:[{id:'a',name:'A',stack:100},{id:'b',name:'B',stack:100},{id:'c',name:'C',stack:45}]};
  const start=[{type:'bet',player:'a',amount:30},{type:'call',player:'b',amount:30},{type:'raiseTo',player:'c',amount:45}];
  assert.throws(()=>replayActions(initial,[...start,{type:'raiseTo',player:'a',amount:90}]),/未达到完整加注/);
  const r=replayActions(initial,[...start,{type:'call',player:'a',amount:15},{type:'call',player:'b',amount:15}]);assert.equal(r.state.pot,165);assert.equal(r.conservation.difference,0);
});
test('street may not advance with unmatched live betting',()=>{
  const initial={pot:20,street:'flop',board:'Ks 7h 2h',players:[{id:'a',name:'A',stack:100},{id:'b',name:'B',stack:100}]};
  assert.throws(()=>replayActions(initial,[{type:'bet',player:'a',amount:10},{type:'street',street:'turn',board:'Ks 7h 2h 9c'}]),/未跟足/);
});
test('malformed HH summary is flagged rather than silently accepted',()=>{
  const bad=IMPORT_EXAMPLES[2].text.replace('Total pot $11.25','Total pot $12.25');const r=parseScenario(bad);assert.equal(r.ok,false);assert.ok(r.issues.some(x=>x.code==='pot_mismatch'));
});
test('rake fields survive normalization and invalid rake is rejected',()=>{
  const s=base();s.rake=5;s.rakeCap=3;const n=normalizeScenario(s);assert.equal(n.rake,5);assert.equal(n.rakeCap,3);assert.equal(validateScenario({...s,rake:-1}).ok,false);assert.equal(validateScenario({...s,rakeCap:'unknown'}).ok,false);
});
test('invalid player object and missing stacks do not silently become zero',()=>{
  assert.equal(validateScenario({...base(),players:[null,null]}).ok,false);const s=base();s.players[0].stack='';assert.ok(validateScenario(s).issues.some(i=>i.code==='invalid_stack'));
});
test('mixed units and multiple hands cannot be accepted as one clean hand',()=>{
  const mix=IMPORT_EXAMPLES[0].text.replace('筹码 120','筹码 120 美元');assert.ok(parseScenario(mix).issues.some(i=>i.code==='mixed_units'));
  assert.ok(parseScenario(IMPORT_EXAMPLES[2].text+'\n'+IMPORT_EXAMPLES[2].text).issues.some(i=>i.code==='multiple_hands'));
});
test('natural live note recovers blinds, implicit calls, stacks and distinct street root',()=>{
  const raw='六人桌现金局，SB/BB 为 0.5/1 BB。BTN 100 BB，SB 150 BB，BB 80 BB。其他人弃牌。BTN 加注到 3 BB，SB 跟注，BB 跟注。翻牌 Qh Ts 7h，SB 过牌，BB 过牌，BTN 下注 6 BB。我在 SB，持 Ah Jh，研究跟注与加注。';
  const r=parseScenario(raw);assert.equal(r.ok,true);assert.equal(r.ready,false);assert.equal(r.kind,'natural');assert.equal(r.scenario.pot,9);assert.equal(r.scenario.hero,'Ah Jh');assert.equal(r.scenario.heroSeat,0);assert.deepEqual(r.scenario.players.map(p=>p.stack),[147,77,97]);assert.equal(r.ledger.at(-1).potAfter,15);assert.deepEqual(r.ledger.filter(a=>a.type==='call').map(a=>a.amount),[2.5,2]);assert.equal(r.metadata.conservation.difference,0);
});
test('natural cash note converts currencies and verifies an explicitly stated pot',()=>{
  const raw='现场1/3，盲注1/3美元。BTN 300美元，SB 300美元，BB 300美元。BTN 加注到9美元，SB 跟注，BB 跟注。翻牌 Ks 7h 2h，底池27美元。我在BTN，持Ac Kd。';
  const r=parseScenario(raw);assert.equal(r.ok,true);assert.equal(r.scenario.pot,9);assert.deepEqual(r.scenario.players.map(p=>p.stack),[97,97,97]);const bad=parseScenario(raw.replace('底池27美元','底池30美元'));assert.equal(bad.ok,false);assert.ok(bad.issues.some(i=>i.code==='pot_mismatch'));
});
test('cumulative short all-ins reopen a full raise while a lone half-bet does not',()=>{
  const initial={pot:10,street:'river',board:'Ks 7h 2h 9c 3s',players:[{id:'a',name:'A',stack:10},{id:'b',name:'B',stack:.5},{id:'c',name:'C',stack:1}]};
  const actions=[{type:'check',player:'a'},{type:'bet',player:'b',amount:.5},{type:'raiseTo',player:'c',amount:1},{type:'raiseTo',player:'a',amount:2}];assert.equal(replayActions(initial,actions).ok,true);
  const short={...initial,players:[initial.players[0],initial.players[1],{id:'c',name:'C',stack:10}]};assert.throws(()=>replayActions(short,[actions[0],actions[1],{type:'call',player:'c',amount:.5},{type:'raiseTo',player:'a',amount:1.5}]),/重新开放/);
});
test('import rejects out-of-turn action and omitted checks instead of only checking money',()=>{
  const wrong=IMPORT_EXAMPLES[2].text.replace('SBPlayer: checks\nBBPlayer: checks','BBPlayer: checks\nSBPlayer: checks');assert.ok(parseScenario(wrong).issues.some(i=>i.code==='wrong_action_order'));
  const missed=IMPORT_EXAMPLES[2].text.replace('SBPlayer: checks\nHero: checks\n*** RIVER','*** RIVER');assert.ok(parseScenario(missed).issues.some(i=>i.code==='unfinished_action_round'));
});
test('replay follows observed clockwise seats rather than raw player-list order',()=>{
  const initial={pot:10,board:'Ks 7h 2h',street:'flop',players:[{id:'b',name:'B',position:'BTN',seat:3,stack:100},{id:'s',name:'S',position:'SB',seat:1,stack:100},{id:'g',name:'G',position:'BB',seat:2,stack:100}]};
  const r=replayActions(initial,[{type:'check',player:'s'},{type:'check',player:'g'},{type:'check',player:'b'},{type:'street',street:'turn',board:'Ks 7h 2h 9c'}],{enforceOrder:true});assert.equal(r.ok,true);assert.equal(r.ledger[0].nextActor,'g');assert.equal(r.ledger.at(-1).nextActor,'s');
});
