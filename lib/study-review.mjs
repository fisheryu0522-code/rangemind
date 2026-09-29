/** Transparent scheduling of recall of a saved model answer. This is not an
 * assessment of poker mastery, transfer to unseen hands, or real-game profit. */
export const STUDY_REVIEW_VERSION=1;
export const DEFAULT_STUDY_REVIEW_POLICY=Object.freeze({minDelayedHours:24,highConfidence:80,highConfidenceErrorHours:6,errorHours:12,intervalDays:Object.freeze([1,3,7,14,30])});
const HOUR=3600000,DAY=24*HOUR;
const finite=x=>typeof x==='number'&&Number.isFinite(x);
const date=x=>x instanceof Date?x.getTime():typeof x==='number'?x:typeof x==='string'?Date.parse(x):NaN;
const iso=x=>Number.isFinite(x)?new Date(x).toISOString():null;
const accuracy=(correct,count)=>count?correct/count:null;

function normalizePolicy(raw={}){
 const p={...DEFAULT_STUDY_REVIEW_POLICY,...raw,intervalDays:[...(raw.intervalDays??DEFAULT_STUDY_REVIEW_POLICY.intervalDays)]};
 if(!finite(p.minDelayedHours)||p.minDelayedHours<24||p.minDelayedHours>168)throw Error('延迟复测最小间隔必须为 24–168 小时。');
 if(!finite(p.highConfidence)||p.highConfidence<0||p.highConfidence>100)throw Error('高信心阈值必须为 0–100。');
 if(![p.highConfidenceErrorHours,p.errorHours].every(x=>finite(x)&&x>0&&x<=24))throw Error('错误短期复核间隔必须大于零且不超过 24 小时。');
 if(!p.intervalDays.length||p.intervalDays.length>10||p.intervalDays.some((x,i)=>!finite(x)||x<p.minDelayedHours/24||x>180||(i&&x<p.intervalDays[i-1])))throw Error('复习间隔阶梯应单调递增，且位于延迟复测下限至 180 天之间。');
 return p;
}

function qualityFor(card){
 const question=card.full??card.publicQuestion??card,q=question.quality??card.quality??{},source=question.source??card.source??{};
 const mode=['exact','sampled'].includes(q.mode)?q.mode:'unknown';
 const measured=finite(q.residual)&&finite(q.target)?q.residual>=0&&q.target>=0&&q.residual<=q.target:null;
 const targetReached=q.targetReached===true&&measured===true;
 const eligibleForRetentionEvidence=mode==='exact'&&source.chance?.exact!==false&&targetReached&&q.provisional!==true;
 return {mode,targetReached,provisional:!eligibleForRetentionEvidence,residual:finite(q.residual)?q.residual:null,target:finite(q.target)?q.target:null,eligibleForRetentionEvidence,countsTowardMastery:false,note:eligibleForRetentionEvidence?'参考为已达自身残差目标的精确发牌模型；这里只统计对该模型答案的延迟提取，不证明迁移能力或实战掌握。':'参考仍有抽样、残差或来源不确定性；保留学习记录与复核安排，不计入可信参考的延迟提取指标。'};
}
function validCard(card){
 if(!card||typeof card.id!=='string'||!card.id.trim())return false;
 const q=card.full??card.publicQuestion??card;
 return q.kind==='study-action'&&Array.isArray(q.choices)&&q.choices.length>0&&q.choices.every(x=>x&&typeof x.id==='string'&&x.id.trim())&&new Set(q.choices.map(x=>x.id)).size===q.choices.length;
}
const statsFor=items=>{
 const correct=items.filter(x=>x.correct).length,eligible=items.filter(x=>x.eligible),eligibleCorrect=eligible.filter(x=>x.correct).length;
 return {count:items.length,correct,accuracy:accuracy(correct,items.length),eligibleCount:eligible.length,eligibleCorrect,eligibleAccuracy:accuracy(eligibleCorrect,eligible.length)};
};

