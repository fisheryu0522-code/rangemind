import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {prepareRiverGame} from './river-engine.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const PYTHON=(process.env.POKERLAB_PYTHON||'python');
export const GPU_RIVER_IMPLEMENTATION_VERSION='1.1.0-adaptive-exact-fp64';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

export function prepareGPURiverGame(raw){
  if(raw?.chanceMode&&raw.chanceMode!=='exact')throw Error('GPU 策略实验仅允许完整机会枚举，不会用抽样代替。');
  if(!['cfr-plus','dcfr','alternating-cfr-plus'].includes(raw?.algorithm??'alternating-cfr-plus'))throw Error('GPU 策略实验只支持 CFR+、alternating CFR+ 与 DCFR。');
  if(!Array.isArray(raw?.players)||raw.players.length<2||raw.players.length>3)throw Error('GPU 策略实验当前验证 2–3 人河牌。');
  const prepared=prepareRiverGame({...raw,maxNodeVisits:raw.maxNodeVisits??1000000000000,algorithm:raw?.algorithm??'alternating-cfr-plus',chanceMode:'exact',zeroReachPruning:false});
  if(raw.adaptivePrecision!==undefined&&typeof raw.adaptivePrecision!=='boolean')throw Error('adaptivePrecision 必须为布尔值。');
  const adaptiveCheckEvery=Number(raw.adaptiveCheckEvery??1000);if(!Number.isInteger(adaptiveCheckEvery)||adaptiveCheckEvery<1||adaptiveCheckEvery>1000000)throw Error('adaptiveCheckEvery 必须为 1–1,000,000 的整数。');
  prepared.adaptivePrecision=raw.adaptivePrecision===true;prepared.adaptiveCheckEvery=adaptiveCheckEvery;
  if(prepared.adaptivePrecision&&!Number.isFinite(prepared.accuracy))throw Error('自适应精度必须提供明确的 accuracy 目标；轮数和时间仍是上限。');
  const gpuMemoryBytes=Number(raw.gpuMemoryBytes??4000000000);if(!Number.isFinite(gpuMemoryBytes)||gpuMemoryBytes<1000000||gpuMemoryBytes>16000000000)throw Error('GPU 显存预算应为 1 MB–16 GB。');
  prepared.gpuMemoryBytes=gpuMemoryBytes;prepared.captureIterations=raw.captureIterations??[];
  if(!Array.isArray(prepared.captureIterations)||prepared.captureIterations.length>10||prepared.captureIterations.some(x=>!Number.isInteger(x)||x<1||x>prepared.iterations))throw Error('调试迭代快照最多 10 个，且必须位于迭代范围内。');
  let strategyCells=0,infoSets=0;for(const n of prepared.nodes)if(n.actor>=0){const C=prepared.combinations[n.actor].length;infoSets+=C;strategyCells+=C*n.actions.length;}
  if(!infoSets)throw Error('此局面没有玩家决策节点，无需进行 GPU 策略迭代。');
  const N=prepared.players.length,D=prepared.deals.length,M=prepared.nodes.length,estimateBytes=M*N*D*8+strategyCells*32+N*D*20+M*N*12+infoSets*16;
  if(estimateBytes>gpuMemoryBytes)throw Error(`完整 GPU 策略工作区预估 ${(estimateBytes/1e9).toFixed(2)} GB，超过 ${(gpuMemoryBytes/1e9).toFixed(2)} GB 预算；请缩小树或范围。未切换为抽样。`);
  prepared.gpuEstimate={bytes:estimateBytes,strategyCells,infoSets,legalDeals:D,publicNodes:M};return prepared;
}

