import crypto from 'node:crypto';
import {cards} from './poker.mjs';
import {normalizeScenario,parseScenario} from './scenario.mjs';
import {parseHandHistoryBatch} from './hand-history-batch.mjs';
import {replayLiveRecorder} from './live-recorder.mjs';

// This verifies correspondence to a stored or reparsed record. It cannot verify
// that a person transcribed a live hand truthfully or that ranges are correct.
const canonical=text=>text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').trim();
const digest=text=>crypto.createHash('sha256').update(canonical(text)).digest('hex');
const copy=x=>structuredClone(x),finite=Number.isFinite;
const historyHeader=raw=>/(?:PokerStars Hand|Poker Hand|GGPoker Hand|GGNetwork Hand)\s*#/i.test(raw);
const unresolved=(issues,street,sourceStreet)=>(Array.isArray(issues)?issues:[]).filter(x=>(x?.severity==='error'||x?.code==='unparsed_text')&&!(street&&['unsupported_dead_cards','preexisting_sidepot'].includes(x?.code)&&(x.street??sourceStreet)&&(x.street??sourceStreet)!==street)).map(x=>x.severity==='error'?x:{...x,severity:'error'});
const fail=(code,message,issues=[])=>{const error=new Error(message+' 草稿仍可保存；请修正原文后重新核对，或明确另建假设模型。');error.code=code;error.issues=issues;throw error;};
function contextObject(context){if(context==null)return null;if(typeof context!=='object'||Array.isArray(context))fail('invalid_input_context','导入来源格式无效。');return context;}
/** The host must resolve this ID from local storage; never accept body.hand. */
export function inputHandSourceId(context){
 const c=contextObject(context);if(!c)return null;
 const ids=[c.sourceHandId,c.metadata?.sourceHandId,c.source?.kind==='hand'?c.source.id:null].filter(x=>x!=null&&x!=='');
 if(ids.some(x=>typeof x!=='string'||x.length>256)||new Set(ids).size>1)fail('conflicting_hand_source','导入来源的本地手牌编号不一致。');
 return ids[0]??null;
}
/** Resolve through the host's local recording store, never through body.recording. */
export function inputRecordingSourceId(context){
 const c=contextObject(context);if(!c)return null;
 const ids=[c.sourceRecordingId,c.metadata?.sourceRecordingId,c.source?.kind==='live-recording'?c.source.id:null].filter(x=>x!=null&&x!=='');
 if(ids.some(x=>typeof x!=='string'||x.length>256)||new Set(ids).size>1)fail('conflicting_recording_source','现场记录的本地来源编号不一致。');
 return ids[0]??null;
}
function forkReason(context){
 const p=context?.provenance;if(p==null)return null;
 if(p.kind!=='hypothetical-fork')fail('unknown_provenance_mode','不支持这个来源模式；checked 或 verified 不能替代原文核对。');
 if(typeof p.reason!=='string'||!p.reason.trim()||p.reason.trim().length>2000)fail('invalid_fork_reason','假设模型需要 1–2000 字的修改理由。');
 return p.reason.trim();
}
export function forkInputContext(context,{reason}={}){
 const c=copy(contextObject(context)??{});c.provenance={kind:'hypothetical-fork',reason};forkReason(c);
 if(!c.raw?.trim()&&!inputHandSourceId(c)&&!inputRecordingSourceId(c)&&!c.ledger?.length)fail('missing_fork_source','没有可保留的原始输入或行动来源。');
 return c;
}
const boardKey=board=>{const cs=cards(board);return [...cs.slice(0,3).sort((a,b)=>a-b),...cs.slice(3)].join(',');};
const heroKey=hand=>cards(hand||'').sort((a,b)=>a-b).join(',');
const sameNumber=(a,b)=>finite(a)&&finite(b)&&Math.abs(a-b)<=1e-7*Math.max(1,Math.abs(a),Math.abs(b));
function structuralDifferences(current,original){
 const diffs=[];
 if(boardKey(current.board)!==boardKey(original.board))diffs.push('公共牌');
 if(!sameNumber(current.pot,original.pot))diffs.push('街起点底池');
 if(current.players.length!==original.players.length)diffs.push('在池人数');
 const byId=new Map(original.players.map(p=>[p.id,p]));
 for(const p of current.players){const q=byId.get(p.id);if(!q){diffs.push('玩家身份');continue;}if(p.position!==q.position)diffs.push(p.id+'的位置');if(!sameNumber(p.stack,q.stack))diffs.push(p.id+'的街起点筹码');}
 const actor=s=>s.toAct==null?null:s.players[s.toAct]?.id,hero=s=>s.heroSeat==null?null:s.players[s.heroSeat]?.id;
 if(actor(current)!==actor(original))diffs.push('街起点行动者');
 if(hero(current)!==hero(original)||heroKey(current.hero)!==heroKey(original.hero))diffs.push('Hero/聚焦手牌');
 return [...new Set(diffs)];
}

