import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {normalizeScenario} from './scenario.mjs';
import {range,cards,cardText,rankHand} from './poker.mjs';
import {assertSolutionScenario} from './solution-identity.mjs';
import {fixedCappedRake} from './river-rake.mjs';
import {gradeRangeConstruction} from './strategy-construction.mjs';
import {publicPlaySession,summarizePlaySession} from './play-session.mjs';
import {createStudyProject,applyStudyProjectEvent} from './learning-plan.mjs';
import {getLesson} from './curriculum.mjs';
import {buildRangeDebrief} from './range-debrief.mjs';
import {assertInputProvenance,inputHandSourceId,inputRecordingSourceId} from './input-provenance.mjs';
import {restoreLiveRecording} from './live-recording-record.mjs';
import {restoreEquityExploration,restoreBoardContrast} from './research-backup.mjs';
const idOK=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
const folders=['cases','training','study-cards','study-attempts','jobs','experiments','hands','imports','ranges','play-sessions','range-attempts','range-evaluations','study-projects','live-recordings','equity-explorations','board-contrasts'];
const read=(file,fallback=null)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fallback;}};
const atomic=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(value));fs.renameSync(temp,file);};
export function exportUserData(root,{includeResults=false}={}){
 const base=path.join(root,'data','pro'),records={};
 for(const folder of folders){const dir=path.join(base,folder);records[folder]=fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>/^[a-f0-9-]{36}\.json$/.test(f)).map(f=>read(path.join(dir,f))).filter(Boolean):[];}
 const jobIDs=new Set(records.jobs.map(j=>j.id));
 for(const c of [...records.cases,...records['study-cards'],...records['play-sessions'],...records['range-attempts'],...records['range-evaluations']]){const id=c.jobId??c.source?.jobId;if(idOK(id))jobIDs.add(id);}
 const results={};if(includeResults)for(const id of jobIDs){const r=read(path.join(base,'jobs',id,'result.json'));if(r)results[id]=r;}
 return {app:'PokerLab',schemaVersion:2,exportedAt:new Date().toISOString(),records,results,includesResults:includeResults};
}

