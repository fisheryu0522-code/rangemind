/** Standalone, reproducible integration campaign; deliberately outside *.test.
 * Run: node tests/v3-math-campaign.mjs --phase=cpu|gpu|analytic
 * Writes a NEW timestamped sibling work directory, never production records.
 * Finite deterministic examples are evidence, not a mathematical proof.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {cards,cardText,range,rankHand} from '../lib/poker.mjs';
import {prepareRiverGame,solveRiverGame} from '../lib/river-engine.mjs';
import {prepareTurnGame,solveTurnGame} from '../lib/turn-engine.mjs';
import {prepareGPURiverGame,solveGPURiverGame} from '../lib/gpu-river-cfr.mjs';
import {createRangeConstruction,evaluateRangeConstruction} from '../lib/strategy-construction.mjs';
import {createPlaySession,advancePlaySession,publicPlaySession} from '../lib/play-session.mjs';
import {listRunoutPlans,buildRunoutPlan} from '../lib/runout-plan.mjs';
import {buildRangeDebrief} from '../lib/range-debrief.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),phase=process.argv.find(x=>x.startsWith('--phase='))?.slice(8)??'cpu';
if(!['cpu','gpu','analytic'].includes(phase))throw Error('--phase must be cpu, gpu or analytic');
const stamp=new Date().toISOString().replace(/[:.]/g,'-'),OUT=path.resolve(ROOT,'..',`v3-math-campaign-${stamp}-${phase}`);
fs.mkdirSync(OUT,{recursive:false});
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
const report={kind:'v3-real-computation-cross-validation',version:1,phase,startedAt:new Date().toISOString(),host:{cpus:os.availableParallelism(),totalRAMBytes:os.totalmem(),node:process.version},seeds:{scenario:28090429,assignments:37119,episodes:20928},cases:[],adversarial:[],limits:['A finite deterministic sample is not a proof of correctness or a population win-rate experiment.','All scores concern the exact supplied ranges and finite action trees; multiplayer CFR has no general Nash convergence guarantee.','An unmet residual target remains explicitly unmet; no tolerance or action model is relaxed to make a result pass.','Independent JS best response chooses one action per public-node/private-hand information set, never a different action per opponent deal.','Wide GPU profiles are independently imported into the CPU evaluator; the independent JS oracle has an explicit smaller work budget.'],files:{}};
for(const file of ['lib/river-engine.mjs','lib/turn-engine.mjs','lib/gpu-river-cfr.mjs','lib/strategy-construction.mjs','lib/play-session.mjs','lib/runout-plan.mjs','lib/range-debrief.mjs','engines/RiverLab/river-engine.exe','engines/TurnLab/turn-engine.exe'])if(fs.existsSync(path.join(ROOT,file)))report.files[file]=sha(fs.readFileSync(path.join(ROOT,file)));
const write=(name,value)=>fs.writeFileSync(path.join(OUT,name),JSON.stringify(value,null,2),{flag:'wx'});
const close=(a,b,t=1e-8,label='numeric equality')=>assert.ok(Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=t,`${label}: ${a} != ${b}`);
function rng(seed){let x=seed>>>0||1;return ()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return ((x>>>0)+.5)/4294967296;};}
const positions=n=>({2:['BB','BTN'],3:['SB','BB','BTN'],4:['SB','BB','CO','BTN'],5:['SB','BB','HJ','CO','BTN'],6:['SB','BB','UTG','HJ','CO','BTN']})[n];
function model(board,n,count,seed,variant){
 const r=rng(seed),blocked=new Set(cards(board)),deck=Array.from({length:52},(_,i)=>i).filter(c=>!blocked.has(c));for(let i=deck.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[deck[i],deck[j]]=[deck[j],deck[i]];}
 const players=Array.from({length:n},(_,p)=>{
  const hands=new Map(),add=(a,b)=>{if(a!==b){const h=[a,b].sort((a,b)=>a-b);hands.set(h.join(','),h.map(cardText).join(''));}};add(deck[p*2],deck[p*2+1]);
  while(hands.size<count){const a=deck[Math.floor(r()*Math.min(16,deck.length))],b=deck[Math.floor(r()*deck.length)];add(a,b);}
  const handList=[...hands.values()],weights=[1,.35,.07,.8],range=handList.map((h,i)=>`${h}:${i%2?weights[i%4]*100+'%':weights[i%4]}`).join(',');
  const stack=board.length===8&&n===4?(variant?([6,11,17,23][p]):12):[8,17,31,5,47,12][(p+variant)%6];return {id:`p${p}`,name:`Player ${p}`,position:positions(n)[p],stack,range};
 });
 const pot=[10,17,24,42][variant%4],fee=variant%2?Math.min(.5,pot*.05):0;
 return {title:`Campaign ${n}p ${board} v${variant}`,format:variant%2?'live':'online',unit:'BB',board,pot,toAct:0,heroSeat:0,hero:range(players[0].range).live[0].label,players,rake:fee?5:0,rakeCap:fee,sizes:[variant%2?75:50],raiseSizes:[50],maxRaises:board.length===8?(n<4?1:0):variant%2?1:0,riverSizes:[50],riverRaiseSizes:[],riverMaxRaises:0,allIn:board.length===10,iterations:board.length===8?180:500,averagingDelay:10,algorithm:['alternating-cfr-plus','cfr-plus','dcfr'][variant%3],accuracy:.1,checkEvery:100,threads:4,maxNodes:50000,maxDeals:1000000,maxNodeVisits:200000000000,maxSeconds:90};
}
function cpuCases(){const out=[];for(let n=2;n<=6;n++)for(let v=0;v<2;v++)out.push({id:`cpu-river-${n}p-${v}`,raw:model(['Ks7h2d9c3s','QhJhTh2h2c'][(n+v)%2],n,n<4?4:3,28090429+n*71+v,n+v)});for(let n=2;n<=4;n++)for(let v=0;v<2;v++)out.push({id:`cpu-turn-${n}p-${v}`,raw:model(['As8h6h2d','QsQd9h4c'][v],n,n===4?2:3,28090429+n*73+v,v)});return out;}
function gpuCases(){
 const board='Ks7h2d9c3s',pool=range('22+,A2s+,K2s+,Q5s+,J7s+,T7s+,96s+,85s+,75s,65s,54s,ATo+,KJo+,QJo',cards(board)).live;
 return [{n:2,count:120,iters:2000,raises:2,algo:'alternating-cfr-plus'},{n:3,count:48,iters:1500,raises:1,algo:'dcfr'},{n:3,count:80,iters:1000,raises:2,algo:'alternating-cfr-plus'}].map(({n,count,iters,raises,algo},j)=>({id:`gpu-river-${n}p-${count}combos`,raw:{title:`GPU independent campaign ${n}p ${count} combos`,format:'study',unit:'BB',board,pot:20,toAct:0,heroSeat:0,players:Array.from({length:n},(_,p)=>({id:`p${p}`,name:`Player ${p}`,position:positions(n)[p],stack:[100,80,50][p],range:Array.from({length:count},(_,i)=>pool[(Math.floor(i*pool.length/count)+p*13)%pool.length].label+(i%5===0?':35%':i%7===0?':0.07':'')).join(',')})),rake:j===1?5:0,rakeCap:j===1?.5:0,sizes:[50],raiseSizes:[50],maxRaises:raises,allIn:true,iterations:iters,averagingDelay:100,algorithm:algo,accuracy:.05,threads:8,maxNodes:50000,maxNodeVisits:1e12,maxSeconds:180,gpuMemoryBytes:12e9}}));
}
function treeIndex(result){const map=new Map(result.nodes.map(n=>[n.id,n])),rows=new Map();for(const n of result.nodes)if(n.actor>=0)rows.set(n.id,new Map(n.combos.map(c=>[c.combo,c])));return {map,rows};}
function routeTo(result,node){const m=new Map(result.nodes.map(n=>[n.id,n])),route=[];while(node.parentId!==null&&node.parentId!==undefined){const parent=m.get(node.parentId);route.unshift(parent.actions.find(a=>a.childId===node.id).id);node=parent;}return route;}
function utilities(node,ranks,pot,fee){
 const invested=node.contributions,net=invested.map(x=>-x),alive=invested.map((_,i)=>i).filter(i=>!node.folded[i]);
 const award=(amount,eligible)=>{if(amount<=0)return;assert.ok(eligible.length);const max=Math.max(...eligible.map(p=>ranks[p])),winners=eligible.filter(p=>ranks[p]===max);winners.forEach(p=>net[p]+=amount/winners.length);};
 award(pot-fee,alive);const levels=[0,...new Set(invested.filter(x=>x>0))].sort((a,b)=>a-b);
 for(let j=1;j<levels.length;j++){const contributors=invested.map((x,i)=>x>=levels[j]-1e-8?i:-1).filter(i=>i>=0),amount=(levels[j]-levels[j-1])*contributors.length;if(contributors.length===1)net[contributors[0]]+=amount;else award(amount,contributors.filter(p=>!node.folded[p]));}
 return net;
}

/** Literal independent small-game evaluation. A responding player's own past
 * actions do not enter the selection weights. Choices aggregate ALL compatible
 * opponent private deals for the same hand, retaining their exact chance mass.
 * Public river branching filters a hidden root-chance river, as in the exact
 * complete-deal representation; no private cards become publicly visible. */
