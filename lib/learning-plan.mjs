import crypto from 'node:crypto';
import {getLesson,listLessons,gradeAttempt,buildTrainingSummary} from './curriculum.mjs';
import {gradeStudyQuestion} from './coach.mjs';
import {buildStudyReview} from './study-review.mjs';
import {cards} from './poker.mjs';

export const LEARNING_PLAN_VERSION=1;
export const STUDY_SOURCE_KINDS=Object.freeze(['manual','hand','case','job','lesson','study-card','course-attempt','study-attempt','range-attempt','play-session','play-decision','experiment']);
export const STUDY_RETEST_KINDS=Object.freeze(['course-attempt','study-attempt','range-attempt','play-session','play-decision']);
export const STUDY_PROJECT_EVENT_KINDS=Object.freeze(['prediction','evidence','conclusion','field-plan','field-observation','retest','edit','close']);
const DAY=86400000,finite=x=>typeof x==='number'&&Number.isFinite(x),copy=x=>structuredClone(x);
const date=x=>x instanceof Date?x.getTime():typeof x==='number'?x:typeof x==='string'?Date.parse(x):NaN;
const iso=x=>new Date(x).toISOString();
function clock(now){const value=date(now??Date.now());if(!finite(value))throw Error('研究记录时间无效。');return value;}
function text(value,label,{max=5000,optional=false}={}){if(value==null&&optional)return '';if(typeof value!=='string'||!value.trim()){if(optional&&value==='')return '';throw Error(`${label}不能为空。`);}const result=value.trim();if(result.length>max)throw Error(`${label}超过 ${max} 字符。`);return result;}
function strings(value,label){if(value==null)return [];if(!Array.isArray(value)||value.length>30)throw Error(`${label}应为不超过 30 项的列表。`);return value.map(x=>text(x,label,{max:2000}));}
const fingerprint=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function source(raw={kind:'manual'}){
 if(!raw||!STUDY_SOURCE_KINDS.includes(raw.kind))throw Error('研究来源类型无效。');
 const out={kind:raw.kind};if(raw.kind!=='manual'||raw.id!=null)out.id=text(raw.id,'来源编号',{max:256});
 for(const key of ['handId','caseId','jobId','nodeId','sessionId','scenarioKey','title'])if(raw[key]!=null)out[key]=text(raw[key],`来源 ${key}`,{max:key==='title'?500:256});
 if(raw.kind==='play-decision'&&!out.sessionId)throw Error('多街决策来源需要 sessionId。');
 if(raw.path!=null){if(!Array.isArray(raw.path)||raw.path.length>200||raw.path.some(x=>typeof x!=='string'||x.length>128))throw Error('来源行动路径无效。');out.path=[...raw.path];}
 if(raw.answerSeen!=null){if(typeof raw.answerSeen!=='boolean')throw Error('答案暴露记录必须为布尔值。');out.answerSeen=raw.answerSeen;}
 return out;
}
function assumptions(raw={}){return {facts:strings(raw.facts,'局面记录'),hypotheses:strings(raw.hypotheses,'范围与对手假设'),factsMeaning:'这里保留用户记录的局面条件；本模块不把自由文本转换为已经核验的事实。'};}
function assertProject(project){
 if(!project||project.version!==LEARNING_PLAN_VERSION||typeof project.id!=='string'||!Array.isArray(project.events))throw Error('研究任务格式无效或版本不受支持。');
 if(fingerprint(project.source)!==project.sourceFingerprint)throw Error('原始研究来源已改变；请保留旧任务并创建新的来源分支。');
 if(!finite(date(project.createdAt)))throw Error('研究创建时间无效。');
}
export function createStudyProject(draft,{id,now=Date.now()}={}){
 const timestamp=clock(now),question=text(draft?.question,'研究问题'),origin=source(draft.source??{kind:'manual'});
 return {version:LEARNING_PLAN_VERSION,id:text(id,'研究编号',{max:256}),question,title:text(draft.title??question.slice(0,60),'研究标题',{max:200}),source:origin,sourceFingerprint:fingerprint(origin),assumptions:assumptions(draft.assumptions),status:'active',createdAt:iso(timestamp),updatedAt:iso(timestamp),events:[],interpretation:'预测、证据判断和结论保留各自来源。自由文本结论不是程序证明；完成研究不代表实战掌握。'};
}
export function applyStudyProjectEvent(project,event,{eventId,now=Date.now(),resolvedRetest}={}){
 assertProject(project);if(project.status==='closed')throw Error('此研究已关闭；如需继续，请创建关联的新任务。');
 const timestamp=clock(now),last=project.events.at(-1);if(timestamp<date(project.createdAt)||(last&&timestamp<date(last.createdAt)))throw Error('新事件不能早于已有研究记录。');
 const id=text(eventId,'事件编号',{max:256});if(project.events.some(e=>e.id===id))throw Error('这个研究事件已保存，不能重复计入。');
 if(!event||!STUDY_PROJECT_EVENT_KINDS.includes(event.kind))throw Error('研究事件类型无效。');
 const out=copy(project),row={id,kind:event.kind,createdAt:iso(timestamp)},prior=kind=>out.events.filter(e=>e.kind===kind).at(-1);
 switch(event.kind){
  case 'prediction': {
   row.statement=text(event.statement,'事前预测');if(!finite(event.confidence)||event.confidence<0||event.confidence>100)throw Error('预测信心必须在 0–100 之间。');row.confidence=event.confidence;
   row.variable=text(event.variable,'改变条件',{optional:true,max:2000});if(event.expectedDirection!=null&&!['increase','decrease','same','switch','unknown'].includes(event.expectedDirection))throw Error('预测方向无效。');row.expectedDirection=event.expectedDirection??'unknown';
   if(event.reportedExposure!=null&&!['unseen','seen','unknown'].includes(event.reportedExposure))throw Error('先前暴露记录无效。');row.reportedExposure=event.reportedExposure??'unknown';
   row.recordedBeforeProjectEvidence=!prior('evidence');row.blindStatus=project.source.answerSeen===true||!row.recordedBeforeProjectEvidence||row.reportedExposure==='seen'?'after-known-evidence':row.reportedExposure==='unseen'?'self-reported-unseen':'unknown';
   row.exposureNote='仅记录本任务内的时间顺序与用户声明；不证明此前在其他页面或平台从未见过答案。';break;
  }
  case 'evidence':
   if(!prior('prediction'))throw Error('请先记录预测，再加入研究证据；已经看过的证据可在预测中如实标注。');
   row.source=source(event.source);if(row.source.kind==='manual')throw Error('研究证据需要链接一条已有局面、课程或实际记录。');row.summary=text(event.summary,'证据观察');if(!['supports','contradicts','inconclusive'].includes(event.userAssessment))throw Error('请选择支持、反驳或暂不能判断。');row.userAssessment=event.userAssessment;row.assessmentBy='user';row.predictionId=prior('prediction').id;row.verification='linked-source-not-free-text-proof';break;
  case 'conclusion':
   if(!prior('evidence'))throw Error('请先附上证据或反例，再整理条件化结论。');
   row.conditionalRule=text(event.conditionalRule,'条件化结论');row.appliesWhen=text(event.appliesWhen,'适用条件');row.exceptions=text(event.exceptions,'失效条件或反例');row.remainingUncertainty=text(event.remainingUncertainty,'尚不确定之处',{optional:true});row.evidenceId=prior('evidence').id;row.proven=false;break;
  case 'field-plan': {
   if(!prior('conclusion'))throw Error('请先整理结论，再确定实战检查项。');row.cue=text(event.cue,'触发场景');row.check=text(event.check,'具体检查动作');row.withdrawIf=text(event.withdrawIf,'撤回或调整条件',{optional:true});const days=event.reviewAfterDays??1;if(!finite(days)||days<1||days>30)throw Error('实战观察回访应在 1–30 天之间。');row.reviewAfterDays=days;row.dueAt=iso(timestamp+days*DAY);row.conclusionId=prior('conclusion').id;break;
  }
  case 'field-observation':
   if(!prior('field-plan'))throw Error('请先写下实战检查项。');if(typeof event.encountered!=='boolean')throw Error('请记录是否遇到目标场景。');row.encountered=event.encountered;
   if(!event.encountered&&event.executed===true)throw Error('没有遇到场景时不能记为已执行。');if(event.encountered&&typeof event.executed!=='boolean')throw Error('遇到场景后请记录是否执行检查。');row.executed=event.encountered?event.executed:null;
   row.note=text(event.note??(!event.encountered?'尚未遇到目标场景。':''),'观察记录');if(event.source)row.source=source(event.source);row.fieldPlanId=prior('field-plan').id;row.evidenceType='self-reported-execution';row.profitOutcomeScored=false;break;
  case 'retest': {
   if(!prior('conclusion'))throw Error('请先形成可复测的条件化结论。');row.source=source(event.source);if(!STUDY_RETEST_KINDS.includes(row.source.kind))throw Error('复测必须链接一条真实作答记录，不能只链接题目或自报得分。');row.note=text(event.note,'复测备注',{optional:true});row.grading='use-linked-attempt';row.conclusionId=prior('conclusion').id;row.verification='unverified-timing';
   // The persistence layer resolves this from the actual saved attempt. Never
   // populate this option from a client's self-reported outcome or timestamp.
   if(resolvedRetest!=null){
    if(resolvedRetest.sourceKind!==row.source.kind||resolvedRetest.sourceId!==row.source.id||row.source.kind==='play-decision'&&resolvedRetest.sessionId!==row.source.sessionId)throw Error('复测核验的来源与链接不一致。');
    const attemptedAt=date(resolvedRetest.createdAt);if(!finite(attemptedAt)||attemptedAt>timestamp)throw Error('复测的实际作答时间无效。');if(attemptedAt<date(prior('conclusion').createdAt))throw Error('结论前的旧作答不能充当后续复测。');
    row.attemptedAt=iso(attemptedAt);row.timeResolution=resolvedRetest.timeResolution==='session'?'session':'attempt';row.verification='linked-attempt-after-conclusion';
   }
   break;
  }
  case 'edit':
   if(event.source!==undefined)throw Error('原始来源不能被改写。');if(event.question!=null){row.question=text(event.question,'研究问题');out.question=row.question;}if(event.title!=null){row.title=text(event.title,'研究标题',{max:200});out.title=row.title;}if(event.assumptions!=null){row.assumptions=assumptions(event.assumptions);out.assumptions=copy(row.assumptions);}if(!row.question&&!row.title&&!row.assumptions)throw Error('没有需要更新的研究文字。');break;
  case 'close':row.note=text(event.note,'关闭备注',{optional:true});out.status='closed';break;
 }
 out.events.push(row);out.updatedAt=iso(timestamp);return out;
}
export function summarizeStudyProject(project,{now=Date.now()}={}){
 assertProject(project);const timestamp=clock(now),latest=kind=>project.events.filter(e=>e.kind===kind).at(-1)||null;
 const prediction=latest('prediction'),evidence=latest('evidence'),conclusion=latest('conclusion'),fieldPlan=latest('field-plan'),fieldObservation=latest('field-observation'),retest=latest('retest');
 let phase,nextAction;const step=(id,title,description,dueAt=null)=>({id,title,description,dueAt});
 if(project.status==='closed'){phase='closed';nextAction=null;}
 else if(!prediction){phase='prediction';nextAction=step('predict','先写一个可被推翻的预测','指出只改变哪个条件、预期什么方向及信心。已见过的答案如实标记。');}
 else if(!evidence||evidence.predictionId!==prediction.id){phase='evidence';nextAction=step('test','用一次对照检验预测','附一个实际求解、练习或牌局来源；记录支持、反驳还是暂不能判断。');}
 else if(!conclusion||conclusion.evidenceId!==evidence.id){phase='conclusion';nextAction=step('conclude','写出适用条件与失效条件','区分观察到的数值和仍需验证的解释，不把当前模型答案变成普遍规则。');}
 else if(!fieldPlan||fieldPlan.conclusionId!==conclusion.id){phase='field-plan';nextAction=step('field-plan','留下一条实战检查项','写明遇到什么场景时检查什么，以及什么新信息会让你撤回这条规则。');}
 else if(!fieldObservation||fieldObservation.fieldPlanId!==fieldPlan.id||!fieldObservation.encountered){phase='field-observation';const due=fieldObservation?.fieldPlanId===fieldPlan.id?iso(date(fieldObservation.createdAt)+fieldPlan.reviewAfterDays*DAY):fieldPlan.dueAt;nextAction=step('field-observation','回访一次真实执行','没遇到目标场景也可以如实记录，不会计成执行失败；结果赢钱或输钱不决定执行评分。',due);}
 else if(!retest||retest.conclusionId!==conclusion.id||retest.verification!=='linked-attempt-after-conclusion'){phase='retest';nextAction=step('retest','链接一次后续复测','优先未见局面；核对真实作答在本次结论之后，同题重刷与延迟复测分别统计。');}
 else {phase='complete';nextAction=step('extend','寻找一个新边界或结束研究','此任务已留下预测、证据、实战观察和复测链接；它不证明实战胜率提高。');}
 return {id:project.id,title:project.title,question:project.question,source:copy(project.source),status:project.status,phase,createdAt:project.createdAt,updatedAt:project.updatedAt,eventCount:project.events.length,nextAction,actionDue:!!nextAction?.dueAt&&date(nextAction.dueAt)<=timestamp,latestPrediction:copy(prediction),latestEvidence:copy(evidence),latestConclusion:copy(conclusion),latestFieldPlan:copy(fieldPlan),latestFieldObservation:copy(fieldObservation),latestRetest:copy(retest),execution:fieldObservation?{encountered:fieldObservation.encountered,executed:fieldObservation.executed,kind:'self-report',profitOutcomeScored:false}:null,countsTowardMastery:false};
}