/** Cards can be saved full entries or publicQuestion wrappers. createdAt is
 * the authoritative attempt time. Reordering input files cannot change the
 * result; timestamps in the future and records without a valid card are ignored.
 */
export function buildStudyReview(cards=[],attempts=[],{now=Date.now(),policy:policyInput={}}={}){
 if(!Array.isArray(cards)||!Array.isArray(attempts))throw TypeError('题卡与作答记录必须是数组。');
 const timestamp=date(now);if(!Number.isFinite(timestamp))throw Error('当前复习时间无效。');
 const policy=normalizePolicy(policyInput),ignored={invalidCards:[],duplicateCards:[],orphanAttempts:[],invalidAttempts:[],duplicateAttempts:[],futureAttempts:[]},byId=new Map(),groups=new Map(),seenAttemptIds=new Set();
 for(const [index,card] of cards.entries()){
  if(!validCard(card)){ignored.invalidCards.push({index,id:card?.id??null,reason:'题卡缺少有效编号、题型或动作选项。'});continue;}
  if(byId.has(card.id)){ignored.duplicateCards.push({index,id:card.id});continue;}
  byId.set(card.id,card);groups.set(card.id,[]);
 }
 for(const [index,a] of attempts.entries()){
  if(!a||typeof a.cardId!=='string'||!byId.has(a.cardId)){ignored.orphanAttempts.push({index,id:a?.id??null,cardId:a?.cardId??null});continue;}
  const card=byId.get(a.cardId),q=card.full??card.publicQuestion??card,t=date(a.createdAt),created=date(card.createdAt);
  let reason=null;
  if(!Number.isFinite(t))reason='作答时间无效。';
  else if(typeof a.correct!=='boolean'||typeof a.answer!=='string'||!q.choices.some(c=>c.id===a.answer))reason='缺少有效评分，或答案不属于这道题。';
  else if(a.confidence!=null&&(!finite(a.confidence)||a.confidence<0||a.confidence>100))reason='信心数值无效。';
  else if(Number.isFinite(created)&&t<created)reason='作答时间早于题卡创建时间。';
  else if(finite(q.referenceEV)&&finite(q.actionEV?.[a.answer])&&finite(q.evTolerance)&&a.correct!==(Math.max(0,q.referenceEV-q.actionEV[a.answer])<=q.evTolerance))reason='已保存评分与该题参考行动 EV 不一致。';
  if(reason){ignored.invalidAttempts.push({index,id:a.id??null,cardId:a.cardId,reason});continue;}
  if(t>timestamp){ignored.futureAttempts.push({index,id:a.id??null,cardId:a.cardId});continue;}
  if(typeof a.id==='string'&&a.id){if(seenAttemptIds.has(a.id)){ignored.duplicateAttempts.push({index,id:a.id,cardId:a.cardId});continue;}seenAttemptIds.add(a.id);}
  groups.get(a.cardId).push({...a,time:t,sourceIndex:index});
 }
 const byCard=[],firstItems=[],delayedItems=[];let totalAttempts=0,highConfidenceErrors=0,totalShortGap=0;
 for(const [id,card] of byId){
  const quality=qualityFor(card),question=card.publicQuestion??card.full??card,rows=groups.get(id).sort((a,b)=>a.time-b.time||String(a.id??'').localeCompare(String(b.id??''))||a.sourceIndex-b.sourceIndex);
  let previous=null,nextDue=null,interval=0,pendingError=false,errorDue=null,lastError=null,priority='normal',streak=0,delayedRetests=0,delayedCorrect=0,eligibleDelayedRetests=0,eligibleDelayedCorrect=0,shortGapAttempts=0,confidenceErrors=0;
  for(const a of rows){
   const isDelayed=previous!==null&&a.time-previous.time>=policy.minDelayedHours*HOUR,attemptQuality=a.quality?qualityFor({quality:a.quality,source:a.source}):quality,eligible=quality.eligibleForRetentionEvidence&&attemptQuality.eligibleForRetentionEvidence;
   if(!previous)firstItems.push({correct:a.correct,eligible});
   else if(isDelayed){delayedRetests++;delayedCorrect+=Number(a.correct);eligibleDelayedRetests+=Number(eligible);eligibleDelayedCorrect+=Number(eligible&&a.correct);delayedItems.push({correct:a.correct,eligible});}
   else shortGapAttempts++;
   if(!a.correct){
    const high=finite(a.confidence)&&a.confidence>=policy.highConfidence;confidenceErrors+=Number(high);interval=(high?policy.highConfidenceErrorHours:policy.errorHours)/24;nextDue=a.time+interval*DAY;errorDue=nextDue;lastError=a.time;pendingError=true;priority=high?'high':'normal';streak=0;
   }else if(pendingError&&a.time<errorDue){
    // Immediate memorization of the disclosed answer cannot erase an earlier
    // error's scheduled short-term check or increase its review interval.
   }else if(isDelayed&&eligible&&(nextDue===null||a.time>=nextDue)){
    pendingError=false;priority='normal';streak++;interval=policy.intervalDays[Math.min(streak,policy.intervalDays.length-1)];nextDue=a.time+interval*DAY;
   }else{
    const wasError=pendingError;pendingError=false;priority='normal';
    if(!previous||wasError||!quality.eligibleForRetentionEvidence){interval=policy.intervalDays[0];nextDue=a.time+interval*DAY;}
    else nextDue=Math.max(nextDue??0,a.time+policy.minDelayedHours*HOUR);
   }
   previous=a;
  }
  const fresh=!rows.length,stage=fresh?'new':pendingError?'relearning':!quality.eligibleForRetentionEvidence?'provisional-review':streak?'delayed-review':'learning';
  const row={id,title:question.title??card.title??'我的研究题',attempts:rows.length,firstAttemptAt:iso(rows[0]?.time),firstAttemptCorrect:rows.length?rows[0].correct:null,firstAttemptEligible:rows.length?firstItems.at(-1).eligible:false,lastAttemptAt:iso(previous?.time),lastAttemptCorrect:previous?.correct??null,nextDueAt:iso(nextDue),due:!fresh&&nextDue<=timestamp,stage,newCard:fresh,intervalDays:interval,priority,delayedRetests,delayedCorrect,eligibleDelayedRetests,eligibleDelayedCorrect,shortGapAttempts,highConfidenceErrors:confidenceErrors,delayedCorrectStreak:streak,lastErrorAt:iso(lastError),quality,countsTowardMastery:false};
  byCard.push(row);totalAttempts+=rows.length;highConfidenceErrors+=confidenceErrors;totalShortGap+=shortGapAttempts;
 }
 byCard.sort((a,b)=>a.id.localeCompare(b.id));
 const due=byCard.filter(c=>c.due).sort((a,b)=>(a.priority==='high'?-1:0)-(b.priority==='high'?-1:0)||Date.parse(a.nextDueAt)-Date.parse(b.nextDueAt)||a.id.localeCompare(b.id));
 const newCards=byCard.filter(c=>c.newCard);
 return {version:STUDY_REVIEW_VERSION,asOf:iso(timestamp),byCard,due,newCards,summary:{totalCards:byCard.length,seenCards:byCard.length-newCards.length,newCards:newCards.length,dueCards:due.length,totalAttempts,shortGapAttempts:totalShortGap,highConfidenceErrors,firstExposure:statsFor(firstItems),delayedRetrieval:statsFor(delayedItems),provisionalCards:byCard.filter(c=>c.quality.provisional).length,countsTowardMastery:false},ignored,policy:{...policy,rule:'transparent-model-answer-review-v1',description:'错误先短期复核；至少间隔指定小时才统计延迟提取；同题短间隔重刷不增长复习阶梯。间隔是可调整启发规则，不是已证明最优的教学安排。'},interpretation:'首见表现、短间隔练习与延迟复测分别统计；新卡不参与已学正确率。抽样、未达残差目标或来源不明的参考不进入可信参考指标。即使多次延迟答对，也只说明对这道模型题的提取表现，不宣称扑克技能掌握或新增实战胜率。'};
}
