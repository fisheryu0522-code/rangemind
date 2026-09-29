import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCoachDraft,validateCoachTeaching,coachOutputSchema,buildCoachModelReport,validateCoachMetricReferences,validateCoachExpectationLanguage,LOCAL_COACH_PROMPT_VERSION} from '../lib/local-coach.mjs';
const scenario={board:'Ks7h2h9c3s',hero:'AcKd'},report={context:{current:{focusCombo:'7c7d'}},evidence:[{id:'E001',label:'全下 120 BB 净 EV',value:34.18,unit:'BB'},{id:'E002',label:'相对最优损失',value:5.31,unit:'BB'}],verifiedActionFacts:{combo:'7c7d',actions:[{label:'全下 120 BB',netEVSign:'positive'}]}};
const draft=claim=>({summary:'先区分净收益与相对收益。',reasoning:[{kind:'evidence',claim,evidenceIds:['E001','E002']}],counterfactuals:[],exercise:'',limits:[]});
test('local language layer substitutes verified numbers and allows current actor hand labels',()=>{const v=validateCoachDraft(draft('7c7d 的 {{E001}}，仍然会少赚 {{E002}}。'),report,scenario);assert.match(v.reasoning[0].claim,/34.18 BB/);assert.match(v.reasoning[0].claim,/5.31 BB/);});
test('invented arithmetic and nonexistent evidence never pass numeric grounding',()=>{assert.throws(()=>validateCoachDraft(draft('全下收益为 99 BB。'),report,scenario),/数字/);assert.throws(()=>validateCoachDraft(draft('{{E999}}'),report,scenario),/不存在|证据不一致|没有计算证据/);assert.throws(()=>validateCoachDraft({...draft('观察范围。'),reasoning:[{kind:'evidence',claim:'必然提高收益',evidenceIds:[]}]},report,scenario),/缺少证据/);});
test('positive net EV cannot be described as negative total EV or obvious loss',()=>{assert.throws(()=>validateCoachDraft(draft('全下明显亏损，因为 {{E002}}。'),report,scenario),/正 EV/);assert.throws(()=>validateCoachDraft(draft('全下 EV 为负。'),report,scenario),/正 EV/);assert.doesNotThrow(()=>validateCoachDraft(draft('全下净收益为正，但相对最佳动作损失 {{E002}}。'),report,scenario));});

test('published teaching rejects title-only claims and accepts evidence-to-decision paragraphs',()=>{
 assert.throws(()=>validateCoachDraft(draft('全下与较小下注的净收益对比及相对损失'),report,scenario,{requireTeaching:true}),/标题|至少两句/);
 const text='全下的 {{E001}} 是给定范围和策略下的正向平均净收益，但 {{E002}} 表明它仍会少赚，所以不能把正收益直接等同于最佳动作。下次遇到相似决策，应比较同一组合在各动作下的后续净收益，再检查差异来自哪个对手响应分支，而不是只看一次下注能够迫使多少牌弃牌。';
 assert.doesNotThrow(()=>validateCoachDraft(draft(text),report,scenario,{requireTeaching:true}));assert.equal(validateCoachTeaching(draft(text)),true);assert.throws(()=>validateCoachTeaching({...draft(text),reasoning:[]}),/完整教学/);
});

test('multiplayer teaching cannot equate the first fold with winning the whole pot',()=>{
 const multi={...report,context:{root:{players:[{},{},{}]},current:{focusCombo:'7c7d'}}};assert.throws(()=>validateCoachDraft(draft('第一位对手弃牌后就直接拿下整个底池。'),multi,scenario),/多人底池/);assert.doesNotThrow(()=>validateCoachDraft(draft('第一位对手弃牌不代表直接拿下整个底池，仍需考虑身后玩家。'),multi,scenario));
});

test('teaching length never relaxes evidence, numeric or positive-EV validation',()=>{
 const invalid=draft('全下明显亏损，因此即使已有正向净收益也不能选择这个动作。下次遇到类似问题，应把相对最佳动作的收益差直接当作这个动作本身的绝对亏损来理解，并忽略其他继续分支。');assert.throws(()=>validateCoachDraft(invalid,report,scenario,{requireTeaching:true}),/正 EV/);
 assert.throws(()=>validateCoachDraft({...draft('观察证据。'),reasoning:[{kind:'fiction',claim:'任意解释',evidenceIds:['E001']}]},report,scenario),/解释类型/);
});