// Recommendation adapters and ranking below use stored attempts only. They do
// not infer opponent population tendencies or diagnose mental state from loss.
export function referenceEvidenceQuality(quality={},origin={}){
 quality=quality??{};origin=origin??{};
 const exact=quality.mode==='exact'&&origin.chance?.exact!==false,measured=finite(quality.residual)&&finite(quality.target)&&quality.residual>=0&&quality.target>=0&&quality.residual<=quality.target;
 const eligible=exact&&measured&&quality.targetReached===true&&quality.provisional!==true;
 return {kind:eligible?'exact-model-reference':'provisional',eligible,mode:quality.mode??'unknown',residual:finite(quality.residual)?quality.residual:null,target:finite(quality.target)?quality.target:null,note:eligible?'参考达到了自身树内残差目标；动作反馈仍限于该模型，残差不是逐组合误差界。':'抽样、未达目标或缺少数值质量信息的参考，不用于确定技能缺陷。'};
}
function inputRows(value,label){if(value==null)return [];if(!Array.isArray(value))throw Error(`${label}必须为数组。`);return value;}
const chronological=(rows,timeOf=r=>r.createdAt)=>rows.slice().sort((a,b)=>(date(timeOf(a??{}))||0)-(date(timeOf(b??{}))||0)||String(a?.id||'').localeCompare(String(b?.id||'')));
const confidenceOf=value=>finite(value)&&value>=0&&value<=100?value:null;
const nonemptyPlan=plan=>!!plan&&['valueTargets','bluffTargets','changeTriggers'].some(k=>typeof plan[k]==='string'?!!plan[k].trim():Array.isArray(plan[k])&&plan[k].length>0);
function decisionPlanEvidence(session,decision,decisionAt){
 // A later revised session.plan must never backdate a plan to an earlier answer.
 // Snapshot text establishes what was saved with this decision, not what the
 // player privately thought or whether it existed before viewing this board.
 if(Object.hasOwn(decision,'planAtDecision'))return {hasRecordedPlan:nonemptyPlan(decision.planAtDecision),planRecordSource:'decision-snapshot'};
 const history=decision.answeredAt||decision.createdAt?chronological((Array.isArray(session.planHistory)?session.planHistory:[]).filter(p=>finite(date(p?.createdAt))&&date(p.createdAt)<=date(decisionAt))):[];
 if(history.length)return {hasRecordedPlan:nonemptyPlan(history.at(-1).plan),planRecordSource:'timestamped-plan-history'};
 return {hasRecordedPlan:false,planRecordSource:nonemptyPlan(session.plan)?'unverified-session-plan':'not-recorded'};
}
export function collectLearningEvidence(data={}, {now=Date.now()}={}){
 const timestamp=clock(now),records=[],ignored=[],seen=new Set();
 const reject=(kind,raw,reason)=>ignored.push({kind,id:raw?.id??null,reason});
 const accept=(kind,raw,at)=>{if(!raw||typeof raw.id!=='string'||!raw.id.trim()){reject(kind,raw,'缺少真实记录编号。');return false;}if(!finite(date(at))||date(at)>timestamp){reject(kind,raw,'记录时间无效或在未来。');return false;}const key=kind+':'+raw.id;if(seen.has(key)){reject(kind,raw,'重复记录编号。');return false;}seen.add(key);return true;};
 for(const a of chronological(inputRows(data.courseAttempts,'课程记录'),a=>a.createdAt||a.review?.lastReviewedAt)){
  const at=a?.createdAt||a?.review?.lastReviewedAt;if(!accept('course-attempt',a,at))continue;
  const submittedConfidence=confidenceOf(a.confidence);if(a.confidence!=null&&submittedConfidence===null){reject('course-attempt',a,'作答信心无效。');continue;}
  let lesson,graded;try{lesson=getLesson(a.lessonId,{reveal:true});graded=gradeAttempt({...a,confidence:submittedConfidence??50},{},at);}catch(e){reject('course-attempt',a,'无法按原题核验：'+e.message);continue;}
  if(typeof a.correct!=='boolean'||a.correct!==graded.correct){reject('course-attempt',a,'保存的评分与该题可复算答案不一致。');continue;}
  records.push({id:a.id,inputFingerprint:fingerprint(a),kind:'course-attempt',createdAt:iso(date(at)),taskKey:'lesson:'+lesson.id,skill:lesson.skill,topic:lesson.theme,target:{kind:'lesson',id:lesson.id,assessment:true},referenceQuality:{kind:'specified-concept-model',eligible:true,note:'只评价题目明确给定的可复算模型。'},correct:graded.correct,confidence:submittedConfidence,lossBB:graded.loss,reasoningScore:graded.reasoningScore,reasonMismatches:graded.reasonFeedback,selectedReasonIds:graded.reasonIds,missingReasonIds:(graded.correctReasons??[]).filter(x=>!graded.reasonIds.includes(x)),trainingRole:lesson.trainingRole??'learning',answerExposure:a.reportedExposure??a.answerExposure??'unknown',sourceRef:{kind:'course-attempt',id:a.id},lessonId:lesson.id});
 }
 const cardsById=new Map(inputRows(data.studyCards,'个人题卡').filter(c=>c&&typeof c.id==='string').map(c=>[c.id,c]));
 for(const a of chronological(inputRows(data.studyAttempts,'个人题卡作答'))){
  if(!accept('study-attempt',a,a?.createdAt))continue;const card=cardsById.get(a.cardId);if(!card){reject('study-attempt',a,'找不到原题卡。');continue;}
  if(finite(date(card.createdAt))&&date(a.createdAt)<date(card.createdAt)){reject('study-attempt',a,'作答早于题卡创建。');continue;}
  const q=card.full??card.publicQuestion??card;let graded;try{if(q.kind!=='study-action')throw Error('题型无效');graded=gradeStudyQuestion(q,a);}catch(e){reject('study-attempt',a,'无法核验题卡反馈：'+e.message);continue;}
  if(a.correct!==graded.correct){reject('study-attempt',a,'保存评分与原题行动 EV 不一致。');continue;}
  const quality=referenceEvidenceQuality(q.quality,q.source),historical=a.quality?referenceEvidenceQuality(a.quality,a.source):quality;if(!historical.eligible){quality.eligible=false;quality.kind='provisional';quality.note=historical.note;}
  const taskKey=q.source?.solveId?'card:'+q.source.solveId+':'+(q.source.nodeId||'')+':'+(q.combo||card.id):'card-id:'+card.id;
  records.push({id:a.id,inputFingerprint:fingerprint(a),kind:'study-attempt',createdAt:iso(date(a.createdAt)),taskKey,skill:'personal-action',topic:'个人局面判断',target:{kind:'study-card',id:card.id},referenceQuality:quality,correct:graded.correct,confidence:graded.confidence,lossBB:graded.loss,reasoningScore:null,reasonMismatches:[],answerExposure:a.reportedExposure??a.answerExposure??'unknown',sourceRef:{kind:'study-attempt',id:a.id},cardId:card.id});
 }
 for(const a of chronological(inputRows(data.rangeAttempts,'范围练习记录'))){
  if(!accept('range-attempt',a,a?.createdAt))continue;const g=a.feedback??a.grade??a,m=g.metrics,quality=referenceEvidenceQuality(g.quality,g.source);
  if(!m||!finite(m.localRegretBB)||m.localRegretBB< -1e-8||!g.sourceFingerprint){reject('range-attempt',a,'缺少范围收益指标或原始局面指纹。');continue;}
  if((g.weighting??a.weighting)==='counterfactual'||g.counterfactual===true){quality.eligible=false;quality.kind='provisional';quality.note='此范围是反事实到达权重，不当作原局面的实际范围证据。';}
  if(a.integrity?.referenceVerified===false){quality.eligible=false;quality.kind='provisional';quality.note='此历史记录尚缺源策略树或完整性核验，保留为研究记录，不用于确定技能缺陷。';}
  const independent=g.independentEvaluation??a.independentEvaluation??null;
  records.push({id:a.id,kind:'range-attempt',createdAt:iso(date(a.createdAt)),taskKey:'range:'+g.sourceFingerprint,skill:'range-construction',topic:'整段范围分工',target:{kind:'range-attempt',id:a.id,jobId:a.jobId??g.source?.solveId??null,nodeId:g.source?.nodeId??null},referenceQuality:quality,correct:null,confidence:confidenceOf(a.confidence??a.submission?.confidence),lossBB:null,reasoningScore:null,reasonMismatches:[],localRegretBB:Math.max(0,m.localRegretBB),metrics:copy(m),independentEvaluation:independent?copy(independent):null,sourceFingerprint:g.sourceFingerprint,answerExposure:a.reportedExposure??'unknown',sourceRef:{kind:'range-attempt',id:a.id},researchBrief:rangeResearchBrief(a,g,quality)});
 }
 for(const session of chronological(inputRows(data.playSessions,'连续练习记录'),s=>s.updatedAt||s.createdAt)){
  const at=session?.updatedAt||session?.createdAt;if(!accept('play-session',session,at))continue;if(!['complete','abandoned'].includes(session.status)){reject('play-session',session,'进行中的练习暂不提供课后诊断。');continue;}
  if(!Array.isArray(session.decisions)){reject('play-session',session,'缺少实际决策列表。');continue;}
  for(const d of session.decisions){
   const decisionAt=d?.answeredAt||d?.createdAt||at;if(!accept('play-decision',d,decisionAt))continue;const f=d.feedback,accepted=f?.acceptedActions;
   if(!f||!finite(f.loss)||f.loss<0||!finite(f.selectedEV)||!finite(f.bestEV)||!Array.isArray(accepted)||typeof d.actionId!=='string'){reject('play-decision',d,'缺少完整的已提交决策反馈。');continue;}
   if(Math.abs(f.loss-Math.max(0,f.bestEV-f.selectedEV))>1e-7){reject('play-decision',d,'单节点机会损失与行动 EV 不一致。');continue;}
   const quality=referenceEvidenceQuality(f.quality??session.source?.quality,session.source),correct=accepted.some(x=>(typeof x==='string'?x:x?.id)===d.actionId);
   records.push({id:d.id,kind:'play-decision',createdAt:iso(date(decisionAt)),timeResolution:d.answeredAt||d.createdAt?'decision':'session',taskKey:'play:'+(session.source?.jobId||session.id)+':'+JSON.stringify(d.path??d.nodeId)+':'+d.heroCombo,skill:'multi-street-plan',topic:'连续决策与后续计划',target:{kind:'play-session',id:session.id,nodeId:d.nodeId},referenceQuality:quality,correct,confidence:confidenceOf(d.confidence),lossBB:f.loss,reasoningScore:null,reasonMismatches:[],late:d.late===true,answerExposure:d.reportedExposure??(d.path?.length===(session.source?.startingPath??[]).length?session.reportedExposure??session.source?.reportedExposure:'unknown')??'unknown',...decisionPlanEvidence(session,d,decisionAt),sourceRef:{kind:'play-decision',id:d.id,sessionId:session.id},sessionId:session.id,lossMeaning:'单节点固定参考后续策略下的条件机会差，不能跨街相加当整局 EV 损失。'});
  }
 }
 records.sort((a,b)=>date(a.createdAt)-date(b.createdAt)||a.kind.localeCompare(b.kind)||a.id.localeCompare(b.id));const latest=new Map();
 for(const r of records){const prior=latest.get(r.taskKey);r.evidenceRole=r.answerExposure==='seen'?'exposed-practice':!prior?'first-exposure':date(r.createdAt)-date(prior.createdAt)>=DAY?'delayed-retrieval':'short-gap-practice';latest.set(r.taskKey,r);}
 return {records,ignored,asOf:iso(timestamp),meaning:'首见指本机该题身份的首次有效记录，不保证此前在其他地方未见过；延迟提取至少间隔同题前次有效记录 24 小时。'};
}
const decimal=x=>finite(x)?Number(x.toPrecision(5)).toString():'未知';
/** A source-bound proposal, not another score or a user's prior prediction.
 * Persisted grades are checked by the host against their reference tree. Here
 * we additionally require self-consistent numbers and navigation identities;
 * incomplete legacy metadata keeps its ordinary recommendation without this
 * richer brief. Imported prose/coaching is deliberately never consulted. */