function track(child,processes,onProgress,role){
  let finish;const closed=new Promise(resolve=>{finish=resolve;}),entry={child,closed};if(child.pid)processes.set(child.pid,entry);
  onProgress({phase:'running',processId:child.pid??null,processIds:[...processes.keys()],role});
  child.once('close',()=>{if(child.pid)processes.delete(child.pid);onProgress({phase:'process-exited',processId:null,exitedProcessId:child.pid??null,processIds:[...processes.keys()],role});finish();});return entry;
}
function killAll(processes){for(const {child} of processes.values())try{child.kill();}catch{}}
async function waitAll(processes){while(processes.size)await Promise.allSettled([...processes.values()].map(p=>p.closed));}
async function run(executable,args,{cwd,signal,onProgress=()=>{},maxSeconds=1200,processes=new Map(),role='cpu-verification'}={}){
  return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(Error('GPU 策略实验已取消。'));let done=false,stderr='',pending='',timedOut=false;
    const child=spawn(executable,args,{cwd,windowsHide:true});track(child,processes,onProgress,role);const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();const timer=setTimeout(()=>{timedOut=true;child.kill();},(maxSeconds+60)*1000);
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    child.stdout.on('data',data=>{pending+=data.toString();const rows=pending.split(/\r?\n/);pending=rows.pop();for(const row of rows)try{onProgress(JSON.parse(row));}catch{}});child.stderr.on('data',data=>stderr=(stderr+data.toString()).slice(-10000));
    child.on('error',error=>{if(done)return;done=true;cleanup();reject(error);});child.on('close',code=>{if(done)return;done=true;cleanup();if(signal?.aborted)return reject(Error('GPU 策略实验已取消。'));if(timedOut)return reject(Error('GPU 策略实验超过时间上限。'));if(code!==0)return reject(Error(stderr||`策略实验进程退出 ${code}`));resolve();});
  });
}

/** Native evaluation fixes the imported policy at every information set, then
 * uses UNRESTRICTED BR. Its constrained residual would be zero by construction
 * and is explicitly excluded from the returned experimental quality report. */
export async function verifyGPUPolicy(prepared,gpu,{directory,signal,onProgress=()=>{},enginePath,processes}={}){
  const created=!directory,dir=directory??fs.mkdtempSync(path.join(os.tmpdir(),'pokerlab-gpu-verify-'));fs.mkdirSync(dir,{recursive:true});
  try{
    if(!Array.isArray(gpu.policy)||!Array.isArray(gpu.profileEV)||gpu.profileEV.length!==prepared.players.length||gpu.profileEV.some(x=>!Number.isFinite(x)))throw Error('GPU 策略或收益元数据不完整。');
    const started=performance.now(),locks=gpu.policy.map(p=>({node:p.node,combo:p.combo,probabilities:p.probabilities}));
    const expected=prepared.nodes.reduce((sum,n)=>sum+(n.actor<0?0:prepared.combinations[n.actor].length),0);if(locks.length!==expected)throw Error('GPU 导出的信息集数量与完整公开树不一致。');
    const seen=new Set();for(const l of locks){const n=prepared.nodes[l.node],key=`${l.node}:${l.combo}`;if(!Number.isInteger(l.node)||!Number.isInteger(l.combo)||seen.has(key)||!n||n.actor<0||l.combo<0||l.combo>=prepared.combinations[n.actor].length||!Array.isArray(l.probabilities)||l.probabilities.length!==n.actions.length||l.probabilities.some(x=>!Number.isFinite(x)||x<0)||Math.abs(l.probabilities.reduce((a,b)=>a+b,0)-1)>1e-8)throw Error('GPU 信息集概率数据未通过完整性验证。');seen.add(key);}
    const input=path.join(dir,'evaluation-input.json'),output=path.join(dir,'evaluation-result.json');fs.writeFileSync(input,JSON.stringify({...prepared,evaluationOnly:true,iterations:1,averagingDelay:0,checkEvery:1,accuracy:null,algorithm:'cfr-plus',locks}));
    await run(enginePath??path.join(ROOT,'engines/RiverLab/river-engine.exe'),[input,output],{signal,maxSeconds:prepared.maxSeconds,processes,onProgress:p=>onProgress({...p,phase:'cpu-independent-verification'})});
    const native=JSON.parse(fs.readFileSync(output));if(native.evaluationOnly!==true||native.stats.iterations!==0)throw Error('原生引擎不支持独立策略评估入口，请更新后重试。');const maxDifference=Math.max(...gpu.profileEV.map((v,p)=>Math.abs(v-native.diagnostics.profileEV[p])));
    const d=native.diagnostics,N=prepared.players.length;if(d.bestResponseIgnoresLocks!==true||['profileEV','bestResponseEV','gain'].some(k=>!Array.isArray(d[k])||d[k].length!==N||d[k].some(v=>!Number.isFinite(v)))||![d.nashConv,d.nashConvPctPot,d.constantSum].every(Number.isFinite))throw Error('CPU 缺少非受约束最佳响应证据，不能使用临时全锁的零残差。');
    const tolerance=1e-7*Math.max(1,prepared.pot);if(Math.abs(d.profileEV.reduce((a,b)=>a+b,0)-(prepared.pot-prepared.fixedRake))>tolerance||Math.abs(d.constantSum-(prepared.pot-prepared.fixedRake))>tolerance||Math.abs(d.gain.reduce((a,b)=>a+b,0)-d.nashConv)>tolerance||Math.abs(d.nashConv/prepared.pot*100-d.nashConvPctPot)>1e-7||d.gain.some((v,p)=>v<0||Math.abs(v-Math.max(0,d.bestResponseEV[p]-d.profileEV[p]))>tolerance))throw Error('CPU 最佳响应或常和诊断不一致，精度结果未发布。');
    if(native.nodes.length!==prepared.nodes.length)throw Error('CPU 核验返回不同的公开树。');
    for(const p of gpu.policy){const expected=prepared.nodes[p.node],node=native.nodes[p.node],row=node?.combos?.[p.combo];if(node?.id!==expected.id||node.actor!==expected.actor||node.actions.length!==expected.actions.length||node.actions.some((a,i)=>a.id!==expected.actions[i].id||a.childId!==expected.actions[i].childId)||row?.combo!==prepared.combinations[expected.actor][p.combo].combo||row.probabilities.length!==p.probabilities.length||row.probabilities.some((v,i)=>Math.abs(v-p.probabilities[i])>1e-12))throw Error('CPU 核验的完整策略与 GPU 检查点不一致，结果未发布。');}
    if(maxDifference>1e-7*Math.max(1,prepared.pot))throw Error(`GPU 与独立 CPU 策略收益不同：${maxDifference} BB；结果未发布。`);
    return {native,seconds:(performance.now()-started)/1000,maxProfileDifference:maxDifference,quality:{nashConv:native.diagnostics.nashConv,nashConvPctPot:native.diagnostics.nashConvPctPot,profileEV:native.diagnostics.profileEV,bestResponseEV:native.diagnostics.bestResponseEV,gain:native.diagnostics.gain,constantSum:native.diagnostics.constantSum,verifiedBy:'Independent CPU information-set-consistent UNRESTRICTED exact best response to the imported GPU average policy',constrainedResidualUsed:false}};
  }finally{if(created&&dir.startsWith(path.join(os.tmpdir(),'pokerlab-gpu-verify-')))fs.rmSync(dir,{recursive:true,force:true});}
}

