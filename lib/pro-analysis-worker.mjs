import {parentPort,workerData} from 'node:worker_threads';
import {analyzeMultiAsync} from './multi-equity.mjs';
const controller=new AbortController();
parentPort.on('message',m=>{if(m.cancel)controller.abort();});
try{parentPort.postMessage({ok:true,result:await analyzeMultiAsync(workerData.scenario,{...workerData.options,signal:controller.signal,onProcess:processId=>parentPort.postMessage({type:'process',processId})})});}catch(e){parentPort.postMessage({ok:false,error:e.message});}finally{parentPort.close();}
