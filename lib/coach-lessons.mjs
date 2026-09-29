const n=v=>Number(v.toPrecision(6)),bb=v=>`${n(v)} BB`,pct=v=>`${n(v*100)}%`;
const near=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-5;
const phases={fold:'自己后续弃牌',uncontested:'其余玩家都弃牌',win:'摊牌获得底池份额',tie:'摊牌含平分份额',loss:'摊牌未获得份额'};

/** Language-model selection is confined to these independently reconstructed
 * lessons. The model never writes the mathematical or poker claims below. */
export function buildVerifiedCoachLessons(report){
 const d=report.decision,f=report.verifiedActionFacts;
 if(!d?.exact||!f?.actions?.length||!Array.isArray(d.actions))return null;
 if(d.combo!==f.combo||d.actorName!==f.actor)throw Error('教案与独立拆解的组合或行动者不一致。');
 for(const a of d.actions){
  const fact=f.actions.find(x=>x.id===a.id);
  if(!fact||!near(fact.netEV,a.ev)||!near(a.ev,a.solverEV)||!near(a.probabilitySum,1))throw Error('教案动作缺少一致的收益证据。');
  if(!near(a.outcomes.reduce((s,x)=>s+x.evContribution,0),a.ev)||!near(a.outcomes.reduce((s,x)=>s+x.probability,0),1)||!near(a.responses.reduce((s,x)=>s+x.evContribution,0),a.ev)||!near(a.responses.reduce((s,x)=>s+x.probability,0),1))throw Error('教案分支贡献未加总到行动收益。');
 }
 const best=Math.max(...d.actions.map(a=>a.ev));
 for(const fact of f.actions)if(!near(fact.lossRelativeToBest,Math.max(0,best-fact.netEV)))throw Error('教案相对损失与动作值不一致。');
 const evidence=report.evidence??[],ids=pred=>evidence.filter(pred).map(e=>e.id),blocks=[];
 const add=(id,title,kind,body,evidenceIds=[],teaching={})=>blocks.push({id,title,kind,body,evidenceIds,...teaching});
 const ordered=[...f.actions].sort((a,b)=>b.netEV-a.netEV),top=ordered[0],worst=ordered.at(-1),gap=top.netEV-worst.netEV;
 add('decision','先分清：净收益和少赚多少','evidence',`${f.actor} 的 ${f.combo} 在当前模型中，${top.label} 的净 EV 最高，为 ${bb(top.netEV)}；${worst.label} 的净 EV 为 ${bb(worst.netEV)}，相对本次最高动作值少 ${bb(gap)}。${worst.netEV>0?'后者仍是正期望，不能把这笔机会成本说成动作本身亏损。':worst.netEV<0?'后者的模型净期望为负；它与相对最佳动作的损失是两个不同数字。':'零净期望也不代表它与其他动作同样有利。'} EV 是给定范围、当前信息和后续策略下的条件平均净收益，不保证单手输赢。先找影响最大的差异，再结合完整动作表检查较接近的替代选择。全局求解残差不是每个组合动作值的误差界。`,[top.netEVID,top.lossEVID,worst.netEVID,worst.lossEVID]);
 const comparisons=[...(d.comparisons??[])].filter(c=>c.alternative.id!=='fold').sort((a,b)=>Math.abs(b.evDifference)-Math.abs(a.evDifference));
 for(const c of comparisons){
  if(!near(d.actions.find(a=>a.id===c.alternative.id)?.ev,c.alternative.ev)||!near(d.actions.find(a=>a.id===c.baseline.id)?.ev,c.baseline.ev)||!near(c.alternative.ev-c.baseline.ev,c.evDifference)||!near(c.outcomes.reduce((s,x)=>s+x.difference,0),c.evDifference))throw Error('教案动作比较不能还原总收益差。');
  const terms=c.outcomes.filter(x=>Math.abs(x.difference)>1e-8).sort((a,b)=>Math.abs(b.difference)-Math.abs(a.difference));
  const positive=c.outcomes.filter(x=>x.difference>0).reduce((s,x)=>s+x.difference,0),negative=c.outcomes.filter(x=>x.difference<0).reduce((s,x)=>s-x.difference,0);
  const pieces=terms.map(x=>`“${phases[x.id]??x.label}”贡献${x.difference>=0?'增加':'减少'} ${bb(Math.abs(x.difference))}`).join('；');
  add('difference:'+c.alternative.id,`${c.alternative.label} 与 ${c.baseline.label}：正负项怎样抵消`,'evidence',`${c.alternative.label} 减去 ${c.baseline.label} 的净 EV 差是 ${bb(c.evDifference)}。${pieces||'各终局贡献相同'}。正向贡献差合计 ${bb(positive)}，负向贡献差的绝对值合计 ${bb(negative)}；两者抵消才得到总差。每项已包含发生概率与后续净收益，不能把贡献下降直接解释成条件胜率下降，也不能只拿某动作内部的一条负分支解释两个动作的差异。这个账本能定位接下来要查的响应与组合，具体范围机制仍需另做对照实验。`,ids(e=>e.baseline===c.baseline.id&&e.alternative===c.alternative.id));
  Object.assign(blocks.at(-1),{summary:`本次重点比较 ${c.alternative.label} 与 ${c.baseline.label}：沿同一组终局事件拆开 ${bb(c.evDifference)} 的净收益差。`,exercise:`先遮住参考，说明 ${c.alternative.label} 相对 ${c.baseline.label} 的主要正向与负向贡献；再选一个未看过答案的相邻局面，预测哪些贡献会改变，最后重新求解检验。`});
 }
 for(const a of d.actions){
  if(!a.responses.length)continue;
  const branches=a.responses.slice(0,3),text=branches.map(r=>{
   const next=r.continuation?.kind==='decision'?`，之后仍轮到 ${r.continuation.actorName} 决策`:r.continuation?.kind==='chance'?'，之后还要发公共牌':r.continuation?.kind==='terminal'?'，该响应后到达终局':'，此分支包含后续行动';
   return `${r.label}：概率 ${pct(r.probability)}，对动作 EV 的贡献 ${bb(r.evContribution)}${next}`;
  }).join('；');
  add('responses:'+a.id,`${a.label} 后，实际还会发生什么`,'evidence',`${text}。${a.responses.length>branches.length?'这里只列概率最高的响应，完整列表见计算证据。':''}响应概率条件于当前具体手牌，分支贡献已经包含从该响应到终局的继续投入、其他玩家行动与收益。${(report.context?.root?.players?.length??0)>2?'前一位对手弃牌或过牌，不能自动当成所有人弃牌或摊牌；先确认下一位行动者。':'只沿树中真实存在的响应研究；全下后是否还有加注，要由剩余玩家、筹码与动作树决定。'} 实战观察应围绕这个具体响应及其继续组合，不能只记一个总弃牌率。`,ids(e=>e.actionId===a.id&&['response-probability','response-contribution'].includes(e.metric)));
  Object.assign(blocks.at(-1),{summary:`本次沿 ${a.label} 后的真实响应，分清谁仍能行动，以及后续收益如何进入当前动作的 EV。`,exercise:`先遮住参考，沿 ${a.label} 后的真实路径逐一说出谁仍能行动，写下一个关于其继续范围的预测；再选一个未看过答案的相邻局面重新求解，检验这条判断条件。`});
 }
 add('balance','从一手动作，走向整段策略','principle','某手牌在固定参考对手下有近似相同的动作收益，不等于把整段范围逐手取整后仍同样安全。你需要检查不同动作留下的价值牌、抓诈唬牌与诈唬牌组合，再让对手对整套新策略做最佳响应。先完成一次范围构建，比较固定对手收益与可被针对的空间；两种评价回答不同问题。多人各方单边收益之和也不能直接叫作你的损失。');
 Object.assign(blocks.at(-1),{summary:'本次重点是整段范围的执行：把固定参考对手下的收益，与对手适应后的可利用空间分开检查。',exercise:'先独立完成一次范围构建，预测哪些组合取整会使整段策略容易被针对；再查看实际最佳响应路径，用一个未见局面检验同一条件。'});
 add('experiment','把原因写成可推翻的条件','principle','当前收益账本还没有证明哪类具体对手组合是变化原因。选一条树中真实存在的对手响应，明确记录哪些组合及概率属于你的假设；先预测收益差会怎样变，再只修改这一处并重新求解。保留不符合预测的结果，检查假设是否不适用。下一次使用未看过答案的相邻局面，先独立判断这条条件是否仍成立，而不是复述刚看过的频率。');
 const primary=comparisons[0],defaults=['decision',...(primary?['difference:'+primary.alternative.id,'responses:'+primary.alternative.id]:[]),'experiment'].filter(id=>blocks.some(b=>b.id===id));
 return {summary:`先研究 ${gap>1e-5?`${worst.label} 相对 ${top.label} 的 ${bb(gap)} 收益差`:'当前动作的近等收益'}，再把解释转成可检验的条件。`,blocks,defaultIds:defaults,combo:f.combo,actor:f.actor};
}

export function composeVerifiedCoachLesson(library,selection){
 if(!library||!Array.isArray(selection)||selection.length<1||selection.length>4||new Set(selection).size!==selection.length)throw Error('教案选择格式无效。');
 const byId=new Map(library.blocks.map(b=>[b.id,b]));
 if(selection.some(id=>!byId.has(id)))throw Error('模型选择了不存在的教案，不能扩展计算结论。');
 const selected=[byId.get('decision'),...selection.filter(id=>id!=='decision').map(id=>byId.get(id))].filter(Boolean).slice(0,4);
 const focus=selected.find(b=>b.id!=='decision'&&b.summary);
 return {summary:focus?.summary??library.summary,reasoning:selected.map(b=>({kind:b.kind,title:b.title,claim:b.body,evidenceIds:b.evidenceIds})),counterfactuals:[],exercise:focus?.exercise??'',limits:[]};
}
