import fs from 'node:fs';
import {parentPort,workerData} from 'node:worker_threads';
import {evaluateRangeConstruction} from './strategy-construction.mjs';
import {buildResponseWitness} from './response-witness.mjs';
const controller=new AbortController();
parentPort.on('message',m=>{if(m.cancel)controller.abort();});
try{
 const result=JSON.parse(fs.readFileSync(workerData.resultFile,'utf8'));
 const grade=await evaluateRangeConstruction(workerData.scenario,result,workerData.submission,{signal:controller.signal,onProgress:progress=>parentPort.postMessage({type:'progress',progress})});
 if(grade.independentEvaluation?.status==='complete'&&workerData.scenario.players.length===2){
  parentPort.postMessage({type:'progress',progress:{phase:'response-witness',message:'正在重建具体反制策略，并核对整段收益贡献。'}});
  try{grade.responseWitness=buildResponseWitness(workerData.scenario,result,workerData.submission,{jobId:workerData.jobId,independentEvaluation:grade.independentEvaluation,maxSeconds:12,signal:controller.signal,onProgress:progress=>parentPort.postMessage({type:'progress',progress:{...progress,phase:'response-witness'}})});}
  catch(error){if(controller.signal.aborted)throw error;grade.responseWitness={status:/预算|耗时|超时/.test(error.message)?'unavailable':'failed',reason:error.message,meaning:'整段独立最佳响应评估仍单独有效；本次没有发布未通过检查的具体反制路径。'};}
 }
 parentPort.postMessage({type:'result',result:grade});
}catch(error){parentPort.postMessage({type:'error',error:error.message});}
finally{parentPort.close();}