async function adaptiveRun(prepared,{dir,python,signal,onProgress,enginePath,started}){
  const controller=new AbortController(),processes=new Map(),nonce=randomUUID(),checkpointDir=fs.mkdtempSync(path.join(dir,'checkpoints-'));
  let deadlineReached=false,userCancelled=signal?.aborted===true,failure=null,lastVerified=null,checks=[],stopReason=null,pending='',stderr='',queue=Promise.resolve(),expectedIteration=Math.min(prepared.iterations,Math.max(prepared.averagingDelay+1,prepared.adaptiveCheckEvery)),checkpointNumber=0,lastReportedIteration=0,lastTrainingSeconds=0,trainingActive=false,verificationSecondsSpent=0,incompleteVerificationSeconds=0;
  const deadline=started+prepared.maxSeconds*1000,remaining=()=>Math.max(0,(deadline-performance.now())/1000);
  const cancel=()=>{userCancelled=true;controller.abort();},abortChildren=()=>killAll(processes);signal?.addEventListener('abort',cancel,{once:true});controller.signal.addEventListener('abort',abortChildren);
  const timer=setTimeout(()=>{deadlineReached=true;controller.abort();},Math.max(1,deadline-performance.now()));
  if(userCancelled)controller.abort();
  const inputFile=path.join(dir,`adaptive-input-${nonce}.json`),outputFile=path.join(dir,`adaptive-output-${nonce}.json`),payload=Buffer.from(JSON.stringify({...prepared,_adaptive:{enabled:true,nonce,directory:checkpointDir,checkEvery:prepared.adaptiveCheckEvery}})),inputSHA256=hash(payload),kernelSHA256=hash(fs.readFileSync(path.join(ROOT,'lib/gpu-river-cfr.ptx')));
  fs.writeFileSync(inputFile,payload,{flag:'wx'});
  let child,closedCode=null;
  const checkCancelled=()=>{if(!controller.signal.aborted&&performance.now()>=deadline){deadlineReached=true;controller.abort();}if(controller.signal.aborted)throw Error(userCancelled?'GPU 自适应精度已取消。':'GPU 自适应精度达到全流程时间预算。');};
  const send=message=>{checkCancelled();if(!child?.stdin.writable)throw Error('GPU 自适应控制管道已关闭。');child.stdin.write(JSON.stringify(message)+'\n');};
  async function checkpoint(event){
    checkCancelled();trainingActive=false;
    if(event.nonce!==nonce||event.inputSHA256!==inputSHA256||event.checkpoint!==checkpointNumber+1||event.iteration!==expectedIteration||event.file!==`checkpoint-${event.checkpoint}.json`||!(/^[0-9a-f]{64}$/).test(event.sha256??''))throw Error('GPU 检查点的会话、输入或迭代绑定不一致。');
    // Progress is intentionally before reading: a subsequent file mutation is
    // caught by the content hash, rather than evaluated as a different policy.
    onProgress({phase:'gpu-checkpoint',checkpoint:event.checkpoint,iteration:event.iteration,policySHA256:event.sha256,processIds:[...processes.keys()]});
    checkCancelled();const bytes=fs.readFileSync(path.join(checkpointDir,event.file));if(hash(bytes)!==event.sha256)throw Error('GPU 检查点文件摘要不一致，拒绝修改或旧文件。');
    const gpu=JSON.parse(bytes);if(gpu.nonce!==nonce||gpu.inputSHA256!==inputSHA256||gpu.checkpoint!==event.checkpoint||gpu.iterations!==event.iteration||gpu.algorithm!==prepared.algorithm||gpu.averagingDelay!==prepared.averagingDelay||gpu.kernelSHA256!==kernelSHA256||gpu.legalDeals!==prepared.deals.length||gpu.publicNodes!==prepared.nodes.length||gpu.chanceExact!==true||gpu.precision!=='float64')throw Error('GPU 平均策略与输入、内核或迭代不属于同一检查点。');
    checkpointNumber=event.checkpoint;lastReportedIteration=event.iteration;lastTrainingSeconds=gpu.trainingSeconds;
    const verificationDir=fs.mkdtempSync(path.join(dir,`verify-${event.checkpoint}-`));
    const verificationStarted=performance.now();let evaluated;
    try{evaluated=await verifyGPUPolicy({...prepared,maxSeconds:Math.max(.001,remaining())},gpu,{directory:verificationDir,signal:controller.signal,onProgress,enginePath,processes});}
    finally{const seconds=(performance.now()-verificationStarted)/1000;verificationSecondsSpent+=seconds;if(!evaluated)incompleteVerificationSeconds+=seconds;}
    const targetReached=evaluated.quality.nashConvPctPot<=prepared.accuracy;
    const record={checkpoint:event.checkpoint,iteration:gpu.iterations,policySHA256:event.sha256,inputSHA256,nashConv:evaluated.quality.nashConv,nashConvPctPot:evaluated.quality.nashConvPctPot,targetAccuracyPctPot:prepared.accuracy,targetReached,trainingSeconds:gpu.trainingSeconds,verificationSeconds:evaluated.seconds,verifiedBy:evaluated.quality.verifiedBy,constrainedResidualUsed:false};
    checks.push(record);lastVerified={gpu,evaluated,binding:{nonce,inputSHA256,policySHA256:event.sha256,kernelSHA256,checkpoint:event.checkpoint,iteration:gpu.iterations}};
    onProgress({phase:'precision-check-complete',...record,processIds:[...processes.keys()]});checkCancelled();
    if(targetReached||gpu.iterations>=prepared.iterations){stopReason=targetReached?'accuracy_target':'iteration_limit';send({command:'stop',reason:stopReason,nonce,checkpoint:event.checkpoint,sha256:event.sha256});return;}
    const perIteration=gpu.trainingSeconds/Math.max(1,gpu.iterations),costAwareBatch=perIteration>0?Math.ceil(2*evaluated.seconds/perIteration):prepared.adaptiveCheckEvery;
    const batch=Math.max(prepared.adaptiveCheckEvery,Math.ceil(gpu.iterations/2),costAwareBatch);expectedIteration=Math.min(prepared.iterations,gpu.iterations+batch);
    onProgress({phase:'gpu-continuing',iteration:gpu.iterations,nextCheckIteration:expectedIteration,lastVerifiedNashConvPctPot:evaluated.quality.nashConvPctPot,remainingSeconds:remaining(),processIds:[...processes.keys()]});
    send({command:'continue',nextIteration:expectedIteration,nonce,checkpoint:event.checkpoint,sha256:event.sha256});trainingActive=true;
  }
  try{
    checkCancelled();child=spawn(python,[path.join(ROOT,'lib/gpu-river-cfr.py'),inputFile,outputFile],{windowsHide:true});const tracked=track(child,processes,onProgress,'gpu-training');trainingActive=true;
    // Never leave a broken stdin pipe as an uncaught event after cancellation.
    child.stdin.on('error',error=>{if(!controller.signal.aborted){failure??=error;controller.abort();}});
    child.stdout.on('data',data=>{pending+=data.toString();const lines=pending.split(/\r?\n/);pending=lines.pop();for(const line of lines){let event;try{event=JSON.parse(line);}catch{if(line.trim()){failure??=Error('GPU 自适应进度协议包含非 JSON 记录。');controller.abort();}continue;}
      if(event.phase==='checkpoint-ready')queue=queue.then(()=>checkpoint(event)).catch(error=>{if(!controller.signal.aborted)failure??=error;controller.abort();});
      else{if(event.phase==='gpu-training'){lastReportedIteration=event.iteration;lastTrainingSeconds=event.seconds;}onProgress(event);}
    }});
    child.stderr.on('data',data=>{stderr=(stderr+data.toString()).slice(-10000);});
    child.on('error',error=>{if(!controller.signal.aborted)failure??=error;controller.abort();});
    child.on('close',code=>{closedCode=code;if(!controller.signal.aborted&&(!stopReason||code!==0)){failure??=Error(stderr||`GPU 常驻进程异常退出 ${code}。`);controller.abort();}});
    if(controller.signal.aborted)killAll(processes);
    await tracked.closed;await queue;
    if(userCancelled||signal?.aborted)throw Error('GPU 自适应精度已取消；未发布中间检查点。');
    if(failure)throw failure;
    if(!lastVerified)throw Error(deadlineReached?'全流程时间预算内没有完成独立精度核验；没有发布未核验策略。':stderr||'GPU 未返回独立核验的平均策略。');
    if(!deadlineReached&&closedCode!==0)throw Error(stderr||'GPU 未正常关闭，结果未发布。');
    const finalReason=stopReason??'time_limit';
    return {...lastVerified,adaptive:{stopReason:finalReason,checks,iterationsExecuted:trainingActive&&deadlineReached?null:lastReportedIteration,iterationsExecutedAtLeast:lastReportedIteration,trainingSeconds:lastTrainingSeconds,verificationSecondsSpent,incompleteVerificationSeconds,timingIncomplete:deadlineReached&&trainingActive,wallSeconds:(performance.now()-started)/1000}};
  }finally{
    clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.signal.removeEventListener('abort',abortChildren);killAll(processes);await waitAll(processes);
  }
}

