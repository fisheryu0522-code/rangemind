import test from 'node:test';
import assert from 'node:assert/strict';
import {IMPORT_EXAMPLES,parseScenario} from '../lib/scenario.mjs';
import {parseHandHistoryBatch} from '../lib/hand-history-batch.mjs';
import {assertInputProvenance,assertObservedInputProvenance,forkInputContext,inputHandSourceId,inputRecordingSourceId} from '../lib/input-provenance.mjs';
import {createLiveRecorder,applyLiveRecorderAction,replayLiveRecorder,buildLiveRecorderStudy} from '../lib/live-recorder.mjs';

const natural='六人桌现金局，SB/BB 为 0.5/1 BB。BTN 100 BB，SB 100 BB，BB 100 BB。其他人弃牌。BTN 加注到 3 BB，SB 跟注，BB 弃牌。翻牌 Qh Ts 7h，SB 过牌，BTN 下注 6 BB，SB 加注到 18 BB。我在 SB，持 Ah Jh。';
const notation=IMPORT_EXAMPLES.find(e=>e.id==='live-three-way').text;
const stars=IMPORT_EXAMPLES.find(e=>e.id==='stars-example').text;
const gg=stars.replace('PokerStars Hand #20260928001','Poker Hand #HDPROVENANCE');
const ctx=(raw,options={})=>{const parsed=parseScenario(raw,{unit:'BB',...options});return {scenario:parsed.scenario,context:{raw,ledger:parsed.ledger,issues:parsed.issues,metadata:parsed.metadata,sourceUnit:'BB',sourceBigBlind:options.bigBlind??1}};};

test('a hand-written model and client checked flags never become verified original-hand provenance',()=>{
 const {scenario}=ctx(notation),a=assertInputProvenance(scenario,null),b=assertInputProvenance(scenario,{checked:true,verified:true});assert.equal(a.kind,'manual-model');assert.equal(a.sourceVerified,false);assert.equal(b.sourceVerified,false);assert.throws(()=>assertObservedInputProvenance(scenario,null),/不能声称精确/);
});

test('valid natural notation is reparsed without inventing ranges, and client ledger changes are replaced',()=>{
 const f=ctx(natural),before=structuredClone(f);f.context.ledger=[{type:'fold',player:'Hero',amount:10000}];
 const r=assertInputProvenance(f.scenario,f.context);assert.equal(r.kind,'reparsed-source');assert.equal(r.sourceVerified,true);assert.equal(r.matchedStreet,'flop');assert.deepEqual(r.inputContext.ledger,before.context.ledger);assert.ok(r.inputContext.snapshots.length);assert.ok(f.scenario.players.every(p=>!p.range));assert.notDeepEqual(f.context.ledger,r.inputContext.ledger);assert.equal(r.sourceRef.kind,'input-text');
});

test('deleting parse errors or adding checked flags cannot bypass an ambiguous real raise',()=>{
 const f=ctx(natural.replace('SB 加注到 18','SB 加注 18'));assert.ok(f.context.issues.some(x=>x.code==='ambiguous_raise_amount'));
 for(const context of [f.context,{...f.context,issues:[],checked:true,verified:true},{raw:f.context.raw,sourceUnit:'BB',sourceBigBlind:1}])assert.throws(()=>assertInputProvenance(f.scenario,context),e=>e.code==='unresolved_import_errors'&&e.issues.some(x=>x.code==='ambiguous_raise_amount'));
 assert.equal(f.scenario.pot,7); // Reading or saving this draft itself is allowed.
});

test('changing recorded money, board, actor, position or known Hero requires an explicit hypothetical fork',()=>{
 const f=ctx(natural);
 for(const mutate of [s=>s.pot++,s=>s.players[0].stack--,s=>s.toAct=1,s=>s.players[0].position='CO',s=>s.board='Qh Ts 8h',s=>s.hero='',s=>s.heroSeat=1]){
  const scenario=structuredClone(f.scenario);mutate(scenario);assert.throws(()=>assertInputProvenance(scenario,f.context),e=>e.code==='source_structure_changed');
 }
});

test('range and rake assumptions can change without altering the original public ledger',()=>{
 const f=ctx(natural),scenario=structuredClone(f.scenario);scenario.players[0].range='AhJh,AcAd';scenario.players[1].range='KcKd,QcQd';scenario.rake=5;scenario.rakeCap=1;const r=assertInputProvenance(scenario,f.context);assert.equal(r.sourceVerified,true);assert.match(r.assumptions.join(' '),/范围与抽水模型仍/);assert.ok(r.inputContext.snapshots[0].scenario.players.every(p=>p.range===''));
});

