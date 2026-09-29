import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {solveTurnGame} from '../lib/turn-engine.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const inputs=JSON.parse(fs.readFileSync(path.join(root,'data/turn-benchmark.json'))).records;
const report={at:new Date().toISOString(),records:[]};
for(const base of inputs){
  const input={...base.input,algorithm:'alternating-cfr-plus',iterations:base.count===20?2000:800,averagingDelay:50,checkEvery:100,accuracy:.5,threads:12,maxSeconds:600};
  const start=Date.now();const result=await solveTurnGame(input,{onProgress:p=>console.log(JSON.stringify({count:base.count,...p}))});const record={count:base.count,input,wallSeconds:(Date.now()-start)/1000,stats:result.stats,diagnostics:result.diagnostics,stopReason:result.stopReason,root:result.nodes[0]};report.records.push(record);console.log(JSON.stringify({count:base.count,stats:result.stats,diagnostics:result.diagnostics}));fs.writeFileSync(path.join(root,'data/turn-alternating-benchmark.json'),JSON.stringify(report,null,2));
}