test('evidence IDs are constrained to actual raw IDs and Chinese amounts cannot bypass grounding',()=>{
 assert.deepEqual(coachOutputSchema(report).properties.reasoning.items.properties.evidenceIds.items.enum,['E001','E002']);assert.equal(coachOutputSchema({evidence:[]}).properties.reasoning.items.properties.evidenceIds.maxItems,0);assert.throws(()=>validateCoachDraft(draft('下注四十个单位可以获得收益。'),report,scenario),/汉字绕过/);assert.throws(()=>validateCoachDraft(draft('弃牌率是百分之五十。'),report,scenario),/汉字绕过/);
});

test('EV proximity, residual size and terminal contributions cannot masquerade as mixing, convergence or showdown equity',()=>{
 for(const [text,pattern] of [['过牌属于近似等 EV 的混合区间。',/混合区间/],['当前求解残差极小，说明该树内策略已高度稳定。',/稳定|收敛/],['全下让摊牌权益断崖式下跌。',/条件摊牌权益/]])assert.throws(()=>validateCoachDraft(draft(text),report,scenario),pattern);
 assert.doesNotThrow(()=>validateCoachDraft(draft('收益接近不能证明混合区间存在。摊牌终局贡献下降不等于条件摊牌权益下降，范围强度变化仍是待检验假设。'),report,scenario));
});

const typed=[
 {id:'E901',metric:'net-ev',label:'全下净 EV',value:31.9151,unit:'BB',source:'verified',actionId:'allin'},
 {id:'E902',metric:'relative-best-loss',label:'全下相对最高行动收益损失',value:7.5725,unit:'BB',actionId:'allin'},
 {id:'E903',metric:'response-probability',label:'全下后对手弃牌概率',value:.834,unit:'比例'},
 {id:'E904',metric:'response-contribution',label:'全下后对手弃牌 EV 贡献',value:33.3616,unit:'BB'},
 {id:'E905',metric:'action-difference',label:'全下相比过牌 EV 差',value:-7.5502,unit:'BB',baseline:'check',alternative:'allin'},
 {id:'E906',metric:'outcome-contribution-difference',label:'全下相比过牌摊牌获得份额贡献差',value:-30.1688,unit:'BB'}
];
const typedReport={...report,evidence:[...report.evidence,...typed],sections:[{title:'Duplicate old prose',body:'must not reach the action model'}],decision:{massiveTree:[1,2,3]},limitations:['范围是研究假设'],nextExperiments:[{body:'只修改一个条件重算'}]};
test('action-model input contains compact typed evidence and never duplicate untyped prose',()=>{
 const compact=buildCoachModelReport(typedReport);assert.equal(compact.evidence.length,6);assert.ok(compact.evidence.every(x=>x.metric&&!Object.hasOwn(x,'source')));assert.equal(compact.sections,undefined);assert.equal(compact.decision,undefined);assert.deepEqual(compact.context,report.context);assert.deepEqual(compact.verifiedActionFacts,report.verifiedActionFacts);assert.deepEqual(compact.limitations,typedReport.limitations);assert.deepEqual(compact.nextExperiments,typedReport.nextExperiments);assert.equal(compact.evidence.find(x=>x.id==='E905').baseline,'check');assert.ok(coachOutputSchema(compact).properties.reasoning.items.properties.evidenceIds.items.enum.every(id=>Number(id.slice(1))>900));
});
test('typed losses cannot reuse a signed baseline difference even when both units are BB',()=>{
 for(const claim of ['全下相对最优损失 {{E905}}。','相对当前最高行动 EV 的损失为 {{E905}}。','放弃最优动作的机会成本是 {{E905}}。','{{E905}} 是相对最优损失。'])assert.throws(()=>validateCoachMetricReferences(claim,typed),/relative|action-difference|相对最优损失/);
 assert.doesNotThrow(()=>validateCoachMetricReferences('全下净 EV 为 {{E901}}，相对最优损失为 {{E902}}；相比过牌 EV 差为 {{E905}}。',typed));
});
test('net EV, branch probability and contribution have distinct reference types',()=>{
 for(const [claim,kind] of [['净 EV 为 {{E904}}。','response-contribution'],['对手弃牌概率为 {{E904}}。','response-contribution'],['此动作净收益 {{E903}}。','response-probability'],['分支贡献 {{E903}}。','response-probability'],['摊牌贡献减少 {{E901}}。','net-ev']])assert.throws(()=>validateCoachMetricReferences(claim,typed),new RegExp(kind));
 assert.doesNotThrow(()=>validateCoachMetricReferences('对手弃牌概率 {{E903}}，此分支贡献 {{E904}}。摊牌获得份额贡献减少 {{E906}}，所有贡献差加总等于总 EV 差 {{E905}}。',typed));
});
test('inline known references complete bibliographic IDs without editing a claim or relaxing metric checks',()=>{
 const input={...draft('全下净 EV {{E901}}，相对最优损失 {{E902}}。'),reasoning:[{kind:'evidence',claim:'全下净 EV {{E901}}，相对最优损失 {{E902}}。',evidenceIds:['E901']}]},original=structuredClone(input),model=buildCoachModelReport(typedReport),out=validateCoachDraft(input,model,scenario);assert.deepEqual(out.reasoning[0].evidenceIds,['E901','E902']);assert.deepEqual(input,original);assert.match(out.reasoning[0].claim,/7.5725 BB/);
 assert.throws(()=>validateCoachDraft({...input,reasoning:[{...input.reasoning[0],claim:'相对最优损失 {{E905}}。'}]},model,scenario),/指标|相对最优损失/);assert.throws(()=>validateCoachDraft({...input,reasoning:[{...input.reasoning[0],claim:'净 EV {{E999}}。'}]},model,scenario),/不存在/);assert.throws(()=>validateCoachDraft({...input,reasoning:[{...input.reasoning[0],claim:'净 EV {{E001}}。'}]},model,scenario),/不存在/);
});