function rangeResearchBrief(attempt,grade,quality){
 try{
  const g=grade,a=attempt,context=g.nodeContext,near=(x,y)=>finite(x)&&finite(y)&&Math.abs(x-y)<=1e-7*Math.max(1,Math.abs(x),Math.abs(y));
  if(!quality.eligible||g.kind!=='range-construction-grade'||g.coverage?.complete!==true||g.weighting!=='observed'||a.referenceAvailable===false||a.integrity?.referenceVerified===false)return null;
  if(typeof a.jobId!=='string'||!a.jobId||a.jobId.length>256||a.sourceFingerprint!==g.sourceFingerprint||!/^([a-f0-9]{64})$/.test(g.sourceFingerprint))return null;
  if(a.nodeId!==g.source?.nodeId||context?.nodeId!==a.nodeId||typeof a.nodeId!=='string'||!a.nodeId||g.source?.solveId&&g.source.solveId!==a.jobId||a.source?.jobId&&a.source.jobId!==a.jobId||a.source?.nodeId&&a.source.nodeId!==a.nodeId)return null;
  if(!Array.isArray(a.nodePath)||a.nodePath.length>200||a.nodePath.some(v=>typeof v!=='string'||!v||v.length>128)||!Array.isArray(context.history)||a.nodePath.length!==context.history.length||a.nodeId==='n0'&&a.nodePath.length!==0||a.nodeId!=='n0'&&a.nodePath.length===0)return null;
  const board=cards(context.board,[3,4,5]),actions=g.actions;if(!Array.isArray(actions)||actions.length<2||new Set(actions.map(x=>x.id)).size!==actions.length||actions.some(x=>typeof x.id!=='string'||!x.id||typeof x.label!=='string'||!x.label))return null;
  if(!Array.isArray(g.combos)||!g.combos.length||g.combos.length>1326)return null;
  const seen=new Set(),eligible=[];let weight=0,totalRegret=0;
  for(const row of g.combos){
   const hole=cards(row.combo,[2]),key=hole.slice().sort((x,y)=>x-y).join(',');if(seen.has(key))return null;seen.add(key);
   if(!row.scoreable){if(row.posteriorWeight!==0||row.weightedRegretBB!==0)return null;continue;}
   if(hole.some(c=>board.includes(c))||!finite(row.posteriorWeight)||row.posteriorWeight<=0||row.posteriorWeight>1)return null;
   if(!row.userProbabilities||!row.actionEV||Object.keys(row.userProbabilities).some(id=>!actions.some(x=>x.id===id))||Object.keys(row.actionEV).some(id=>!actions.some(x=>x.id===id)))return null;
   const probabilities=actions.map(x=>row.userProbabilities[x.id]),ev=actions.map(x=>row.actionEV?.[x.id]);
   if(probabilities.some(x=>!finite(x)||x<0||x>1)||!near(probabilities.reduce((s,v)=>s+v,0),1)||ev.some(x=>!finite(x)))return null;
   const userEV=probabilities.reduce((s,p,i)=>s+p*ev[i],0),best=Math.max(...ev),regret=row.locked?0:Math.max(0,best-userEV);
   if(!near(row.userEV,userEV)||row.locked&&!near(row.referenceEV,userEV)||!near(row.regretBB,regret)||!near(row.weightedRegretBB,row.posteriorWeight*regret)||!near(row.localBestEV,row.locked?row.referenceEV:best))return null;
   weight+=row.posteriorWeight;totalRegret+=row.weightedRegretBB;if(row.editable===true&&row.locked!==true)eligible.push(row);
  }
  if(!near(weight,1)||!near(totalRegret,g.metrics.localRegretBB)||!eligible.length)return null;
  eligible.sort((x,y)=>y.weightedRegretBB-x.weightedRegretBB||y.regretBB-x.regretBB||x.combo.localeCompare(y.combo));const row=eligible[0],small=totalRegret<=.02;
  const sourceRef={kind:'range-attempt',id:a.id,jobId:a.jobId,nodeId:a.nodeId,path:[...a.nodePath],sourceFingerprint:g.sourceFingerprint},target={kind:'job',id:a.jobId,jobId:a.jobId,nodeId:a.nodeId,path:[...a.nodePath],combo:row.combo,projectId:null};
  const candidateActions=actions.filter(x=>Math.abs(row.actionEV[x.id]-row.localBestEV)<=1e-9).map(x=>({id:x.id,label:x.label,ev:row.actionEV[x.id]})),players=context.contributions?.length,hu=players===2,multi=Number.isInteger(players)&&players>2;
  return {kind:'range-contrast-proposal',version:1,origin:'program-suggested-not-user-prediction',editable:true,alreadyExposed:true,sourceRef,sourceProjectId:typeof a.projectId==='string'?a.projectId:null,projectId:null,target,
   focus:{combo:row.combo,actorId:context.actorId??null,board:context.board,posteriorWeight:row.posteriorWeight,userProbabilities:copy(row.userProbabilities),actions:actions.map(x=>({id:x.id,label:x.label})),actionEV:copy(row.actionEV),userEV:row.userEV,localRegretBB:row.regretBB,rangeContributionBB:row.weightedRegretBB,candidateActions},
   focusMeaning:small?'局部机会差已经很小；此组合只作为整段分配的对照起点，不称为已确认漏洞。':'按这道题对整段局部机会差的加权贡献选焦点，不按未知实战出现率排名。',
   question:`在原节点只改变 ${row.combo} 的行动分配，固定参考对手下的局部收益和允许对手调整后的整套结果，会不会朝同一方向变化？`,
   heldFixed:['同一原始策略树、公共牌、筹码、起点范围、尺寸和抽水。','第一轮仅改选中组合的行动概率；其余组合、节点和对手策略保持原提交/参考。','独立响应检验时固定提交后的整套策略，使用相同模型与预算比较原提交和修订提交。'],
   changedItem:`先选择 ${row.combo} 在哪些已存在动作之间移动概率，记录自己的方向预测；每个组合仍合计 100%。若之后扩展为一组牌，应另记组成员，不能把单组合结论直接外推。`,
   readout:[{metric:'metrics.localRegretBB',label:'固定参考后续下的局部机会差',meaning:'比较两次完整范围提交的本节点加权机会差；不是参考频率距离。'},{metric:hu?'independentEvaluation.responseExposure.submittedSecurityEV':multi?'independentEvaluation.responseExposure.players[].submittedGainBB':'independentEvaluation.responseExposure',label:hu?'对手最佳响应下的起点安全收益':multi?'各玩家单独改打法的收益空间':'同一模型下的独立响应检验',meaning:hu?'对比原提交与修订提交在研究起点的安全收益；不能与本节点机会差直接相减。':multi?'逐人比较两次提交的单边偏离收益，不能相加或当成你的损失。':'先确认双人或多人检验口径，不猜具体反制效果。'}],
   completionSignal:'保留一个修订提交及其独立评估，再写出支持或推翻原解释的条件。简报不是已提交的预测，也不替你填写结论。',
   limitations:['这是已看过反馈后的纠错研究，不记为新的盲测、迁移证明或实战胜率改善。','本次计算最高行动收益不是唯一正确策略，微差受有限树和输入假设影响；全局残差不是逐组合误差界。','程序只整理可核验的原记录；自由文字假设须由用户确认，后续打开原节点仍需核对策略指纹。']};
 }catch{return null;}
}
const independentBasis=rows=>({sampleCount:rows.length,independentCount:new Set(rows.map(r=>r.taskKey)).size,referenceQuality:[...new Set(rows.map(r=>r.referenceQuality.kind))],independenceMeaning:'按题目身份去重，不等于统计独立或证明此前未见过。',countsTowardMastery:false});
function evidenceSummary(records){
 const block=rows=>{const judged=rows.filter(r=>r.referenceQuality.eligible&&typeof r.correct==='boolean'),confident=judged.filter(r=>r.confidence!==null);return {records:rows.length,distinctTasks:new Set(rows.map(r=>r.taskKey)).size,judged:judged.length,correct:judged.filter(r=>r.correct).length,accuracy:judged.length?judged.filter(r=>r.correct).length/judged.length:null,confidenceSamples:confident.length,brier:confident.length?confident.reduce((s,r)=>s+(r.confidence/100-Number(r.correct))**2,0)/confident.length:null,highConfidenceErrors:confident.filter(r=>!r.correct&&r.confidence>=80).length,lowConfidenceCorrect:confident.filter(r=>r.correct&&r.confidence<=50).length,provisional:rows.filter(r=>!r.referenceQuality.eligible).length};};
 return {all:block(records),firstExposure:block(records.filter(r=>r.evidenceRole==='first-exposure')),delayedRetrieval:block(records.filter(r=>r.evidenceRole==='delayed-retrieval')),shortGapPractice:block(records.filter(r=>r.evidenceRole==='short-gap-practice')),exposedPractice:block(records.filter(r=>r.evidenceRole==='exposed-practice')),lossAggregation:'不跨题或跨街累计模型机会差，也不换算新增 bb/100。',exposureMeaning:'已声明见过答案的练习不进入首次/延迟诊断；unknown 仅表示本机记录，并非已经认证的盲测。',countsTowardMastery:false};
}
export function buildLearningPlan(data={}, {now=Date.now(),limit=3}={}){
 const timestamp=clock(now);if(!Number.isInteger(limit)||limit<1||limit>10)throw Error('今日处方数量必须为 1–10。');
 const collected=collectLearningEvidence(data,{now:timestamp}),records=collected.records,candidates=[],projects=[],ignoredProjects=[];
 const add=(key,rank,entry)=>candidates.push({id:'next-'+fingerprint(key).slice(0,20),priority:rank>=85?'high':'normal',...entry,_rank:rank});
 for(const p of inputRows(data.projects,'研究任务'))try{
  if(date(p?.createdAt)>timestamp||date(p?.updatedAt)>timestamp)throw Error('研究时间在未来。');const s=summarizeStudyProject(p,{now:timestamp});projects.push(s);
  if(s.status==='closed'||s.phase==='complete')continue;
  const due=s.actionDue,waiting=s.nextAction?.dueAt&&date(s.nextAction.dueAt)>timestamp;
  add('project:'+s.id,due?96:waiting?20:82,{kind:'continue-project',title:s.nextAction.title,why:due?'你已为这条真实研究留下回访时间，现在可以记录是否遇到场景及是否执行。':`这条研究目前停在“${s.nextAction.title}”；继续已有问题，避免只积累新收藏。`,evidenceRefs:[{kind:'study-project',id:s.id}],target:{kind:'study-project',id:s.id},basis:{sampleCount:s.eventCount,independentCount:1,referenceQuality:['project-record'],countsTowardMastery:false},estimatedMinutes:3,nextAction:s.nextAction,projectQuestion:s.question,waiting:!!waiting});
 }catch(e){ignoredProjects.push({id:p?.id??null,reason:e.message});}
 const current=new Map(),latestStudy=new Map();for(const r of records){latestStudy.set(r.taskKey,r);if(!['short-gap-practice','exposed-practice'].includes(r.evidenceRole))current.set(r.taskKey,r);}
 const currentRows=[...current.values()],latestStudyRows=[...latestStudy.values()],groups=new Map();
 for(const r of currentRows.filter(r=>r.referenceQuality.eligible&&r.correct===false)){
  const group=groups.get(r.skill)||[];group.push(r);groups.set(r.skill,group);
 }
 for(const [skill,rows] of groups){
  const chosen=rows.slice().sort((a,b)=>(Number(b.confidence>=80)-Number(a.confidence>=80))||date(b.createdAt)-date(a.createdAt))[0],high=rows.some(r=>r.confidence>=80),reasonCount=rows.filter(r=>r.reasonMismatches?.length||r.missingReasonIds?.length).length;
  add('investigate:'+skill,high?93:74,{kind:'investigate',title:high?'复查一次高信心的模型分歧':'把同类判断分歧变成一个研究问题',why:`你在 ${rows.length} 个不同题目身份的有效记录中选择了参考容差之外的动作。${high?'其中至少一次信心不低于 80%。':''}${reasonCount?`其中 ${reasonCount} 次还存在参考理由遗漏或误选；这只是可观察的选择记录，不是原因诊断。`:''}`,evidenceRefs:rows.map(r=>r.sourceRef),target:chosen.target,basis:independentBasis(rows),estimatedMinutes:8,suggestedProject:{question:`在${chosen.topic}中，改变哪个条件会让我的行动判断反转？`,source:chosen.sourceRef},observed:{highConfidence:high,localModelLossBB:chosen.lossBB},completionSignal:'先写一个单条件预测，再用实际证据记录支持、反驳或暂不能判断。',diagnosis:'candidate-question-not-inferred-cause'});
 }
 for(const r of currentRows.filter(r=>r.referenceQuality.eligible&&r.correct===true&&r.confidence!==null&&r.confidence<=50).slice(-2))add('confidence:'+r.taskKey,47,{kind:'confidence-check',title:'确认一次低信心但答对的判断',why:`这次动作与参考一致，但你只给了 ${decimal(r.confidence)}% 信心。可以通过无提示解释或一个不同条件的题目确认依据，而非立即判为已掌握。`,evidenceRefs:[r.sourceRef],target:r.target,basis:independentBasis([r]),estimatedMinutes:4,completionSignal:'先说明关键响应分支，再尝试尚未做过的同类题；低信心本身不是错误。'});
 for(const r of currentRows.filter(r=>r.referenceQuality.eligible&&r.correct===true&&finite(r.reasoningScore)&&r.reasoningScore<100).slice(-2))add('reason:'+r.taskKey,66,{kind:'reason-check',title:'动作答对后，单独检验所选理由',why:'行动落在题目参考容差内，但选择的理由包含遗漏或误选。这里只报告可复查的选择差异，不能据此断定你靠猜测答对。',evidenceRefs:[r.sourceRef],target:r.target,basis:independentBasis([r]),estimatedMinutes:5,suggestedProject:{question:`在${r.topic}中，我选择的理由在哪种反例下会失效？`,source:r.sourceRef},completionSignal:'先用自己的话指出响应机制，再找一个只改变关键条件的反例。',diagnosis:'observed-reason-selection-difference'});
 for(const r of latestStudyRows.filter(r=>r.kind==='range-attempt').slice(-2)){
  const brief=r.researchBrief?copy(r.researchBrief):null;
  const originalProject=brief?.sourceProjectId?projects.find(p=>p.id===brief.sourceProjectId&&date(p.createdAt)<=date(r.createdAt)):null;
  const linkedProject=projects.find(p=>p.status!=='closed'&&p.phase!=='complete'&&(p.id===originalProject?.id||p.source.kind==='range-attempt'&&p.source.id===r.id));
  if(brief){brief.sourceProjectId=originalProject?.id??null;brief.projectId=linkedProject?.id??null;brief.target.projectId=brief.projectId;}
  if(linkedProject&&r.referenceQuality.eligible){const continuation=candidates.find(c=>c.kind==='continue-project'&&c.target.id===linkedProject.id);if(continuation&&brief&&!continuation.researchBrief)continuation.researchBrief=brief;continue;}
  const exposure=r.independentEvaluation?.status==='complete'?r.independentEvaluation.responseExposure:null,hasHU=exposure?.kind==='heads-up-security'&&finite(exposure.adaptationCostBB),multi=exposure?.kind==='multiplayer-unilateral-gains';
  const why=!r.referenceQuality.eligible?'这次范围练习的参考仍有抽样、残差或来源不确定性。先核对参考，再讨论策略缺陷。':hasHU?`这次范围记录给出本节点固定参考下的局部机会差 ${decimal(r.localRegretBB)} BB；双人模型中，研究起点的对手适应代价为 ${decimal(exposure.adaptationCostBB)} BB，用户整套策略固定。两者回答不同问题，不能直接相减；先检查范围分配改变了什么，再用对照定位原因。`:multi?`已获得多人单方偏离检验与局部机会差 ${decimal(r.localRegretBB)} BB。每位玩家的偏离收益不是你的损失，也不代表多人同时调整；先找出改变的范围分工。`:`这次范围构建的局部机会差为 ${decimal(r.localRegretBB)} BB，条件是对手和后续策略固定。尚不能据此声称整套策略容易被针对；可先写出准备检验的范围变化。`;
  add('range:'+r.taskKey,r.referenceQuality.eligible?71:55,{kind:r.referenceQuality.eligible?'range-audit':'verify-reference',title:r.referenceQuality.eligible?'检查整段范围怎样承受响应':'先核对范围练习的参考质量',why,evidenceRefs:[r.sourceRef],target:r.target,basis:independentBasis([r]),estimatedMinutes:8,suggestedProject:{question:brief?.question??'改变一类牌的行动分配，固定对手收益和允许对手调整后的结果会怎样变化？',source:r.sourceRef},...(brief?{researchBrief:brief}:{}),completionSignal:'指出一类被重新分配的牌、预期影响及一个会推翻解释的对照。'});
 }
 const unplanned=latestStudyRows.filter(r=>r.kind==='play-decision'&&!r.hasRecordedPlan),sessions=[...new Set(unplanned.map(r=>r.sessionId))];
 if(sessions.length){const r=unplanned.at(-1);add('plan:'+sessions.join(','),62,{kind:'plan-audit',title:'下一场连续练习先写后续计划',why:`在 ${sessions.length} 场已结束练习中，至少一次决策缺少当时可核对的计划记录。之后补写的计划不会倒算到此前决策；这也不能证明你心里没有计划。下次可先写价值对象、诈唬对象和改计划的触发条件。`,evidenceRefs:sessions.map(id=>({kind:'play-session',id})),target:r.target,basis:independentBasis(unplanned),estimatedMinutes:5,completionSignal:'在看到后续牌和响应前保存计划；新信息出现后允许有依据地修订。'});}
 try{
  const validCourseRows=new Map(records.filter(r=>r.kind==='course-attempt').map(r=>[r.id,r.inputFingerprint]));
  const course=buildTrainingSummary(inputRows(data.courseAttempts,'课程记录').filter(a=>a&&validCourseRows.get(a.id)===fingerprint(a)),timestamp);
  for(const d of course.due.slice(0,3))add('due:lesson:'+d.lessonId,d.priority==='high'?95:78,{kind:'review',title:'先复测，再看上次的解释',why:'这道课程题已到已保存的复习时间；此处检查提取表现，不把短间隔刷分当新的迁移证据。',evidenceRefs:records.filter(r=>r.lessonId===d.lessonId).slice(-1).map(r=>r.sourceRef),target:{kind:'lesson',id:d.lessonId,assessment:true},basis:{sampleCount:1,independentCount:1,referenceQuality:['specified-concept-model'],countsTowardMastery:false},estimatedMinutes:3});
  const validStudyRows=new Map(records.filter(r=>r.kind==='study-attempt').map(r=>[r.id,r.inputFingerprint]));
  const review=buildStudyReview(inputRows(data.studyCards,'题卡'),inputRows(data.studyAttempts,'题卡作答').filter(a=>a&&validStudyRows.get(a.id)===fingerprint(a)),{now:timestamp});
  for(const d of review.due.slice(0,3))add('due:card:'+d.id,d.priority==='high'?95:78,{kind:'review',title:'复测一张自己的研究题',why:d.quality.eligibleForRetentionEvidence?'这张真实保存的题卡已到复核时间；先独立判断，再看模型依据。':'这张题卡已到复习时间，但其参考仍有不确定性；只作研究复核，不作为技能证据。',evidenceRefs:[{kind:'study-card',id:d.id}],target:{kind:'study-card',id:d.id},basis:{sampleCount:d.attempts,independentCount:1,referenceQuality:[d.quality.mode],countsTowardMastery:false},estimatedMinutes:3});
 }catch(e){collected.ignored.push({kind:'review',id:null,reason:e.message});}
 const anyDecision=records.some(r=>r.referenceQuality.eligible&&typeof r.correct==='boolean'&&r.answerExposure!=='seen');
 if(anyDecision){
  const lastCourse=records.filter(r=>r.kind==='course-attempt').at(-1),seenLessons=new Set(records.filter(r=>r.lessonId).map(r=>r.lessonId));
  const unseen=listLessons().filter(l=>!seenLessons.has(l.id));
  const selected=unseen.find(l=>l.skill===lastCourse?.skill&&l.trainingRole==='transfer')||unseen.find(l=>l.skill===lastCourse?.skill)||unseen.find(l=>l.trainingRole==='transfer')||unseen[0];
  if(selected)add('transfer:'+selected.id,40,{kind:'transfer-check',title:'用一个尚无作答记录的局面检验判断',why:'在本机已有记录之外换一个条件，先独立预测，再看反馈。题目身份不同不等于已经证明迁移，也不能保证你在其他地方未见过。',evidenceRefs:lastCourse?[lastCourse.sourceRef]:[],target:{kind:'lesson',id:selected.id,assessment:true},basis:{sampleCount:lastCourse?1:0,independentCount:lastCourse?1:0,referenceQuality:['new-local-task'],countsTowardMastery:false},estimatedMinutes:4,completionSignal:'先提交行动、理由和信心；明确说出本题哪个条件改变了你的判断。'});
 }
 if(!anyDecision){const selected=listLessons().find(l=>l.id==='raise-transfer-reraise-fold')||listLessons()[0];add('baseline:'+selected.id,45,{kind:'baseline',title:'先留下一次中性的基线判断',why:'当前没有足够的有效判断记录来识别学习重点。先做一题并保存理由与信心；不会凭空把某项技能列为你的漏洞。',evidenceRefs:[],target:{kind:'lesson',id:selected.id,assessment:true},basis:{sampleCount:0,independentCount:0,referenceQuality:['insufficient-records'],countsTowardMastery:false},estimatedMinutes:4,completionSignal:'在揭示答案前提交判断、理由和信心。'});}
 candidates.sort((a,b)=>b._rank-a._rank||a.id.localeCompare(b.id));const recommendations=[],usedTargets=new Set();let briefShown=false;
 for(const item of candidates){const key=item.target.kind+':'+item.target.id;if(usedTargets.has(key))continue;usedTargets.add(key);const {_rank,...visible}=item;if(visible.researchBrief){if(briefShown)delete visible.researchBrief;else briefShown=true;}recommendations.push(visible);if(recommendations.length===limit)break;}
 return {version:LEARNING_PLAN_VERSION,asOf:iso(timestamp),recommendations,projects:projects.sort((a,b)=>date(b.updatedAt)-date(a.updatedAt)||a.id.localeCompare(b.id)),evidenceSummary:evidenceSummary(records),needsBaseline:!anyDecision,ignored:{records:collected.ignored,projects:ignoredProjects},policy:{limit,minDelayedHours:24,highConfidence:80,lowConfidence:50,ranking:'先到期重点复核与高信心分歧，再继续未完研究、同类判断、范围/计划和低信心正确反馈。此顺序是透明启发规则，不是已证明的最优课程。'},limitations:['处方只来自提供的本机记录；缺失、选择性录入和未记录的学习不能据此补全。','自由文本理由与结论不自动判真；候选研究问题不等于已诊断的心理或技术原因。','模型内行动机会差不能跨街相加当整局损失，也不推导真实胜率增益。','首见、延迟和短间隔分别统计；不同题目身份不保证统计独立或真实世界迁移。']};
}