test('explicit live notation units and currency conversion are honored rather than guessed',()=>{
 const raw='标题：现场金额核对\n单位：美元\n盲注：1/3\n公共牌：Ks 7h 2h 9c 3s\n底池：60\nHero：BB Ac Kd\nSB：筹码 120 范围 77,22\nBB：筹码 160 范围 AK\n先行动：SB',f=ctx(raw,{unit:'currency',bigBlind:3});f.context.sourceUnit='currency';f.context.sourceBigBlind=3;assert.equal(f.scenario.pot,20);assert.equal(assertInputProvenance(f.scenario,f.context).sourceVerified,true);
 const ambiguous=ctx(raw.replace('单位：美元\n','').replace('盲注：1/3\n',''),{unit:'currency',bigBlind:3});const context={raw:ambiguous.context.raw};assert.throws(()=>assertInputProvenance(ambiguous.scenario,context),/金额|单位|识别/);
 assert.equal(assertInputProvenance(ctx(notation).scenario,ctx(notation).context).sourceVerified,true);
});

test('the actual $0.25 hand-history header wins over a default external bigBlind of 1',()=>{
 for(const raw of [stars,gg]){const parsed=parseScenario(raw,{unit:'BB',bigBlind:1});assert.equal(parsed.metadata.bigBlind,.25);assert.equal(parsed.scenario.pot,9);const r=assertInputProvenance(parsed.scenario,{raw,sourceUnit:'BB',sourceBigBlind:1});assert.equal(r.sourceVerified,true);assert.equal(r.inputContext.sourceUnit,'currency');assert.equal(r.inputContext.sourceBigBlind,.25);const bad={...parsed.scenario,pot:2.25};assert.throws(()=>assertInputProvenance(bad,{raw,sourceBigBlind:1}),/街起点底池/);}
});

test('GG inbox context is verified against the trusted stored hand, including each street snapshot',()=>{
 const hand={...parseHandHistoryBatch('\uFEFF'+gg.replace(/\n/g,'\r\n')).hands[0],id:'local-hand'};
 for(const point of hand.summary.streets.filter(s=>s.scenario)){
  const context={raw:hand.raw,ledger:hand.parse.ledger,snapshots:hand.parse.snapshots,issues:hand.parse.issues,metadata:hand.parse.metadata,sourceHandId:hand.id,sourceKey:hand.sourceKey,sourceUnit:'currency',sourceBigBlind:.25};
  const r=assertInputProvenance(point.scenario,context,{hand});assert.equal(r.matchedStreet,point.street);assert.equal(r.sourceRef.id,hand.id);assert.equal(r.sourceVerified,true);assert.equal(r.inputContext.sourceHandId,hand.id);
 }
});

test('fake, conflicting or missing stored-hand references cannot be authenticated from client data',()=>{
 const hand={...parseHandHistoryBatch(gg).hands[0],id:'saved'},f=ctx(gg);f.context.sourceHandId=hand.id;
 assert.throws(()=>assertInputProvenance(f.scenario,f.context),e=>e.code==='local_hand_missing');assert.throws(()=>assertInputProvenance(f.scenario,{...f.context,raw:gg.replace('$3','$4')},{hand}),e=>e.code==='local_hand_text_mismatch');
 assert.throws(()=>inputHandSourceId({sourceHandId:'a',metadata:{sourceHandId:'b'}}),e=>e.code==='conflicting_hand_source');assert.equal(inputHandSourceId({metadata:{sourceHandId:'saved'}}),'saved');assert.equal(inputHandSourceId({source:{kind:'hand',id:'saved'}}),'saved');
 const review={...hand,status:'needs-review',parse:{...hand.parse,issues:[{severity:'error',code:'conflicting_hand_id',message:'本地牌谱编号冲突。'}]}};assert.throws(()=>assertInputProvenance(f.scenario,{...f.context,issues:[]},{hand:review}),/编号冲突/);
});

test('single-hand cash provenance rejects unsupported games even if their public cards parse',()=>{
 for(const raw of [stars.replace("Hold'em No Limit",'Omaha Pot Limit'),stars.replace("Hold'em No Limit","Tournament Hold'em No Limit"),stars+'\n'+gg]){
  const scenario=ctx(stars).scenario;assert.throws(()=>assertInputProvenance(scenario,{raw,issues:[]}),/未解决|识别/);
 }
});

