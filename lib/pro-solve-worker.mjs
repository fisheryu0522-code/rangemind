import {parentPort,workerData} from 'node:worker_threads';
import {solveGame} from './solve-game.mjs';
const controller=new AbortController();
parentPort.on('message',m=>{if(m?.cancel)controller.abort();});
try{const result=await solveGame(workerData.input,{outputFile:workerData.outputFile,signal:controller.signal,onProgress:progress=>parentPort.postMessage({type:'progress',progress})});const summary=Object.fromEntries(['diagnostics','stats','limits','assumptions','engine','chance','validation','capabilities','stopReason','outputScope','scope','rakeModel','settings','experimental','qualityVerified','policyEvaluation','precisionChecks','checkpointBinding','input'].map(k=>[k,result[k]]));parentPort.postMessage({type:'result',result:summary});}catch(e){parentPort.postMessage({type:'error',error:e.message});}finally{parentPort.close();}
