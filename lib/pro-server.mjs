import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {createOwnedProcesses,stopWorkerGracefully} from './owned-processes.mjs';
import {validateScenario,normalizeScenario,parseScenario,IMPORT_EXAMPLES} from './scenario.mjs';
import {riverNode} from './river-engine.mjs';
import {observedPath} from './observed-path.mjs';
import {inputHandSourceId,inputRecordingSourceId,assertInputProvenance,assertObservedInputProvenance} from './input-provenance.mjs';
import {solveSettings} from './solve-settings.mjs';
import {createLiveRecorderAPI} from './live-recorder-api.mjs';
import {createHandHistoryAPI} from './hand-history-api.mjs';
import {assertSolutionScenario} from './solution-identity.mjs';
import {createTrainingLabAPI} from './training-lab-api.mjs';
import {createResearchAPI} from './research-api.mjs';
import {localCoachStatus,stopLocalCoach,releaseLocalCoach,generateLocalCoach,LOCAL_COACH_PROMPT_VERSION} from './local-coach.mjs';
import {listStudyLibrary} from './study-library.mjs';
import {exportUserData,createLocalBackup,listLocalBackups,backupFile,restoreUserData,restoreLocalBackup,restoreCompressedBackup} from './backup.mjs';
const idOK=id=>/^[a-f0-9-]{36}$/.test(id);
const copy=v=>JSON.parse(JSON.stringify(v));
const isActive=record=>['running','cancelling','cleanup-required'].includes(record?.status);
const withoutPids=value=>JSON.parse(JSON.stringify(value,(key,v)=>['processId','processIds','exitedProcessId'].includes(key)?undefined:v));
const inputContext=value=>{if(value==null)return null;if(typeof value!=='object'||Array.isArray(value))throw Error('导入上下文格式无效。');const text=JSON.stringify(value);if(text.length>1000000)throw Error('导入上下文过大，请只保存当前这一手牌。');return JSON.parse(text);};
const readBackupUpload=req=>new Promise((resolve,reject)=>{let bytes=0,done=false;const chunks=[];req.on('data',chunk=>{if(done)return;bytes+=chunk.length;if(bytes>128*1024*1024){done=true;reject(Error('备份上传超过 128 MB。'));return;}chunks.push(chunk);});req.on('end',()=>{if(!done){done=true;resolve(Buffer.concat(chunks));}});req.on('error',reject);});
const safeRead=(f,fallback=null)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch{return fallback;}};
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const scenarioKey=s=>hash({board:s.board,pot:s.pot,players:s.players.map(p=>({id:p.id,position:p.position,range:p.range,stack:p.stack})),hero:s.hero,heroSeat:s.heroSeat,toAct:s.toAct,rake:s.rake??0,rakeCap:s.rakeCap??0});
function writeJSON(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(value));fs.renameSync(temp,file);}