function independentOracle(prepared,result,maxVisits=5000000){
 const {deals,combinations}=prepared,D=deals.length,N=prepared.players.length,index=treeIndex(result),holes=prepared.chance?.holeDeals;
 const work=holes?result.nodes.reduce((s,n)=>s+(String(n.board).length===10?holes:D),0):result.nodes.length*D;
 if(work>maxVisits)return {status:'budget-limited',estimatedNodeDealVisits:work,limit:maxVisits};
 const all=Array.from({length:D},(_,i)=>i),prior=Float64Array.from(deals,d=>d.weight),started=performance.now(),calls={profile:0,bestResponse:0};
 function one(player,responding){
  function visit(node,active,opponentMass){
   const value=new Float64Array(D);calls[responding?'bestResponse':'profile']++;
   if(node.terminal||node.actor===-1){for(const d of active)value[d]=utilities(node,deals[d].ranks,prepared.pot,prepared.fixedRake)[player];return value;}
   if(node.chance||node.actor===-2){for(const action of node.actions){const selected=active.filter(d=>deals[d].river===action.card);if(!selected.length)continue;const sub=visit(index.map.get(action.childId),selected,opponentMass);for(const d of selected)value[d]=sub[d];}return value;}
   const policies=active.map(d=>index.rows.get(node.id).get(combinations[node.actor][deals[d].hands[node.actor]].combo).probabilities),children=[];
   for(let a=0;a<node.actions.length;a++){
    let next=opponentMass;if(responding&&node.actor!==player){next=Float64Array.from(opponentMass);for(let i=0;i<active.length;i++)next[active[i]]*=policies[i][a];}
    children.push(visit(index.map.get(node.actions[a].childId),active,next));
   }
   if(responding&&node.actor===player){
    const sums=Array.from({length:combinations[player].length},()=>new Float64Array(children.length));for(const d of active){const c=deals[d].hands[player];for(let a=0;a<children.length;a++)sums[c][a]+=opponentMass[d]*children[a][d];}
    const best=sums.map(v=>{let a=0;for(let j=1;j<v.length;j++)if(v[j]>v[a])a=j;return a;});for(const d of active)value[d]=children[best[deals[d].hands[player]]][d];
   }else for(let i=0;i<active.length;i++){const d=active[i];for(let a=0;a<children.length;a++)value[d]+=policies[i][a]*children[a][d];}
   return value;
  }
  const value=visit(result.nodes[0],all,prior);return all.reduce((s,d)=>s+prior[d]*value[d],0);
 }
 const profileEV=[],bestResponseEV=[];for(let p=0;p<N;p++){profileEV.push(one(p,false));bestResponseEV.push(one(p,true));}
 const gain=bestResponseEV.map((v,p)=>Math.max(0,v-profileEV[p])),nashConv=gain.reduce((a,b)=>a+b,0),diff=Math.max(...profileEV.map((v,p)=>Math.abs(v-result.diagnostics.profileEV[p])),...bestResponseEV.map((v,p)=>Math.abs(v-result.diagnostics.bestResponseEV[p])));
 assert.ok(diff<1e-7*Math.max(1,prepared.pot),`independent oracle differs ${diff}`);
 return {status:'complete',profileEV,bestResponseEV,gain,nashConv,maxNativeDifferenceBB:diff,estimatedNodeDealVisits:work,seconds:(performance.now()-started)/1000,algorithm:'Independent literal JS exact policy value and information-set-consistent unilateral best response',publicNodeVisits:calls};
}
function assignment(question,seed){const random=rng(seed);return {nodeId:question.source.nodeId,weighting:question.weighting,sourceFingerprint:question.sourceFingerprint,assignments:question.combos.filter(c=>c.editable).map(c=>{const weights=question.actions.map(()=>.03+random()),sum=weights.reduce((a,b)=>a+b,0);return {combo:c.combo,probabilities:Object.fromEntries(question.actions.map((a,i)=>[a.id,weights[i]/sum]))};})};}
function assertBlind(view){assert.equal(view.review,undefined);assert.equal(view.summary,undefined);const forbidden=new Set(['privateHands','randomState','sourceFingerprint','actionEV','acceptedAnswers','referenceProbabilities','selectedEV','bestEV']);function check(v){if(!v||typeof v!=='object')return;for(const [k,x]of Object.entries(v)){assert.ok(!forbidden.has(k),`blind leak ${k}`);check(x);}}check(view);}
function playAudit(raw,result,seed,count=3){
 const started=performance.now(),episodes=[],random=rng(seed),index=treeIndex(result);for(let e=0;e<count;e++){
  let session=createPlaySession(raw,result,{heroSeat:e%raw.players.length,feedbackMode:'end',reportedExposure:'unknown'},{seed:Math.floor(random()*4294967295),now:Date.parse('2026-09-28T04:29:00Z')});
  for(let depth=0;session.status==='playing'&&depth<80;depth++){
   const view=publicPlaySession(session,result);assertBlind(view);assert.equal(new Set([...cards(view.board),...session.privateHands.flat()]).size,cards(view.board).length+raw.players.length*2);
   const actions=view.decision.actions,action=actions[Math.floor(random()*actions.length)];session=advancePlaySession(session,result,{decisionId:view.decision.id,actionId:action.id,confidence:73,reason:'Deterministic integration campaign'},{now:Date.parse(session.updatedAt)+1200});
  }
  assert.equal(session.status,'complete');const view=publicPlaySession(session,result),out=view.review.outcome,node=index.map.get(session.currentNodeId),board=cards(out.board),ranks=session.privateHands.map(h=>rankHand([...board,...h]));
  const wanted=utilities(node,ranks,raw.pot,result.rakeModel?.fixedRake??0);out.net.forEach((v,p)=>close(v,wanted[p],1e-8,'episode settlement'));close(out.net.reduce((a,b)=>a+b,0),raw.pot-(result.rakeModel?.fixedRake??0));
  for(const p of out.players)if(p.seat!==session.source.heroSeat&&(p.folded||!out.showdown))assert.equal(p.cards,null);
  assert.equal(new Set([...board,...session.privateHands.flat()]).size,board.length+raw.players.length*2);
  for(const decision of view.review.decisions){const row=index.rows.get(decision.nodeId).get(range(decision.heroCombo).live[0].label),action=index.map.get(decision.nodeId).actions.findIndex(a=>a.id===decision.actionId);if(decision.feedback.loss!==null)close(decision.feedback.selectedEV,row.actionEV[action],1e-8,'information-set score');}
  episodes.push({heroSeat:session.source.heroSeat,decisions:session.decisions.length,streets:[...new Set(session.decisions.map(d=>cards(d.board).length))],showdown:out.showdown,finalBoard:out.board,net:out.net,refunds:out.uncalledRefunds,referenceWarnings:session.referenceWarnings.length});
 }return {status:'complete',seconds:(performance.now()-started)/1000,episodes};
}
function runoutAudit(raw,result,prepared){
 if(cards(raw.board).length!==4)return {status:'not-applicable'};const sources=listRunoutPlans(raw,result).sources.filter(s=>s.reach>0),chosen=[sources[0],sources.filter(s=>s.folded?.some(Boolean)).sort((a,b)=>b.reach-a.reach)[0]].filter((s,i,a)=>s&&a.findIndex(x=>x?.nodeId===s.nodeId)===i),index=treeIndex(result),checks=[];
 for(const source of chosen){
  let node=result.nodes[0];const history=[];for(const id of source.path){const a=node.actions.findIndex(a=>a.id===id);history.push({node,a});node=index.map.get(node.actions[a].childId);}
  const focusOptions=[undefined,...listRunoutFocus(source,result).slice(0,1)];for(const focusCombo of focusOptions){
   const plan=buildRunoutPlan(raw,result,{chancePath:source.path,focusCombo}),expected=new Map();let total=0;
   for(const d of prepared.deals){if(focusCombo&&prepared.combinations[source.actorSeat][d.hands[source.actorSeat]].combo!==focusCombo)continue;let mass=d.weight;for(const step of history){if(step.node.actor===-2){if(d.river!==step.node.actions[step.a].card)mass=0;}else mass*=index.rows.get(step.node.id).get(prepared.combinations[step.node.actor][d.hands[step.node.actor]].combo).probabilities[step.a];}if(!mass)continue;total+=mass;expected.set(cardText(d.river),(expected.get(cardText(d.river))??0)+mass);}
   assert.ok(total>0);let diff=0;for(const row of plan.rows){const p=(expected.get(row.card)??0)/total;diff=Math.max(diff,Math.abs(row.probability-p));close(row.probability,p,1e-8,'conditional runout');}close(plan.summary.probabilitySum,1);
   checks.push({path:source.path,folded:source.folded,focusCombo:focusCombo??null,maxDirectEnumerationProbabilityDifference:diff,possibleCards:plan.summary.possibleCards,weightedReferenceEV:plan.summary.weightedReferenceEV});
  }
 }return {status:'complete',sources:sources.length,checks};
}
function listRunoutFocus(source,result){const n=result.nodes.find(n=>n.id===source.nodeId),m=new Map(result.nodes.map(n=>[n.id,n]));return [...new Set(n.actions.flatMap(a=>m.get(a.childId).combos.filter(c=>c.reach>0).map(c=>c.combo)))];}
async function nvidia(){return new Promise(resolve=>execFile('nvidia-smi',['--query-gpu=name,memory.used,utilization.gpu','--format=csv,noheader,nounits'],{windowsHide:true},(error,stdout)=>{if(error)return resolve(null);const [name,memoryMiB,utilization]=stdout.trim().split(',').map(s=>s.trim());resolve({at:new Date().toISOString(),name,memoryMiB:Number(memoryMiB),utilizationPct:Number(utilization)});}));}
async function oneCase(item,ordinal){
 const started=performance.now(),entry={id:item.id,status:'running',input:item.raw,startedAt:new Date().toISOString()},events=[];report.cases.push(entry);console.log(JSON.stringify({case:item.id,phase:'start'}));
 let timer,polling=false;const telemetry=[];
 try{
  const prepare=cards(item.raw.board).length===4?prepareTurnGame:phase==='gpu'?prepareGPURiverGame:prepareRiverGame,prepared=prepare(item.raw);entry.size={players:prepared.players.length,rangeCombos:prepared.combinations.map(r=>r.length),legalDeals:prepared.deals.length,holeDeals:prepared.chance?.holeDeals??prepared.deals.length,publicNodes:prepared.nodes.length,estimatedNodeVisits:prepared.estimatedNodeVisits,gpuEstimatedBytes:prepared.gpuEstimate?.bytes??null};
  if(phase==='gpu'){telemetry.push(await nvidia());timer=setInterval(async()=>{if(polling)return;polling=true;try{telemetry.push(await nvidia());}finally{polling=false;}},500);}
  const run=cards(item.raw.board).length===4?solveTurnGame:phase==='gpu'?solveGPURiverGame:solveRiverGame;
  const result=await run(item.raw,{onProgress:p=>{if(p.phase==='prepared'||p.iteration||p.iterations)events.push({...p,at:new Date().toISOString()});}});
  if(timer){clearInterval(timer);timer=null;telemetry.push(await nvidia());}
  write(`${item.id}-result.json`,result);entry.resultFile=`${item.id}-result.json`;entry.resultSHA256=sha(JSON.stringify(result));entry.stats=result.stats;entry.quality={nashConvBB:result.diagnostics.nashConv,nashConvPctPot:result.diagnostics.nashConvPctPot,residualForOptimizationPctPot:result.diagnostics.optimizationResidualPctPot??result.diagnostics.nashConvPctPot,targetPctPot:item.raw.accuracy,targetReached:(result.diagnostics.optimizationResidualPctPot??result.diagnostics.nashConvPctPot)<=item.raw.accuracy,constantSum:result.diagnostics.constantSum,iterations:result.stats.iterations,note:'Only the displayed exact finite model; reference target may remain unmet.'};
  entry.gpuValidation=result.validation??null;close(result.diagnostics.profileEV.reduce((a,b)=>a+b,0),item.raw.pot-(result.rakeModel?.fixedRake??0),1e-7);
  entry.oracle=independentOracle(prepared,result);
  const root=result.nodes[0],deep=result.nodes.filter(n=>n.actor>=0&&n.id!=='n0'&&n.actions.length>1&&n.reach>1e-8&&n.combos.some(c=>c.reach>0&&!c.locked)).sort((a,b)=>routeTo(result,b).length-routeTo(result,a).length||b.reach-a.reach)[0],nodes=[root,...(deep?[deep]:[])];entry.rangeExercises=[];
  for(const node of nodes){
   const q=createRangeConstruction(item.raw,result,{nodeId:node.id}).publicQuestion;for(const c of q.combos){assert.equal(c.actionEV,undefined);assert.equal(c.referenceProbabilities,undefined);}assert.equal(q.acceptedAnswers,undefined);
   const submission=assignment(q,37119+ordinal*111+entry.rangeExercises.length),grade=await evaluateRangeConstruction(item.raw,result,submission,{maxNodeDealVisits:200000000,maxSeconds:180});
   assert.equal(grade.independentEvaluation.status,'complete');const e=grade.independentEvaluation;close(e.fixedOpponent.changeBB,grade.metrics.rootEVChangeBB,1e-7*Math.max(1,item.raw.pot));close(grade.actions.reduce((s,a)=>s+a.evContribution,0),grade.metrics.rangeEV,1e-8);close(grade.combos.reduce((s,c)=>s+c.weightedRegretBB,0),grade.metrics.localRegretBB);
   if(item.raw.players.length>2){assert.equal(e.responseExposure.userLossBB,null);assert.equal(e.responseExposure.coalitionModel,false);}else close(e.responseExposure.adaptationCostBB,e.submitted.gain[1-e.userSeat],1e-7);
   const debrief=buildRangeDebrief(grade,{jobId:item.id,nodePath:routeTo(result,node)});assert.equal(debrief.kind,'range-learning-debrief');
   write(`${item.id}-range-${node.id}.json`,{publicQuestion:q,submission,grade,debrief});entry.rangeExercises.push({nodeId:node.id,path:routeTo(result,node),actor:node.actor,combos:q.requirements.editableCombos,metrics:grade.metrics,independent:e});
  }
  entry.play=playAudit(item.raw,result,20928+ordinal*73,phase==='gpu'?2:3);entry.runout=runoutAudit(item.raw,result,prepared);entry.status='pass';
 }catch(error){entry.status=/预算|超过|上限/.test(error.message)?'budget-limited':'fail';entry.error={message:error.message,stack:error.stack};console.log(JSON.stringify({case:item.id,phase:entry.status,error:error.message}));}
 finally{if(timer)clearInterval(timer);entry.wallSeconds=(performance.now()-started)/1000;entry.finishedAt=new Date().toISOString();entry.gpuTelemetry=telemetry.filter(Boolean);entry.peakDeviceMemoryMiB=entry.gpuTelemetry.length?Math.max(...entry.gpuTelemetry.map(x=>x.memoryMiB)):null;entry.progress=events;write(`${item.id}-audit.json`,entry);console.log(JSON.stringify({case:item.id,status:entry.status,seconds:entry.wallSeconds,targetReached:entry.quality?.targetReached}));}
}
async function rejections(){
 const raw=model('Ks7h2d9c3s',3,2,714,1),r=await solveRiverGame({...raw,iterations:3,averagingDelay:0}),q=createRangeConstruction(raw,r).publicQuestion;
 const probes=[['sampled tree cannot issue exact range task',()=>createRangeConstruction(raw,{...r,chance:{...r.chance,exact:false}})],['partial tree cannot issue continuous session',()=>createPlaySession(raw,{...r,capabilities:{fullTree:false}})],['changed mathematical model cannot borrow old solution',()=>createPlaySession({...raw,pot:raw.pot+1},r)],['missing private assignment is rejected',()=>evaluateRangeConstruction(raw,r,{...assignment(q,2),assignments:[]})],['uncapped fee cannot masquerade as fixed fee',()=>prepareRiverGame({...raw,rake:5,rakeCap:9})],['5-player turn rejected rather than pruning players',()=>prepareTurnGame({...model('Ks7h2d9c',5,2,718,1),iterations:2,averagingDelay:0})],['4-player GPU refused explicitly',()=>prepareGPURiverGame({...model('Ks7h2d9c3s',4,2,719,1),iterations:2,averagingDelay:0})]];
 for(const [name,fn] of probes){let error;try{await fn();}catch(e){error=e;}assert.ok(error,`Expected refusal: ${name}`);report.adversarial.push({name,status:'pass',refusal:error.message});}
 const analytic={title:'No clairvoyant bluff catching',board:'KcQd8h6s2c',pot:10,toAct:0,heroSeat:1,players:[{id:'a',name:'Bettor',position:'BB',range:'AsAh:80%,3d4d:20%',stack:20},{id:'b',name:'Catcher',position:'BTN',range:'JsJh',stack:20}],sizes:[50],raiseSizes:[],maxRaises:0,allIn:false,iterations:100,averagingDelay:0,locks:[{nodeId:'n0',actions:{bet_5:1}}]},prepared=prepareRiverGame(analytic),result=await solveRiverGame(analytic),oracle=independentOracle(prepared,result),m=treeIndex(result),reply=m.map.get(result.nodes[0].actions.find(a=>a.id==='bet_5').childId),call=m.map.get(reply.actions.find(a=>a.id==='call').childId);
 // Calling wins 15 BB against air (20%) and loses 5 against value (80%):
 // its EV is -1, so an information-set best response folds for 0. A cheating
 // agent that sees the opponent hand would call only air and report +3 BB.
 const callEV=prepared.deals.reduce((s,d)=>s+d.weight*utilities(call,d.ranks,10,0)[1],0),clairvoyantEV=prepared.deals.reduce((s,d)=>s+d.weight*Math.max(0,utilities(call,d.ranks,10,0)[1]),0);
 close(callEV,-1);close(oracle.bestResponseEV[1],0);close(clairvoyantEV,3);assert.ok(clairvoyantEV>oracle.bestResponseEV[1]);
 report.adversarial.push({name:'Best response must aggregate hidden deals before choosing fold/call',status:'pass',callEV,informationSetBestResponseEV:oracle.bestResponseEV[1],illegalClairvoyantEV:clairvoyantEV,oracle});write('analytic-hidden-information-result.json',result);
}
const cases=phase==='cpu'?cpuCases():phase==='gpu'?gpuCases():[];for(let i=0;i<cases.length;i++)await oneCase(cases[i],i);if(phase!=='gpu')await rejections();
report.finishedAt=new Date().toISOString();report.summary={cases:report.cases.length,pass:report.cases.filter(c=>c.status==='pass').length,failed:report.cases.filter(c=>c.status==='fail').length,budgetLimited:report.cases.filter(c=>c.status==='budget-limited').length,referenceTargetsReached:report.cases.filter(c=>c.quality?.targetReached).length,referenceTargetsUnmet:report.cases.filter(c=>c.quality&&!c.quality.targetReached).length,rangeExercises:report.cases.reduce((s,c)=>s+(c.rangeExercises?.length??0),0),playEpisodes:report.cases.reduce((s,c)=>s+(c.play?.episodes?.length??0),0),directRunoutComparisons:report.cases.reduce((s,c)=>s+(c.runout?.checks?.length??0),0),independentJSOracles:report.cases.filter(c=>c.oracle?.status==='complete').length,adversarialRefusals:report.adversarial.length};write('report.json',report);
fs.writeFileSync(path.join(OUT,'REPORT.md'),`# PokerLab v3 real calculation campaign\n\n${JSON.stringify(report.summary,null,2)}\n\n${report.cases.map(c=>`- ${c.id}: ${c.status}; ${c.wallSeconds.toFixed(2)} s; residual ${c.quality?.nashConvPctPot??'unavailable'}% pot; target ${c.quality?.targetReached?'reached':'NOT reached / unavailable'}.`).join('\n')}\n\n${report.limits.map(s=>'- '+s).join('\n')}\n`,{flag:'wx'});
console.log(JSON.stringify({finished:true,output:OUT,summary:report.summary}));if(report.summary.failed)process.exitCode=1;
