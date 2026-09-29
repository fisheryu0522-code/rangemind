const finite=Number.isFinite;
const bb=x=>finite(x)?Number(x.toFixed(4)).toString():'未知';
const pct=x=>finite(x)?Number((x*100).toFixed(1))+'%':'未知';
const signed=x=>(x>0?'+':'')+bb(x);
const mix=(probabilities,actions)=>actions.filter(a=>probabilities[a.id]>1e-8).map(a=>`${a.label} ${pct(probabilities[a.id])}`).join(' / ');

/** A deterministic teaching scaffold over already verified values. It does
 * not infer a player's psychological cause or label hand categories as value
 * and bluff merely from their showdown rank. */
export function buildRangeDebrief(grade,{jobId,nodePath=[]}={}){
 if(grade?.kind!=='range-construction-grade'||!grade.coverage?.complete)throw Error('范围复盘需要完整、已评分的提交。');
 const counterfactual=grade.weighting==='counterfactual',rangeLabel=counterfactual?'反事实研究范围':'当前到达范围',weightLabel=counterfactual?'反事实范围权重':'当前到达权重';
 const metrics=grade.metrics,free=grade.combos.filter(r=>r.editable&&r.scoreable),ranked=[...free].sort((a,b)=>b.weightedRegretBB-a.weightedRegretBB||b.regretBB-a.regretBB||a.combo.localeCompare(b.combo));
 const meaningful=ranked.filter(r=>r.weightedRegretBB>1e-8),focus=(meaningful.length?meaningful:ranked).slice(0,3).map(row=>{
  const best=grade.actions.filter(a=>row.localBestEV-row.actionEV[a.id]<=.02),alternative=best.map(a=>a.label).join(' / '),summary=`${row.combo} 的${weightLabel}为 ${pct(row.posteriorWeight)}。你分配了 ${mix(row.userProbabilities,grade.actions)}，混合收益 ${bb(row.userEV)} BB；此组合在固定参考后续策略下的最高行动收益是 ${bb(row.localBestEV)} BB。`;
  return {combo:row.combo,conditionalWeight:row.posteriorWeight,userEV:row.userEV,localBestEV:row.localBestEV,localRegretBB:row.regretBB,rangeRegretContributionBB:row.weightedRegretBB,shareOfLocalRegret:metrics.localRegretBB>1e-12?row.weightedRegretBB/metrics.localRegretBB:0,summary,changeMeaning:`仅把这一组合改成其局部最优动作，会使这道题的加权条件收益增加 ${bb(row.weightedRegretBB)} BB；其他组合和后续策略都不变。`,closeActions:best.map(a=>({id:a.id,label:a.label,ev:row.actionEV[a.id]})),question:best.some(a=>a.type==='raise'||a.type==='bet')?`先预测 ${alternative} 的收益主要来自哪些响应：更差牌继续、更好牌弃牌，还是其他分支？再打开逐响应收益拆解核对。`:`先解释 ${alternative} 留下了什么后续应对机会，以及另一个动作增加了哪些投入；再用相同组合的行动 EV 和响应分支检验。`,target:{kind:'job',id:jobId,jobId,path:[...nodePath],nodeId:grade.source.nodeId,combo:row.combo}};
 });
 const distribution=grade.actions.map(action=>({id:action.id,label:action.label,yourFrequency:action.userFrequency,referenceFrequency:action.referenceFrequency,frequencyDifference:action.userFrequency-action.referenceFrequency,description:`你有 ${pct(action.userFrequency)} 的${rangeLabel}选择 ${action.label}，参考为 ${pct(action.referenceFrequency)}。这是范围分配差异，不直接构成错误判定。`}));
 const independent=grade.independentEvaluation;let balance;
 if(independent?.status!=='complete')balance={status:independent?.status??'not-run',title:'还需要分清：当前收益与对手适应',body:'这里的逐组合评分把其他玩家与未来策略固定。若所有边界牌的 EV 接近，许多不同分配会拿到相似局部收益；仍须独立评估整套策略，才能观察对手改打法后的影响。',next:'完成独立反制评估，再决定哪些混合可以简化。',limits:independent?.reason?[independent.reason]:[]};
 else if(independent.responseExposure.kind==='heads-up-security'){
  const r=independent.responseExposure,f=independent.fixedOpponent;
  balance={status:'complete',kind:r.kind,title:'两个问题，分别用两个结果回答',body:`保持其他策略不变时，你在研究起点的收益变化是 ${signed(f.changeBB)} BB。允许对手在全部信息集作最佳响应后，你的起点收益是 ${bb(r.submittedSecurityEV)} BB，原参考为 ${bb(r.baselineSecurityEV)} BB，差值 ${signed(r.securityEVChangeBB)} BB。`,next:'如果局部收益很好但第二个结果明显下降，先重新检查整段分配；不要把所有近似等 EV 的组合同时移到同一个动作。',limits:['这是当前有限树内的整套固定策略对照，只修改了本题一个节点。它没有证明具体哪个组合导致某种现实对手行为。'],fixedOpponentChangeBB:f.changeBB,securityEVChangeBB:r.securityEVChangeBB};
 }else{
  const r=independent.responseExposure;
  balance={status:'complete',kind:r.kind,title:'多人：逐人检查单边改打法的空间',body:r.players.map(p=>`${p.name} 的单边偏离收益由 ${bb(p.baselineGainBB)} 变为 ${bb(p.submittedGainBB)} BB`).join('；')+'。每一行都固定其他人的策略，只允许该玩家单独改变。',next:'挑一个变化较大的玩家，回到其后续决策研究响应。一次只改变一个假设，保留其他玩家的策略。',limits:['对手增加的收益也可能来自另一位对手，不能相加成你的损失；这不是多人同时适应或合谋模型。'],players:r.players};
 }
 return {kind:'range-learning-debrief',version:1,headline:metrics.localRegretBB<=.02?'固定参考后续下的局部收益接近最高值，接下来检验整段分配能否被反制。':'先找出最影响整段收益的组合，再检验修订后的范围。',basis:{localRegretBB:metrics.localRegretBB,referenceDifferenceBB:metrics.referenceDifferenceBB,weighting:grade.weighting,quality:grade.quality,freeCombos:free.length},focus,distribution,balance,learningSteps:[{id:'predict-response',title:'先解释一个分歧',instruction:focus[0]?.question??'选择一个自己犹豫的组合，先说出其收益来自哪些对手响应。',target:focus[0]?.target??null},{id:'change-one-assumption',title:'寻找会让结论反转的条件',instruction:'写下一条可被推翻的预测，例如“愿意跟加注的更差牌减少时，加注相对跟注的收益会降低”。链接原节点，在对照实验中只改一个范围假设。',source:{kind:'job',id:jobId,jobId,path:[...nodePath],nodeId:grade.source.nodeId}},{id:'rebuild',title:'关闭参考，重新构建一遍',instruction:'保留一条条件化规则和一个失效条件。稍后或次日再作答；当前看着结果修改属于纠错练习，不能冒充未提示基线。'}],limitations:['文字只组织已经算出的证据与待检验问题，不自动判断自由文本理由是否正确。','排序按这道题的条件范围收益贡献，不按未知的实战出现率，也不换算 bb/100。','成牌类型、参考频率不同或某个单手输赢，都不单独证明价值/诈唬类别或策略漏洞。']};
}