const finite=Number.isFinite,hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex'),hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const hashMemo=new WeakMap(),policyHash=r=>{if(!hashMemo.has(r))hashMemo.set(r,hash(r));return hashMemo.get(r);};
const time=x=>typeof x==='string'&&finite(Date.parse(x));
const near=(a,b)=>finite(a)&&finite(b)&&Math.abs(a-b)<=1e-8*Math.max(1,Math.abs(a),Math.abs(b));
function equivalent(actual,expected,label){
 if((label.endsWith('.board')||label==='决策公共牌')&&typeof actual==='string'&&typeof expected==='string'){if(cards(actual).join(',')!==cards(expected).join(','))throw Error(`${label} 与原始参考公共牌不一致。`);return;}
 if(typeof expected==='number'){if(!near(actual,expected))throw Error(`${label} 与原始参考重算不一致。`);return;}
 if(expected===null||typeof expected!=='object'){if(actual!==expected)throw Error(`${label} 与原始参考不一致。`);return;}
 if(!actual||typeof actual!=='object'||Array.isArray(actual)!==Array.isArray(expected))throw Error(`${label} 格式无效。`);
 if(Array.isArray(expected)){if(actual.length!==expected.length)throw Error(`${label} 数量不一致。`);expected.forEach((x,i)=>equivalent(actual[i],x,`${label}[${i}]`));return;}
 for(const [key,value] of Object.entries(expected))if(value!==undefined)equivalent(actual[key],value,label+'.'+key);
}
function clearProcessIDs(record){
 if(!record||typeof record!=='object')return;
 for(const key of Object.keys(record)){if(/^(processIds?|exitedProcessIds?|pids?|workerPids?|nativePids?)$/i.test(key))delete record[key];else if(record[key]&&typeof record[key]==='object')clearProcessIDs(record[key]);}
}
const activeStatus=status=>['running','queued','preparing','cancelling','cleanup-required'].includes(status);
// A saved witness is derived prose plus a policy-value decomposition, not an
// independently authenticated artifact. Do not trust any imported numbers or
// verification flags, even when the source tree is present.
function invalidateResponseWitness(record){
 if(!record||typeof record!=='object')return;
 for(const key of Object.keys(record))if(key==='responseWitness')record[key]={status:'unavailable',reason:'备份恢复没有重新运行具体反制策略及收益贡献核验；请重新发起独立评估。',restored:true,requiresIndependentEvaluation:true};else if(record[key]&&typeof record[key]==='object')invalidateResponseWitness(record[key]);
}
function restoreInputSource(entry,lookup,context=entry.inputContext??entry.scenario?.inputContext){
 try{
  const id=inputHandSourceId(context),recordingId=inputRecordingSourceId(context),assessment=assertInputProvenance(entry.scenario,context,{hand:id?lookup('hands',id):null,recording:recordingId?lookup('live-recordings',recordingId):null});
  entry.inputContext=assessment.inputContext;const {inputContext,...provenance}=assessment;entry.inputProvenance={...provenance,restored:true};
 }catch(error){
  // Historical models and drafts remain reviewable. An unresolved import must
  // pass the normal live gate before it can be computed as a real-hand study.
  entry.inputContext=structuredClone(context??null);if(entry.inputContext&&typeof entry.inputContext==='object'){delete entry.inputContext.checked;delete entry.inputContext.verified;}
  entry.inputProvenance={kind:'unverified-legacy',sourceVerified:false,restored:true,error:error.message,code:error.code??'source-recheck-failed',assumptions:['保留历史参数模型；恢复时未能核对原文与当前局面，不代表已还原真实牌局。']};
 }
}
function recordBase(entry,kind){if(entry.kind!==kind||!time(entry.createdAt))throw Error(`${kind} 记录类型或创建时间无效。`);}
function pathNode(result,route){
 if(!Array.isArray(route)||route.length>200||route.some(x=>typeof x!=='string'||x.length>256))throw Error('备份中的行动路径无效。');
 const nodes=new Map(result.nodes.map(n=>[n.id,n]));let node=nodes.get('n0');const steps=[];
 for(const id of route){const action=node?.actions?.find(a=>a.id===id),child=nodes.get(action?.childId);if(!action||!child)throw Error('备份中的路径不属于原始策略树。');steps.push({node,action});node=child;}
 if(!node)throw Error('备份策略树缺少起点。');return {node,steps};
}
function qualityFrom(result){const residual=result.diagnostics?.optimizationResidualPctPot??result.diagnostics?.nashConvPctPot??null,target=result.input?.accuracy??null,targetReached=finite(residual)&&finite(target)?residual<=target:null;return {mode:'exact',residual,target,targetReached,provisional:targetReached!==true,countsTowardMastery:false};}
function gradeArithmetic(grade){
 if(grade?.kind!=='range-construction-grade'||grade.schemaVersion!==1||!hex(grade.sourceFingerprint)||!Array.isArray(grade.combos)||!grade.combos.length||!Array.isArray(grade.actions)||!grade.actions.length)throw Error('范围评分缺少完整的组合依据。');
 const ids=grade.actions.map(a=>a.id);if(new Set(ids).size!==ids.length)throw Error('范围评分动作重复。');
 let mass=0,rangeEV=0,referenceEV=0,bestEV=0,regret=0,rootChange=0;const combos=new Set();
 for(const row of grade.combos){
  const combo=cards(row.combo,[2]).sort((a,b)=>a-b).join(',');if(combos.has(combo))throw Error('范围评分组合重复。');combos.add(combo);
  for(const key of ['userProbabilities','referenceProbabilities']){const p=row[key];if(!p||ids.some(id=>!finite(p[id])||p[id]<0||p[id]>1)||Object.keys(p).some(id=>!ids.includes(id))||!near(ids.reduce((s,id)=>s+p[id],0),1))throw Error('范围评分概率无效。');}
  if(!finite(row.posteriorWeight)||row.posteriorWeight<0||!finite(row.reach)||row.reach<0)throw Error('范围评分权重无效。');
  if(!row.scoreable){if(row.posteriorWeight!==0)throw Error('未评分组合含非零权重。');continue;}
  if(!row.actionEV||ids.some(id=>!finite(row.actionEV[id])))throw Error('范围评分缺少行动收益。');
  const u=ids.reduce((s,id)=>s+row.userProbabilities[id]*row.actionEV[id],0),r=ids.reduce((s,id)=>s+row.referenceProbabilities[id]*row.actionEV[id],0),b=row.locked?r:Math.max(...ids.map(id=>row.actionEV[id])),loss=Math.max(0,b-u);
  for(const [key,value] of Object.entries({userEV:u,referenceEV:r,localBestEV:b,regretBB:loss,weightedRegretBB:row.posteriorWeight*loss,referenceDifferenceBB:u-r}))if(!near(row[key],value))throw Error('范围组合收益与策略概率不一致。');
  mass+=row.posteriorWeight;rangeEV+=row.posteriorWeight*u;referenceEV+=row.posteriorWeight*r;bestEV+=row.posteriorWeight*b;regret+=row.posteriorWeight*loss;rootChange+=row.reach*(u-r);
 }
 if(!near(mass,1))throw Error('范围后验权重未归一。');
 equivalent(grade.metrics,{rangeEV,referenceEV,localBestEV:bestEV,localRegretBB:regret,referenceDifferenceBB:rangeEV-referenceEV,rootEVChangeBB:rootChange},'范围聚合收益');
}
function gradeAgainst(grade,expected){for(const key of ['schemaVersion','kind','sourceFingerprint','source','nodeContext','weighting','coverage','metrics','combos','actions','quality'])equivalent(grade[key],expected[key],'范围评分.'+key);}
function validateRange(entry,resolve){
 recordBase(entry,'range-attempt');if(!idOK(entry.jobId)||!hex(entry.sourceFingerprint)||!entry.submission||!finite(entry.confidence)||entry.confidence<0||entry.confidence>100)throw Error('范围作答记录不完整。');
 if(entry.reportedExposure!=null&&!['unseen','seen','unknown'].includes(entry.reportedExposure))throw Error('范围练习的答案暴露记录无效。');
 gradeArithmetic(entry.grade);if(entry.sourceFingerprint!==entry.grade.sourceFingerprint||entry.submission.sourceFingerprint!==entry.sourceFingerprint||entry.submission.nodeId!==entry.nodeId||entry.grade.source?.nodeId!==entry.nodeId||entry.grade.weighting!==entry.weighting||entry.submission.weighting!==entry.weighting)throw Error('范围作答与题目指纹或节点不一致。');
 equivalent(entry.quality,entry.grade.quality,'范围作答质量');
 const {job,result}=resolve(entry.jobId);if(!job)throw Error('范围作答缺少源求解记录。');
 if(result){const reached=pathNode(result,entry.nodePath??[]).node;if(reached.id!==entry.nodeId)throw Error('范围作答路径与节点不一致。');const expected=gradeRangeConstruction(job.scenario,result,entry.submission);gradeAgainst(entry.grade,expected);entry.grade.coaching=buildRangeDebrief(entry.grade,{jobId:entry.jobId,nodePath:entry.nodePath??[]});entry.referenceAvailable=true;entry.integrity={referenceVerified:true,method:'recomputed-against-saved-policy',nativeRerun:false};}
 else{delete entry.grade.coaching;entry.referenceAvailable=false;entry.integrity={referenceVerified:false,reason:'source-result-missing',note:'保留原始作答与历史反馈；缺少源树，尚不能重新核验评分，不作为确定的技能证据。'};}
 return entry;
}
function validateOutcome(entry,node,result){
 const o=entry.outcome,board=cards(o?.board??''),known=cards(node.board||entry.scenario.board),N=entry.scenario.players.length,alive=entry.scenario.players.map((_,i)=>i).filter(i=>!node.folded[i]);
 if(!o||!alive.length||alive.length>1&&board.length!==5||board.slice(0,known.length).join(',')!==known.join(',')||new Set([...board,...entry.privateHands.flat()]).size!==board.length+2*N)throw Error('模拟终局公共牌或参赛资格无效。');
 const fixedRake=fixedCappedRake(entry.scenario,entry.scenario.pot).fixedRake,contributions=node.contributions,payout=Array(N).fill(0),refunds=Array(N).fill(0),pots=[],ranks=alive.length>1?entry.privateHands.map(h=>rankHand([...board,...h])):null;
 const award=(amount,eligible,label)=>{if(amount<=1e-10)return;if(!eligible.length)throw Error('模拟终局边池无人有资格领取。');const best=alive.length>1?Math.max(...eligible.map(i=>ranks[i])):null,winners=alive.length>1?eligible.filter(i=>ranks[i]===best):eligible;for(const i of winners)payout[i]+=amount/winners.length;pots.push({label,amount,eligible,winners});};
 award(entry.scenario.pot-fixedRake,alive,'街起点共同底池');let previous=0;
 for(const cap of [...new Set(contributions.filter(x=>x>0))].sort((a,b)=>a-b)){const contributors=contributions.map((x,i)=>x>=cap-1e-8?i:-1).filter(i=>i>=0),amount=(cap-previous)*contributors.length;previous=cap;if(contributors.length===1){refunds[contributors[0]]+=amount;payout[contributors[0]]+=amount;}else award(amount,contributors.filter(i=>!node.folded[i]),pots.length?'后续投入形成的底池':'底池');}
 const net=payout.map((v,i)=>v-(contributions[i]-entry.startContributions[i]));equivalent(o,{kind:'simulated-terminal',showdown:alive.length>1,heroNet:net[entry.source.heroSeat],payout,net,uncalledRefunds:refunds,pots,fixedRake,players:entry.scenario.players.map((p,i)=>({seat:i,name:p.name,position:p.position,folded:node.folded[i],cards:i===entry.source.heroSeat||alive.length>1&&!node.folded[i]?entry.privateHands[i].map(cardText).join(''):null,net:net[i]}))},'模拟终局结算');
}
function validatePlay(entry,resolve){
 recordBase(entry,'play-session');if(entry.schemaVersion!==1||!['playing','complete','abandoned','interrupted'].includes(entry.status)||!time(entry.updatedAt)||!idOK(entry.source?.jobId)||!hex(entry.sourceFingerprint)||!Array.isArray(entry.decisions))throw Error('连续练习记录不完整。');
 if(entry.completedAt!=null&&(!time(entry.completedAt)||Date.parse(entry.completedAt)<Date.parse(entry.createdAt)||Date.parse(entry.completedAt)>Date.parse(entry.updatedAt)))throw Error('连续练习完成时间与记录时间不一致。');
 const {job,result}=resolve(entry.source.jobId);if(!job)throw Error('连续练习缺少源求解记录。');entry.scenario=normalizeScenario(entry.scenario);
 if(!result){entry.previousStatus=entry.previousStatus??entry.status;entry.status='interrupted';entry.interruptedDecision=entry.interruptedDecision??entry.decision;entry.decision=null;entry.referenceAvailable=false;entry.recoverable=false;entry.interruptionReason='备份没有包含完整原始策略树；原始牌局与决策仍保留，但不能接续练习或重新核验评分。';entry.integrity={referenceVerified:false,reason:'source-result-missing'};return entry;}
 assertSolutionScenario(entry.scenario,result);if(entry.sourceFingerprint!==policyHash(result))throw Error('连续练习引用的策略指纹与保留的源树不一致。');
 const N=entry.scenario.players.length,hero=entry.source.heroSeat;if(!Number.isInteger(hero)||hero<0||hero>=N||!Array.isArray(entry.privateHands)||entry.privateHands.length!==N)throw Error('连续练习位置或私牌无效。');
 const known=cards(entry.scenario.board),seen=new Set(known),canon=hand=>hand.slice().sort((a,b)=>a-b).join(',');
 entry.privateHands.forEach((hand,p)=>{if(!Array.isArray(hand)||hand.length!==2||hand.some(c=>!Number.isInteger(c)||c<0||c>51||seen.has(c))||hand[0]===hand[1])throw Error('连续练习私牌冲突。');hand.forEach(c=>seen.add(c));if(!range(entry.scenario.players[p].range,known).live.some(c=>canon(c.cards)===canon(hand)))throw Error('连续练习私牌不属于原始范围。');});
 const current=pathNode(result,entry.path),origin=pathNode(result,entry.source.startingPath??[]);if(current.node.id!==entry.currentNodeId||JSON.stringify(entry.path.slice(0,(entry.source.startingPath??[]).length))!==JSON.stringify(entry.source.startingPath??[]))throw Error('连续练习起点或当前路径不一致。');
 if(entry.source.startingNodeId!=null&&entry.source.startingNodeId!==origin.node.id)throw Error('连续练习起点节点与路径不一致。');if(entry.source.reportedExposure!=null&&!['unseen','seen','unknown'].includes(entry.source.reportedExposure))throw Error('连续练习起点答案暴露记录无效。');
 equivalent(entry.startContributions,origin.node.contributions,'练习起点投入');equivalent(entry.source.quality,qualityFrom(result),'连续练习质量');
 if(!Array.isArray(entry.history)||entry.history.length!==current.steps.length)throw Error('连续练习行动账本不完整。');
 for(let i=0;i<current.steps.length;i++){const {node,action}=current.steps[i],h=entry.history[i],deal=node.chance===true||node.actor===-2;equivalent(h,{actionId:action.id,path:entry.path.slice(0,i),actorSeat:deal?null:node.actor,type:deal?'deal':action.type,label:action.label||action.id,amount:action.amount??0,to:action.to??0,board:node.board||entry.scenario.board},'练习行动账本');if(deal&&entry.privateHands.flat().includes(action.card))throw Error('连续练习公共牌与私牌冲突。');}
 const rowAt=node=>{const row=node.combos?.find(c=>canon(cards(c.combo,[2]))===canon(entry.privateHands[node.actor]));if(!row||!Array.isArray(row.probabilities)||row.probabilities.length!==node.actions.length||row.probabilities.some(p=>!finite(p)||p<0||p>1)||!near(row.probabilities.reduce((a,b)=>a+b,0),1))throw Error('连续练习行动者的参考概率无效。');return row;};
 const lockedAt=(node,row)=>row.locked===true||(result.input?.locks??[]).some(l=>(l.nodeId===node.id||l.node===Number(node.id.slice(1)))&&(l.combo==null||l.combo===-1||typeof l.combo==='string'&&canon(cards(l.combo,[2]))===canon(entry.privateHands[node.actor])));
 const warningRows=[],referenceAt=new Map(),expectedDecisions=new Set();
 const warn=(node,depth,reason)=>{if(!warningRows.some(w=>w.nodeId===node.id&&w.reason===reason))warningRows.push({nodeId:node.id,path:entry.path.slice(0,depth),board:node.board??entry.scenario.board,actorSeat:node.actor,reason});};
 for(let i=0;i<current.steps.length;i++){
  const {node,action}=current.steps[i];if(node.actor<0||node.chance)continue;const row=rowAt(node),p=row.probabilities[node.actions.findIndex(a=>a.id===action.id)];
  if(i<origin.steps.length){if(!(p>0))throw Error('练习起点的实际私牌不可能经过已记录的原始路径。');continue;}
  if(node.actor===hero&&!lockedAt(node,row)){
   const child=current.steps[i+1]?.node??current.node,entersZeroFrequencyContinuation=p===0&&!child.terminal&&child.actor!==-1;
   expectedDecisions.add(i);referenceAt.set(i,{offReference:warningRows.length>0||row.reach===0,selectedReferenceProbability:p,nextContinuationWarning:entersZeroFrequencyContinuation?{reason:'hero-selected-zero-reference-action',childNodeId:child.id}:null});
   if(entersZeroFrequencyContinuation)warn(node,i,'hero-selected-zero-reference-action');
  }
  else{if(!(finite(row.counterfactualReach)&&row.counterfactualReach>0)){if(!warningRows.length)throw Error('正到达自动策略缺少反事实到达，源结果不一致。');warn(node,i,'zero-or-missing-opponent-counterfactual-reach');}if(!(p>0))throw Error('自动行动选择了参考概率为零的动作，连续练习记录不一致。');}
 }
 if(entry.referenceWarnings!==undefined||warningRows.length)equivalent(entry.referenceWarnings,warningRows,'连续练习零到达警告');
 const decisionIds=new Set(),decisionDepths=new Set();let previousIndex=-1;
 for(const d of entry.decisions){
  if(d.reportedExposure!=null&&!['unseen','seen','unknown'].includes(d.reportedExposure))throw Error('连续练习的答案暴露记录无效。');
  if(!idOK(d.id)||decisionIds.has(d.id)||!time(d.answeredAt??d.createdAt)||Date.parse(d.answeredAt??d.createdAt)<Date.parse(entry.createdAt)||Date.parse(d.answeredAt??d.createdAt)>Date.parse(entry.updatedAt)||!finite(d.confidence)||d.confidence<0||d.confidence>100)throw Error('连续练习作答身份、时间或信心无效。');decisionIds.add(d.id);
  const {node}=pathNode(result,d.path),depth=d.path.length;if(depth<=previousIndex||depth<entry.source.startingPath.length||JSON.stringify(entry.path.slice(0,depth))!==JSON.stringify(d.path)||entry.path[depth]!==d.actionId||node.id!==d.nodeId||node.actor!==hero||canon(cards(d.heroCombo,[2]))!==canon(entry.privateHands[hero]))throw Error('连续练习作答与真实行动路径不一致。');previousIndex=depth;decisionDepths.add(depth);
  if(d.reportedExposure!==undefined)equivalent(d.reportedExposure,node.id===(entry.source.startingNodeId??origin.node.id)?entry.source.reportedExposure??'unknown':'unknown','逐决策答案暴露记录');
  const row=rowAt(node),index=node.actions.findIndex(a=>a.id===d.actionId),ev=row?.actionEV,scored=Array.isArray(ev)&&ev.length===node.actions.length&&ev.every(finite)&&finite(row.counterfactualReach)&&row.counterfactualReach>0,reference=referenceAt.get(depth);if(!reference)throw Error('被约束的自动动作不能伪造为自由决策。');
  equivalent(d.board,node.board||entry.scenario.board,'决策公共牌');
  if(scored){const best=Math.max(...ev);equivalent(d.feedback,{loss:Math.max(0,best-ev[index]),selectedEV:ev[index],bestEV:best,acceptedActions:node.actions.filter((a,i)=>best-ev[i]<=.02).map(a=>a.id),evTolerance:.02,referenceKind:reference.offReference?'off-reference-fixed-continuation':'fixed-reference-continuation',quality:{...qualityFrom(result),...(reference.offReference?{provisional:true}:{})},actions:node.actions.map((a,i)=>({id:a.id,label:a.label,ev:ev[i],frequency:row.probabilities[i]}))},'连续练习反馈');}
  else equivalent(d.feedback,{loss:null,referenceKind:'unavailable',quality:{...qualityFrom(result),provisional:true}},'无条件 EV 的决策反馈');
  if(d.feedback.selectedReferenceProbability!==undefined||entry.source.startingNodeId!==undefined)equivalent(d.feedback.selectedReferenceProbability,reference.selectedReferenceProbability,'所选动作的参考概率');
  if(reference.nextContinuationWarning)equivalent(d.feedback.nextContinuationWarning,reference.nextContinuationWarning,'下一步零频路径警告');
  else if(d.feedback.nextContinuationWarning!==undefined)throw Error('此动作不进入零频后续，下一步警告与真实路径不一致。');
 }
 if(expectedDecisions.size!==decisionDepths.size||[...expectedDecisions].some(i=>!decisionDepths.has(i)))throw Error('连续练习决策记录与自由选择次数不一致，不能遗漏作答后恢复成绩。');
 if(entry.completedAt&&entry.decisions.some(d=>Date.parse(d.answeredAt??d.createdAt)>Date.parse(entry.completedAt)))throw Error('连续练习完成时间不能早于真实作答。');
 // Public rendering independently checks the session version, model and full
 // future tree. It never exposes this private view through the backup API.
 if(entry.status!=='interrupted')publicPlaySession(entry,result);
 if(entry.status==='playing'&&(!entry.decision||entry.decision.nodeId!==entry.currentNodeId||current.node.actor!==hero||current.node.terminal||JSON.stringify(entry.decision.path)!==JSON.stringify(entry.path)))throw Error('连续练习待答节点无效。');
 if(entry.status==='playing'&&entry.decision.reportedExposure!==undefined)equivalent(entry.decision.reportedExposure,current.node.id===(entry.source.startingNodeId??origin.node.id)?entry.source.reportedExposure??'unknown':'unknown','当前待答节点的答案暴露记录');
 if(entry.status==='complete'&&!current.node.terminal)throw Error('连续练习尚未到达终局，不能称为完成。');
 if(entry.status==='complete')validateOutcome(entry,current.node,result);
 entry.summary=summarizePlaySession(entry);entry.referenceAvailable=true;entry.integrity={referenceVerified:true,method:'recomputed-decisions-against-saved-policy',nativeRerun:false};return entry;
}
function validateEvaluation(entry,lookup,resolve){
 recordBase(entry,'range-evaluation');if(!idOK(entry.attemptId)||!idOK(entry.jobId)||!['running','queued','preparing','cancelling','cleanup-required','complete','failed','cancelled','interrupted'].includes(entry.status))throw Error('范围独立评估记录无效。');
 const attempt=lookup('range-attempts',entry.attemptId);if(!attempt||attempt.jobId!==entry.jobId)throw Error('范围独立评估缺少对应原始作答。');
 if(activeStatus(entry.status)){entry.status='interrupted';entry.error='独立评估从未完全停止的备份恢复，进程身份已清除；请重新发起评估。';}
 if(entry.status==='complete'){
  const result=entry.result;if(!result)throw Error('已完成的范围评估缺少结果。');gradeArithmetic(result);gradeAgainst(result,attempt.grade);const independent=result.independentEvaluation;
  if(!independent||!['complete','unavailable'].includes(independent.status))throw Error('范围评估缺少独立核验状态。');
  if(independent.status==='complete'){
   const {job, result:policy}=resolve(entry.jobId),N=job.scenario.players.length,actor=result.nodeContext.actorSeat,before=independent.baseline,after=independent.submitted;
   for(const summary of [before,after]){
    if(!summary||['profileEV','bestResponseEV','gain'].some(k=>!Array.isArray(summary[k])||summary[k].length!==N||summary[k].some(x=>!finite(x)))||summary.bestResponseIgnoresLocks!==true)throw Error('独立评估缺少逐玩家最佳响应证据。');
    for(let p=0;p<N;p++)if(summary.gain[p]<-1e-8||!near(summary.gain[p],summary.bestResponseEV[p]-summary.profileEV[p]))throw Error('独立评估的偏离收益不一致。');
    if(!near(summary.nashConv,summary.gain.reduce((a,b)=>a+b,0))||!near(summary.nashConvPctPot,summary.nashConv/job.scenario.pot*100))throw Error('独立评估残差不一致。');
   }
   equivalent(independent.fixedOpponent,{baselineUserEV:before.profileEV[actor],submittedUserEV:after.profileEV[actor],changeBB:after.profileEV[actor]-before.profileEV[actor],expectedChangeFromLocalBB:attempt.grade.metrics.rootEVChangeBB,consistencyDifferenceBB:Math.abs(after.profileEV[actor]-before.profileEV[actor]-attempt.grade.metrics.rootEVChangeBB)},'独立评估固定策略收益');
   if(N===2){const opponent=1-actor,sum=job.scenario.pot-fixedCappedRake(job.scenario,job.scenario.pot).fixedRake,base=sum-before.bestResponseEV[opponent],submitted=sum-after.bestResponseEV[opponent];equivalent(independent.responseExposure,{kind:'heads-up-security',opponent,baselineSecurityEV:base,submittedSecurityEV:submitted,securityEVChangeBB:submitted-base,baselineAdaptationCostBB:Math.max(0,before.profileEV[actor]-base),adaptationCostBB:Math.max(0,after.profileEV[actor]-submitted)},'双人反调整指标');}
   else equivalent(independent.responseExposure,{kind:'multiplayer-unilateral-gains',players:job.scenario.players.map((p,i)=>({player:i,playerId:p.id,name:p.name,baselineGainBB:before.gain[i],submittedGainBB:after.gain[i],gainChangeBB:after.gain[i]-before.gain[i]})),userLossBB:null,coalitionModel:false},'多人单方偏离指标');
  }
 }
 clearProcessIDs(entry);entry.referenceAvailable=!!resolve(entry.jobId).result;if(entry.result){delete entry.result.coaching;if(entry.referenceAvailable)entry.result.coaching=buildRangeDebrief(entry.result,{jobId:entry.jobId,nodePath:attempt.nodePath??[]});}entry.integrity={referenceVerified:attempt.integrity?.referenceVerified===true,independentRecomputed:false,method:'saved-reference-and-arithmetic-validation',note:'恢复时核对来源与数值恒等式，没有重新运行完整最佳响应；历史独立评估与本次重新评估应区分。'};return entry;
}
const SOURCE_FOLDERS={'hand':'hands','case':'cases','job':'jobs','study-card':'study-cards','course-attempt':'training','study-attempt':'study-attempts','range-attempt':'range-attempts','play-session':'play-sessions','experiment':'experiments'};
function validateProject(entry,lookup){
 if(entry.version!==1||!Array.isArray(entry.events)||!time(entry.createdAt)||!time(entry.updatedAt)||!hex(entry.sourceFingerprint)||hash(entry.source)!==entry.sourceFingerprint||!['active','closed'].includes(entry.status))throw Error('研究任务身份或事件列表无效。');
 const resolve=source=>{
  if(source?.kind==='manual')return {record:true};if(source?.kind==='lesson'){getLesson(source.id);return {record:true};}
  if(source?.kind==='play-decision'){const session=lookup('play-sessions',source.sessionId),record=session?.decisions?.find(d=>d.id===source.id);return {record,createdAt:record?.answeredAt??record?.createdAt,session,timeResolution:'attempt'};}
  const folder=SOURCE_FOLDERS[source?.kind],record=folder&&lookup(folder,source.id);
  return {record,createdAt:source?.kind==='play-session'?record?.completedAt??record?.updatedAt:record?.answeredAt??record?.createdAt,timeResolution:source?.kind==='play-session'?'session':'attempt'};
 };
 const missing=[],checkSource=source=>{
  const resolved=resolve(source),record=resolved.record,parent=resolved.session;
  const reason=!record?'source-record-missing':record.integrity?.referenceVerified===false||record.referenceAvailable===false||record.status==='interrupted'||parent?.integrity?.referenceVerified===false||parent?.referenceAvailable===false||parent?.status==='interrupted'?'source-reference-unverified':null;
  if(reason&&!missing.some(s=>s.kind===source?.kind&&s.id===source?.id&&s.sessionId===source?.sessionId))missing.push({kind:source?.kind,id:source?.id??null,...(source?.sessionId?{sessionId:source.sessionId}:{}),reason});
  if(record&&source?.jobId){const actual=source.kind==='job'?record.id:record.jobId??record.sourceJobId??record.source?.jobId??parent?.source?.jobId;if(actual&&actual!==source.jobId)throw Error('研究来源与原始求解身份不一致。');}
  return {...resolved,referenceVerified:!reason,verificationReason:reason};
 };
 checkSource(entry.source);let rebuilt=createStudyProject({question:entry.question,title:entry.title,source:entry.source,assumptions:entry.assumptions},{id:entry.id,now:Date.parse(entry.createdAt)});
 for(const e of entry.events){if(!idOK(e.id)||!time(e.createdAt)||Date.parse(e.createdAt)>Date.parse(entry.updatedAt))throw Error('研究事件编号或时间无效。');let resolvedRetest;
  let sourceCheck;
  if(e.source){sourceCheck=checkSource(e.source);if(e.kind==='retest'&&sourceCheck.record){if(sourceCheck.record.status==='playing'||sourceCheck.session?.status==='playing')throw Error('进行中的牌局不能恢复成课后复测。');if(sourceCheck.referenceVerified){if(!time(sourceCheck.createdAt))throw Error('复测原始记录没有可核验时间。');resolvedRetest={sourceKind:e.source.kind,sourceId:e.source.id,sessionId:e.source.sessionId,createdAt:sourceCheck.createdAt,timeResolution:sourceCheck.timeResolution};}}}
  rebuilt=applyStudyProjectEvent(rebuilt,e,{eventId:e.id,now:Date.parse(e.createdAt),resolvedRetest});
  if(sourceCheck&&!sourceCheck.referenceVerified){const row=rebuilt.events.at(-1);row.restoration={referenceVerified:false,reason:sourceCheck.verificationReason};if(e.kind==='retest'&&time(e.attemptedAt))row.historicalAttemptedAt=e.attemptedAt;}
 }
 if(rebuilt.status!==entry.status)throw Error('研究关闭状态与事件账本不一致。');
 rebuilt.updatedAt=entry.updatedAt;rebuilt.integrity={referenceVerified:missing.length===0,unresolvedSources:missing,method:'replayed-events-and-actual-retest-timestamps'};return rebuilt;
}
export function createLocalBackup(root,{automatic=false}={}){
 const dir=path.join(root,'data','backups');fs.mkdirSync(dir,{recursive:true});
 const date=new Date().toISOString().replace(/[:.]/g,'-'),name=`${automatic?'auto':'manual'}-${date}.json.gz`,file=path.join(dir,name);
 const data=exportUserData(root,{includeResults:!automatic}),raw=Buffer.from(JSON.stringify(data));if(raw.length>512*1024*1024)throw Error('研究资料超过完整备份的 512 MB 解压上限。请先分别导出重要求解，避免产生无法恢复的备份。');const compressed=zlib.gzipSync(raw,{level:3});if(compressed.length>128*1024*1024)throw Error('压缩备份超过 128 MB 可恢复文件上限，请分批保存研究资料。');
 fs.writeFileSync(file,compressed,{flag:'wx'});
 return {name,createdAt:data.exportedAt,bytes:compressed.length,rawBytes:raw.length,includesResults:data.includesResults,records:Object.fromEntries(Object.entries(data.records).map(([k,v])=>[k,v.length]))};
}
export function listLocalBackups(root){
 const dir=path.join(root,'data','backups');if(!fs.existsSync(dir))return [];
 return fs.readdirSync(dir).filter(n=>/^(?:auto|manual)-[0-9TZ-]+\.json\.gz$/.test(n)).map(name=>{const s=fs.statSync(path.join(dir,name));return {name,bytes:s.size,createdAt:s.mtime.toISOString()};}).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
}
export function backupFile(root,name){if(typeof name!=='string'||!/^(?:auto|manual)-[0-9TZ-]+\.json\.gz$/.test(name))throw Error('备份文件名无效。');const file=path.join(root,'data','backups',name);if(!fs.existsSync(file))throw Error('备份不存在。');return file;}
export function restoreUserData(root,backup){
 if(backup?.app!=='PokerLab'||backup.schemaVersion!==2||!backup.records||typeof backup.records!=='object')throw Error('这不是受支持的 PokerLab 备份。');
 if(backup.results!=null&&(typeof backup.results!=='object'||Array.isArray(backup.results)))throw Error('备份求解结果表无效。');
 const base=path.join(root,'data','pro'),incoming=new Map(),existing=new Map(),resultCache=new Map(),staging=[];let skipped=0;
 for(const folder of folders){const values=backup.records[folder]??[];if(!Array.isArray(values)||values.length>100000)throw Error('备份记录格式或数量无效。');const rows=new Map();for(const input of values){if(!input||!idOK(input.id))throw Error('备份包含无效记录。');if(rows.has(input.id))throw Error('备份中同类记录编号重复。');rows.set(input.id,structuredClone(input));}incoming.set(folder,rows);}
 const stored=(folder,id)=>{const key=folder+':'+id;if(!existing.has(key))existing.set(key,idOK(id)?read(path.join(base,folder,id+'.json')):null);return existing.get(key);};
 const lookup=(folder,id)=>stored(folder,id)??incoming.get(folder)?.get(id)??null;
 const resolve=id=>{const job=lookup('jobs',id);if(!resultCache.has(id)){const current=idOK(id)?read(path.join(base,'jobs',id,'result.json')):null;resultCache.set(id,current??backup.results?.[id]??null);}const result=resultCache.get(id);if(result){if(!job?.scenario)throw Error('依赖策略树缺少同编号任务。');assertSolutionScenario(job.scenario,result,{settings:job.settings??{}});}return {job,result};};
 // Existing records win, so every new dependent record is checked against the
 // tree that will actually remain on disk after this merge.
 for(const [id,value] of Object.entries(backup.results??{})){
  if(!idOK(id)||!value||!Array.isArray(value.nodes)||!value.engine)throw Error('备份中的求解结果无效。');const raw=incoming.get('jobs').get(id),job=lookup('jobs',id);
  if(!job?.scenario)throw Error('备份中的求解树缺少同编号任务，无法核对原始模型。');
  if(raw?.scenario)assertSolutionScenario(raw.scenario,value,{settings:raw.settings??{}});assertSolutionScenario(job.scenario,value,{settings:job.settings??{}});
  const file=path.join(base,'jobs',id,'result.json');if(!fs.existsSync(file))staging.push({file,value:structuredClone(value)});
 }
 const order=folders.filter(f=>!['range-attempts','range-evaluations','play-sessions','study-projects'].includes(f)).concat(['range-attempts','range-evaluations','play-sessions','study-projects']);
 for(const folder of order){for(const [id,input] of incoming.get(folder)){let entry=input;
   if(folder==='cases'){const context=entry.inputContext??entry.scenario?.inputContext;entry.scenario=normalizeScenario(entry.scenario,{requireRanges:false});entry.needsRanges=entry.scenario.players.some(p=>!p.range.trim());entry.draft=entry.needsRanges;restoreInputSource(entry,lookup,context);}
   if(folder==='jobs'){const context=entry.inputContext??entry.scenario?.inputContext;entry.scenario=normalizeScenario(entry.scenario);const hasResult=!!resolve(entry.id).result;if(activeStatus(entry.status)||entry.status==='complete'&&!hasResult){entry.status='interrupted';entry.error=hasResult?'此任务从运行中备份恢复；需要重新求解。':'这份备份只含参数与记录，没有完整求解树；请重新求解。';}restoreInputSource(entry,lookup,context);}
   if(folder==='experiments'){if(!idOK(entry.sourceJobId)||!entry.input)throw Error('范围实验记录不完整。');if(activeStatus(entry.status)){entry.status='interrupted';entry.error='范围实验从未完全停止的备份恢复；已完成的历史结果保留，请重新启动实验。';}}
   if(folder==='hands'&&(typeof entry.raw!=='string'||typeof entry.sourceKey!=='string'||!entry.parse||!Array.isArray(entry.summary?.streets)))throw Error('牌谱收件箱记录不完整。');
   if(folder==='imports'){if(typeof entry.raw!=='string'||!Array.isArray(entry.handIds))throw Error('牌谱导入记录不完整。');if(activeStatus(entry.status))entry.status='interrupted';}
   if(folder==='ranges'){if(typeof entry.range!=='string'||!entry.range.trim()||entry.range.length>200000||typeof entry.title!=='string')throw Error('个人范围记录不完整。');const parsed=range(entry.range);entry.count=parsed.count;entry.weighted=parsed.weighted;}
   if(folder==='live-recordings')entry=restoreLiveRecording(entry);
   if(folder==='equity-explorations')entry=restoreEquityExploration(entry);
   if(folder==='board-contrasts')entry=restoreBoardContrast(entry,lookup,resolve);
   if(folder==='training'&&typeof entry.lessonId!=='string')throw Error('训练记录缺少题目编号。');
   if(folder==='study-cards'&&(!entry.full||!entry.publicQuestion))throw Error('私人题卡不完整。');
   if(folder==='study-attempts'&&!idOK(entry.cardId))throw Error('私人训练记录缺少题卡编号。');
   if(folder==='range-attempts')entry=validateRange(entry,resolve);
   if(folder==='range-evaluations')entry=validateEvaluation(entry,lookup,resolve);
   if(folder==='play-sessions')entry=validatePlay(entry,resolve);
   if(folder==='study-projects')entry=validateProject(entry,lookup);
   clearProcessIDs(entry);invalidateResponseWitness(entry);
   incoming.get(folder).set(id,entry);
   const file=path.join(base,folder,entry.id+'.json');if(fs.existsSync(file)){skipped++;continue;}staging.push({file,value:entry});
  }
 }
 // Validate everything before the first write, then preserve every existing ID.
 const before=createLocalBackup(root,{automatic:true});
 for(const entry of staging)atomic(entry.file,entry.value);
 return {imported:staging.length,skipped,backupBeforeRestore:before.name,mode:'仅补充缺失记录；已有记录不覆盖'};
}
export function restoreCompressedBackup(root,compressed){
 if(!Buffer.isBuffer(compressed)||compressed.length>128*1024*1024)throw Error('压缩备份超过 128 MB 上传上限。');
 let backup;try{const raw=zlib.gunzipSync(compressed,{maxOutputLength:512*1024*1024});backup=JSON.parse(raw.toString('utf8'));}catch{throw Error('备份格式无效、文件损坏或解压后超过 512 MB 上限。');}
 return restoreUserData(root,backup);
}
export function restoreLocalBackup(root,name){return restoreCompressedBackup(root,fs.readFileSync(backupFile(root,name)));}
