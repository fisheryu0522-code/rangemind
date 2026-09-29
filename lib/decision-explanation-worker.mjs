import fs from 'node:fs';
import {parentPort,workerData} from 'node:worker_threads';
import {explainDecision} from './decision-explanation.mjs';
try{const result=JSON.parse(fs.readFileSync(workerData.resultFile,'utf8'));parentPort.postMessage({ok:true,result:explainDecision(workerData.scenario,result,workerData.options)});}catch(e){parentPort.postMessage({ok:false,error:e.message});}
