import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {createOwnedProcesses,stopWorkerGracefully} from './owned-processes.mjs';
import {createPlaySession,advancePlaySession,finishPlaySession,publicPlaySession,summarizePlaySession} from './play-session.mjs';
import {createRangeConstruction,gradeRangeConstruction} from './strategy-construction.mjs';
import {createStudyProject,applyStudyProjectEvent,summarizeStudyProject,buildLearningPlan} from './learning-plan.mjs';
import {getLesson} from './curriculum.mjs';
import {listRunoutPlans,buildRunoutPlan} from './runout-plan.mjs';
import {buildRangeDebrief} from './range-debrief.mjs';

const uuid=()=>crypto.randomUUID(),now=()=>new Date().toISOString();
const idOK=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
const atomic=(file,value)=>{const temp=file+'.'+uuid()+'.tmp';fs.writeFileSync(temp,JSON.stringify(value));fs.renameSync(temp,file);};
const finite=x=>typeof x==='number'&&Number.isFinite(x);
function confidence(value){if(!finite(value)||value<0||value>100)throw Error('请填写 0–100 的信心。');return value;}
function exposure(value='unknown'){if(!['unseen','seen','unknown'].includes(value))throw Error('答案暴露记录无效。');return value;}
function nodeAt(result,route=[]){
 if(!Array.isArray(route)||route.length>150||route.some(x=>typeof x!=='string'||x.length>200))throw Error('节点路径无效。');
 const nodes=new Map(result.nodes.map(n=>[n.id,n]));let node=nodes.get('n0');
 for(const id of route){const a=node?.actions.find(a=>a.id===id);node=a&&nodes.get(a.childId);if(!node)throw Error('这个公开行动路径不存在。');}
 if(!node)throw Error('求解树缺少起点。');return node;
}
const errorMessage='找不到这条本地记录；请重新打开原始题目或研究。';
const SOURCE_FOLDERS={'hand':'hands','case':'cases','job':'jobs','study-card':'study-cards','course-attempt':'training','study-attempt':'study-attempts','range-attempt':'range-attempts','play-session':'play-sessions','experiment':'experiments'};