export async function solveGPURiverGame(raw,{onProgress=()=>{},signal,python=PYTHON,workDir,verify=true,outputFile,enginePath}={}){
  const started=performance.now(),prepared=prepareGPURiverGame(raw),dir=workDir?path.resolve(workDir):fs.mkdtempSync(path.join(os.tmpdir(),'pokerlab-gpu-cfr-'));fs.mkdirSync(dir,{recursive:true});
  onProgress({phase:'prepared',...prepared.gpuEstimate});
  try{
    if(prepared.adaptivePrecision&&!verify)throw Error('自适应精度不能关闭独立 CPU 核验。');
    let gpu,evaluated,adaptive,binding;
    if(prepared.adaptivePrecision){({gpu,evaluated,adaptive,binding}=await adaptiveRun(prepared,{dir,python,signal,onProgress,enginePath,started}));}
    else{const input=path.join(dir,'gpu-input.json'),output=path.join(dir,'gpu-result.json');fs.writeFileSync(input,JSON.stringify(prepared));await run(python,[path.join(ROOT,'lib/gpu-river-cfr.py'),input,output],{signal,maxSeconds:prepared.maxSeconds,onProgress,role:'gpu-training'});gpu=JSON.parse(fs.readFileSync(output));}
    if(!verify)return {...gpu,input:prepared.input,verification:null,secondsIncludingPreparation:(performance.now()-started)/1000};
    evaluated??=await verifyGPUPolicy(prepared,gpu,{directory:dir,signal,onProgress,enginePath});if(signal?.aborted)throw Error('GPU 策略实验已取消；未发布中间检查点。');const result=evaluated.native;
    result.source={implementationVersion:GPU_RIVER_IMPLEMENTATION_VERSION,kernelSHA256:gpu.kernelSHA256,cpuEvaluatorVersion:result.implementationVersion};result.implementationVersion=GPU_RIVER_IMPLEMENTATION_VERSION;
    result.engine=gpu.engine;result.evaluationOnly=false;result.experimental=true;result.qualityVerified=true;result.stopReason=adaptive?.stopReason??gpu.stopReason;result.input=prepared.input;
    result.diagnostics={...evaluated.quality,locksPresent:prepared.locks.length>0,bestResponseIgnoresLocks:true,optimizationResidualPctPot:evaluated.quality.nashConvPctPot,residualForStopping:adaptive?'independent_unrestricted_nashConvPctPot':'not_used_for_stopping_gpu_fixed_iteration_experiment'};
    const locked=new Set();for(const l of prepared.locks){const n=prepared.nodes[l.node];for(let c=0;c<prepared.combinations[n.actor].length;c++)if(l.combo<0||l.combo===c)locked.add(`${l.node}:${c}`);}
    for(let i=0;i<result.nodes.length;i++)result.nodes[i].combos?.forEach((c,j)=>c.locked=locked.has(`${i}:${j}`));
    result.stats={...result.stats,iterations:gpu.iterations,averagedIterations:Math.max(0,gpu.iterations-prepared.averagingDelay),playerUpdatePasses:gpu.iterations*(gpu.algorithm==='alternating-cfr-plus'?prepared.players.length:1),seconds:(performance.now()-started)/1000,trainingSeconds:gpu.trainingSeconds,gpuPreparationSeconds:gpu.preparationSeconds,verificationSeconds:evaluated.seconds,algorithm:`GPU ${gpu.algorithm} · FP64`,precision:'float64',threads:null,device:gpu.engine,allocatedEstimateBytes:gpu.allocatedEstimateBytes,chanceSampling:false};
    const target=prepared.accuracy;result.stats.targetAccuracyPctPot=target;result.stats.targetReached=target===null?null:evaluated.quality.nashConvPctPot<=target;result.stats.adaptiveStopping=!!adaptive;
    if(adaptive){Object.assign(result.stats,{iterationsExecuted:adaptive.iterationsExecuted,iterationsExecutedAtLeast:adaptive.iterationsExecutedAtLeast,trainingSeconds:adaptive.trainingSeconds,verificationSeconds:adaptive.verificationSecondsSpent,incompleteVerificationSeconds:adaptive.incompleteVerificationSeconds,precisionChecks:adaptive.checks.length,wallSeconds:(performance.now()-started)/1000,timingIncomplete:adaptive.timingIncomplete});result.precisionChecks=adaptive.checks;result.checkpointBinding=binding;}
    result.validation={gpuProfileEV:gpu.profileEV,maxProfileDifference:evaluated.maxProfileDifference,independentCPU:evaluated.quality};result.gpu={...gpu,stopReason:result.stopReason,policy:undefined};
    result.limits=[...result.limits,...gpu.limits,adaptive?'GPU 常驻状态按独立非受约束残差检查目标；迭代与全流程时间均为上限，不保证目标一定能达到。发布的是最后一个完整核验的平均策略。':'GPU 实验按迭代次数或时间停止；最终残差由独立 CPU 校验，尚未用于 GPU 自适应停止。'];
    if(prepared.locks.length)result.limits.push('这里的最终残差允许偏离用户锁定的动作；没有使用为导入整套 GPU 策略临时施加的全锁受约束零残差。');
    if(outputFile){fs.mkdirSync(path.dirname(outputFile),{recursive:true});fs.writeFileSync(outputFile,JSON.stringify(result));}return result;
  }finally{if(!workDir&&dir.startsWith(path.join(os.tmpdir(),'pokerlab-gpu-cfr-')))fs.rmSync(dir,{recursive:true,force:true});}
}