test('conditional expectation never licenses guaranteed realized profit or absence of losses',()=>{
 for(const claim of ['净收益为正仅说明该动作在此刻不会导致绝对亏损。','正 EV 保证这次一定盈利。','这是无风险的选择。','正期望意味着单次不亏。','所以不会输钱。','净收益为正意味着没有绝对亏损。','虽然不是最好的动作，但正 EV 仍保证盈利。'])assert.throws(()=>validateCoachExpectationLanguage(claim,typedReport),/条件平均|单次/);
 for(const claim of ['EV 是给定范围及后续策略下的条件平均净收益，正 EV 仍可能在单次牌局中亏损。','正 EV 不保证盈利，也不代表单次不会亏损。','不能说正 EV 保证盈利，更不能认为这次不亏。','这里比较的是模型期望收益，不是本次实际输赢。'])assert.doesNotThrow(()=>validateCoachExpectationLanguage(claim,typedReport));
 // The guarantee is in another clause: unrelated negation must not hide it.
 assert.throws(()=>validateCoachExpectationLanguage('这不是最优动作，但一定赚钱。',typedReport),/条件平均/);
});
test('unsupported initiative is rejected even when attached to valid numerical citations',()=>{
 for(const claim of ['过牌面对对手下注时缺乏主动权。','下注保留主动权，因此收益更高。','只是假设丧失主动权造成收益降低。','可以控制节奏以提升收益。'])assert.throws(()=>validateCoachExpectationLanguage(claim,typedReport),/主动权/);
 for(const claim of ['不能用主动权代替实际分支计算。','尚无证据说明主动权具有独立收益效应。','主动权不是这份报告已经验证的原因。'])assert.doesNotThrow(()=>validateCoachExpectationLanguage(claim,typedReport));
 assert.throws(()=>validateCoachDraft(draft('全下的 {{E001}} 为正，因为主动权使收益提高。'),report,scenario),/主动权/);
});
test('published action teaching explicitly locates EV in the conditional model, not realized outcomes',()=>{
 const text='这些动作都具有正向净收益，但不同动作与最佳动作相比仍有不同的机会成本。下次面对相似节点，应检查每个响应分支如何改变动作价值，再核对当前输入范围是否符合实战判断。';assert.throws(()=>validateCoachDraft(draft(text),report,scenario,{requireTeaching:true}),/条件平均/);
 assert.doesNotThrow(()=>validateCoachDraft(draft('EV 是给定范围与后续策略下的条件平均净收益，单次牌局仍可能亏损。'+text),report,scenario,{requireTeaching:true}));
});
test('rendered references are concise values while full evidence remains independently inspectable',()=>{
 const raw={...draft('全下净 EV 为 {{E901}}，相对最优损失为 {{E902}}，对手弃牌概率为 {{E903}}。'),reasoning:[{kind:'evidence',claim:'全下净 EV 为 {{E901}}，相对最优损失为 {{E902}}，对手弃牌概率为 {{E903}}。',evidenceIds:[]}]},before=structuredClone(typedReport),out=validateCoachDraft(raw,buildCoachModelReport(typedReport),scenario);
 assert.equal(out.reasoning[0].claim,'全下净 EV 为 31.9151 BB，相对最优损失为 7.5725 BB，对手弃牌概率为 83.4 %。');assert.deepEqual(out.reasoning[0].evidenceIds,['E901','E902','E903']);assert.deepEqual(typedReport,before);assert.equal(LOCAL_COACH_PROMPT_VERSION,15);
 const small={...report,evidence:[{id:'E001',label:'极小但非零模型差',value:1.23456789e-8,unit:'BB'},report.evidence[1]]};const shown=validateCoachDraft(draft('{{E001}}。'),small,scenario);assert.match(shown.reasoning[0].claim,/1\.23457e-8 BB/);
});
test('signed differences render decreases as magnitudes without altering evidence or reversing direction',()=>{
 const model=buildCoachModelReport(typedReport),raw={...draft('摊牌贡献下降 {{E906}}，贡献差为 {{E906}}。'),reasoning:[{kind:'evidence',claim:'摊牌贡献下降 {{E906}}，贡献差为 {{E906}}。',evidenceIds:[]}]};const shown=validateCoachDraft(raw,model,scenario);assert.equal(shown.reasoning[0].claim,'摊牌贡献下降 30.1688 BB，贡献差为 -30.1688 BB。');assert.equal(model.evidence.find(e=>e.id==='E906').value,-30.1688);
 assert.throws(()=>validateCoachMetricReferences('摊牌贡献增加 {{E906}}。',typed),/方向矛盾/);assert.throws(()=>validateCoachMetricReferences('净 EV 减少 {{E901}}。',typed),/不是变化量/);assert.doesNotThrow(()=>validateCoachMetricReferences('摊牌贡献差下降至 {{E906}}。',typed));
});
test('highest reported EV does not establish a unique strategy or turn product tolerance into a confidence interval',()=>{
 for(const text of ['这是唯一正确动作。','你只能执行最高 EV 的动作。','容忍阈值就是该动作的置信区间。'])assert.throws(()=>validateCoachDraft(draft(text),report,scenario),/唯一|容忍阈值/);
 assert.doesNotThrow(()=>validateCoachDraft(draft('本次计算最高 EV 不代表唯一正确动作。容忍阈值不是置信区间，近等收益也不能证明精确混合频率。'),report,scenario));
});

