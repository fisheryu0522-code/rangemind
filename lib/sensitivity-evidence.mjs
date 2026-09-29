import {runSensitivity} from './sensitivity.mjs';
import {assertSolutionScenario} from './solution-identity.mjs';

/** Rebuild the comparison from its saved complete policies, with no solve.
 * Restored or edited summary numbers alone never acquire a new certificate.
 */
export async function reconstructSensitivityEvidence(record,{getJob,getResult}){
 if(record?.status!=='complete'||!record.result||!record.input||!Array.isArray(record.result.rows))throw Error('需要一份完整的范围对照实验；未完成的行不能形成跨假设结论。');
 const source=getJob(record.sourceJobId),baseline=getResult(record.sourceJobId);
 if(source.status!=='complete')throw Error('原参考求解不完整。');
 assertSolutionScenario(record.input.scenario,baseline,{settings:record.input.settings??{}});
 const scales=record.input.scales??[.25,.5,1],rows=new Map();
 for(const row of record.result.rows){if(rows.has(row.scale))throw Error('范围实验的已算倍率重复。');rows.set(row.scale,row);}
 if(rows.size!==scales.length||scales.some(scale=>!rows.has(scale)))throw Error('范围实验缺少某个已请求的假设结果。');
 const pending=scales.filter(scale=>scale!==1);let index=0;
 const rebuilt=await runSensitivity({...record.input,scenario:source.scenario,settings:source.settings??{},baseline},{
  solve:async expected=>{
   const scale=pending[index++],row=rows.get(scale),job=getJob(row.jobId),result=getResult(row.jobId);
   if(job.status!=='complete')throw Error('某一行尚没有完整的原始求解。');
   assertSolutionScenario(expected,result,{settings:expected});
   return result;
  },
  saveVariant:async({scale})=>{
   const row=rows.get(scale);if(scale===1&&row.jobId!==record.sourceJobId)throw Error('未改变范围的一行必须引用原始参考求解。');return row.jobId;
  }
 });
 return {...rebuilt,evidence:{source:'reconstructed-from-saved-complete-policies',sourceJobId:record.sourceJobId,experimentId:record.id,recomputedStrategy:false,note:'从保留的策略树重建各行的组合 EV 与残差；没有运行新的求解，也没有认证现实范围假设。'}};
}