test('explicit forks preserve original references but do not inherit checked-hand or exact-navigation meaning',()=>{
 const hand={...parseHandHistoryBatch(gg).hands[0],id:'saved'},f=ctx(gg),context={...f.context,sourceHandId:hand.id},fork=forkInputContext(context,{reason:'把起点底池改大，检查策略对 SPR 的敏感性。'}),scenario={...f.scenario,pot:20,hero:'',heroSeat:null};
 const r=assertInputProvenance(scenario,fork,{hand});assert.equal(r.kind,'hypothetical-fork');assert.equal(r.sourceVerified,false);assert.equal(r.sourceRef.id,hand.id);assert.equal(r.inputContext.raw,gg);assert.match(r.inputContext.provenance.reason,/SPR/);assert.equal(r.matchedStreet,null);assert.throws(()=>assertObservedInputProvenance(scenario,fork,{hand}),e=>e.code==='not_original_hand_navigation');assert.equal(context.provenance,undefined);
 const bad=ctx(natural.replace('SB 加注到 18','SB 加注 18')),research=assertInputProvenance(bad.scenario,forkInputContext(bad.context,{reason:'不猜原始金额；仅研究自己明确填入的街起点假设。'}));assert.equal(research.sourceVerified,false);assert.ok(research.sourceIssues.some(x=>x.code==='ambiguous_raise_amount'));
});

test('fork reasons are bounded and an imported ledger without source text cannot pass as checked',()=>{
 const f=ctx(natural);for(const reason of ['',null,'a'.repeat(2001)])assert.throws(()=>forkInputContext(f.context,{reason}),/1–2000/);assert.throws(()=>forkInputContext(null,{reason:'缺原始来源'}),/没有可保留/);assert.throws(()=>assertInputProvenance(f.scenario,{provenance:{kind:'hypothetical-fork',reason:'没有来源'}}),/没有可保留/);assert.throws(()=>assertInputProvenance(f.scenario,{ledger:f.context.ledger,checked:true}),/缺少.*原文/);assert.throws(()=>assertInputProvenance(f.scenario,{...f.context,provenance:{kind:'verified',checked:true}}),/checked/);
});

test('unrecognized notation text stays unresolved even if the base monetary snapshot is valid',()=>{
 const f=ctx(notation+'\nSB 神秘操作 18');assert.ok(f.context.issues.some(x=>x.code==='unparsed_text'));
 assert.throws(()=>assertInputProvenance(f.scenario,{...f.context,issues:[]}),e=>e.code==='unresolved_import_errors'&&e.issues.some(x=>x.code==='unparsed_text'));
 const fork=assertInputProvenance(f.scenario,forkInputContext(f.context,{reason:'无法核对原行动，另外研究明确填写的静态局面。'}));assert.equal(fork.sourceVerified,false);
});

test('legacy source-ID locations are canonicalized without trusting a new raw text or claiming unseen Hero cards',()=>{
 const hand={...parseHandHistoryBatch(gg).hands[0],id:'saved'},f=ctx(gg);
 for(const ref of [{metadata:{sourceHandId:hand.id}},{source:{kind:'hand',id:hand.id}}]){
  const r=assertInputProvenance(f.scenario,{...f.context,...ref},{hand});assert.equal(r.inputContext.sourceHandId,hand.id);assert.equal(r.sourceVerified,true);assert.ok(r.inputContext.snapshots.every(s=>s.scenario.players.every(p=>p.range==='')));
 }
});

function recordedFlop(){
 let draft=createLiveRecorder({unit:'BB',playerCount:3,hero:{playerId:'BTN',hand:'Ac Kd'}});
 for(const action of [{type:'call'},{type:'call'},{type:'check'},{type:'street',cards:'Qs 7h 2d'}])draft=applyLiveRecorderAction(draft,action);
 const study=buildLiveRecorderStudy(draft),recording={id:'local-recording',revision:4,draft,studySnapshots:[]},context={...study.inputContext,sourceRecordingId:recording.id,sourceRecordingRevision:4};return {draft,study,recording,context};
}

test('a local manual recording is authenticated from its stored draft and explicit revision, not client flags or embedded records',()=>{
 const f=recordedFlop(),r=assertInputProvenance(f.study.scenario,f.context,{recording:f.recording});assert.equal(r.sourceVerified,true);assert.deepEqual(r.sourceRef,{kind:'live-recording',id:'local-recording',revision:4});assert.match(r.assumptions.join(' '),/不是现实牌局真实性认证/);assert.equal(r.inputContext.sourceRecordingRevision,4);assert.equal(r.inputContext.sourceUnit,'BB');
 assert.throws(()=>assertInputProvenance(f.study.scenario,{...f.context,recording:f.recording,checked:true}),e=>e.code==='local_recording_missing');assert.throws(()=>assertInputProvenance(f.study.scenario,f.context,{recording:{...f.recording,id:'different'}}),/找不到/);
 for(const revision of [undefined,null,-1,1.5,'4',999])assert.throws(()=>assertInputProvenance(f.study.scenario,{...f.context,sourceRecordingRevision:revision},{recording:f.recording}),/版本/);
 const missingRaw={...f.context};delete missingRaw.raw;assert.equal(assertInputProvenance(f.study.scenario,missingRaw,{recording:f.recording}).inputContext.raw,f.context.raw);
 assert.throws(()=>assertInputProvenance(f.study.scenario,{...f.context,raw:f.context.raw.replace('BB 100 BB','BB 200 BB')},{recording:f.recording}),e=>e.code==='local_recording_text_mismatch');
 assert.equal(inputRecordingSourceId({metadata:{sourceRecordingId:'r'}}),'r');assert.throws(()=>inputRecordingSourceId({sourceRecordingId:'a',metadata:{sourceRecordingId:'b'}}),/不一致/);assert.throws(()=>assertInputProvenance(f.study.scenario,{...f.context,sourceHandId:'different-source'},{recording:f.recording}),/不能同时/);
});