export function createProAPI({root,json:sendJSON,body:readBody,onShutdown=()=>{}}){
 const json=(...args)=>{sendJSON(...args);return true;};
 let research=null,closing=null;const assertOpen=()=>{if(closing)throw Error('工作台正在关闭，请重新打开后操作。');};
 const body=async req=>{assertOpen();const value=await readBody(req);assertOpen();return value;};
 const data=path.join(root,'data','pro');for(const d of ['cases','jobs','analyses','coach','training','study-cards','study-attempts','experiments'])fs.mkdirSync(path.join(data,d),{recursive:true});
 const inbox=createHandHistoryAPI({root,json,body}),liveRecorder=createLiveRecorderAPI({root,json,body});
 const experiments=new Map(),jobs=new Map(),workers=new Set(),ownedProcesses=createOwnedProcesses(),resultCache=new Map();let analyzing=false,coachBusy=false;
 const gpuPolicyActive=()=>research?.busy||[...jobs.values()].some(x=>isActive(x.job)&&x.job.settings?.engine==='gpu-river');
 const modules=async()=>Promise.all([import('./curriculum.mjs'),import('./coach.mjs')]);
 const privateReview=async()=>{const {buildStudyReview}=await import('./study-review.mjs');return buildStudyReview(list('study-cards'),list('study-attempts'),{now:new Date()});};
 const fileFor=(type,id)=>{if(!idOK(id))throw Error('无效记录编号。');return path.join(data,type,id+'.json');};
 const list=type=>fs.readdirSync(path.join(data,type)).filter(x=>/^[a-f0-9-]{36}\.json$/.test(x)).map(f=>safeRead(path.join(data,type,f))).filter(Boolean);
 const verifyInput=(scenario,context,{observed=false}={})=>{const id=inputHandSourceId(context),recordingId=inputRecordingSourceId(context),hand=id?safeRead(fileFor('hands',id)):null,recording=recordingId?safeRead(fileFor('live-recordings',recordingId)):null;return (observed?assertObservedInputProvenance:assertInputProvenance)(scenario,context,{hand,recording});};
 const savedInputAssessment=job=>{try{const checked=verifyInput(job.scenario,job.inputContext);return {...checked,inputContext:undefined};}catch(error){return {kind:'unverified-legacy',sourceVerified:false,error:error.message,assumptions:['以下只解释已保存参数对应的数学模型，不能据此声称已经核对原始实战牌局。请修正原文或明确建立假设分支后再计算。']};}};
 const getJob=id=>{const j=jobs.get(id)?.job??safeRead(fileFor('jobs',id));if(!j)throw Error('找不到这次求解。');return j;};
 const resultStamp=file=>{try{const st=fs.statSync(file,{bigint:true});return [st.size,st.mtimeNs,st.ctimeNs,st.ino].join(':');}catch{throw Error('求解结果尚未准备好。');}};
 const getResult=id=>{
  const job=getJob(id),file=path.join(data,'jobs',id,'result.json'),stamp=resultStamp(file),entry=resultCache.get(id);
  if(entry?.stamp===stamp){assertSolutionScenario(job.scenario,entry.result,{settings:job.settings??{}});return entry.result;}
  const bytes=fs.readFileSync(file);if(stamp!==resultStamp(file))throw Error('求解结果正在变化，请稍后重试。');
  let result;try{result=JSON.parse(bytes.toString('utf8'));}catch{throw Error('求解结果尚未准备好。');}
  assertSolutionScenario(job.scenario,result,{settings:job.settings??{}});resultCache.set(id,{stamp,result,digest:crypto.createHash('sha256').update(bytes).digest('hex')});if(resultCache.size>3)resultCache.delete(resultCache.keys().next().value);return result;
 };
 const lab=createTrainingLabAPI({root,json,body,getJob,getResult,policyBusy:()=>research?.busy||[...jobs.values()].some(x=>isActive(x.job))||[...experiments.values()].some(x=>isActive(x.record))});
 const researchPolicyBusy=()=>lab.busy||analyzing||coachBusy||[...jobs.values()].some(x=>isActive(x.job))||[...experiments.values()].some(x=>isActive(x.record));
 research=createResearchAPI({root,json,body,getJob,getResult,startPolicySolve,decisionDetails,policyBusy:researchPolicyBusy,releaseGPU:releaseLocalCoach});
 const saveAnalysis=(cacheFile,result,scenario)=>{writeJSON(cacheFile,result);if(idOK(result.id))writeJSON(fileFor('analyses',result.id),{cacheFile:path.basename(cacheFile),scenarioHash:scenarioKey(scenario)});};
 const getAnalysis=(id,scenario)=>{if(!idOK(id??''))throw Error('请先完成权益计算，再请求数值解读。');const ref=safeRead(fileFor('analyses',id));if(!ref||!/^([a-f0-9]{64})\.json$/.test(ref.cacheFile)||ref.scenarioHash!==scenarioKey(scenario))throw Error('局面已改变或结果未保存，请重新计算后解读。');const value=safeRead(path.join(data,'analyses',ref.cacheFile));if(!value||value.id!==id)throw Error('该权益结果不存在，请重新计算。');return value;};
 for(const x of list('experiments'))if(isActive(x)){x.status='interrupted';x.error='上次范围实验未完成，可以重新启动。';writeJSON(fileFor('experiments',x.id),x);}
 for(const j of list('jobs'))if(['running','queued','preparing','cancelling','cleanup-required'].includes(j.status)){j.status='interrupted';j.error='上次运行在完成前结束；参数已保存，可以重新求解。';writeJSON(fileFor('jobs',j.id),j);}
 function shutdown(){
  if(closing)return closing;
  closing=(async()=>{
   for(const {job} of jobs.values())if(isActive(job))job.cancelRequested=true;
   for(const {record} of experiments.values())if(isActive(record))record.cancelRequested=true;
   const all=new Set([...workers,...[...jobs.values()].map(x=>x.worker),...[...experiments.values()].map(x=>x.worker)]);
   const labCleanup=lab.shutdown(),researchCleanup=research.shutdown();inbox.shutdown();const coachCleanup=releaseLocalCoach();ownedProcesses.stopAll();
   await Promise.all([...all].map(worker=>stopWorkerGracefully(worker)));
   return Promise.all([labCleanup,researchCleanup,coachCleanup,ownedProcesses.drainAll()]);
  })();return closing;
 }
 async function startPolicySolve(b){
   const scenario=normalizeScenario(b.scenario),rawSettings=b.settings??{},settings=solveSettings(rawSettings),provenance=verifyInput(scenario,inputContext(b.scenario?.inputContext??b.inputContext));
   if(scenario.board.replace(/\s/g,'').length===6&&scenario.players.length!==2)throw Error('翻牌策略当前支持双人；多人翻牌可计算权益，多人策略从转牌或河牌起点研究。');
   if(research?.busy||lab.busy||[...jobs.values()].some(({job})=>isActive(job))||[...experiments.values()].some(x=>isActive(x.record)))throw Object.assign(Error('已有策略任务运行中。请等待完成或取消。'),{statusCode:409});
   if(settings.engine==='gpu-river'){if(analyzing||coachBusy)throw Object.assign(Error('请等待当前权益计算或本地解释结束，再启动 GPU 策略求解。'),{statusCode:409});await releaseLocalCoach();if(research?.busy||lab.busy||analyzing||coachBusy||[...jobs.values()].some(x=>isActive(x.job))||[...experiments.values()].some(x=>isActive(x.record)))throw Object.assign(Error('已有新计算开始，请等待完成后重试。'),{statusCode:409});}
   assertOpen();const id=crypto.randomUUID(),job={id,status:'running',createdAt:new Date().toISOString(),startedAt:Date.now(),scenario,inputContext:provenance.inputContext,inputProvenance:{...provenance,inputContext:undefined},settings,progress:{phase:'preparing'},log:[]};
   const outputFile=path.join(data,'jobs',id,'result.json'),w=new Worker(new URL('./pro-solve-worker.mjs',import.meta.url),{workerData:{input:{...scenario,...settings},outputFile}}),entry={job,worker:w};jobs.set(id,entry);writeJSON(fileFor('jobs',id),savedSummary(job));let complete=false,settling=null;
   const finish=(status,error)=>{
    if(complete||settling)return settling;
    settling=(async()=>{
     const clean=await ownedProcesses.drain(w);
     if(!clean){job.status='cleanup-required';job.error='后台计算尚未完全停止，暂时保留资源占用。请再次停止计算。';writeJSON(fileFor('jobs',id),savedSummary(job));settling=null;return;}
     complete=true;job.status=job.cancelRequested?'cancelled':status;job.seconds=(Date.now()-job.startedAt)/1000;job.finishedAt=new Date().toISOString();if(error)job.error=error;delete job.processId;delete job.processIds;writeJSON(fileFor('jobs',id),savedSummary(job));
    })();return settling;
   };entry.finish=finish;
   w.on('message',m=>{
    if(m.type==='progress'){
     ownedProcesses.observe(w,m.progress);if(job.cancelRequested)ownedProcesses.stop(w);if(complete)return;
     job.progress=job.cancelRequested?{...m.progress,phase:'cancelling'}:m.progress;job.log.push({...m.progress,at:Date.now()});if(job.log.length>80)job.log.shift();
    }
    if(m.type==='result'){if(!job.cancelRequested){const {input,...summary}=m.result;job.result=summary;job.settings={...job.settings,...solveSettings(input)};}finish('complete');}
    if(m.type==='error')finish('failed',m.error);
   });
   w.on('error',e=>finish('failed',e.message));w.on('exit',code=>{if(!complete)finish('failed',code?'求解进程提前退出。':undefined);});
   return savedSummary(job);
 }
 const presets=()=>IMPORT_EXAMPLES.filter(e=>e.format==='notation').map(e=>{const p=parseScenario(e.text,{format:'notation'});return {id:e.id,title:e.title,description:e.id.includes('three')?'三人河牌 · 研究身后玩家与加注':'双人河牌 · 比较跟注、加注与对手响应',scenario:p.scenario,source:'原创研究假设 · 非人口统计或预解范围',parse:p};});
 const savedSummary=j=>withoutPids(j);
 async function decisionDetails(id,nodeId,combo){
  assertOpen();
  const job=getJob(id);getResult(id);const digest=resultCache.get(id).digest,cacheFile=path.join(data,'jobs',id,'explanation-'+hash({nodeId,combo,digest,version:6})+'.json'),cached=safeRead(cacheFile);if(cached)return cached;
  return new Promise((resolve,reject)=>{const w=new Worker(new URL('./decision-explanation-worker.mjs',import.meta.url),{workerData:{scenario:job.scenario,resultFile:path.join(data,'jobs',id,'result.json'),options:{nodeId,combo}}});workers.add(w);let done=false;const timer=setTimeout(()=>w.terminate(),30000);w.on('message',m=>{if(done)return;done=true;if(m.ok){try{getResult(id);if(resultCache.get(id).digest!==digest)throw Error('求解结果在拆解期间发生变化，已停止发布旧教案。');writeJSON(cacheFile,m.result);resolve(m.result);}catch(error){reject(error);}}else reject(Error(m.error));});w.on('error',e=>{done=true;reject(e);});w.on('exit',()=>{clearTimeout(timer);workers.delete(w);if(!done)reject(Error('收益拆解未在预算内完成。'));});});
 }
 function appendDecisionEvidence(report,details){
  const added=[],facts=[],best=Math.max(...details.actions.map(a=>a.ev));let next=901;
  const add=(label,value,metric,unit='BB',extra={})=>{const id='E'+next++;report.evidence.push({id,label,value,unit,metric,source:'independent-policy-reconstruction',...extra});return id;};
  for(const action of details.actions){
   const evId=add(details.combo+' '+action.label+' 净 EV',action.ev,'net-ev','BB',{actionId:action.id});
   const loss=Math.max(0,best-action.ev),lossId=add(details.combo+' '+action.label+' 相对当前最高行动 EV 的损失',loss,'relative-best-loss','BB',{actionId:action.id});
   const ids=[evId,lossId],parts=[];
   for(const branch of action.responses){if(branch.probability<.0001)continue;
    const pid=add(action.label+' 后 '+branch.label+' 概率',branch.probability,'response-probability','比例',{actionId:action.id,responseId:branch.id});
    const vid=add(action.label+' 后 '+branch.label+' EV 贡献',branch.evContribution,'response-contribution','BB',{actionId:action.id,responseId:branch.id});
    ids.push(pid,vid);parts.push(branch.label+'：概率 '+(branch.probability*100).toFixed(2)+'%，贡献 '+branch.evContribution.toFixed(4)+' BB');
   }
   added.push({title:action.label+' 的收益来自哪里',body:details.combo+' 固定执行此动作的净 EV 为 '+action.ev.toFixed(4)+' BB，相对当前最高行动 EV 的损失为 '+loss.toFixed(4)+' BB。'+parts.join('；')+'。分支贡献加总与求解器行动 EV 一致；多人时第一位对手弃牌仍可能有后续玩家。',evidenceIds:ids});
   facts.push({id:action.id,label:action.label,netEV:action.ev,netEVSign:action.ev>1e-9?'positive':action.ev< -1e-9?'negative':'zero',lossRelativeToBest:loss,netEVID:evId,lossEVID:lossId,closeToBest:loss<=.02});
  }
  for(const comparison of details.comparisons??[]){if(comparison.alternative.id==='fold')continue;
   const id=add(comparison.alternative.label+' 相比 '+comparison.baseline.label+' EV 差',comparison.evDifference,'action-difference','BB',{alternative:comparison.alternative.id,baseline:comparison.baseline.id}),parts=[],ids=[id];
   for(const outcome of comparison.outcomes.filter(o=>Math.abs(o.difference)>.00001).sort((a,b)=>Math.abs(b.difference)-Math.abs(a.difference))){
    const oid=add(comparison.alternative.label+' 相比 '+comparison.baseline.label+'，'+outcome.label+'贡献差',outcome.difference,'outcome-contribution-difference','BB',{alternative:comparison.alternative.id,baseline:comparison.baseline.id,outcome:outcome.id});ids.push(oid);parts.push(outcome.label+'贡献'+(outcome.difference>=0?'增加':'减少')+' '+Math.abs(outcome.difference).toFixed(4)+' BB');
   }
   added.push({title:'为什么 '+comparison.alternative.label+' 与 '+comparison.baseline.label+' 的收益不同',body:'在相同手牌及对手策略下，EV 差为 '+comparison.evDifference.toFixed(4)+' BB。'+parts.join('；')+'。这些是同一组终局事件上的收益差，加总等于总 EV 差；已经计入后续投入。带符号的动作间差值不能替代“相对最佳动作的非负损失”，终局贡献也不能当作条件摊牌权益。',evidenceIds:ids});
  }
  report.sections.push(...added);report.decision=details;report.verifiedActionFacts={combo:details.combo,actor:details.actorName,meaning:'净 EV 是从此节点向后的期望净收益；正值不保证单手盈利。相对最优损失是当前最高行动 EV 减去该动作 EV 的非负差，不能用与过牌或跟注的带符号差值替代。',bestActionLabels:facts.filter(a=>a.lossRelativeToBest<1e-9).map(a=>a.label),actions:facts};report.limitations.push(...details.limits);return report;
 }
 const backupTimer=setTimeout(()=>{try{const latest=listLocalBackups(root)[0];if(!latest||Date.now()-Date.parse(latest.createdAt)>24*60*60*1000)createLocalBackup(root,{automatic:true});}catch(e){console.error('Automatic backup failed:',e.message);}},3000);backupTimer.unref();
 async function handler(req,res,u){const p=u.pathname;if(!p.startsWith('/api/pro/'))return false;if(closing)return json(res,{error:'工作台正在关闭，请完成退出后重新打开。'},503);if(await inbox.handler(req,res,u))return true;if(await liveRecorder.handler(req,res,u))return true;if(await lab.handler(req,res,u))return true;try{if(await research.handler(req,res,u))return true;}catch(e){if(e.statusCode===409)return json(res,{error:e.message},409);throw e;}
  if(p==='/api/pro/metadata'&&req.method==='GET'){
   const [c]=await modules();return json(res,{app:'PokerLab',version:'0.3.0',title:'私人德州训练工作台',hardware:{cpu:os.cpus()[0]?.model,threads:os.cpus().length,memoryGB:Math.round(os.totalmem()/2**30),gpu:'NVIDIA RTX 4090 · 24 GB',cudaReady:fs.existsSync(path.join(root,'lib','multi-equity.ptx'))},examples:presets(),importExamples:IMPORT_EXAMPLES,localCoach:localCoachStatus(),lessons:c.listLessons(),engines:[{id:'hu-postflop',name:'HUPostflop 双人三街',scope:'双人翻牌至河牌；预算内完整树提供独立 EV 与最佳响应核验',rake:false,actionEV:'complete-tree-with-independent-evaluation',nodeLocking:false,limits:['只导出当前街时不提供行动 EV','原生报告与独立指标分开显示','未来公共牌联合概率已在本地修复并独立验证']},{id:'turnlab',name:'TurnLab 转牌→河牌',scope:'2–4 人，枚举下一张公共牌与两街完整行动',rake:'fixed-cap-reached-at-root',exactChance:true,nodeLocking:true,limits:['限定范围与树预算','未提供翻牌三街求解']},{id:'riverlab',name:'RiverLab 多人河牌',scope:'2–6 人河牌，受组合与行动树预算限制',actions:['check','bet','fold','call','raise','all-in'],rake:'fixed-cap-reached-at-root',exactChance:true,nodeLocking:true,limits:['支持无抽水或起点已封顶的固定抽水','当前街从起点建树','独立范围先验条件于无撞牌，未包含弃牌者信息']},{id:'gpu-river',name:'NVIDIA GPU 精确策略 · 实验',scope:'2–3 人河牌，FP64 完整机会枚举并经 CPU 独立最佳响应核验',rake:'fixed-cap-reached-at-root',exactChance:true,nodeLocking:true,limits:['默认显存预算 4 GB，可设至 16 GB','可选独立残差自适应停止；迭代与时间仍为预算上限','小任务可能比 CPU 慢']},{id:'cuda-equity',name:'CUDA 多人权益',scope:'2–9 人权益；权益实验室支持翻前至河牌及显式范围阶段',strategy:false}],limitations:['权益与策略 EV 是不同结果','数值残差只适用于所建树与输入假设','尚未验证教学能提高实战胜率']});
  }
  if(p==='/api/pro/parse'&&req.method==='POST'){const b=await body(req);return json(res,parseScenario(b.text,{...b.options,...(b.unit?{unit:b.unit}:{}),...(b.bigBlind?{bigBlind:b.bigBlind}:{}),format:b.format||'auto'}));}
  if(p==='/api/pro/input-provenance'&&req.method==='POST'){const b=await body(req);return json(res,verifyInput(b.scenario,b.inputContext??b.scenario?.inputContext));}
  if(p==='/api/pro/validate'&&req.method==='POST'){const b=await body(req);return json(res,validateScenario(b.scenario??b,{requireRanges:b.requireRanges!==false}));}
  if(p==='/api/pro/ranges'&&req.method==='GET'){const {listRangeSnippets}=await import('./range-library.mjs');return json(res,listRangeSnippets(root,{includeArchived:u.searchParams.get('archived')==='true'}));}
  if(p==='/api/pro/ranges'&&req.method==='POST'){const {saveRangeSnippet}=await import('./range-library.mjs');return json(res,saveRangeSnippet(root,await body(req)));}
  const rangeArchive=p.match(/^\/api\/pro\/ranges\/([a-f0-9-]{36})\/archive$/);if(rangeArchive&&req.method==='POST'){const b=await body(req),{archiveRangeSnippet}=await import('./range-library.mjs');return json(res,archiveRangeSnippet(root,rangeArchive[1],b.archived!==false));}
  if(p==='/api/pro/library'&&req.method==='GET'){const solved=safeRead(path.join(root,'data','library','index.json'),[]);return json(res,listStudyLibrary().map(x=>({...x,solved:solved.find(s=>s.presetId===x.id&&s.status==='complete')??null})));}
  if(p==='/api/pro/backups'&&req.method==='GET')return json(res,listLocalBackups(root));
  if(p==='/api/pro/backups'&&req.method==='POST')return json(res,createLocalBackup(root));
  if(p==='/api/pro/backups/download'&&req.method==='GET'){const file=backupFile(root,u.searchParams.get('name'));res.writeHead(200,{'Content-Type':'application/gzip','Content-Disposition':`attachment; filename="${path.basename(file)}"`});fs.createReadStream(file).pipe(res);return true;}
  if(p==='/api/pro/backups/import'&&req.method==='POST'){if(research?.busy||lab.busy||inbox.busy||analyzing||coachBusy||[...jobs.values()].some(x=>isActive(x.job))||[...experiments.values()].some(x=>isActive(x.record)))throw Error('请等待当前计算和牌谱导入结束再导入备份。');const compressed=await readBackupUpload(req);assertOpen();if(research?.busy||lab.busy||inbox.busy||analyzing||coachBusy||[...jobs.values()].some(x=>isActive(x.job))||[...experiments.values()].some(x=>isActive(x.record)))throw Error('上传期间开始了新任务，请等待结束后再导入。');const restored=restoreCompressedBackup(root,compressed);inbox.invalidateIndex();return json(res,restored);}
  if(p==='/api/pro/backups/restore'&&req.method==='POST'){const b=await body(req);if(research?.busy||lab.busy||inbox.busy||analyzing||coachBusy||[...jobs.values()].some(x=>isActive(x.job))||[...experiments.values()].some(x=>isActive(x.record)))throw Error('请等待当前任务结束再恢复备份。');const restored=b.name?restoreLocalBackup(root,b.name):restoreUserData(root,b.backup);inbox.invalidateIndex();return json(res,restored);}
  if(['/api/pro/training/guided','/api/pro/training/guides','/api/pro/training/guide'].includes(p)&&req.method==='GET'){const [c]=await modules();return json(res,u.searchParams.has('id')?c.getGuidedLesson(u.searchParams.get('id')):c.listGuidedLessons());}
  if(p==='/api/pro/analyze'&&req.method==='POST'){
   const b=await body(req),scenario=normalizeScenario(b.scenario??b),provenance=verifyInput(scenario,b.inputContext??b.scenario?.inputContext??b.inputContext);if(gpuPolicyActive()&&b.engine!=='cpu')return json(res,{error:'4090 正在求解策略，请等待完成或取消后再计算 GPU 权益。'},409);if(analyzing||research.busy)return json(res,{error:'已有权益计算正在进行，请稍后再试。'},409);analyzing=true;
   const options={samples:b.samples??b.options?.samples??1000000,engine:b.engine??'gpu'},cacheKey=hash({scenario,options,version:3}),cacheFile=path.join(data,'analyses',cacheKey+'.json');
   const cached=safeRead(cacheFile);if(cached){saveAnalysis(cacheFile,cached,scenario);analyzing=false;return json(res,{...cached,cached:true,inputProvenance:provenance});}
   const w=new Worker(new URL('./pro-analysis-worker.mjs',import.meta.url),{workerData:{scenario,options}});workers.add(w);let sent=false;const cancelAnalysis=()=>{w.postMessage({cancel:true});ownedProcesses.stop(w);w.terminate();};const timer=setTimeout(cancelAnalysis,140000);res.on('close',()=>{if(!res.writableEnded&&!sent){sent=true;cancelAnalysis();}});
   w.on('message',async m=>{if(m.type==='process'){ownedProcesses.observe(w,m);return;}if(sent)return;sent=true;if(m.ok){try{const [,coach]=await modules();m.result.explanation=coach.buildCoachReport(scenario,m.result,{kind:'equity'});}catch{}saveAnalysis(cacheFile,m.result,scenario);json(res,{...m.result,inputProvenance:provenance});}else json(res,{error:m.error},400);});
   w.on('error',e=>{if(!sent){sent=true;json(res,{error:e.message},500);}});w.on('exit',async()=>{clearTimeout(timer);workers.delete(w);const clean=await ownedProcesses.drain(w);analyzing=!clean;if(!sent){sent=true;json(res,{error:'权益计算未完成，请减少样本或检查输入。'},500);}});return true;
  }
  if(p==='/api/pro/solve'&&req.method==='POST'){try{return json(res,await startPolicySolve(await body(req)));}catch(e){if(e.statusCode===409)return json(res,{error:e.message},409);throw e;}}
  if(p==='/api/pro/jobs'&&req.method==='GET'){const all=new Map(list('jobs').map(j=>[j.id,j]));for(const {job} of jobs.values())all.set(job.id,savedSummary(job));return json(res,[...all.values()].sort((a,b)=>b.startedAt-a.startedAt));}
  if(p==='/api/pro/experiments'&&req.method==='GET')return json(res,list('experiments').sort((a,b)=>b.createdAt.localeCompare(a.createdAt)));
  const debriefMatch=p.match(/^\/api\/pro\/experiments\/([a-f0-9-]{36})\/debrief$/);
  if(debriefMatch&&req.method==='POST'){
   const b=await body(req),record=experiments.get(debriefMatch[1])?.record??safeRead(fileFor('experiments',debriefMatch[1]));if(!record)throw Error('找不到这份范围实验。');
   const [{reconstructSensitivityEvidence},{buildSensitivityDebrief}]=await Promise.all([import('./sensitivity-evidence.mjs'),import('./sensitivity-debrief.mjs')]);assertOpen();
   const checked=await reconstructSensitivityEvidence(record,{getJob,getResult}),debrief=buildSensitivityDebrief(checked,{toleranceBB:b.toleranceBB,actionId:b.actionId});
   return json(res,{...debrief,evidence:checked.evidence});
  }
  const expMatch=p.match(/^\/api\/pro\/experiments\/([a-f0-9-]{36})(?:\/(cancel))?$/);
  if(expMatch){const [,id,action]=expMatch,active=experiments.get(id),record=active?.record??safeRead(fileFor('experiments',id));if(!record)throw Error('找不到范围实验。');if(action==='cancel'&&req.method==='POST'&&active&&isActive(record)){await body(req);record.cancelRequested=true;record.status='cancelling';active.worker.postMessage({cancel:true});ownedProcesses.stop(active.worker);writeJSON(fileFor('experiments',id),withoutPids(record));if(active.worker.threadId===-1)active.finish('cancelled');else setTimeout(()=>active.worker.terminate(),2000);}return json(res,withoutPids(record));}
  const match=p.match(/^\/api\/pro\/jobs\/([a-f0-9-]{36})(?:\/(node|cancel|download|explain|observed-path|sensitivity))?$/);
  if(match){const [,id,action]=match,j=getJob(id);
   if(!action&&req.method==='GET')return json(res,savedSummary(j));
   if(action==='cancel'&&req.method==='POST'){await body(req);const x=jobs.get(id);if(x&&isActive(x.job)){x.job.cancelRequested=true;x.job.status='cancelling';x.job.progress={...x.job.progress,phase:'cancelling'};writeJSON(fileFor('jobs',id),savedSummary(x.job));x.worker.postMessage({cancel:true});ownedProcesses.stop(x.worker);if(x.worker.threadId===-1)x.finish('cancelled');else setTimeout(()=>x.worker.terminate(),2000);}return json(res,{ok:true,status:x?.job.status??j.status});}
   if(action==='node'&&req.method==='POST'){const b=await body(req),result=getResult(id);let node=riverNode(result,'n0');for(const a of b.path??[]){const next=node.actions.find(x=>x.id===a);if(!next)throw Error('该行动路径不存在。');node=riverNode(result,next.childId);}const [,coach]=await modules();return json(res,{node,inputProvenance:savedInputAssessment(j),diagnostics:result.diagnostics,chance:result.chance,validation:result.validation,capabilities:result.capabilities??{actionEV:true,nodeLock:true,studyCards:result.chance?.exact===true,evBreakdown:result.chance?.exact===true,fullTree:true},limits:result.limits,assumptions:result.assumptions,outputScope:result.outputScope,scope:result.scope,rakeModel:result.rakeModel,explanation:coach.buildCoachReport(j.scenario,result,{kind:'strategy',nodeId:node.id,focusCombo:b.combo})});}
   if(action==='sensitivity'&&req.method==='POST'){
    if(research?.busy||lab.busy||[...jobs.values()].some(x=>isActive(x.job))||[...experiments.values()].some(x=>isActive(x.record)))return json(res,{error:'已有策略计算运行中，请等待完成或取消。'},409);
    const b=await body(req),experimentId=crypto.randomUUID(),input={scenario:j.scenario,settings:j.settings??{},player:Number(b.player),subset:String(b.subset||''),combo:String(b.combo||''),nodePath:b.nodePath??[],scales:b.scales??[.25,.5,1]};
    if(research?.busy||lab.busy||[...jobs.values()].some(x=>isActive(x.job))||[...experiments.values()].some(x=>isActive(x.record)))return json(res,{error:'已有策略计算开始，请等待完成或取消。'},409);
    verifyInput(j.scenario,j.inputContext);getResult(id);const record={id:experimentId,sourceJobId:id,status:'running',createdAt:new Date().toISOString(),input,variants:[],progress:{phase:'preparing'}};
    const w=new Worker(new URL('./sensitivity-worker.mjs',import.meta.url),{workerData:{input,resultFile:path.join(data,'jobs',id,'result.json'),jobsDir:path.join(data,'jobs'),sourceJobId:id,experimentId}}),entry={record,worker:w};workers.add(w);experiments.set(experimentId,entry);writeJSON(fileFor('experiments',experimentId),record);let done=false,settling=null;
    const finish=(status,error)=>{if(done||settling)return settling;settling=(async()=>{const clean=await ownedProcesses.drain(w);if(!clean){record.status='cleanup-required';record.error='后台实验尚未完全停止，请再次停止计算。';writeJSON(fileFor('experiments',experimentId),withoutPids(record));settling=null;return;}done=true;record.status=record.cancelRequested?'cancelled':status;record.finishedAt=new Date().toISOString();if(error)record.error=error;writeJSON(fileFor('experiments',experimentId),withoutPids(record));})();return settling;};entry.finish=finish;
    w.on('message',m=>{if(m.type==='progress'){ownedProcesses.observe(w,m.progress);if(record.cancelRequested)ownedProcesses.stop(w);if(!done)record.progress=record.cancelRequested?{...m.progress,phase:'cancelling'}:m.progress;}if(m.type==='variant'&&!record.cancelRequested){ownedProcesses.forget(w);writeJSON(fileFor('jobs',m.job.id),m.job);record.variants.push({jobId:m.job.id,index:m.index,scale:m.scale});}if(m.type==='result'){if(!record.cancelRequested)record.result=m.result;finish('complete');}if(m.type==='error')finish('failed',m.error);});w.on('error',e=>finish('failed',e.message));w.on('exit',()=>{workers.delete(w);if(!done)finish('interrupted','范围实验尚未完成；已完成的独立求解仍保留。');});return json(res,withoutPids(record));
   }
   if(action==='observed-path'&&req.method==='POST'){const b=await body(req),result=getResult(id),provenance=verifyInput(j.scenario,j.inputContext??b.inputContext,{observed:true});return json(res,observedPath(j.scenario,result,provenance.inputContext));}
   if(action==='explain'&&req.method==='POST'){const b=await body(req),result=getResult(id);let node=riverNode(result);for(const a of b.path??b.nodePath??[]){const next=node.actions.find(x=>x.id===a);if(!next)throw Error('收益拆解路径不存在。');node=riverNode(result,next.childId);}return json(res,{...await decisionDetails(id,node.id,b.combo),inputProvenance:savedInputAssessment(j)});}
   if(action==='download'&&req.method==='GET'){const result=getResult(id);res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="pokerlab-solve.json"'});res.end(JSON.stringify(result));return true;}
  }
  if(p==='/api/pro/cases'&&req.method==='GET')return json(res,list('cases').sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)));
  if(p==='/api/pro/cases'&&req.method==='POST'){const b=await body(req),scenario=normalizeScenario(b.scenario,{requireRanges:false}),id=b.id&&idOK(b.id)?b.id:crypto.randomUUID(),old=safeRead(fileFor('cases',id));const needsRanges=scenario.players.some(p=>!p.range.trim());const item={id,draft:needsRanges,needsRanges,title:String(b.title||scenario.title||'未命名研究').slice(0,160),scenario,notes:String(b.notes||'').slice(0,20000),tags:Array.isArray(b.tags)?b.tags.map(String).slice(0,20):[],jobId:idOK(b.jobId??'')?b.jobId:null,inputContext:inputContext(b.inputContext??old?.inputContext),settings:solveSettings(b.settings??old?.settings??{}),createdAt:old?.createdAt??new Date().toISOString(),updatedAt:new Date().toISOString(),savedAt:new Date().toISOString()};writeJSON(fileFor('cases',id),item);return json(res,item);}
  if(p==='/api/pro/training/lessons'&&req.method==='GET'){const [c]=await modules();return json(res,c.listLessons());}
  if(p==='/api/pro/training/lesson'&&req.method==='GET'){const [c]=await modules();return json(res,c.getLesson(u.searchParams.get('id'),{reveal:false}));}
  if(p==='/api/pro/training/summary'&&req.method==='GET'){const [c]=await modules(),attempts=list('training');return json(res,c.buildTrainingSummary(attempts));}
  if(p==='/api/pro/training/attempt'&&req.method==='POST'){const b=await body(req),[c]=await modules(),previous=list('training').filter(a=>a.lessonId===b.lessonId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];const feedback=c.gradeAttempt(b,previous);const attempt={...copy(b),id:crypto.randomUUID(),createdAt:new Date().toISOString(),...feedback};writeJSON(fileFor('training',attempt.id),attempt);return json(res,{attempt,feedback,summary:c.buildTrainingSummary(list('training'))});}
  if(p==='/api/pro/training/history'&&req.method==='GET')return json(res,list('training').sort((a,b)=>b.createdAt.localeCompare(a.createdAt)));
  if(p==='/api/pro/training/study-history'&&req.method==='GET')return json(res,list('study-attempts').sort((a,b)=>b.createdAt.localeCompare(a.createdAt)));
  if(p==='/api/pro/training/from-solve'&&req.method==='POST'){
   const b=await body(req),j=getJob(b.jobId),result=getResult(b.jobId),[,coach]=await modules();let node=riverNode(result);
   for(const a of b.nodePath??[]){const action=node.actions.find(x=>x.id===a);if(!action)throw Error('训练节点路径不存在。');node=riverNode(result,action.childId);}
   const card=coach.createStudyQuestion(j.scenario,result,{nodeId:node.id,combo:b.combo,evTolerance:b.evTolerance??.02});const id=crypto.randomUUID(),entry={id,createdAt:new Date().toISOString(),jobId:j.id,nodePath:b.nodePath??[],scenario:j.scenario,...card};writeJSON(fileFor('study-cards',id),entry);return json(res,{id,createdAt:entry.createdAt,jobId:j.id,publicQuestion:entry.publicQuestion});
  }
  if(p==='/api/pro/training/study-summary'&&req.method==='GET')return json(res,await privateReview());
  if(p==='/api/pro/training/study-cards'&&req.method==='GET'){const reviews=await privateReview(),byId=new Map(reviews.byCard.map(r=>[r.id,r]));return json(res,list('study-cards').map(x=>({id:x.id,createdAt:x.createdAt,jobId:x.jobId,publicQuestion:x.publicQuestion,attempts:byId.get(x.id)?.attempts??0,review:byId.get(x.id)??null})));}
  if(p==='/api/pro/training/study-attempt'&&req.method==='POST'){
   const b=await body(req),card=safeRead(fileFor('study-cards',b.cardId));if(!card)throw Error('找不到训练题。');const [,coach]=await modules(),feedback=coach.gradeStudyQuestion(card.full,b),attempt={...copy(b),id:crypto.randomUUID(),createdAt:new Date().toISOString(),...feedback};writeJSON(fileFor('study-attempts',attempt.id),attempt);const reviews=await privateReview();return json(res,{attempt,feedback,review:reviews.byCard.find(r=>r.id===card.id)??null,reviewSummary:reviews.summary});
  }
  if(p==='/api/pro/coach/unload'&&req.method==='POST'){if(coachBusy)return json(res,{error:'请等待当前解释生成结束。'},409);stopLocalCoach();return json(res,localCoachStatus());}
  if(p==='/api/pro/coach'&&req.method==='POST'){
   const b=await body(req),[,coach]=await modules();let scenario=normalizeScenario(b.scenario),result=null,kind='equity',nodeId='n0',currentBoard=null;
   if(b.jobId){const job=getJob(b.jobId);if(scenarioKey(scenario)!==scenarioKey(job.scenario))throw Error('输入局面已改变。请恢复这次求解的局面，或重新求解后请求解释。');scenario=job.scenario;result=getResult(b.jobId);kind='strategy';let node=riverNode(result);for(const a of b.nodePath??[]){const act=node.actions.find(x=>x.id===a);if(!act)throw Error('解读路径无效。');node=riverNode(result,act.childId);}nodeId=node.id;currentBoard=node.board??null;}
   else if(b.analysisId||b.analysis?.id)result=getAnalysis(b.analysisId??b.analysis.id,scenario);
   const provenance=verifyInput(scenario,b.jobId?getJob(b.jobId).inputContext:b.inputContext??b.scenario?.inputContext);
   const report=coach.buildCoachReport(scenario,result,{kind,nodeId,focusCombo:b.combo});report.inputProvenance={...provenance,inputContext:undefined};
   if(b.jobId&&b.combo)try{appendDecisionEvidence(report,await decisionDetails(b.jobId,nodeId,b.combo));}catch(e){report.limitations.push('本次未加入独立收益拆解：'+e.message);}
   if(gpuPolicyActive()&&b.localModel!==false)return json(res,{report,text:report.sections.map(s=>s.title+'\n'+s.body).join('\n\n'),model:'可核验规则解释',grounding:'deterministic',warning:'4090 正在求解策略，当前先提供计算证据；求解完成后可再生成中文教练解读。',limitations:report.limitations});
   if(b.localModel===false)return json(res,{report,text:report.sections.map(s=>s.title+'\n'+s.body).join('\n\n'),model:'可核验规则解释',grounding:'deterministic',limitations:report.limitations});
   const question=String(b.question||'请解释这个局面，并给我一个迁移练习。').slice(0,3000),coachCache=path.join(data,'coach',hash({report,question,model:'qwen36-27b-q4',prompt:LOCAL_COACH_PROMPT_VERSION})+'.json'),cachedCoach=safeRead(coachCache);if(cachedCoach)return json(res,{...cachedCoach,report,cached:true});
   assertOpen();if(coachBusy)return json(res,{error:'本地教练正在生成上一段解释，请稍后重试。',report},409);coachBusy=true;
   try{const r=await generateLocalCoach({report,question,scenario:currentBoard?{...scenario,board:currentBoard}:scenario});if(r.grounding==='local-language-model-over-verified-evidence')writeJSON(coachCache,r);return json(res,{...r,report});}finally{coachBusy=false;}
  }
  if(p==='/api/pro/export'&&req.method==='GET')return json(res,exportUserData(root,{includeResults:u.searchParams.get('results')==='true'}));
  if(p==='/api/pro/status'&&req.method==='GET')return json(res,{analyzing,coachBusy,activeResearchJobs:research.active,activeRangeEvaluations:lab.activeEvaluations,activeImport:inbox.status,localCoach:localCoachStatus(),activeExperiments:[...experiments.values()].filter(x=>isActive(x.record)).map(x=>withoutPids(x.record)),activeJobs:[...jobs.values()].filter(x=>isActive(x.job)).map(x=>savedSummary(x.job))});
  if(p==='/api/pro/shutdown'&&req.method==='POST'){json(res,{ok:true,message:'工作台正在安全关闭。'});setTimeout(onShutdown,100);return true;}
  return json(res,{error:'未知专业训练接口。'},404);
 }
 return {handler,shutdown};
}