export function createTrainingLabAPI({root,json,body:readBody,getJob,getResult,policyBusy=()=>false}){
 let closing=false;const assertOpen=()=>{if(closing)throw Error('训练工作台正在关闭，请重新打开后操作。');};
 const body=async req=>{assertOpen();const value=await readBody(req);assertOpen();return value;};
 const data=path.join(root,'data','pro'),active=new Map(),ownedProcesses=createOwnedProcesses();
 for(const name of ['play-sessions','range-attempts','range-evaluations','study-projects'])fs.mkdirSync(path.join(data,name),{recursive:true});
 const file=(folder,id)=>{if(!idOK(id))throw Error('记录编号无效。');return path.join(data,folder,id+'.json');};
 const list=folder=>{const dir=path.join(data,folder);return fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>/^[a-f0-9-]{36}\.json$/.test(f)).map(f=>read(path.join(dir,f))).filter(Boolean):[];};
 const get=(folder,id)=>{const record=read(file(folder,id));if(!record)throw Error(errorMessage);return record;};
 const save=(folder,record)=>atomic(file(folder,record.id),record);
 const busy=()=>active.size>0;
 const getSolved=id=>{const job=getJob(id);if(job.status!=='complete')throw Error('这份参考尚未完整求解；请先完成求解。');return {job,result:getResult(id)};};
 const projectID=id=>{if(id==null||id==='')return null;get('study-projects',id);return id;};
 const byRecent=rows=>rows.sort((a,b)=>String(b.updatedAt??b.createdAt).localeCompare(String(a.updatedAt??a.createdAt)));
 const rangeBrief=a=>({id:a.id,kind:a.kind,createdAt:a.createdAt,jobId:a.jobId,nodePath:a.nodePath,nodeId:a.nodeId,source:a.source,weighting:a.weighting,confidence:a.confidence,reason:a.reason,metrics:a.grade?.metrics,quality:a.quality,projectId:a.projectId,evaluationId:a.evaluationId});
 const playBrief=s=>({id:s.id,kind:s.kind,status:s.status,source:s.source,createdAt:s.createdAt,updatedAt:s.updatedAt,completedAt:s.completedAt,feedbackMode:s.feedbackMode,decisions:s.decisions.length,...(['complete','abandoned'].includes(s.status)?{summary:summarizePlaySession(s)}:{}),...(s.status==='interrupted'?{interruptionReason:s.interruptionReason,recoverable:false}:{})});
 const evaluationBrief=r=>{const {processId,...record}=r;return record;};
 const learningRangeAttempts=()=>list('range-attempts').map(attempt=>{
  const evaluation=idOK(attempt.evaluationId)?read(file('range-evaluations',attempt.evaluationId)):null;
  if(evaluation?.status!=='complete'||evaluation.attemptId!==attempt.id||evaluation.jobId!==attempt.jobId||evaluation.result?.sourceFingerprint!==attempt.sourceFingerprint||evaluation.result?.independentEvaluation?.status!=='complete')return attempt;
  return {...attempt,independentEvaluation:evaluation.result.independentEvaluation,independentEvaluationSource:{id:evaluation.id,createdAt:evaluation.createdAt,finishedAt:evaluation.finishedAt,integrity:evaluation.integrity??null}};
 });
 for(const record of list('range-evaluations'))if(['running','cancelling','cleanup-required'].includes(record.status)){
  record.status='interrupted';record.error='上次独立评估在完成前结束，原始范围作答仍保留。';record.finishedAt=now();delete record.processId;save('range-evaluations',record);
 }

 // References and retest times come from local records, never client-supplied
 // grades, titles, timestamps, or an asserted answer exposure.
 function resolveSource(input={kind:'manual'}){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('研究来源格式无效。');
  const kind=input.kind??'manual';let record=null,parent=null;
  if(kind==='manual')return {source:{kind:'manual',...(input.title?{title:String(input.title).slice(0,200)}:{})},createdAt:null};
  if(kind==='lesson'){record=getLesson(input.id,{reveal:false});if(!record)throw Error(errorMessage);}
  else if(kind==='play-decision'){
   parent=get('play-sessions',input.sessionId);if(!['complete','abandoned'].includes(parent.status))throw Error('请先结束这轮连续练习，再把其中的决策加入研究。');
   record=parent.decisions.find(d=>d.id===input.id);if(!record)throw Error(errorMessage);
  }else{const folder=SOURCE_FOLDERS[kind];if(!folder)throw Error('不支持的研究来源。');record=get(folder,input.id);}
  if(kind==='play-session'&&!['complete','abandoned'].includes(record.status))throw Error('请先完成或结束这轮练习，再使用它作为研究证据。');
  const source={kind,id:input.id};if(parent)source.sessionId=parent.id;
  const actualJob=kind==='job'?record.id:record.jobId??record.sourceJobId??record.source?.jobId??parent?.source?.jobId;
  const actualPath=record.nodePath??record.path??(kind==='play-session'?record.source?.startingPath:null);
  const actualNode=record.nodeId??record.grade?.source?.nodeId;
  if(input.jobId&&actualJob!==input.jobId)throw Error('来源与所选求解不属于同一份模型。');
  if(input.path&&actualPath&&JSON.stringify(input.path)!==JSON.stringify(actualPath))throw Error('来源的行动路径不匹配。');
  if(input.nodeId&&actualNode&&input.nodeId!==actualNode)throw Error('来源节点不匹配。');
  if(actualJob){source.jobId=actualJob;const {result}=getSolved(actualJob);const route=actualPath??input.path??[];const node=nodeAt(result,route);if(input.nodeId&&node.id!==input.nodeId)throw Error('来源节点与路径不一致。');source.path=route;source.nodeId=node.id;}
  if(kind==='hand')source.handId=record.id;
  if(kind==='case')source.caseId=record.id;
  source.title=String(record.title??record.question??record.source?.title??parent?.source?.title??record.publicQuestion?.title??kind).slice(0,200);
  if(input.answerSeen===true||['course-attempt','study-attempt','range-attempt','play-session','play-decision'].includes(kind))source.answerSeen=true;
  return {source,createdAt:kind==='play-session'?record.completedAt??record.updatedAt:record.answeredAt??record.createdAt??null,record};
 }
 function startPlay(options){
  const {job,result}=getSolved(options.jobId),session=createPlaySession(job.scenario,result,{jobId:job.id,heroSeat:options.heroSeat,startingPath:options.startingPath??[],focusCombo:options.focusCombo??'',feedbackMode:options.feedbackMode??'end',timeBudgetSeconds:options.timeBudgetSeconds??null,plan:options.plan,reportedExposure:exposure(options.reportedExposure),projectId:projectID(options.projectId),parentId:options.parentId??null});
  const view=publicPlaySession(session,result);save('play-sessions',session);return view;
 }
 function stopEvaluation(entry,status,error){
  if(!['running','cancelling','cleanup-required'].includes(entry.record.status))return;
  entry.stopStatus=status;entry.stopError=error;entry.record.status='cancelling';entry.record.progress={...entry.record.progress,phase:'cancelling'};save('range-evaluations',entry.record);
  entry.worker.postMessage({cancel:true});ownedProcesses.stop(entry.worker);clearTimeout(entry.timer);
  if(entry.worker.threadId===-1)entry.finish(status,error);else {clearTimeout(entry.killTimer);entry.killTimer=setTimeout(()=>entry.worker.terminate(),2000);}
 }
 function startEvaluation(attempt){
  assertOpen();
  if(policyBusy()||busy())throw Error('已有策略求解或独立评估正在运行，请等待完成或取消。');
  const {job}=getSolved(attempt.jobId),record={id:uuid(),kind:'range-evaluation',attemptId:attempt.id,jobId:job.id,status:'running',createdAt:now(),progress:{phase:'preparing'}};
  const worker=new Worker(new URL('./strategy-construction-worker.mjs',import.meta.url),{workerData:{jobId:job.id,scenario:job.scenario,resultFile:path.join(data,'jobs',job.id,'result.json'),submission:attempt.submission}});
  const entry={record,worker,timer:null,killTimer:null,stopStatus:null,settling:null};active.set(record.id,entry);save('range-evaluations',record);attempt.evaluationId=record.id;save('range-attempts',attempt);
  entry.timer=setTimeout(()=>stopEvaluation(entry,'interrupted','独立评估超过总时间预算，局部范围评分仍然保留。'),150000);
  const finish=(status,error,result)=>{
   if(entry.settling)return entry.settling;if(!['running','cancelling','cleanup-required'].includes(record.status))return;
   entry.settling=(async()=>{
    if(!await ownedProcesses.drain(worker)){record.status='cleanup-required';record.error='独立评估尚未完全停止，请再次停止计算。';save('range-evaluations',record);entry.settling=null;return;}
    record.status=entry.stopStatus??status;record.finishedAt=now();if(entry.stopError??error)record.error=entry.stopError??error;
    if(result&&!entry.stopStatus){record.result=result;record.result.coaching=buildRangeDebrief(result,{jobId:attempt.jobId,nodePath:attempt.nodePath});}
    clearTimeout(entry.timer);clearTimeout(entry.killTimer);save('range-evaluations',record);active.delete(record.id);
   })();return entry.settling;
  };entry.finish=finish;
  worker.on('message',m=>{
   if(m.type==='progress'){ownedProcesses.observe(worker,m.progress);if(entry.stopStatus)ownedProcesses.stop(worker);if(['running','cancelling'].includes(record.status))record.progress=entry.stopStatus?{...m.progress,phase:'cancelling'}:m.progress;}
   if(m.type==='result')finish('complete',null,m.result);if(m.type==='error')finish('failed',m.error);
  });
  worker.on('error',error=>finish('failed',error.message));
  worker.on('exit',()=>{clearTimeout(entry.timer);clearTimeout(entry.killTimer);finish('interrupted','独立评估进程提前结束，未发布不完整反制指标。');});
  return evaluationBrief(record);
 }
 async function handler(req,res,u){
  const p=u.pathname;
  if(p==='/api/pro/training/balance-examples'&&req.method==='GET'){
   const examples=read(path.join(root,'data','library','balance-examples.json'))?.examples??[];
   return json(res,examples.map(({id,title,question,construction,options,sourceJobId,nodePath,scenario,grade})=>({id,title,question,construction,options,sourceJobId,nodePath,scenario,experimentActor:{seat:grade.nodeContext.actorSeat,name:grade.nodeContext.actorName,position:scenario.players[grade.nodeContext.actorSeat].position},userAttempts:false})));
  }
  const balance=p.match(/^\/api\/pro\/training\/balance-examples\/([a-z0-9-]+)$/);
  if(balance&&req.method==='GET'){
   const item=read(path.join(root,'data','library','balance-examples.json'))?.examples?.find(x=>x.id===balance[1]);if(!item)throw Error('找不到这个教学实验。');
   const {job,result}=getSolved(item.sourceJobId),question=createRangeConstruction(job.scenario,result,{nodeId:nodeAt(result,item.nodePath??[]).id});
   if(question.publicQuestion.sourceFingerprint!==item.sourceFingerprint)throw Error('这个教学实验的原始策略已改变，不能把旧对照附在新策略上。');
   return json(res,{...item,userAttempts:false,recording:'此页面是已经核验的教学演示；预测与揭示不记为用户能力成绩。请进入整段构建保存自己的实际作品。'});
  }
  if(p==='/api/pro/play/sessions'){
   if(req.method==='GET')return json(res,byRecent(list('play-sessions')).map(playBrief));
   if(req.method==='POST')return json(res,startPlay(await body(req)));
  }
  const play=p.match(/^\/api\/pro\/play\/sessions\/([a-f0-9-]{36})(?:\/(step|finish|next))?$/);
  if(play){
   const [,id,action]=play;
   if(!action&&req.method==='GET'){const s=get('play-sessions',id);if(s.status==='interrupted')return json(res,{...playBrief(s),decision:null});return json(res,publicPlaySession(s,getResult(s.source.jobId)));}
   if(action&&req.method==='POST'){
    // Read after awaiting the body. Pure transition + atomic write is synchronous,
    // so two submissions cannot both consume the same outstanding decision ID.
    const b=await body(req),s=get('play-sessions',id);if(s.status==='interrupted')throw Error('此练习的完整参考缺失或中断，不能继续。请恢复原始求解或重新求解后开始新练习。');const result=getResult(s.source.jobId);
    if(action==='next'){if(s.status==='playing')throw Error('请先结束当前练习，再开始下一手。');return json(res,startPlay({...s.source,feedbackMode:s.feedbackMode,timeBudgetSeconds:s.timeBudgetSeconds,plan:b.plan??{},reportedExposure:'unknown',parentId:s.id}));}
    const next=action==='step'?advancePlaySession(s,result,b):finishPlaySession(s,result),view=publicPlaySession(next,result);save('play-sessions',next);return json(res,view);
   }
  }
  if(p==='/api/pro/training/range-question'&&req.method==='POST'){
   const b=await body(req),{job,result}=getSolved(b.jobId),node=nodeAt(result,b.nodePath??[]),question=createRangeConstruction(job.scenario,result,{nodeId:node.id,weighting:b.weighting??'observed'});
   return json(res,{...question,sourceFingerprint:question.publicQuestion.sourceFingerprint,jobId:job.id,nodePath:b.nodePath??[],weighting:b.weighting??'observed'});
  }
  if(p==='/api/pro/training/range-attempt'&&req.method==='POST'){
   const b=await body(req);confidence(b.confidence);if(typeof b.sourceFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(b.sourceFingerprint))throw Error('请重新打开原始范围题再作答。');
   const {job,result}=getSolved(b.jobId),node=nodeAt(result,b.nodePath??[]),submission={nodeId:node.id,weighting:b.weighting??'observed',sourceFingerprint:b.sourceFingerprint,assignments:b.assignments},grade=gradeRangeConstruction(job.scenario,result,submission);
   grade.coaching=buildRangeDebrief(grade,{jobId:job.id,nodePath:b.nodePath??[]});
   const attempt={id:uuid(),kind:'range-attempt',createdAt:now(),jobId:job.id,nodePath:b.nodePath??[],nodeId:node.id,weighting:submission.weighting,sourceFingerprint:b.sourceFingerprint,reason:String(b.reason??'').slice(0,10000),confidence:b.confidence,reportedExposure:exposure(b.reportedExposure),submission,grade,quality:grade.quality,source:{jobId:job.id,title:job.scenario.title,nodeId:node.id},projectId:projectID(b.projectId),evaluationId:null};
   save('range-attempts',attempt);return json(res,{attempt,grade});
  }
  if(p==='/api/pro/training/range-attempts'&&req.method==='GET')return json(res,byRecent(list('range-attempts')).map(rangeBrief));
  const attemptMatch=p.match(/^\/api\/pro\/training\/range-attempts\/([a-f0-9-]{36})(?:\/(evaluate))?$/);
  if(attemptMatch){if(!attemptMatch[2]&&req.method==='GET')return json(res,get('range-attempts',attemptMatch[1]));if(attemptMatch[2]&&req.method==='POST'){await body(req);return json(res,startEvaluation(get('range-attempts',attemptMatch[1])));}}
  const evalMatch=p.match(/^\/api\/pro\/training\/range-evaluations\/([a-f0-9-]{36})(?:\/(cancel))?$/);
  if(evalMatch){
   const entry=active.get(evalMatch[1]);if(evalMatch[2]&&req.method==='POST'){await body(req);if(entry)stopEvaluation(entry,'cancelled','用户取消独立评估。');return json(res,evaluationBrief(entry?.record??get('range-evaluations',evalMatch[1])));}
   if(!evalMatch[2]&&req.method==='GET')return json(res,evaluationBrief(entry?.record??get('range-evaluations',evalMatch[1])));
  }
  const runout=p.match(/^\/api\/pro\/jobs\/([a-f0-9-]{36})\/(runout-sources|runout-plan)$/);
  if(runout){
   if(runout[2]==='runout-sources'&&req.method==='GET'){const {job,result}=getSolved(runout[1]);return json(res,{jobId:job.id,...listRunoutPlans(job.scenario,result)});}
   if(runout[2]==='runout-plan'&&req.method==='POST'){const b=await body(req),{job,result}=getSolved(runout[1]);return json(res,{jobId:job.id,...buildRunoutPlan(job.scenario,result,{chancePath:b.chancePath,focusCombo:b.focusCombo})});}
  }
  if(p==='/api/pro/learning-plan'&&req.method==='GET')return json(res,buildLearningPlan({courseAttempts:list('training'),studyCards:list('study-cards'),studyAttempts:list('study-attempts'),rangeAttempts:learningRangeAttempts(),playSessions:list('play-sessions').filter(s=>['complete','abandoned'].includes(s.status)),projects:list('study-projects')}));
  if(p==='/api/pro/study-projects'){
   if(req.method==='GET')return json(res,byRecent(list('study-projects')).map(p=>summarizeStudyProject(p)));
   if(req.method==='POST'){const b=await body(req),resolved=resolveSource(b.source),project=createStudyProject({...b,source:resolved.source},{id:uuid(),now:Date.now()});save('study-projects',project);return json(res,{...project,summary:summarizeStudyProject(project)});}
  }
  const projectMatch=p.match(/^\/api\/pro\/study-projects\/([a-f0-9-]{36})(?:\/(events|export))?$/);
  if(projectMatch){
   const [,id,action]=projectMatch;
   if(!action&&req.method==='GET'){const project=get('study-projects',id);return json(res,{...project,summary:summarizeStudyProject(project)});}
   if(action==='export'&&req.method==='GET'){const project=get('study-projects',id);res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="pokerlab-project-${id}.json"`});res.end(JSON.stringify({app:'PokerLab',kind:'study-project-export',exportedAt:now(),project,summary:summarizeStudyProject(project)},null,2));return true;}
   if(action==='events'&&req.method==='POST'){
    const b=await body(req),project=get('study-projects',id);let resolvedRetest;
    if(['evidence','retest'].includes(b.kind)||b.kind==='field-observation'&&b.source){
     const resolved=resolveSource(b.source);b.source=resolved.source;
     if(b.kind==='retest'){
      const conclusion=project.events.findLast(e=>e.kind==='conclusion');
      if(!Number.isFinite(Date.parse(resolved.createdAt))||!conclusion||Date.parse(resolved.createdAt)<Date.parse(conclusion.createdAt))throw Error('复测需要引用形成这条结论之后实际完成的新作答，不能把此前成绩补链成复测。');
      if(resolved.source.kind==='play-session'&&!resolved.record.decisions.length)throw Error('复测需要至少一次真实决策，不能使用没有作答的练习。');
      resolvedRetest={createdAt:resolved.createdAt,sourceKind:resolved.source.kind,sourceId:resolved.source.id,timeResolution:resolved.source.kind==='play-session'?'session':'attempt',...(resolved.source.sessionId?{sessionId:resolved.source.sessionId}:{})};
     }
    }
    const next=applyStudyProjectEvent(project,b,{eventId:uuid(),now:Date.now(),resolvedRetest});save('study-projects',next);return json(res,{...next,summary:summarizeStudyProject(next)});
   }
  }
  return false;
 }
 return {handler,get busy(){return busy();},get activeEvaluations(){return [...active.values()].map(x=>evaluationBrief(x.record));},async shutdown(){closing=true;const entries=[...active.values()];for(const entry of entries)stopEvaluation(entry,'interrupted','服务关闭，独立评估尚未完成。');await Promise.all(entries.map(entry=>stopWorkerGracefully(entry.worker)));return ownedProcesses.drainAll();},resolveSource};
}