test('negated guaranteed-outcome language remains valid while an actual guarantee in a later clause is rejected',()=>{
 assert.doesNotThrow(()=>validateCoachExpectationLanguage('正 EV 不保证这次牌局盈利，也不表示本次不会亏损。',typedReport));
 assert.doesNotThrow(()=>validateCoachExpectationLanguage('正 EV 不意味着单次不会亏损。',typedReport));
 assert.throws(()=>validateCoachExpectationLanguage('不表示本次不会亏损，但这次一定盈利。',typedReport),/条件平均/);
});
test('transfer prompts use available node actions and prioritize a material loss rather than an absent call',async()=>{
 const {coachTransferQuestion}=await import('../lib/local-coach.mjs');
 const q=coachTransferQuestion({verifiedActionFacts:{actions:[{id:'check',label:'过牌',lossRelativeToBest:.02},{id:'bet_20',label:'下注 20 BB',lossRelativeToBest:.03},{id:'bet_80',label:'全下 80 BB',lossRelativeToBest:7}]},context:{current:{toCall:0}}});
 assert.match(q,/全下 80 BB 相对 过牌/);assert.doesNotMatch(q,/跟注更有价值/);
});

test('first-response continuations prevent a multiplayer check from being taught as showdown',async()=>{
 const {validateCoachContinuationLanguage}=await import('../lib/local-coach.mjs');
 const source={...typedReport,decision:{actions:[{id:'check',label:'过牌',responses:[{id:'n1:check',label:'BB 过牌',continuation:{kind:'decision',actorName:'BTN'}}]}]}};
 const compact=buildCoachModelReport(source);assert.equal(compact.continuations[0].actorName,'BTN');
 assert.throws(()=>validateCoachContinuationLanguage('BB 过牌的概率很高，说明直接进入摊牌。',compact),/仍轮到 BTN/);
 assert.doesNotThrow(()=>validateCoachContinuationLanguage('BB 过牌不代表直接进入摊牌，BTN 仍须决策。',compact));
 assert.doesNotThrow(()=>validateCoachContinuationLanguage('BB 过牌后直接进入摊牌。',{continuations:[{responseLabel:'BB 过牌',kind:'terminal'}]}));
 assert.throws(()=>validateCoachContinuationLanguage('过牌保留身后玩家摊牌权益。',compact),/没有独立证据/);
 assert.equal(compact.teachingFocus.difference.id,'E905');assert.equal(compact.teachingFocus.contributions.length,0);
});
