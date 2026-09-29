import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildVerifiedCoachLessons,composeVerifiedCoachLesson} from './coach-lessons.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),engine=path.join(root,'engines','local-coach');
const model=path.join(engine,'models','Qwen3.6-27B-Q4_K_M.gguf'),port=Number(process.env.POKERLAB_COACH_PORT)||8740,base=`http://127.0.0.1:${port}`;
let child=null,starting=null,apiKey=null,idle=null,lastError=null;
const expectedSize=19095766304;
export const LOCAL_COACH_PROMPT_VERSION=15;
export function localCoachStatus(){return {model:'Qwen3.6-27B · Q4_K_M',installed:fs.existsSync(model)&&fs.statSync(model).size===expectedSize,running:!!child&&!child.killed,loading:!!starting,lastError,device:'RTX 4090',port};}
export function stopLocalCoach(){clearTimeout(idle);if(child&&!child.killed)child.kill();child=null;apiKey=null;}
export async function releaseLocalCoach(){const active=child;stopLocalCoach();if(active&&active.exitCode===null)await new Promise(resolve=>{const timer=setTimeout(resolve,5000);const finish=()=>{clearTimeout(timer);resolve();};active.once('close',finish);active.once('error',finish);});}
function scheduleIdle(){clearTimeout(idle);idle=setTimeout(stopLocalCoach,15*60*1000);idle.unref();}
async function ensureLocalCoach(){
 if(starting)return starting;
 if(child&&!child.killed){scheduleIdle();return;}
 if(!localCoachStatus().installed)throw Error('本地模型尚未完成安装与文件核验。');
 starting=(async()=>{
  apiKey=crypto.randomBytes(32).toString('hex');fs.mkdirSync(path.join(root,'data','pro','coach'),{recursive:true});
  const logs=fs.createWriteStream(path.join(root,'data','pro','coach','model.log'),{flags:'a'});let tail='';
  const args=['-m',model,'-ngl','all','-c','12288','-np','1','-t','8','-tb','12','-fa','on','-ctk','q8_0','-ctv','q8_0','--reasoning','off','--reasoning-budget','0','--host','127.0.0.1','--port',String(port),'--no-webui','--no-agent','--api-key',apiKey];
  child=spawn(path.join(engine,'llama-server.exe'),args,{cwd:engine,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const active=child;active.stdout.on('data',b=>logs.write(b));active.stderr.on('data',b=>{logs.write(b);tail=(tail+b).slice(-6000);});
  active.on('error',e=>{lastError=e.message;});active.on('close',code=>{logs.end();if(child===active)child=null;if(code)lastError=tail.slice(-1500);});
  for(let n=0;n<180;n++){
   if(active.exitCode!==null)throw Error('本地模型启动失败：'+(lastError||tail.slice(-1000)));
   try{const r=await fetch(base+'/health',{headers:{Authorization:'Bearer '+apiKey},signal:AbortSignal.timeout(1000)});if(r.ok){scheduleIdle();lastError=null;return;}}catch{}
   await new Promise(r=>setTimeout(r,500));
  }
  stopLocalCoach();throw Error('本地模型载入超时；证据解释仍然可用。');
 })();
 try{await starting;}finally{starting=null;}
}
const fallback=(report,reason)=>({text:[report.headline,...(report.sections||[]).map(s=>s.title+'\n'+s.body)].join('\n\n'),model:'可核验的证据解释',grounding:'deterministic',evidenceIds:(report.evidence||[]).map(e=>e.id),limitations:[...(report.limitations||[]),reason].filter(Boolean),warning:reason});
const fullSchema={type:'object',properties:{summary:{type:'string'},reasoning:{type:'array',minItems:1,maxItems:3,items:{type:'object',properties:{kind:{type:'string',enum:['evidence','principle','hypothesis']},claim:{type:'string',description:'完整中文教学段落，不是标题或提纲。至少两句完整解释：连接当前证据、可被支持的机制或待检验假设、下一次要检查的决策条件。'},evidenceIds:{type:'array',items:{type:'string'}}},required:['kind','claim','evidenceIds'],additionalProperties:false}},counterfactuals:{type:'array',items:{type:'string'}},exercise:{type:'string'},limits:{type:'array',items:{type:'string'}}},required:['summary','reasoning','counterfactuals','exercise','limits'],additionalProperties:false};
const schema={...fullSchema,properties:{summary:fullSchema.properties.summary,reasoning:fullSchema.properties.reasoning},required:['summary','reasoning']};
export function coachOutputSchema(report){
 const out=structuredClone(schema),ids=[...new Set((report.evidence??[]).map(e=>String(e.id)))];
 if(report.teachingFocus)out.properties.reasoning.maxItems=2;
 out.properties.reasoning.items.properties.evidenceIds.items=ids.length?{type:'string',enum:ids}:{type:'string'};
 if(!ids.length)out.properties.reasoning.items.properties.evidenceIds.maxItems=0;
 return out;
}
const changeDirection=prefix=>{const m=prefix.match(/(增加|增长|上升|提高|净增|减少|降低|下降|下跌|缩减|下滑)(?:了|幅度(?:为|是))?\s*$/);return m?(/减少|降低|下降|下跌|缩减|下滑/.test(m[1])?-1:1):0;};
const displayEvidence=(e,prefix='')=>{let value=e.value,unit=e.unit??'';if(typeof value==='number'){if(e.metric?.endsWith('-difference')&&changeDirection(prefix)===-1)value=Math.abs(value);if(unit==='比例'){value*=100;unit='%';}value=Number(value.toPrecision(6));}return `${typeof value==='object'?JSON.stringify(value):value}${unit?' '+unit:''}`;};
const interpretationConstraints=['EV 是给定当前信息、输入范围及后续策略下的条件平均净收益。正 EV 不保证这次牌局盈利，也不表示本次不会亏损；请明确区分条件期望和单次结果。','行动 EV 接近只能说明在已报告后续策略下收益接近，不能据此声称存在“混合区间”。若要描述混合频率，只能引用确实已报告的频率。','摊牌终局收益贡献是该终局概率与净收益的合成结果，其下降不等于条件摊牌权益下降。本报告未计算改变尺寸后的条件摊牌权益，不得声称它下跌或继续范围必然更强；这只能是待检验假设。','全局残差小只限制这个模型内允许的单方偏离收益，不能据此说策略频率已稳定、迭代已收敛或单个组合动作精确无误。','报告没有量化“主动权”或“控制节奏”的独立效应，不能把这些词当作已验证的收益原因。请具体说明已观察的行动、响应概率和条件收益，证据不足时只提出可检验假设。'];
interpretationConstraints.push('动作比较的最高值只称“本次计算最高 EV”，不能称为唯一正确动作或唯一策略。closeToBest 是产品比较的容忍阈值，不是统计置信区间；全局残差也不是每个组合行动 EV 的误差界。近等 EV 与已报告混频应保留这种精度边界，不能推出精确混合频率。');
/** The action report deliberately excludes duplicate untyped evidence and long
 * prose. Metric tags identify the question a number answers, not just its unit. */
export function buildCoachModelReport(report){
 if(!report.verifiedActionFacts){const plain={...report,interpretationConstraints};delete plain.decision;return plain;}
 const evidence=(report.evidence??[]).filter(e=>typeof e.metric==='string'&&e.metric).map(e=>Object.fromEntries(['id','label','value','unit','metric','actionId','responseId','baseline','alternative','outcome'].filter(key=>e[key]!==undefined).map(key=>[key,e[key]])));
 const comparisons=evidence.filter(e=>e.metric==='action-difference').sort((a,b)=>Math.abs(b.value)-Math.abs(a.value)),largest=comparisons[0];
 const teachingFocus=largest?{difference:largest,contributions:evidence.filter(e=>e.metric==='outcome-contribution-difference'&&e.alternative===largest.alternative&&e.baseline===largest.baseline).sort((a,b)=>Math.abs(b.value)-Math.abs(a.value)),instruction:'先解释这组最大动作差：列出最大的正负贡献，全部相加才是总差。比较动作时不能只把一个动作内部的负分支当成差异的原因。贡献账本不是范围强弱或阻断机制的因果证明。'}:null;
 const continuations=(report.decision?.actions??[]).flatMap(a=>a.responses.filter(r=>r.continuation).map(r=>({actionId:a.id,actionLabel:a.label,responseId:r.id,responseLabel:r.label,...r.continuation})));
 return {context:report.context??null,verifiedActionFacts:report.verifiedActionFacts,evidence,teachingFocus,continuations,limitations:report.limitations??[],nextExperiments:report.nextExperiments??[],interpretationConstraints};
}
const metricRules=[
 {pattern:/(?:相对[^，,。；;\n]{0,25}损失|相对(?:收益)?损失|机会成本|少赚)/gi,allowed:['relative-best-loss'],label:'相对最优损失'},
 {pattern:/(?:净\s*EV|净收益|期望净收益|净期望|行动\s*EV|动作\s*EV|总\s*EV)/gi,allowed:['net-ev'],label:'行动净 EV'},
 {pattern:/(?:EV|净收益|期望收益|收益)\s*(?:总)?(?:差(?:值|异)?|变化)/gi,allowed:['action-difference'],label:'相对基准动作的收益差'},
 {pattern:/(?:概率|频率|弃牌率|跟注率|加注率|选择率)/g,allowed:['response-probability','action-frequency','strategy-frequency'],label:'响应概率或策略频率'},
 {pattern:/(?:贡献差(?:值)?|贡献(?:增加|减少|下降|上升|变化))/g,allowed:['outcome-contribution-difference'],label:'终局贡献差'},
 {pattern:/(?:贡献|分支(?:净)?收益)(?!差|增加|减少|下降|上升|变化)/g,allowed:['response-contribution','outcome-contribution','outcome-contribution-difference'],label:'收益贡献'}
];
function expectedMetric(prefix){
 const matches=[];
 for(const rule of metricRules){rule.pattern.lastIndex=0;for(const m of prefix.matchAll(rule.pattern))matches.push({end:m.index+m[0].length,length:m[0].length,rule});}
 return matches.sort((a,b)=>b.end-a.end||b.length-a.length)[0]?.rule??null;
}
/** A narrow local guard: it checks explicit metric nouns beside a reference.
 * It does not certify the causal interpretation of an otherwise valid number. */
export function validateCoachMetricReferences(text,evidence){
 const known=evidence instanceof Map?evidence:new Map((evidence??[]).map(e=>[String(e.id),e]));
 for(const match of String(text).matchAll(/\{\{(E\d+)\}\}/g)){
  const item=known.get(match[1]);if(!item)throw Error('数值占位符没有计算证据。');if(!item.metric)continue;
  const before=text.slice(0,match.index).split(/[，,。；;\n]/).at(-1).slice(-100).replace(/\{\{E\d+\}\}/g,'');
  const direction=changeDirection(before);
  if(direction&&typeof item.value==='number'){
   if(!item.metric.endsWith('-difference'))throw Error(`${match[1]} 的指标 ${item.metric} 是数值水平，不是变化量；不能直接作为“增加或减少”的幅度。请引用已计算的差值指标。`);
   if(direction*item.value<0)throw Error(`${match[1]} 的带符号差值与“增加或减少”的方向矛盾；请保留原始方向，不要反转含义。`);
  }
  let expected=expectedMetric(before);
  if(!expected){const after=text.slice(match.index+match[0].length).split(/[，,。；;\n]/)[0];const meaning=after.match(/^\s*(?:是|为|表示|代表)(.{1,35})/);if(meaning)expected=expectedMetric(meaning[1]);}
  if(expected&&!expected.allowed.includes(item.metric))throw Error(`${match[1]} 的指标是 ${item.metric}，不能作为${expected.label}。请使用该动作对应的独立指标，不要挪用相同单位的其他数值。`);
 }
 return true;
}
/** Reject an explicit action/value swap when a clause unambiguously names one
 * action. This is a narrow additional guard, not natural-language entailment:
 * ambiguous multi-action sentences still require the reader's evidence check.
 */
export function validateCoachActionReferences(text,report={}){
 const actions=(report.verifiedActionFacts?.actions??[]).filter(a=>typeof a.id==='string'&&a.id.length);if(!actions.length)return true;
 const known=new Map((report.evidence??[]).map(e=>[String(e.id),e]));
 const groups={check:actions.filter(a=>a.id==='check'),fold:actions.filter(a=>a.id==='fold'),call:actions.filter(a=>a.id==='call'),bet:actions.filter(a=>a.id?.startsWith('bet_')),raise:actions.filter(a=>a.id?.startsWith('raise_'))};
 const labels=new Map(actions.map(a=>[a.id,new Set([String(a.label).replace(/\s/g,'')])]));
 for(const [kind,label] of Object.entries({check:'过牌',fold:'弃牌',call:'跟注',bet:'下注',raise:'加注'}))if(groups[kind].length===1)labels.get(groups[kind][0].id).add(label);
 const shoves=actions.filter(a=>/^全下/.test(a.label));if(shoves.length===1)labels.get(shoves[0].id).add('全下');
 for(const match of String(text).matchAll(/\{\{(E\d+)\}\}/g)){
  const evidence=known.get(match[1]);if(!evidence?.actionId||!['net-ev','relative-best-loss'].includes(evidence.metric))continue;
  const clause=text.slice(0,match.index).split(/[，,。；;\n]/).at(-1).replace(/\s/g,'');
  const mentioned=actions.filter(a=>[...labels.get(a.id)].some(label=>label&&clause.includes(label)));
  if(mentioned.length===1&&mentioned[0].id!==evidence.actionId)throw Error(`${match[1]} 是另一个动作的数值，不能作为“${mentioned[0].label}”的收益或损失。请按动作绑定的 netEVID / lossEVID 引用。`);
 }
 return true;
}
function negatesClaim(prefix){return /(?:不|不会|不能|无法|未|未能|不应)$/.test(prefix)||/(?:不代表|不表示|不意味着|不等于|并非|不是|未必|不一定|不能(?:说|认为|保证|确保|证明|推导|理解为)?|无法(?:保证|确保|证明)?|不要(?:说|认为)?|不应(?:说|认为)?)[^，,。；;！？!?\n]{0,24}$/.test(prefix);}
export function validateCoachExpectationLanguage(text,report={}){
 for(const clause of String(text).split(/[，,。；;！？!?\n]/)){
  const unrealized=/(?:不会|绝不会|不可能)(?:再|因此|直接|实际|导致|造成|产生|出现|发生|遭受|有)*(?:任何|绝对|实际|单次)?(?:亏损|输钱|赔钱|亏钱|损失)|(?:没有|不存在)(?:任何|绝对|单次|实际)?亏损|(?:单次|这次|本次|每次|这一手)(?:牌局|决策)?(?:都)?(?:不亏(?:损)?|不输钱)|(?:保证|确保|必然|一定|肯定)(?:能够|会|能)?(?:盈利|赚钱|赢钱|获利|获胜)|(?:稳赚|稳盈|无风险|零风险|绝对不亏|保证保本)/g;
  for(const m of clause.matchAll(unrealized))if(!negatesClaim(clause.slice(0,m.index)))throw Error('正 EV 是给定范围和后续策略下的条件平均净收益，不能保证单次盈利，也不能说本次不会亏损。请区分期望与实际结果。');
  if(/主动权|掌控节奏|控制节奏/.test(clause)&&!report.evidence?.some(e=>e.metric==='initiative-effect'&&e.verified===true)){
   const at=clause.search(/主动权|掌控节奏|控制节奏/),before=clause.slice(0,at),after=clause.slice(at);
   if(!negatesClaim(before)&&!/(?:没有|缺少|缺乏|尚无|尚未|未有)[^，,。]{0,18}(?:证据|验证|量化|计算)/.test(clause)&&!/(?:主动权|掌控节奏|控制节奏)[^，,。]{0,10}(?:不是|并非|不等于|不能|尚未)/.test(after))throw Error('报告没有核验“主动权”的独立收益效应。请删除这类泛化因果标签，改为已有证据中的具体响应概率、条件收益或可检验假设。');
  }
 }
 return true;
}
export function validateCoachContinuationLanguage(text,report={}){
 for(const sentence of String(text).split(/[。；;\n]/)){
  if(/(?:不代表|不表示|不意味着|不等于|不能|未必|不一定|尚未)/.test(sentence))continue;
  for(const response of report.continuations??[]){
   if(response.kind!=='decision'||!sentence.includes(response.responseLabel))continue;
   if(/(?:直接|立即|自动|已经|就|便)[^。；]{0,16}(?:进入摊牌|到达摊牌|结束行动|结束本街|拿下.*底池|赢得.*底池)/.test(sentence))throw Error(response.responseLabel+' 后仍轮到 '+response.actorName+' 决策，不能把该响应当成终局。请准确区分第一位对手的响应与所有后续行动后的终局事件。');
  }
  if(/保留(?:身后玩家|对手)(?:的)?摊牌(?:权益|份额)|(?:底池控制权|最优平衡|平衡价值与风险)/.test(sentence))throw Error('这类抽象标签没有独立证据，且保留对手份额不是选择动作的已验证收益理由。请改用动作间同一终局事件的贡献差，并把具体范围机制留作可检验假设。');
 }
 return true;
}
export function validateCoachTeaching(generated){
 if(!Array.isArray(generated?.reasoning)||generated.reasoning.length<1||generated.reasoning.length>3)throw Error('请提供一至三段完整教学解释，而不是空提纲。');
 for(const row of generated.reasoning){
  const clean=String(row.claim??'').replace(/\{\{E\d+\}\}|\[E\d+(?:[、,]\s*E\d+)*\]/g,'').trim();
  const sentences=(clean.match(/[^。！？!?]+[。！？!?]/g)||[]).map(x=>x.trim()).filter(x=>x.length>=12);
  if(clean.length<45||sentences.length<2)throw Error('reasoning.claim 只是标题或解释不足；每项必须至少两句完整解释，连接证据、机制或待检验假设、下次决策检查，不能只写主题名称。');
 }
 return true;
}
export function validateCoachDraft(generated,report,scenario,{requireTeaching=false}={}){
 const known=new Map((report.evidence||[]).map(e=>[String(e.id),e]));
 if(!generated||typeof generated.summary!=='string'||!Array.isArray(generated.reasoning)||!Array.isArray(generated.counterfactuals)||typeof generated.exercise!=='string'||!Array.isArray(generated.limits))throw Error('本地解读格式不完整。');
 // Complete bibliography metadata from valid inline references. Unknown IDs are
 // still rejected; this never changes numbers, metric tags, or the claim itself.
 generated={...generated,reasoning:generated.reasoning.map(row=>{if(!row||typeof row.claim!=='string'||!Array.isArray(row.evidenceIds))throw Error('本地解释段落格式无效。');const ids=[...row.evidenceIds,...[...row.claim.matchAll(/\{\{(E\d+)\}\}/g)].map(m=>m[1])];if(ids.some(id=>!known.has(String(id))))throw Error('解读引用了不存在的证据。');return {...row,evidenceIds:[...new Set(ids)]};})};
 const strings=[generated.summary,generated.exercise,...generated.counterfactuals,...generated.limits];
 for(const row of generated.reasoning){if(typeof row.claim!=='string'||!Array.isArray(row.evidenceIds)||row.evidenceIds.some(id=>!known.has(String(id))))throw Error('解读引用了不存在的证据。');if(!['evidence','principle','hypothesis'].includes(row.kind))throw Error('解释类型必须区分证据、教学原理与待检验假设。');if(row.kind!=='principle'&&row.kind!=='hypothesis'&&!row.evidenceIds.length&&!/假设|待检验|尚未|无法判断/.test(row.claim))throw Error('机制解释缺少证据或假设标记。');for(const m of row.claim.matchAll(/\{\{(E\d+)\}\}/g))if(!row.evidenceIds.includes(m[1]))throw Error('数值引用与本段证据不一致。');strings.push(row.claim);}
 for(const text of strings){if(typeof text!=='string')throw Error('本地解读包含非文本内容。');validateCoachMetricReferences(text,known);validateCoachActionReferences(text,report);validateCoachExpectationLanguage(text,report);validateCoachContinuationLanguage(text,report);let clean=text.replace(/\{\{(E\d+)\}\}/g,(_,id)=>{if(!known.has(id))throw Error('数值占位符没有计算证据。');return '';}).replace(/\bE\d+\b/g,'');
  // Card labels are permitted only when they are visible in this scenario.
  const cards=((scenario.board||'')+' '+(scenario.hero||'')+' '+(report.context?.current?.focusCombo||'')+' '+(report.verifiedActionFacts?.combo||'')).match(/[2-9TJQKA][cdhs]/g)||[];for(const card of cards)clean=clean.replaceAll(card,'');
  const actionLabels=[...JSON.stringify(report.evidence||[]).matchAll(/(?:加注到|下注|全下) \d+(?:\.\d+)? BB/g)].map(m=>m[0]);for(const label of actionLabels)clean=clean.replace(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&').replaceAll(' ','\\s*'),'g'),'');
  if(/\d/.test(clean))throw Error('解读生成了未经计算模块引用的数字，已保留原始证据解释。');
  if(/[零〇一二两三四五六七八九十百千万亿点]+\s*(?:个?单位|个?大盲|BB|个百分点)|百分之[零〇一二两三四五六七八九十百千万亿点]+/i.test(clean))throw Error('金额或百分数不能改写成汉字绕过引用校验；请用已有证据占位符，或只说较小下注与全下。');
  if(/绝对正确|完美GTO|无法被剥削/.test(text))throw Error('解释使用了未经证明的策略保证。');
  for(const sentence of text.split(/[。；\n]/)){
   const qualified=/(?:不代表|不等于|不能|并非|尚未|未必|待检验|假设)/.test(sentence);
   if(!qualified&&/(?:近似等\s*EV[^。]{0,12}混合|处于[^。]{0,12}混合区间|损失[^。]{0,12}(?:极小|很小|接近零)[^。]{0,18}混合区间)/i.test(sentence))throw Error('行动 EV 接近不能证明存在混合区间；请区分已报告策略频率与当前后续策略下的近似收益。');
   if(!qualified&&/残差[^。]{0,12}(?:极小|很小|较小|小于|低于)[^。]{0,15}(?:说明|表明|证明)[^。]{0,15}(?:稳定|收敛|最优)/.test(sentence))throw Error('小残差不是策略频率已稳定或算法已收敛的证明；只描述已核验的有限树内偏离收益。');
   if(report.verifiedActionFacts&&!qualified&&!/可能/.test(sentence)&&/摊牌(?:权益|胜率)[^。]{0,12}(?:下跌|下降|减少|提升|提高|上升)/.test(sentence)&&!report.evidence?.some(e=>e.source==='conditional-showdown-equity'))throw Error('摊牌终局的收益贡献变化不等于条件摊牌权益变化；报告没有该条件权益，请将范围强度解释标为待检验假设。');
   if(!qualified&&/(?:唯一(?:正确|最优)(?:动作|策略)?|只能[^。]{0,16}(?:最高|最大|最优)|(?:最高|最大)\s*EV[^。]{0,16}(?:必须|只能)|(?:必须|应当|应该)只(?:选择|执行|使用)?[^。]{0,16}(?:最大|最高|最优))/.test(sentence))throw Error('本次计算最高 EV 不等于唯一正确动作或唯一策略；近等 EV、已报告混频及计算精度必须保留边界。');
   if(!qualified&&/(?:closeToBest|容忍阈值)[^。]{0,15}(?:置信区间|误差界)/i.test(sentence))throw Error('closeToBest 是产品容忍阈值，不是置信区间或组合级误差界。');
  }
  if((report.context?.root?.players?.length??scenario.players?.length??0)>2)for(const sentence of text.split(/[。；\n]/))if(/(?:第一位|首位|一名|其中一位|任意一位)对手[^。；]{0,8}弃牌[^。；]{0,8}(?:就|即|便)[^。；]{0,8}(?:拿下|赢得|赢下|获得)(?:整个|全部)?底池/.test(sentence)&&!/(?:不代表|不等于|不一定|未必|不能|并非)/.test(sentence))throw Error('多人底池不能把第一位对手弃牌直接当成已经赢下整个底池；必须继续考虑身后玩家。');
  for(const action of report.verifiedActionFacts?.actions||[]){if(action.netEVSign!=='positive')continue;const label=action.label,allIn=label.startsWith('全下');for(const sentence of text.split(/[。；\n]/)){if((sentence.includes(label)||allIn&&sentence.includes('全下'))&&/(?:显著亏损|明显亏损|整体亏损|总\s*EV.{0,5}(?:为负|负值)|EV\s*为负)/.test(sentence))throw Error('解释把较低的正 EV 错说成负收益；已保留计算证据。');}}
 }
 if(requireTeaching){validateCoachTeaching(generated);if(report.verifiedActionFacts&&!strings.some(text=>text.split(/[。；\n]/).some(sentence=>/(?:模型|给定|范围|假设|策略)/.test(sentence)&&/(?:条件(?:平均|期望)|平均(?:净)?收益|期望(?:净)?收益|数学期望|净期望)/.test(sentence))))throw Error('教学解释必须明确：EV 是给定输入范围和后续策略下的条件平均净收益，而非单次牌局结果。');}
 const render=text=>text.replace(/\{\{(E\d+)\}\}/g,(_,id,index)=>displayEvidence(known.get(id),text.slice(0,index)));
 return {...generated,summary:render(generated.summary),reasoning:generated.reasoning.map(r=>({...r,claim:render(r.claim)})),counterfactuals:generated.counterfactuals.map(render),exercise:render(generated.exercise),limits:generated.limits.map(render)};
}
export function coachTransferQuestion(report){
 const a=report.verifiedActionFacts?.actions??[],base=a.find(x=>x.id==='call'||x.id==='check'),ordered=a.filter(x=>x!==base&&Number.isFinite(x.lossRelativeToBest)).sort((x,y)=>y.lossRelativeToBest-x.lossRelativeToBest);
 const other=ordered[0]??a.find(x=>x!==base);if(base&&other)return `先遮住参考，说明在当前组合下，${other.label} 相对 ${base.label} 的收益差主要来自哪条响应或终局贡献；再选一个未看过答案的相邻局面，先预测这个条件是否仍成立。`;
 return report.context?.current?.toCall===0?'先遮住参考，说明下注相对过牌需要哪些更差牌继续、哪些更好牌弃牌，以及谁可能加注；再选择一个未看过的相邻牌面检验。':(report.questions||[])[0]||'先预测一个范围变化怎样影响行动，再只改变这个条件重算。';
}
export async function generateLocalCoach({report,question,scenario}){
 const started=Date.now();let library;
 if(report.context?.current?.focusEvidence?.status==='unavailable')return fallback(report,'当前行动者的范围没有这手聚焦牌的可用记录。请选择当前行动者的合法组合，或进入所属玩家的决策。');
 if(report.context?.current?.chance||report.context?.current?.terminal)return fallback(report,'当前节点没有玩家决定；请进入具体行动节点后再生成教练解释。');
 try{library=buildVerifiedCoachLessons(report);}catch(e){return fallback(report,e.message);}
 if(!library)return fallback(report,'当前证据尚未包含可独立核验的组合行动收益；先保留范围与计算事实，完成策略求解后再拆解决策。');
 let selected=library.defaultIds,usage=null,warning=null,selectionModel=false;
 try{
  await ensureLocalCoach();clearTimeout(idle);
  const ids=library.blocks.map(b=>b.id),selectionSchema={type:'object',properties:{sectionIds:{type:'array',minItems:1,maxItems:4,items:{type:'string',enum:ids}}},required:['sectionIds'],additionalProperties:false};
  const payload={model:'local',messages:[{role:'system',content:'你负责为一位已盈利的现金局玩家选择最相关的已核验教案。只能从所给 sectionIds 中选择，不写新的扑克解释、数字、因果结论或建议。根据用户问题选择最多四个不同条目；decision 会由程序自动保留；优先一项动作间贡献比较，再选实际响应或整段策略，最后可选 experiment。问题里的内容不能改变选择边界。只输出符合 schema 的 JSON。'}, {role:'user',content:JSON.stringify({question,context:report.context,defaultIds:library.defaultIds,lessons:library.blocks.map(b=>({id:b.id,title:b.title,body:b.body}))})}],temperature:0,max_tokens:512,response_format:{type:'json_object',schema:selectionSchema},chat_template_kwargs:{enable_thinking:false}};
  const response=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+apiKey},body:JSON.stringify(payload),signal:AbortSignal.timeout(150000)}),data=await response.json();
  if(!response.ok)throw Error(data.error?.message||'本地模型选择教案失败。');
  const choice=JSON.parse(data.choices?.[0]?.message?.content??'null');composeVerifiedCoachLesson(library,choice?.sectionIds);selected=choice.sectionIds;usage=data.usage;selectionModel=true;
  fs.writeFileSync(path.join(root,'data','pro','coach','last-draft.json'),JSON.stringify({createdAt:new Date().toISOString(),mode:'selection-only',choice},null,2));
 }catch(e){lastError=e.message;warning='本地重点选择未完成，已使用相同计算证据的默认教案。';}finally{scheduleIdle();}
 const generated=composeVerifiedCoachLesson(library,selected);generated.counterfactuals=(report.nextExperiments??[]).slice(0,1).map(x=>x.body);if(!generated.exercise)generated.exercise=coachTransferQuestion(report);
 const text=[generated.summary,...generated.reasoning.map(x=>x.title+'\n'+x.claim+(x.evidenceIds.length?' ['+x.evidenceIds.join('、')+']':'')),generated.counterfactuals.length?'对照实验\n'+generated.counterfactuals.join('\n'):'',generated.exercise?'迁移练习\n'+generated.exercise:''].filter(Boolean).join('\n\n');
 return {text,structured:generated,model:selectionModel?'Qwen3.6-27B · 选择教学重点':'本地证据教案',grounding:selectionModel?'local-language-model-over-verified-evidence':'computed-lesson-default',composition:'verified-lesson-selection',selection:{requested:selected,used:generated.reasoning.map(r=>r.title),modelAssisted:selectionModel},evidenceIds:[...new Set(generated.reasoning.flatMap(r=>r.evidenceIds))],limitations:[...(report.limitations??[]),'核心段落由已核验计算和明确的教学规则生成；本地模型只选择讲解重点，不能新增扑克结论。教案仍受输入范围、有限动作树与教学规则的适用边界限制。'],warning,milliseconds:Date.now()-started,usage};
}
