import {cards,cardText,range} from './poker.mjs';
import {exactMultiRiver,sampleMultiCPU} from './multi-equity.mjs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
const text=(v,n=200)=>String(v??'').trim().slice(0,n),boardText=b=>b.map(cardText).join(' '),street=n=>({0:'preflop',3:'flop',4:'turn',5:'river'})[n];
function compatible(ranges,board){
 const used=new Set(board);let visits=0;
 function find(i){if(++visits>300000)throw Error('联合范围合法性检查超过预算，请收窄极端重叠范围。');if(i===ranges.length)return true;for(const h of ranges[i])if(h.cards.every(c=>!used.has(c))){h.cards.forEach(c=>used.add(c));const ok=find(i+1);h.cards.forEach(c=>used.delete(c));if(ok)return true;}return false;}
 if(!find(0))throw Error('这些位置的范围无法同时发出合法的互不重复手牌。');
}
export function prepareEquityExplorer(input){
 if(!input||typeof input!=='object')throw Error('范围阶段输入无效。');
 const board=cards(input.board??'',[0,3,4,5]);
 if(!Array.isArray(input.stages)||input.stages.length<1||input.stages.length>8)throw Error('请提供 1–8 个明确的范围阶段。');
 const ids=new Set(),stages=input.stages.map((s,i)=>{
  const id=text(s.id||'stage-'+i,60);if(ids.has(id))throw Error('范围阶段编号重复。');ids.add(id);
  if(!Array.isArray(s.players)||s.players.length<2||s.players.length>9)throw Error('每个阶段需要 2–9 个仍在比较的玩家范围。');
  const pids=new Set(),players=s.players.map((p,j)=>{const pid=text(p.id||p.position||'p'+j,60);if(pids.has(pid))throw Error('同一阶段位置编号重复。');pids.add(pid);const rangeText=text(p.range,200000);range(rangeText,board);return {id:pid,name:text(p.name||p.position||pid,80),position:text(p.position||p.name||pid,40),range:rangeText,sourceNote:text(p.sourceNote||'用户设定范围；未经翻前均衡认证',1000)};});
  if(new Set(players.map(p=>p.position.toUpperCase())).size!==players.length)throw Error('同一阶段的位置名称不能重复，以免把不同玩家画成同一条权益曲线。');
  compatible(players.map(p=>range(p.range,board).live),board);
  return {id,label:text(s.label||'阶段 '+(i+1),80),actionLine:text(s.actionLine||'',500),sourceNote:text(s.sourceNote||'明确输入的研究假设',1000),players};
 });
 const samples=input.samples??200000;if(!Number.isInteger(samples)||samples<10000||samples>2000000)throw Error('每个模型的样本预算须为 10,000–2,000,000 的整数。');
 const engine=input.engine??'gpu';if(!['gpu','cpu'].includes(engine))throw Error('权益引擎选择无效。');
 const runoutStageId=input.runoutStageId||null;if(runoutStageId&&(!ids.has(runoutStageId)||![3,4].includes(board.length)))throw Error('逐张下一街比较需要指定一个有效阶段，且牌面为翻牌或转牌。');
 return {version:1,title:text(input.title||'翻前范围与牌面权益',160),board:boardText(board),stages,samples,engine,includeStreetTrail:input.includeStreetTrail!==false,runoutStageId,seed:Number.isInteger(input.seed)?input.seed>>>0:20260928,meaning:'阶段和位置只标识你输入的范围；未求解翻前动作，也未假定这些范围来自均衡。'};
}
export function equityDistribution(rg,player,{points=41}={}){
 const rows=rg.map((c,i)=>({combo:c.label,equity:player.combos?.[i]?.equity,weight:player.combos?.[i]?.reach??0,samples:player.combos?.[i]?.samples??null})).filter(c=>Number.isFinite(c.equity)&&c.weight>0).sort((a,b)=>b.equity-a.equity),mass=rows.reduce((s,c)=>s+c.weight,0);
 if(!(mass>0))return {points:[],representedCombos:0,unobservedCombos:rg.length,meaning:'没有可用的组合权益分布。'};
 const curve=[];let j=0,cumulative=rows[0].weight/mass;
 for(let i=0;i<points;i++){const q=i/(points-1);while(j<rows.length-1&&cumulative<q){j++;cumulative+=rows[j].weight/mass;}curve.push({percentile:q,equity:rows[j].equity,combo:rows[j].combo});}
 return {points:curve,representedCombos:rows.length,unobservedCombos:rg.length-rows.length,weightedMean:rows.reduce((s,c)=>s+c.equity*c.weight,0)/mass,meaning:'按该玩家每个组合对兼容对手范围的条件摊牌权益排序；横轴为合法联合发牌的后验质量。采样未见组合不等于组合不存在。'};
}
function gpuBatch(tasks,{onProgress,onProcess,signal}){
 return new Promise((resolve,reject)=>{
  if(signal?.aborted)return reject(Error('权益探索已取消。'));
  const python=(process.env.POKERLAB_PYTHON||'python'),child=spawn(python,[fileURLToPath(new URL('./multi_gpu.py',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe']});onProcess(child.pid);
  let out='',err='',line='',problem=null;const cancel=()=>{problem=Error(signal?.aborted?'权益探索已取消。':'权益批处理超过时间预算。');child.kill();},timer=setTimeout(cancel,180000);
  signal?.addEventListener('abort',cancel,{once:true});child.stdout.on('data',b=>{out+=b;if(out.length>96*1024*1024){problem=Error('权益输出超过内存预算。');child.kill();}});
  child.stderr.on('data',b=>{line+=b;const lines=line.split('\n');line=lines.pop();for(const l of lines){try{const p=JSON.parse(l);if(Number.isInteger(p.completed))onProgress({phase:'gpu-equity-batch',...p});}catch{err=(err+l).slice(-6000);}}});
  child.stdin.on('error',()=>{});child.on('error',e=>{problem=e;});child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);onProcess(null);if(problem)return reject(problem);try{const data=JSON.parse(out);if(code||data.error)throw Error(data.error||err||'GPU 权益计算失败。');if(data.results?.length!==tasks.length)throw Error('GPU 返回的模型数量不完整。');resolve(data.results);}catch(e){reject(e);}});
  child.stdin.end(JSON.stringify({tasks,progress:true}));
 });
}
export async function runEquityExplorer(raw,{onProgress=()=>{},onProcess=()=>{},signal}={}){
 const input=prepareEquityExplorer(raw),started=performance.now(),board=cards(input.board),models=[],unavailable=[];
 function add(stage,b,kind,card=null){
  let ranges;try{ranges=stage.players.map(p=>range(p.range,b));compatible(ranges.map(r=>r.live),b);}catch(e){if(kind!=='next-card')throw e;unavailable.push({stageId:stage.id,kind,card:cardText(card),board:boardText(b),status:'unavailable',reason:e.message});return;}
  models.push({stage,board:b,kind,card,ranges,task:{board:b,ranges:ranges.map(r=>r.live),samples:input.samples,seed:(input.seed+models.length*1009)>>>0,summaryOnly:kind==='next-card'}});
 }
 for(const stage of input.stages){add(stage,board,'current');if(input.includeStreetTrail)for(const n of [0,3,4])if(n<board.length)add(stage,board.slice(0,n),'street-trail');}
 if(input.runoutStageId){const s=input.stages.find(s=>s.id===input.runoutStageId);for(let c=0;c<52;c++)if(!board.includes(c))add(s,[...board,c],'next-card',c);}
 if(models.length>85||models.length*input.samples>90000000)throw Error('本次探索超过 85 个模型或 9,000 万总样本预算；减少阶段、关闭逐张比较或降低每模型样本。');
 const results=Array(models.length),pending=[];
 for(let i=0;i<models.length;i++){if(signal?.aborted)throw Error('权益探索已取消。');const m=models[i];if(m.board.length===5&&m.ranges.reduce((n,r)=>n*r.live.length,1)<=500000){results[i]=exactMultiRiver(m.task.ranges,m.board);onProgress({phase:'exact-equity',completed:i+1,total:models.length});}else pending.push(i);}
 if(input.engine==='gpu'&&pending.length){const batch=await gpuBatch(pending.map(i=>models[i].task),{onProgress,onProcess,signal});pending.forEach((i,k)=>results[i]=batch[k]);}
 else for(const i of pending){if(signal?.aborted)throw Error('权益探索已取消。');results[i]=sampleMultiCPU(models[i].task.ranges,models[i].board,Math.min(input.samples,30000),models[i].task.seed);onProgress({phase:'cpu-equity',completed:i+1,total:models.length});}
 const rows=models.map((m,i)=>{
  const r=results[i];if(r.players.length!==m.stage.players.length||r.players.some(p=>!Number.isFinite(p.equity)||p.equity<0||p.equity>1)||Math.abs(r.players.reduce((a,p)=>a+p.equity,0)-1)>1e-8)throw Error('权益总份额不守恒，未发布本次结果。');
  return {stageId:m.stage.id,label:m.stage.label,kind:m.kind,street:street(m.board.length),board:boardText(m.board),card:m.card==null?null:cardText(m.card),status:'complete',exact:r.exact,engine:r.engine,samples:r.samples,seed:r.seed??null,ciMethod:r.ciMethod,ciCoverage:r.ciCoverage,milliseconds:r.milliseconds,players:m.stage.players.map((p,k)=>({id:p.id,name:p.name,position:p.position,equity:r.players[k].equity,ci:r.players[k].ci,ciLow:r.players[k].ciLow,ciHigh:r.players[k].ciHigh,legalCombos:m.ranges[k].count,weightedCombos:m.ranges[k].weighted,removedCombos:m.ranges[k].removed,...(m.kind==='current'?{distribution:equityDistribution(m.ranges[k].live,r.players[k])}:{})}))};
 });
 const nextCards=rows.filter(r=>r.kind==='next-card');
 if(nextCards.length){const baseIndex=models.findIndex(m=>m.kind==='current'&&m.stage.id===input.runoutStageId),m=models[baseIndex],r=results[baseIndex],used=Array(52).fill(0);m.task.ranges.forEach((rg,p)=>rg.forEach((h,k)=>h.cards.forEach(c=>used[c]+=r.players[p].combos[k].reach??0)));for(const row of nextCards){const c=cards(row.card)[0];row.nextCardProbability=Math.max(0,1-used[c])/(52-board.length-2*m.stage.players.length);row.nextCardProbabilityExact=r.exact;}}
 const final={schemaVersion:1,kind:'equity-explorer-result',createdAt:new Date().toISOString(),input,inputFingerprint:crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex'),rows:[...rows,...unavailable],models:models.length,milliseconds:performance.now()-started,assumptions:['权益是直接发完公共牌后的摊牌底池份额，没有下注、弃牌、加注、权益实现或边池结算。','open / 3bet / 4bet / 5bet 阶段由用户提供独立范围；没有从位置名称自动推断均衡范围。','各街曲线固定该阶段的范围先验，只条件于当街公共牌；没有暗中添加翻后行动筛选。','所有玩家范围独立给定，再共同条件于牌张不冲突；未输入先前弃牌者的隐藏牌分布。','采样误差带是逐项 95% 界，不是全部阶段、曲线和差值同时成立的 95% 保证。','下一张牌的条件概率根据当前联合底牌分布估计，不能把所有剩余牌直接视为等概率。'],teaching:{question:'权益变化来自范围收窄、公共牌移除，还是相同组合的摊牌强度变化？先固定另外两项再比较。',method:['先选同一牌面，只改变明确的翻前范围阶段。','再固定一个阶段，观察逐街或下一张牌的变化。','权益领先不直接推出下注或加注；要解释行动变化，进入同一范围模型的换牌策略实验。']}};
 if(signal?.aborted)throw Error('权益探索已取消。');return final;
}
