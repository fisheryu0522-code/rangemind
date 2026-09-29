import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {parentPort,workerData} from 'node:worker_threads';
import {runSensitivity} from './sensitivity.mjs';
import {solveSettings} from './solve-settings.mjs';
const controller=new AbortController();parentPort.on('message',m=>{if(m.cancel)controller.abort();});
try{const result=await runSensitivity({...workerData.input,baseline:JSON.parse(fs.readFileSync(workerData.resultFile,'utf8'))},{signal:controller.signal,onProgress:progress=>parentPort.postMessage({type:'progress',progress}),saveVariant:async({result,scenario,index,scale})=>{
 if(scale===1)return workerData.sourceJobId;
 const id=crypto.randomUUID(),dir=path.join(workerData.jobsDir,id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result));
 const finishedAt=new Date().toISOString(),seconds=result.stats?.seconds??null;
 const job={id,origin:'sensitivity',experimentId:workerData.experimentId,sourceJobId:workerData.sourceJobId,status:'complete',createdAt:finishedAt,startedAt:Date.now()-(Number.isFinite(seconds)?seconds*1000:0),finishedAt,seconds,scenario:{...scenario,title:scenario.title+' · 到达权重 '+Math.round(scale*100)+'%'},settings:solveSettings(result.input),log:[],result:Object.fromEntries(['diagnostics','stats','limits','assumptions','engine','chance','validation','capabilities','rakeModel'].map(k=>[k,result[k]]))};
 parentPort.postMessage({type:'variant',job,index,scale});return id;
 }});parentPort.postMessage({type:'result',result});}catch(e){parentPort.postMessage({type:'error',error:e.message});}finally{parentPort.close();}
