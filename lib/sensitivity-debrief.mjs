const finite=Number.isFinite;
const equalSet=(a,b)=>a.length===b.length&&a.every(id=>b.includes(id));
const sameNumber=(a,b)=>Math.abs(a-b)<=32*Number.EPSILON*Math.max(1,Math.abs(a),Math.abs(b));
const REASONS={
 'missing-target':'原实验没有明确的数值精度目标，不能认定所有模型已经达到目标。',
 'missing-residual':'此行缺少有限、非负的独立残差证据。',
 'target-not-reached':'此行尚未达到原实验的数值精度目标。',
 'conflicting-quality':'此行保存的精度证据互相矛盾，需要重新核对原求解。',
 'missing-counterfactual-reach':'此行缺少正的反事实到达权重，无法核验该手牌的条件行动收益。',
 'unobserved-decision':'此行没有正的实际到达权重，只能作为未到达分支研究，不能据此认定实战动作稳定。',
 'invalid-action-values':'此行没有完整、相同的合法行动集合及有限行动 EV，不能评分。',
 'explicitly-unscoreable':'原记录明确把此行标记为不可评分。'
};

/** Summarize only the discrete models already solved by runSensitivity.
 * toleranceBB is a user's practical comparison choice, never an error bound.
 * Recompute regret from source action EVs rather than trusting saved rankings,
 * loss fields, strategy frequencies, or a probability over range hypotheses. */
