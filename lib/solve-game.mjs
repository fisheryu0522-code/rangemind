import fs from 'node:fs';
import path from 'node:path';
import {cards} from './poker.mjs';
import {solveRiverGame} from './river-engine.mjs';
import {solveTurnGame} from './turn-engine.mjs';
import {solveHUPostflop} from './hu-postflop.mjs';
import {solveGPURiverGame} from './gpu-river-cfr.mjs';
import {evaluateHUPolicy} from './hu-policy-evaluation.mjs';

export async function solveGame(input,options={}){
 const count=cards(input.board).length;
 if(input.engine==='gpu-river')return solveGPURiverGame(input,options);
 if(count!==3&&input.engine!=='hu-postflop')return (count===4?solveTurnGame:solveRiverGame)(input,options);
 let result=await solveHUPostflop(input,{...options,outputFile:undefined});
 if(result.capabilities.fullTree){
  options.onProgress?.({phase:'independent-policy-evaluation',processId:null,publicNodes:result.nodes.length});
  try{
   result=evaluateHUPolicy(result,{maxNodes:200000,maxHoleDeals:10000,maxNodeDealVisits:50000000,maxSeconds:60,mutate:false,signal:options.signal,onProgress:p=>options.onProgress?.({...p,phase:'independent-policy-evaluation',processId:null})});
   result.diagnostics.optimizationResidualPctPot=result.diagnostics.exploitabilityPctPot;
   result.diagnostics.optimizationMetric='HU exploitability = NashConv / 2, percentage of starting pot';
   result.stats.targetReached=result.diagnostics.exploitabilityPctPot<=result.input.accuracy;
   result.stats.targetAccuracyPctPot=result.input.accuracy;
   result.stats.targetMetric='independentExploitabilityPctPot';
   result.capabilities.studyCards=true;
   result.capabilities.evBreakdown=count>=4;
  }catch(e){
   if(!/预算|耗时|超时/.test(e.message))throw e;
   result.capabilities={...result.capabilities,actionEV:false,studyCards:false,evBreakdown:false};
   result.policyEvaluation={completed:false,reason:e.message};
   result.limits.push('独立全树 EV 与最佳响应评估未完成：'+e.message+'。本结果保留原生策略频率，不提供未核验的行动 EV。');
  }
 }
 if(options.outputFile){fs.mkdirSync(path.dirname(options.outputFile),{recursive:true});fs.writeFileSync(options.outputFile,JSON.stringify(result));}
 return result;
}