/** Pure gate used before analyze, solve and evidence-based coaching.
 * `hand` is an optional trusted local inbox record supplied by the host.
 * Ranges and rake remain explicit modeling assumptions. All recorded public
 * structure and known Hero identity must match, unless a fork is declared. */
export function assertInputProvenance(scenario,context,{hand=null,recording=null}={}){
 const current=normalizeScenario(scenario,{requireRanges:false}),c=contextObject(context),sourceHandId=inputHandSourceId(c),sourceRecordingId=inputRecordingSourceId(c),reason=forkReason(c),street=({3:'flop',4:'turn',5:'river'})[cards(current.board).length];
 if(sourceHandId&&sourceRecordingId)fail('conflicting_input_sources','同一份输入不能同时声称来自线上原始牌谱和独立现场记录。');
 if(sourceHandId&&(!hand||hand.id!==sourceHandId))fail('local_hand_missing','找不到这个本地原始牌谱，不能认证客户端提供的手牌引用。');
 if(hand&&sourceHandId&&typeof hand.raw!=='string')fail('local_hand_raw_missing','本地手牌缺少原始文本。');
 if(c?.raw!=null&&typeof c.raw!=='string')fail('invalid_source_text','原始输入必须是文本。');
 if(sourceHandId&&c.raw?.trim()&&canonical(c.raw)!==canonical(hand.raw))fail('local_hand_text_mismatch','提交的原文与本地原始牌谱不一致。');
 let recorded=null;
 if(sourceRecordingId){
  if(!recording||recording.id!==sourceRecordingId)fail('local_recording_missing','找不到这个本地现场记录，不能认证客户端提供的引用。');
  const revision=c.sourceRecordingRevision;if(!Number.isInteger(revision)||revision<0)fail('invalid_recording_revision','现场记录需要明确的非负整数版本号。');
  const snapshots=(recording.studySnapshots??[]).filter(s=>s.revision===revision);
  if(snapshots.length>1)fail('conflicting_recording_revision','本地现场记录有重复研究版本，需先核对来源。');
  const draft=recording.revision===revision?recording.draft:snapshots[0]?.draft;
  if(!draft)fail('recording_revision_missing','本地现场记录没有这个研究版本；不能把后续修改冒充原始研究输入。');
  recorded=replayLiveRecorder(draft);
  if(c.raw?.trim()&&canonical(c.raw)!==canonical(recorded.inputContext.raw))fail('local_recording_text_mismatch','提交的原文与本地现场记录的指定版本不一致。');
 }
 const raw=sourceHandId?hand.raw:recorded?recorded.inputContext.raw:c?.raw??'',sourceRef=sourceHandId?{kind:'hand',id:sourceHandId,sourceKey:hand.sourceKey??null}:sourceRecordingId?{kind:'live-recording',id:sourceRecordingId,revision:c.sourceRecordingRevision}:raw.trim()?{kind:'input-text',digest:digest(raw)}:null;
 const hasImport=!!raw.trim()||!!sourceHandId||!!sourceRecordingId||!!c?.ledger?.length||!!c?.issues?.length;
 if(reason&&!raw.trim()&&!sourceHandId&&!sourceRecordingId&&!c?.ledger?.length)fail('missing_fork_source','没有可保留的原始输入或行动来源。');
 if(!hasImport&&!reason){const inputContext=c?copy(c):null;if(inputContext){delete inputContext.checked;delete inputContext.verified;}return {kind:'manual-model',sourceVerified:false,sourceRef:null,sourceDigest:null,matchedStreet:null,inputContext,assumptions:['手动建立的模型；没有原始牌谱核验声明。']};}
 if(!raw.trim()&&!reason)fail('source_text_missing','导入上下文缺少可重新核对的原文。');
 const isHistory=historyHeader(raw);
 let parsed=null,batchHand=null,batchIssues=[];
 if(raw.trim()){
  if(isHistory){
   const batch=parseHandHistoryBatch(raw,{maxHands:1});batchHand=batch.hands[0]??null;
   batchIssues=[...batch.rejected.map(x=>({severity:'error',code:x.code,message:x.reason})),...unresolved(batchHand?.parse?.issues,street)];
   if(batch.hands.length!==1||batch.stats.detected!==1)batchIssues.push({severity:'error',code:'not_one_hand',message:'真实牌局研究需要恰好一手支持的现金局原文。'});
  }
  const options={street};
  if(!isHistory){
   if(c?.sourceUnit!=null&&!['BB','currency'].includes(c.sourceUnit))fail('invalid_source_unit','原始金额单位必须明确为 BB 或实际金额。');
   if(c?.sourceBigBlind!=null&&(!finite(Number(c.sourceBigBlind))||Number(c.sourceBigBlind)<=0))fail('invalid_source_big_blind','原始大盲金额必须为正数。');
   if(c?.sourceUnit)options.unit=c.sourceUnit;
   if(c?.sourceBigBlind!=null)options.bigBlind=Number(c.sourceBigBlind);
  }
  parsed=parseScenario(raw,options);
 }
 const inputContext={...(c?copy(c):{}),raw,...(sourceHandId?{sourceHandId}:{}),...(sourceRecordingId?{sourceRecordingId,sourceRecordingRevision:c.sourceRecordingRevision,sourceUnit:recorded.draft.unit,sourceBigBlind:recorded.draft.bigBlind}:{}),...(parsed?{ledger:copy(parsed.ledger??[]),snapshots:copy(parsed.snapshots??[]),issues:copy(parsed.issues??[]),assumptions:copy(parsed.assumptions??[]),metadata:copy(parsed.metadata??{})}:{}),...(isHistory&&parsed?{sourceUnit:'currency',sourceBigBlind:parsed.metadata?.bigBlind}: {})};
 delete inputContext.checked;delete inputContext.verified;
 const claimedErrors=unresolved(c?.issues,street,c?.metadata?.selectedStreet),localErrors=sourceHandId?unresolved(hand.parse?.issues,street,hand.parse?.metadata?.selectedStreet):[],allLocalErrors=sourceHandId?unresolved(hand.parse?.issues):[];
 const errors=[...claimedErrors,...localErrors,...batchIssues,...unresolved(parsed?.issues)];
 if(reason){
  inputContext.provenance={kind:'hypothetical-fork',reason};
  return {kind:'hypothetical-fork',sourceVerified:false,sourceRef,sourceDigest:raw.trim()?digest(raw):null,matchedStreet:null,inputContext,sourceIssues:errors,assumptions:['这是用户明确修改的假设模型，保留原始引用，但不声称当前参数还原了真实牌局。','原记录的后续行动只作背景，不能以精确匹配方式套用在这份修改后的模型上。']};
 }
 const sourceStatusOK=!sourceHandId||hand.status==='parsed'||hand.status==='needs-review'&&allLocalErrors.length>0&&localErrors.length===0;
 if(errors.length||!sourceStatusOK)fail('unresolved_import_errors','原始牌局仍有未解决的识别或金额问题：'+(errors[0]?.message??'本地记录尚未通过核对。'),errors);
 if(!parsed?.scenario)fail('source_street_missing','原文没有当前所选街的完整研究起点。');
 const original=normalizeScenario(parsed.scenario,{requireRanges:false}),differences=structuralDifferences(current,original);
 if(differences.length)fail('source_structure_changed','当前参数与原文不一致：'+differences.join('、')+'。');
 // Explicitly replace client-supplied ledger/issues with the local reparse.
 return {kind:'reparsed-source',sourceVerified:true,sourceRef,sourceDigest:digest(raw),matchedStreet:street,inputContext,assumptions:[...(sourceRecordingId?['原文与本地手工行动记录的指定版本一致；这不是现实牌局真实性认证。']:[]),'仅核验当前公开局面、资金和 Hero 信息与原文一致，不证明原文准确记录了现实牌局。','各玩家范围与抽水模型仍为明确输入的研究假设；不会从事后摊牌替你补范围。']};
}

/** A hypothetical fork must never retain exact original-hand navigation. */
export function assertObservedInputProvenance(scenario,context,options){
 const result=assertInputProvenance(scenario,context,options);
 if(result.kind!=='reparsed-source')fail('not_original_hand_navigation','当前是手动或假设模型，不能声称精确回到原始牌局决策。');
 return result;
}