export function buildSensitivityDebrief(result,{toleranceBB,actionId=null}={}){
 if(!result||typeof result!=='object'||!Array.isArray(result.rows)||result.rows.length<2||result.rows.length>5)throw Error('需要一份含 2–5 个已计算假设的完整范围实验。');
 if(!finite(toleranceBB)||toleranceBB<0)throw Error('请明确填写不小于 0 BB 的实践收益容忍；它不是计算误差上界。');
 if(!Array.isArray(result.actions)||result.actions.length<1||result.actions.some(a=>typeof a?.id!=='string'||!a.id)||new Set(result.actions.map(a=>a.id)).size!==result.actions.length)throw Error('范围实验的行动集合无效。');
 const actions=result.actions.map(a=>({id:a.id,label:String(a.label??a.id)})),ids=actions.map(a=>a.id);
 if(actionId!==null&&!ids.includes(actionId))throw Error('所选动作不在这份范围实验中。');
 if(result.rows.some(r=>!finite(r?.scale)||r.scale<=0||r.scale>1)||new Set(result.rows.map(r=>r.scale)).size!==result.rows.length)throw Error('原实验的权重倍率必须是 2–5 个不同的 (0,1] 数值。');
 const target=finite(result.settings?.accuracy)&&result.settings.accuracy>=0?result.settings.accuracy:null;
 const rows=[...result.rows].sort((a,b)=>a.scale-b.scale).map(row=>{
  const reasonCodes=[],add=code=>{if(!reasonCodes.includes(code))reasonCodes.push(code);};
  const source=row.actions,complete=Array.isArray(source)&&source.length===ids.length&&new Set(source.map(a=>a?.id)).size===ids.length&&source.every(a=>ids.includes(a?.id)&&finite(a.ev))&&source.every(a=>finite(Math.max(...source.map(x=>x.ev))-a.ev));
  const byId=complete?new Map(source.map(a=>[a.id,a])):null;
  if(!complete)add('invalid-action-values');
  if(row.scoreable===false||row.quality?.scoreable===false)add('explicitly-unscoreable');
  if(!(finite(row.counterfactualReach)&&row.counterfactualReach>0))add('missing-counterfactual-reach');
  if(!(finite(row.observedReach)&&row.observedReach>0))add('unobserved-decision');
  if(target===null)add('missing-target');
  // Under node locks the constrained optimization residual is the stopping
  // metric. An unrestricted deviation gain is a different question.
  const diagnostic=row.diagnostics?.optimizationResidualPctPot??row.diagnostics?.nashConvPctPot;
  const reported=row.quality?.residualPctPot;
  const residual=finite(diagnostic)&&diagnostic>=0?diagnostic:finite(reported)&&reported>=0?reported:null;
  if(residual===null)add('missing-residual');
  if(diagnostic!=null&&(!finite(diagnostic)||diagnostic<0)||reported!=null&&(!finite(reported)||reported<0))add('conflicting-quality');
  if(finite(diagnostic)&&finite(reported)&&!sameNumber(diagnostic,reported))add('conflicting-quality');
  if(row.quality?.targetReached!==undefined&&row.quality.targetReached!==null&&typeof row.quality.targetReached!=='boolean')add('conflicting-quality');
  if(row.quality?.targetReached===false||(target!==null&&residual!==null&&residual>target))add('target-not-reached');
  const verified=reasonCodes.length===0,bestEV=complete?Math.max(...source.map(a=>a.ev)):null;
  const values=actions.map(a=>{
   const ev=complete?byId.get(a.id).ev:null,lossBB=complete?Math.max(0,bestEV-ev):null,numericallyWithinTolerance=complete?lossBB<=toleranceBB:null;
   return {...a,ev,lossBB,numericallyWithinTolerance,status:verified?(numericallyWithinTolerance?'within-tolerance':'exceeds-tolerance'):'unverified'};
  });
  return {scale:row.scale,jobId:row.jobId??null,bestEV,counterfactualReach:finite(row.counterfactualReach)?row.counterfactualReach:null,observedReach:finite(row.observedReach)?row.observedReach:null,highestEVActionIds:complete?values.filter(a=>a.ev===bestEV).map(a=>a.id):[],withinToleranceActionIds:complete?values.filter(a=>a.numericallyWithinTolerance).map(a=>a.id):[],verified,quality:{status:verified?'verified':'unverified',targetPctPot:target,residualPctPot:residual,reasonCodes,reasons:reasonCodes.map(code=>REASONS[code])},actions:values};
 });
 const allVerified=rows.every(r=>r.verified),actionSummaries=actions.map(action=>{
  const values=rows.map(row=>({row,value:row.actions.find(a=>a.id===action.id)})),withinScales=values.filter(x=>x.value.status==='within-tolerance').map(x=>x.row.scale),exceedsScales=values.filter(x=>x.value.status==='exceeds-tolerance').map(x=>x.row.scale),unverifiedScales=values.filter(x=>!x.row.verified).map(x=>x.row.scale);
  return {...action,status:!allVerified?'unverified':exceedsScales.length?'exceeds-in-some-tested':'within-tolerance-in-all-tested',usableInAllTested:allVerified?exceedsScales.length===0:null,maxLossBB:values.every(x=>finite(x.value.lossBB))?Math.max(...values.map(x=>x.value.lossBB)):null,verifiedRows:rows.length-unverifiedScales.length,testedRows:rows.length,withinScales,exceedsScales,unverifiedScales};
 });
 const intervals=rows.slice(1).map((upper,index)=>{
  const lower=rows[index],verified=lower.verified&&upper.verified;
  const changes=verified?actions.filter(a=>lower.withinToleranceActionIds.includes(a.id)!==upper.withinToleranceActionIds.includes(a.id)).map(a=>({id:a.id,from:lower.withinToleranceActionIds.includes(a.id)?'within-tolerance':'exceeds-tolerance',to:upper.withinToleranceActionIds.includes(a.id)?'within-tolerance':'exceeds-tolerance'})):[];
  const selected=actionId===null?null:{id:actionId,from:lower.actions.find(a=>a.id===actionId).status,to:upper.actions.find(a=>a.id===actionId).status,changed:verified?changes.some(a=>a.id===actionId):null};
  return {lowerScale:lower.scale,upperScale:upper.scale,lowerJobId:lower.jobId,upperJobId:upper.jobId,verified,status:!verified?'unverified-endpoint':changes.length?'refinement-needed':'tested-endpoints-only',highestEVChanged:verified?!equalSet(lower.highestEVActionIds,upper.highestEVActionIds):null,practicalSetChanged:verified?changes.length>0:null,actionChanges:changes,selectedAction:selected};
 });
 const commonActionIds=allVerified?actionSummaries.filter(a=>a.usableInAllTested).map(a=>a.id):[];
 return {kind:'sensitivity-debrief',version:1,toleranceBB,quality:{status:allVerified?'verified-discrete-models':'incomplete-evidence',verifiedRows:rows.filter(r=>r.verified).length,totalRows:rows.length,allVerified},basis:{combo:result.combo??null,nodePath:[...(result.nodePath??[])],player:result.player??null,subset:result.subset??null,locksPreserved:!!result.settings?.locks?.length,scaleMeaning:'所选牌组起点权重的保留倍率，不是该牌组的后验概率。',toleranceMeaning:'你选择的实践比较容忍，不是数值误差上界，也不是实战出现率或收益保证。'},rows,actions:actionSummaries,commonActionIds,selectedAction:actionId===null?null:actionSummaries.find(a=>a.id===actionId),intervals,meaning:'每行把该动作与同一范围假设下数值最高的行动 EV 比较；只总结已计算的离散假设，不给这些假设赋予发生概率。',limits:['各行所有未锁定策略都重新优化；这是模型敏感性，不是固定对手策略下单独改牌组的因果效果。','最高 EV 动作换位可能只是极小数值差，不能自动解释为需要改变实战动作。','待细化区间只表示两个已测端点的容忍状态不同；没有插值出临界点，不保证单调，也不保证同状态端点之间不曾改变。','全局残差不是此组合行动 EV 的误差上界；达到目标仍不证明细微收益排序准确。','“全部可用”只覆盖本次已计算且可核验的假设、此具体手牌和此节点，不是对所有范围或整段混合策略的稳健性证明。','逐手把容忍内动作改成纯策略仍可能破坏范围平衡；这里没有评估对手适应后的整套策略收益。']};
}
