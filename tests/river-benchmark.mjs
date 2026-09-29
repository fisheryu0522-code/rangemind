import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {range,cards} from '../lib/poker.mjs';
import {prepareRiverGame,solveRiverGame} from '../lib/river-engine.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const board='Kh9h4c7s2d';
const pool=range('22+,A2s+,K2s+,Q2s+,J2s+,T2s+,98s,87s,76s,65s,54s,AKo,AQo,AJo,ATo,KQo,KJo,QJo',cards(board)).live;
const records=[];
for(const count of [50,100,200]){
  const input={board,pot:20,players:[0,1,2].map((p)=>({id:`p${p}`,stack:[60,40,30][p],range:Array.from({length:count},(_,k)=>pool[(k+p*17)%pool.length].label).join(',')})),sizes:[50],raiseSizes:[50],maxRaises:1,iterations:100,averagingDelay:10,checkEvery:100,maxDeals:2000000,threads:12,maxSeconds:180};
  const record={combosPerPlayer:count,input};records.push(record);
  const start=Date.now();try{const result=await solveRiverGame(input,{onProgress:p=>console.log(JSON.stringify({count,...p}))});record.wallSeconds=(Date.now()-start)/1000;record.stats=result.stats;record.diagnostics=result.diagnostics;record.status='solved';}catch(error){record.wallSeconds=(Date.now()-start)/1000;record.status='rejected';record.reason=error.message;}
  console.log(JSON.stringify(record));fs.writeFileSync(path.join(root,'data','river-benchmark.json'),JSON.stringify({at:new Date().toISOString(),records},null,2));
}
