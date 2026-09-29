import {parentPort,workerData} from 'node:worker_threads';
import {parseHandHistoryBatch} from './hand-history-batch.mjs';
try { parentPort.postMessage({ok:true,result:parseHandHistoryBatch(workerData.text,{fileName:workerData.fileName})}); }
catch(e) { parentPort.postMessage({ok:false,error:e.message}); }
