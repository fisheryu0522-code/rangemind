import {parentPort,workerData} from 'node:worker_threads';
import {runEquityExplorer} from './equity-explorer.mjs';
const controller=new AbortController();parentPort.on('message',m=>{if(m.cancel)controller.abort();});
try{const result=await runEquityExplorer(workerData.input,{signal:controller.signal,onProcess:processId=>parentPort.postMessage({type:'progress',progress:{processId}}),onProgress:progress=>parentPort.postMessage({type:'progress',progress})});parentPort.postMessage({type:'result',result});}catch(e){parentPort.postMessage({type:'error',error:e.message});}finally{parentPort.close();}