test('immutable study snapshots preserve an earlier recording revision after further actions, while absent or conflicting snapshots never guess',()=>{
 const f=recordedFlop(),later=applyLiveRecorderAction(f.draft,{type:'check'}),recording={...f.recording,revision:5,draft:later,studySnapshots:[{revision:4,createdAt:'2026-09-28T00:00:00.000Z',draft:f.draft}]};
 const old=assertInputProvenance(f.study.scenario,f.context,{recording});assert.equal(old.sourceVerified,true);assert.equal(old.sourceRef.revision,4);assert.equal(old.inputContext.ledger.at(-1).type,'street');
 const study=buildLiveRecorderStudy(later),current={...study.inputContext,sourceRecordingId:recording.id,sourceRecordingRevision:5};assert.equal(assertInputProvenance(study.scenario,current,{recording}).inputContext.ledger.at(-1).type,'check');
 assert.throws(()=>assertInputProvenance(f.study.scenario,f.context,{recording:{...recording,studySnapshots:[]}}),e=>e.code==='recording_revision_missing');assert.throws(()=>assertInputProvenance(f.study.scenario,f.context,{recording:{...recording,studySnapshots:[...recording.studySnapshots,...recording.studySnapshots]}}),e=>e.code==='conflicting_recording_revision');
 assert.throws(()=>assertInputProvenance(f.study.scenario,f.context,{recording:{...recording,studySnapshots:[{revision:4,draft:later}]}}),e=>e.code==='local_recording_text_mismatch');
 const changed={...f.study.scenario,pot:8},fork=forkInputContext(f.context,{reason:'另建更大底池的假设，保留原手工记录版本。'}),assumed=assertInputProvenance(changed,fork,{recording});assert.equal(assumed.sourceVerified,false);assert.equal(assumed.sourceRef.revision,4);assert.throws(()=>assertObservedInputProvenance(changed,fork,{recording}),/不能声称精确/);
});

test('street-specific model limitations in legacy imported contexts do not erase a valid earlier street, but all ledger errors still block',()=>{
 const folded=stars.replace('SBPlayer: checks\nBBPlayer: checks\nHero: bets $1.50\nSBPlayer: calls $1.50\nBBPlayer: folds','SBPlayer: bets $1.50\nBBPlayer: calls $1.50\nHero: folds').replace('Hero: checks','BBPlayer: checks').replace('Hero: calls $3','BBPlayer: calls $3').replace('Hero: shows [Ac Kd]','BBPlayer: shows [Qc Qd]').replace('Hero collected','BBPlayer collected'),hand={...parseHandHistoryBatch(folded).hands[0],id:'folded-hand'},earlier=parseScenario(folded,{street:'flop'}),later=parseScenario(folded,{street:'turn'});
 assert.equal(hand.status,'parsed');assert.equal(hand.summary.streets.find(s=>s.street==='flop').canOpenStudy,true);assert.equal(hand.summary.streets.find(s=>s.street==='turn').canOpenStudy,false);
 const prior={...hand,status:'needs-review',parse:{...hand.parse,issues:[...hand.parse.issues,{severity:'error',code:'unsupported_dead_cards',street:'turn',message:'旧版本把后街死牌限制记成全手错误'}]}};
 const context={raw:folded,sourceHandId:hand.id,issues:prior.parse.issues};assert.equal(assertInputProvenance(earlier.scenario,context,{hand:prior}).sourceVerified,true);assert.throws(()=>assertInputProvenance(later.scenario,{...context,issues:[]},{hand:prior}),/死牌/);
 const broken={...prior,parse:{...prior.parse,issues:[...prior.parse.issues,{severity:'error',code:'ambiguous_call_amount',street:'turn',message:'真正资金错误'}]}};assert.throws(()=>assertInputProvenance(earlier.scenario,{...context,issues:[]},{hand:broken}),/真正资金错误/);
});
