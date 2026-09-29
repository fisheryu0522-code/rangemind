import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {solveRiverGame} from '../lib/river-engine.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const base=JSON.parse(fs.readFileSync(path.join(root,'data/river-benchmark.json'))).records.find(r=>r.combosPerPlayer===200).input;
const records=[];
for(const seed of [20260928,20260929]){
  const input={...base,chanceMode:'sampled',chanceSamples:100000,evaluationSamples:100000,seed,iterations:3000,averagingDelay:100,checkEvery:500,accuracy:.5,maxSeconds:180};
  const start=Date.now();const result=await solveRiverGame(input,{onProgress:p=>console.log(JSON.stringify({seed,...p})),outputFile:path.join(root,`data/river-sampled-${seed}.json`)});
  records.push({seed,wallSeconds:(Date.now()-start)/1000,stats:result.stats,chance:result.chance,diagnostics:result.diagnostics,holdout:result.validation.holdout,rootActions:result.nodes[0].actions});
  fs.writeFileSync(path.join(root,'data/river-sampled-benchmark.json'),JSON.stringify({at:new Date().toISOString(),records},null,2));console.log(JSON.stringify({seed,stats:result.stats,diagnostics:result.diagnostics,holdout:result.validation.holdout}));
}
