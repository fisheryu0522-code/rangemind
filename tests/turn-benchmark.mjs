import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {solveTurnGame} from '../lib/turn-engine.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=JSON.parse(fs.readFileSync(path.join(root,'data/river-benchmark.json'))).records.find(r=>r.combosPerPlayer===100).input;
const records=[];
for(const count of [20,40]){
  const input={...source,board:'Kh9h4c7s',players:source.players.map(p=>({...p,range:p.range.split(',').slice(0,count).join(',')})),iterations:2000,averagingDelay:100,checkEvery:250,accuracy:.5,allIn:false,maxRaises:0,riverMaxRaises:0,maxDeals:3000000,maxSeconds:300,maxNodeVisits:1000000000000};
  const start=Date.now();try{const r=await solveTurnGame(input,{onProgress:p=>console.log(JSON.stringify({count,...p}))});records.push({count,input,wallSeconds:(Date.now()-start)/1000,stats:r.stats,diagnostics:r.diagnostics,stopReason:r.stopReason,root:r.nodes[0],status:'solved'});}catch(e){records.push({count,input,wallSeconds:(Date.now()-start)/1000,status:'rejected',error:e.message});}
  fs.writeFileSync(path.join(root,'data/turn-benchmark.json'),JSON.stringify({at:new Date().toISOString(),records},null,2));console.log(JSON.stringify(records.at(-1),['count','wallSeconds','stats','diagnostics','iterations','seconds','legalDeals','publicNodes','nashConv','nashConvPctPot','payoffMemoryBytes','stopReason','status','error']));
}
