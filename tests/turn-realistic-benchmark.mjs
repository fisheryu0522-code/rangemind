import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareTurnGame,solveTurnGame} from '../lib/turn-engine.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ranges=[
  'AcKd,AdKd,AsKd,AcKh,AdKh,AsKh,KcQd,KdQd,KhQd,KcJd,KdJd,KhJd,7c7d,7c7s,2c2d,9d9h,AhQh,AhJh,QhJh,JhTh',
  'AcKc,AdKc,AhKc,KdQc,KdQs,KcQs,KhQs,KdJc,KcJc,KhJc,9h9s,9d9s,7d7s,2d2s,AhTh,Ah8h,QhTh,Jh8h,Th8h,8h6h',
  'AcKh,AdKh,AsKh,KcQh,KdQh,KcJh,KdJh,QcQd,QcQs,QdQs,JcJd,JcJs,9h9s,7c7d,2c2s,AhQh,AhJh,QhJh,JhTh,Th8h'
];
const input={title:'Three-way mixed top-pair, sets, medium pairs and draws; turn raises',board:'Ks7h2h9c',pot:20,players:ranges.map((range,i)=>({id:`p${i}`,name:['BB','HJ','BTN'][i],range,stack:[30,30,20][i]})),toAct:0,riverToAct:0,sizes:[50],raiseSizes:[50],riverSizes:[50],riverRaiseSizes:[50],maxRaises:1,riverMaxRaises:0,allIn:false,rake:0,algorithm:'alternating-cfr-plus',iterations:3000,averagingDelay:50,checkEvery:100,accuracy:.5,threads:12,maxSeconds:300,maxNodes:50000,maxDeals:3000000,maxNodeVisits:1000000000000};
const report={at:new Date().toISOString(),scope:'Synthetic study ranges containing multiple hand classes, not an estimated population range or a real player range.',input};
const start=Date.now();
try{
  const g=prepareTurnGame(input);report.preparation={legalDeals:g.deals.length,holeDeals:g.chance.holeDeals,publicNodes:g.nodes.length,payoffMemoryBytes:g.estimatedMemoryBytes,turnRaiseNodes:g.nodes.filter(n=>n.street==='turn'&&n.actions.some(a=>a.type==='raise')).length};console.log(JSON.stringify(report.preparation));
  const r=await solveTurnGame(input,{onProgress:p=>console.log(JSON.stringify(p))});Object.assign(report,{stats:r.stats,diagnostics:r.diagnostics,stopReason:r.stopReason,root:r.nodes[0],wallSeconds:(Date.now()-start)/1000,status:'solved'});
}catch(e){Object.assign(report,{status:'rejected',error:e.message,wallSeconds:(Date.now()-start)/1000});}
fs.writeFileSync(path.join(root,'data/turn-realistic-benchmark.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,error:report.error,stats:report.stats,diagnostics:report.diagnostics}));
