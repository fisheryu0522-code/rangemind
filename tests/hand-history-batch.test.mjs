import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHandHistoryBatch} from '../lib/hand-history-batch.mjs';
import {IMPORT_EXAMPLES} from '../lib/scenario.mjs';

const stars=IMPORT_EXAMPLES.find(x=>x.id==='stars-example').text;
const withId=(text,id)=>text.replace(/#20260928001/,`#${id}`);
const gg=stars.replace('PokerStars Hand #20260928001','Poker Hand #HD987654321').replace("Table 'Training example'","Table 'Rush & Cash fixture'");
const join=(...hands)=>hands.join('\n\n');
const one=text=>parseHandHistoryBatch(text).hands[0];
const preflop=stars.slice(0,stars.indexOf('Hero: raises'))+'Hero: folds\nSBPlayer: folds\nUncalled bet ($0.15) returned to BBPlayer\nBBPlayer collected $0.20 from pot\n*** SUMMARY ***\nTotal pot $0.20 | Rake $0';
const allIn="Poker Hand #HDALLIN1: Hold'em No Limit ($0.50/$1 USD) - 2026/09/28 09:00:00\nTable 'All-in fixture' 2-max Seat #1 is the button\nSeat 1: Hero ($10 in chips)\nSeat 2: Villain ($10 in chips)\nHero: posts small blind $0.50\nVillain: posts big blind $1\n*** HOLE CARDS ***\nDealt to Hero [Kh Kd]\nHero: raises $9 to $10 and is all-in\nVillain: calls $9 and is all-in\n*** FLOP *** [As 7h 2d]\n*** TURN *** [As 7h 2d] [9c]\n*** RIVER *** [As 7h 2d 9c] [3s]\n*** SHOW DOWN ***\nHero: shows [Kh Kd]\nVillain: shows [Ah Ad]\nVillain collected $20 from pot\n*** SUMMARY ***\nTotal pot $20 | Rake $0";

test('BOM/CRLF mixed PokerStars and GG preserve original bytes and each street cash accounting',()=>{
  const a='\uFEFF'+stars.replace(/\n/g,'\r\n'),b=gg.replace(/\n/g,'\r\n'),r=parseHandHistoryBatch(a+'\r\n\r\n'+b,{fileName:'C:\\exports\\cash.txt'});
  assert.equal(r.ok,true);assert.equal(r.fileName,'cash.txt');assert.deepEqual(r.stats,{detected:2,imported:2,parsed:2,needsReview:0,preflopOnly:0,rejected:0,duplicates:0});assert.equal(r.hands[0].raw,a+'\r\n\r\n');assert.equal(r.hands[1].raw,b);assert.deepEqual(r.hands.map(h=>h.sourceKey),['pokerstars:20260928001','gg:HD987654321']);
  for(const h of r.hands){assert.equal(h.parse.metadata.conservation.difference,0);assert.equal(h.parse.ready,false);assert.equal(h.eligibleForStudy,true);assert.equal(h.summary.heroPosition,'BTN');assert.equal(h.summary.heroHand,'Ac Kd');assert.equal(h.summary.maxPlayers,6);assert.equal(h.summary.seatedPlayers,3);assert.deepEqual(h.summary.streets.map(s=>[s.street,s.pot]),[['preflop',1.4],['flop',9],['turn',21],['river',21]]);assert.equal(h.summary.stakes.bigBlind,.25);assert.ok(h.summary.streets.every(s=>s.players.every(p=>p.range==='')));}
});

test('street snapshots contain no future opponent hole cards or future board cards',()=>{
  const h=one(stars),summary=JSON.stringify(h.summary);assert.ok(h.raw.includes('Ah Qh'));assert.equal(summary.includes('Ah Qh'),false);assert.equal(h.summary.streets[1].board,'Ks 7h 2h');assert.equal(h.summary.streets[1].scenario.board,'Ks 7h 2h');assert.equal(h.summary.streets[0].heroToAct,true);assert.equal(h.summary.streets[1].heroToAct,false);assert.equal(h.summary.streets[1].toActPlayerId,'seat1');
});

test('hero position and known hand survive a later hero fold without inserting hero into later pots',()=>{
  const folded=stars.replace('SBPlayer: checks\nBBPlayer: checks\nHero: bets $1.50\nSBPlayer: calls $1.50\nBBPlayer: folds','SBPlayer: bets $1.50\nBBPlayer: calls $1.50\nHero: folds').replace('Hero: checks','BBPlayer: checks').replace('Hero: calls $3','BBPlayer: calls $3').replace('Hero: shows [Ac Kd]','BBPlayer: shows [Qc Qd]').replace('Hero collected','BBPlayer collected');
  const h=one(folded);assert.equal(h.status,'parsed',JSON.stringify(h.parse.issues));assert.equal(h.summary.heroPosition,'BTN');assert.equal(h.summary.heroHand,'Ac Kd');assert.equal(h.summary.streets[1].heroInHand,true);assert.equal(h.summary.streets[2].heroInHand,false);assert.equal(h.summary.streets[2].scenario.hero,'');assert.equal(h.summary.streets[2].scenario.heroSeat,null);assert.equal(h.summary.streets[2].scenario.players.some(p=>p.name==='Hero'),false);assert.match(h.summary.streets[2].scenario.notes,/牌张移除/);
});

test('preflop-only completed cash hands remain legitimate inbox records',()=>{
  const h=one(preflop);assert.equal(h.status,'preflop-only',JSON.stringify(h.parse.issues));assert.equal(h.eligibleForStudy,false);assert.equal(h.summary.heroPosition,'BTN');assert.equal(h.summary.streets.length,1);assert.equal(h.summary.finalGrossPot,.8);assert.equal(h.parse.metadata.conservation.difference,0);
});

test('all-in public runouts remain valid history without inventing a next actor',()=>{
  const h=one(allIn);assert.equal(h.status,'parsed',JSON.stringify(h.parse.issues));assert.equal(h.eligibleForStudy,false);assert.equal(h.summary.streets.length,4);for(const s of h.summary.streets.slice(1)){assert.equal(s.pot,20);assert.equal(s.toActPlayerId,null);assert.equal(s.heroToAct,null);assert.equal(s.canOpenStudy,false);assert.ok(s.players.every(p=>p.stack===0));}
});

test('a side pot formed before the chosen street is never flattened into a common starting pot',()=>{
  const text="Poker Hand #HDSIDEPOT: Hold'em No Limit ($0.50/$1 USD) - 2026/09/28 09:00:00\nTable 'Side-pot fixture' 3-max Seat #3 is the button\nSeat 1: SB ($20 in chips)\nSeat 2: BB ($20 in chips)\nSeat 3: Hero ($5 in chips)\nSB: posts small blind $0.50\nBB: posts big blind $1\n*** HOLE CARDS ***\nDealt to Hero [Ah Ad]\nHero: raises $4 to $5 and is all-in\nSB: calls $4.50\nBB: raises $5 to $10\nSB: calls $5\n*** FLOP *** [Ks 7h 2d]\nSB: checks\nBB: checks\n*** TURN *** [Ks 7h 2d] [9c]\nSB: checks\nBB: checks\n*** RIVER *** [Ks 7h 2d 9c] [3s]\nSB: checks\nBB: checks\n*** SHOW DOWN ***\nHero: shows [Ah Ad]\n*** SUMMARY ***\nTotal pot $25 | Rake $0";
  const h=one(text);assert.equal(h.parse.metadata.conservation.difference,0);assert.equal(h.status,'needs-review');assert.equal(h.eligibleForStudy,false);assert.ok(h.parse.issues.some(x=>x.code==='preexisting_sidepot'));assert.equal(h.summary.streets[1].pot,25);
  const matched=one(text.replace('BB: raises $5 to $10\nSB: calls $5','BB: calls $4').replace('Total pot $25','Total pot $15'));assert.equal(matched.status,'parsed',JSON.stringify(matched.parse.issues));assert.equal(matched.summary.streets[1].pot,15);assert.equal(matched.summary.streets[1].canOpenStudy,true);
});

test('missing ranges are expected while incorrect amounts or unknown actions require review',()=>{
  const amountBad=withId(stars.replace('SBPlayer: calls $0.65','SBPlayer: calls $0.75'),'BADAMOUNT');
  const actionBad=withId(stars.replace('SBPlayer: checks','SBPlayer: mystery action'),'BADACTION');
  const r=parseHandHistoryBatch(join(stars,amountBad,actionBad));assert.equal(r.hands[0].status,'parsed');assert.ok(r.hands[0].parse.issues.some(i=>i.code==='ranges_required'));assert.deepEqual(r.hands.slice(1).map(h=>h.status),['needs-review','needs-review']);assert.ok(r.hands.slice(1).every(h=>!h.eligibleForStudy));assert.ok(r.hands[1].parse.issues.some(i=>i.code==='ambiguous_call_amount'));
});

test('different-content repeated hand ID never silently overrides either record',()=>{
  const changed=stars.replace('Total pot $11.25','Total pot $99.25'),r=parseHandHistoryBatch(join(stars,stars.replace(/\n/g,'\r\n'),changed));assert.equal(r.hands.length,1);assert.equal(r.duplicates.length,1);assert.equal(r.rejected.length,1);assert.equal(r.rejected[0].raw,changed);assert.equal(r.rejected[0].code,'conflicting_hand_id');assert.equal(r.hands[0].status,'needs-review');assert.equal(r.hands[0].eligibleForStudy,false);assert.ok(r.hands[0].summary.streets.every(s=>!s.canOpenStudy));
});

test('same numeric hand ID at different sites is not a duplicate',()=>{
  const r=parseHandHistoryBatch(join(stars,gg.replace('HD987654321','20260928001')));assert.equal(r.hands.length,2);assert.equal(r.duplicates.length,0);assert.notEqual(r.hands[0].sourceKey,r.hands[1].sourceKey);
});

test('PLO, limit, tournaments, run-it-twice and unknown sites reject individually without losing supported hands',()=>{
  const unsupported=[withId(stars.replace("Hold'em No Limit",'Omaha Pot Limit'),'PLO'),withId(stars.replace('No Limit','Limit'),'LIMIT'),withId(stars.replace(": Hold'em",": Tournament #77, Hold'em"),'MTT'),withId(stars.replace('*** FLOP ***','*** FIRST FLOP ***'),'TWICE'),withId(stars.replace('PokerStars Hand','OtherPoker Hand'),'OTHER')];
  const r=parseHandHistoryBatch(join(stars,...unsupported,gg));assert.equal(r.hands.length,2);assert.equal(r.rejected.length,5);assert.deepEqual(r.rejected.map(x=>x.code),['unsupported_variant','unsupported_betting_structure','unsupported_tournament','unsupported_runout','unsupported_site']);assert.ok(r.rejected.every(x=>x.raw.includes('#')));
});

test('Zoom NLHE uses explicit site parsing and its original header remains intact',()=>{
  const h=one(stars.replace('PokerStars Hand','PokerStars Zoom Hand'));assert.equal(h.site,'pokerstars');assert.equal(h.status,'parsed',JSON.stringify(h.parse.issues));assert.ok(h.raw.startsWith('PokerStars Zoom Hand'));
});

test('missing big blind and ambiguous numeric or mixed currency units cannot become clean studies',()=>{
  for(const text of [stars.replace('($0.10/$0.25 USD)','(unknown stakes)'),stars.replace('$0.10/$0.25','$0,10/$0,25'),stars.replace('SBPlayer: calls $0.65','SBPlayer: calls €0.65')]){const h=one(text);assert.equal(h.status,'needs-review');assert.equal(h.eligibleForStudy,false);}
  const noSymbol=one(stars.replaceAll('$','').replace(' USD',''));assert.equal(noSymbol.status,'parsed');assert.equal(noSymbol.summary.stakes.currency,null);assert.equal(noSymbol.summary.stakes.symbol,null);assert.equal(noSymbol.summary.streets[1].pot,9);
});

test('known hero/public card collision and inconsistent gross pot are flagged',()=>{
  for(const text of [stars.replace('Dealt to Hero [Ac Kd]','Dealt to Hero [Ks Kd]'),stars.replace('Total pot $11.25','Total pot $12.25')]){const h=one(text);assert.equal(h.status,'needs-review');assert.equal(h.eligibleForStudy,false);}
});

test('no Dealt to does not use later shows to infer Hero',()=>{
  const h=one(stars.replace('Dealt to Hero [Ac Kd]\n',''));assert.equal(h.status,'parsed');assert.equal(h.summary.heroHand,null);assert.equal(h.summary.heroName,null);assert.equal(h.summary.heroPosition,null);assert.ok(h.summary.streets.every(s=>s.heroInHand===false));assert.equal(JSON.stringify(h.summary).includes('Ac Kd'),false);
});

test('incomplete records, duplicate seats and sitting-out ambiguity retain reviewable raw',()=>{
  const variants=[stars.slice(0,stars.indexOf('*** SUMMARY')),stars.replace('Seat 3: Hero','Seat 2: Hero'),stars.replace('Seat 1: SBPlayer ($25 in chips)','Seat 1: SBPlayer ($25 in chips) is sitting out')];
  for(const text of variants){const r=parseHandHistoryBatch(text);assert.equal(r.hands.length,1);assert.equal(r.hands[0].status,'needs-review');assert.equal(r.hands[0].raw,text);}
});

test('hand limits and unassigned preamble preserve original segments instead of dropping the whole file',()=>{
  const r=parseHandHistoryBatch('Export notes\n'+join(stars,gg),{maxHands:1});assert.equal(r.hands.length,1);assert.equal(r.rejected.length,1);assert.equal(r.rejected[0].code,'hand_limit');assert.equal(r.rejected[0].raw,gg);assert.equal(r.unassigned[0].raw,'Export notes\n');assert.equal(r.stats.detected,2);
});

test('UTF-8 byte budget, invalid options and unrecognized files fail explicitly',()=>{
  assert.throws(()=>parseHandHistoryBatch('中文',{maxBytes:5}),e=>e.code==='batch_too_large');assert.throws(()=>parseHandHistoryBatch(stars,{maxHands:0}),/maxHands/);assert.throws(()=>parseHandHistoryBatch(new Uint8Array()),/UTF-8/);const r=parseHandHistoryBatch('not a hand');assert.equal(r.ok,false);assert.equal(r.rejected[0].raw,'not a hand');assert.equal(r.rejected[0].code,'unrecognized_file');
});

test('missing hand IDs use a stable content hash and six-plus is explicitly unsupported',()=>{
  const missing=stars.replace('#20260928001:','#:');const h=one(missing);assert.equal(h.handId,null);assert.match(h.sourceKey,/^sha256:[a-f0-9]{64}$/);assert.equal(parseHandHistoryBatch(join(missing,missing)).duplicates.length,1);const short=stars.replace("Hold'em No Limit","6+ Hold'em No Limit");assert.equal(parseHandHistoryBatch(short).rejected[0].code,'unsupported_variant');
});
