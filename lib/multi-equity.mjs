import {cards,range,cardText,rankHand,composition} from './poker.mjs';
import {spawnSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';

const mask=cs=>cs.reduce((m,c)=>{m[c<32?0:1]|=1<<(c<32?c:c-32);return m;},[0,0]);
export const EQUITY_CI_METHOD='Empirical Bernstein · Maurer–Pontil 2009 Theorem 4 · two-sided pointwise 95%';
const CI_META={ciMethod:EQUITY_CI_METHOD,ciLevel:.95,ciCoverage:'pointwise',ciSource:'https://www.cs.mcgill.ca/~colt2009/papers/012.pdf'};
// Apply Theorem 4 to X and 1-X with delta/2 for each tail. Shares may be
// fractional in a split pot, so a Bernoulli-only interval would not suffice.
export function equitySamplingInterval(sum,squares,n,delta=.05){
  if(!Number.isFinite(n)||n<0||!Number.isFinite(sum)||!Number.isFinite(squares)||delta<=0||delta>=1)throw Error('无效采样统计量。');
  if(n===0)return {equity:null,ci:null,ciLow:null,ciHigh:null};
  const equity=sum/n,variance=n>1?Math.max(0,(squares-sum*sum/n)/(n-1)):0,L=Math.log(4/delta);
  const ci=n<2?1:Math.min(1,Math.sqrt(2*variance*L/n)+7*L/(3*(n-1)));
  return {equity,ci,ciLow:Math.max(0,equity-ci),ciHigh:Math.min(1,equity+ci)};
}
const normalizedWeights=r=>{const top=Math.max(...r.map(c=>c.weight));if(!(top>0)||r.some(c=>!Number.isFinite(c.weight)||c.weight<=0))throw Error('范围需要有限的正权重。');const scaled=r.map(c=>c.weight/top),sum=scaled.reduce((a,b)=>a+b,0);return scaled.map(w=>w/sum);};
const assumptions=[
  '权益指所有剩余公共牌发出并摊牌时的底池份额，不是任何行动的 EV。',
  '各输入范围按权重独立建模，再联合排除重复牌；未建模的历史相关性与弃牌者移除效应不包含在内。',
  '范围矩阵和成牌构成显示输入权重；组合 reach 是排除撞牌后的实际边际概率。',
  '多人权益按共享底池等分计算；不同筹码的边池价值应在策略树或明确的全下金额模型中计算。',
  '采样误差采用 [0,1] 底池份额的双侧 95% 逐项经验 Bernstein 界；零观测方差不再显示零误差。保证以独立同分布采样模型为前提，不同时覆盖所有组合，也不包含范围假设或策略误差。'
];
export function prepareEquity(s){
  if(!s||!Array.isArray(s.players)||s.players.length<2||s.players.length>9)throw Error('权益计算支持 2–9 个玩家。');
  const board=cards(s.board,[3,4,5]);
  const ranges=s.players.map((p,i)=>{try{return range(p.range,board);}catch(e){throw Error(`${p.name||p.position||'玩家 '+(i+1)}：${e.message}`);}});
  const hero=cards(s.hero||'',[0,2]),heroSeat=Number(s.heroSeat??0);
  if(!Number.isInteger(heroSeat)||heroSeat<0||heroSeat>=ranges.length)throw Error('请选择正确的 Hero 座位。');
  if(new Set([...board,...hero]).size!==board.length+hero.length)throw Error('Hero 手牌与公共牌重复。');
  let visits=0;const marked=ranges.map(r=>r.live.map(c=>mask(c.cards)));let found=false;
  const find=(p,lo,hi)=>{if(++visits>500000)throw Error('范围相互重叠过高，无法快速找到兼容发牌。');if(p===ranges.length)return true;for(const [a,b] of marked[p])if(!(lo&a)&&!(hi&b)&&find(p+1,lo|a,hi|b))return true;return false;};
  const [bl,bh]=mask(board);found=find(0,bl,bh);if(!found)throw Error('这些范围无法同时发出互不重复的手牌。');
  return {board,ranges,hero,heroSeat};
}
export function exactMultiRiver(ranges,board,{maxProducts=500000}={}){
  if(board.length!==5)throw Error('精确河牌枚举需要 5 张公共牌。');
  const product=ranges.reduce((v,r)=>v*r.length,1);if(product>maxProducts)throw Error('组合笛卡尔积超过本次精确枚举预算。');
  const started=performance.now(),N=ranges.length;
  const data=ranges.map(r=>{const probabilities=normalizedWeights(r);return r.map((c,i)=>({...c,probability:probabilities[i],bits:mask(c.cards),rank:rankHand([...board,...c.cards])}));});
  const stats=data.map(r=>({equity:0,tieProbability:0,combos:r.map(()=>({mass:0,sum:0}))}));let mass=0,deals=0;const chosen=[];
  function rec(p,lo,hi,w){
    if(p===N){let best=-1,win=[];for(let i=0;i<N;i++){const q=data[i][chosen[i]].rank;if(q>best){best=q;win=[i];}else if(q===best)win.push(i);}mass+=w;deals++;const share=1/win.length;
      for(let i=0;i<N;i++){const st=stats[i],q=st.combos[chosen[i]];q.mass+=w;if(win.includes(i)){st.equity+=w*share;q.sum+=w*share;if(win.length>1)st.tieProbability+=w;}}return;}
    for(let k=0;k<data[p].length;k++){const c=data[p][k];if(lo&c.bits[0]||hi&c.bits[1])continue;chosen[p]=k;rec(p+1,lo|c.bits[0],hi|c.bits[1],w*c.probability);}
  }
  const [lo,hi]=mask(board);rec(0,lo,hi,1);if(!mass)throw Error(deals?'合法发牌概率发生数值下溢；请检查极端范围权重。':'范围之间没有兼容的联合发牌。');
  return {players:stats.map(s=>({equity:s.equity/mass,ci:0,ciLow:s.equity/mass,ciHigh:s.equity/mass,tieProbability:s.tieProbability/mass,combos:s.combos.map(c=>({equity:c.mass?c.sum/c.mass:null,ci:c.mass?0:null,ciLow:c.mass?c.sum/c.mass:null,ciHigh:c.mass?c.sum/c.mass:null,samples:null,reach:c.mass/mass}))})),exact:true,samples:deals,jointMass:mass,jointMassMeaning:'Independent normalized-prior probability of a compatible joint deal',ciMethod:'Exact enumeration · no sampling uncertainty',ciLevel:null,ciCoverage:'exact',engine:'CPU 多人河牌精确枚举',milliseconds:performance.now()-started};
}
export function sampleMultiCPU(ranges,board,n=30000,seed=20260928){
  const started=performance.now(),N=ranges.length,cdf=ranges.map(r=>{let sum=0;return normalizedWeights(r).map(w=>sum+=w);});let state=seed||1;
  const rand=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296;};
  const stats=ranges.map(r=>({sum:0,sq:0,tie:0,combos:r.map(()=>({sum:0,sq:0,count:0}))}));const bm=mask(board);let done=0,attempts=0;
  while(done<n){if(++attempts>n*500)throw Error('范围重叠过高，采样无法在预算内完成。');let lo=bm[0],hi=bm[1],valid=true;const hands=[],indices=[];
    for(let p=0;p<N;p++){const z=rand()*cdf[p].at(-1);let l=0,h=cdf[p].length-1;while(l<h){let m=(l+h)>>1;if(z<cdf[p][m])h=m;else l=m+1;}const c=ranges[p][l],b=mask(c.cards);if(lo&b[0]||hi&b[1]){valid=false;break;}lo|=b[0];hi|=b[1];hands.push(c.cards);indices.push(l);}
    if(!valid)continue;const used=new Set([...board,...hands.flat()]),run=[...board];while(run.length<5){const c=Math.floor(rand()*52);if(!used.has(c)){used.add(c);run.push(c);}}
    const ranks=hands.map(h=>rankHand([...run,...h])),best=Math.max(...ranks),wins=ranks.filter(v=>v===best).length;
    for(let p=0;p<N;p++){const share=ranks[p]===best?1/wins:0,st=stats[p],co=st.combos[indices[p]];st.sum+=share;st.sq+=share*share;st.tie+=share>0&&wins>1;co.sum+=share;co.sq+=share*share;co.count++;}done++;
  }
  const calc=equitySamplingInterval;
  return {players:stats.map(s=>({...calc(s.sum,s.sq,n),tieProbability:s.tie/n,combos:s.combos.map(c=>({...calc(c.sum,c.sq,c.count),samples:c.count,reach:c.count/n}))})),exact:false,...CI_META,samples:n,seed,engine:'CPU 多人蒙特卡洛',milliseconds:performance.now()-started};
}
export function analyzeMulti(s,{samples=1000000,engine='gpu',python}={}){
  const t0=performance.now(),v=prepareEquity(s),n=Math.min(10000000,Math.max(10000,Math.trunc(Number(samples)||1000000)));
  const tasks=[{ranges:v.ranges.map(r=>r.live),board:v.board,samples:n,seed:20260928}];
  if(v.hero.length){const rs=tasks[0].ranges.map((r,i)=>i===v.heroSeat?[{cards:v.hero,weight:1}]:range(s.players[i].range,[...v.board,...v.hero]).live);tasks.push({...tasks[0],ranges:rs,seed:20260929});}
  const result=new Array(tasks.length),pending=[],warnings=[];
  for(let i=0;i<tasks.length;i++){const x=tasks[i];if(v.board.length===5&&x.ranges.reduce((n,r)=>n*r.length,1)<=500000)result[i]=exactMultiRiver(x.ranges,x.board);else pending.push(i);}
  if(pending.length&&engine!=='cpu'){
    const p=spawnSync(python||(process.env.POKERLAB_PYTHON||'python'),[fileURLToPath(new URL('./multi_gpu.py',import.meta.url))],{input:JSON.stringify({tasks:pending.map(i=>tasks[i])}),encoding:'utf8',windowsHide:true,timeout:120000,maxBuffer:32*1024*1024});
    try{const d=JSON.parse(p.stdout);if(p.status||d.error)throw Error(d.error||p.stderr||'GPU 未完成');pending.forEach((id,k)=>result[id]=d.results[k]);}catch(e){warnings.push('GPU 本次未完成，已使用 CPU 有限样本重新计算：'+e.message);}
  }
  for(const i of pending)if(!result[i])result[i]=sampleMultiCPU(tasks[i].ranges,v.board,Math.min(30000,n),tasks[i].seed);
  const base=result[0],players=s.players.map((p,i)=>{const r=v.ranges[i];return {...p,id:p.id||'p'+i,range:r,rangeText:p.range,...base.players[i],composition:composition(r,v.board),combos:r.live.map((c,j)=>({...c,...base.players[i].combos[j]}))};});
  const hero=result[1]?{seat:v.heroSeat,hand:v.hero.map(cardText).join(''),equity:result[1].players[v.heroSeat].equity,ci:result[1].players[v.heroSeat].ci,ciLow:result[1].players[v.heroSeat].ciLow,ciHigh:result[1].players[v.heroSeat].ciHigh,ciMethod:result[1].ciMethod,exact:result[1].exact,samples:result[1].samples}:null;
  if(v.hero.length&&!v.ranges[v.heroSeat].live.some(c=>c.cards.every(k=>v.hero.includes(k))))warnings.push('聚焦手牌不在该玩家输入范围内；其权益是单独条件研究，不代表这手牌实际到达了节点。');
  const sections=[{title:'范围与组合',body:players.map(p=>`${p.name||p.position}：${p.range.count} 个合法组合，${p.range.weighted.toFixed(2)} 个加权组合`).join('；')+'。这些是输入假设，不是对手真实范围的证明。',evidenceIds:['range-counts']},{title:'权益与策略的区别',body:hero?`聚焦手牌摊牌份额为 ${(hero.equity*100).toFixed(2)}%。跟注、加注和过牌的价值还取决于响应与后续行动；请进入策略树研究。`:'摊牌份额用于理解范围结构。需要判断下注、跟注或加注时，使用包含相关动作的策略树。',evidenceIds:hero?['hero-equity']:['range-equity']},{title:'下一步对照',body:players.length>2?'保持其他条件不变，调整身后玩家的继续范围。先预测权益变化，再研究他加注后你的后续行动；多人防守不直接套用单挑 MDF。':'调整一个具体牌组的权重，并预测哪些组合受影响。阻断价值牌和阻断弃牌，对行动 EV 可能产生相反影响。',evidenceIds:[]}];
  return {id:crypto.randomUUID(),scenario:s,createdAt:new Date().toISOString(),engine:base.engine,exact:base.exact,ciMethod:base.ciMethod,ciLevel:base.ciLevel,ciCoverage:base.ciCoverage,ciSource:base.ciSource,samples:base.samples,milliseconds:performance.now()-t0,kernelMilliseconds:base.milliseconds,seed:base.seed??null,assumptions,players,hero,explanation:{headline:'先看范围结构，再研究行动价值',sections,limitations:assumptions},warnings};
}

/** Server path uses an asynchronous, separately cancellable GPU process. The
 * synchronous reference above remains available for independent validation. */
export async function analyzeMultiAsync(s,{samples=1000000,engine='gpu',python,onProcess=()=>{},signal}={}){
  const started=performance.now(),v=prepareEquity(s),n=Math.min(10000000,Math.max(10000,Math.trunc(Number(samples)||1000000)));
  const tasks=[{ranges:v.ranges.map(r=>r.live),board:v.board,samples:n,seed:20260928}];
  if(v.hero.length)tasks.push({ranges:tasks[0].ranges.map((r,i)=>i===v.heroSeat?[{cards:v.hero,weight:1}]:range(s.players[i].range,[...v.board,...v.hero]).live),board:v.board,samples:n,seed:20260929});
  const result=new Array(tasks.length),pending=[],warnings=[];
  for(let i=0;i<tasks.length;i++){const t=tasks[i];if(v.board.length===5&&t.ranges.reduce((n,r)=>n*r.length,1)<=500000)result[i]=exactMultiRiver(t.ranges,t.board);else pending.push(i);}
  if(pending.length&&engine!=='cpu')try{
    const d=await new Promise((resolve,reject)=>{
      if(signal?.aborted)return reject(Error('权益计算已取消。'));
      const child=spawn(python||(process.env.POKERLAB_PYTHON||'python'),[fileURLToPath(new URL('./multi_gpu.py',import.meta.url))],{windowsHide:true,stdio:['pipe','pipe','pipe']});onProcess(child.pid);
      let out='',err='',done=false;const cancel=()=>child.kill(),timer=setTimeout(cancel,120000);
      signal?.addEventListener('abort',cancel,{once:true});
      const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);onProcess(null);error?reject(error):resolve(value);};
      child.stdout.on('data',b=>{out+=b;if(out.length>32*1024*1024){child.kill();finish(Error('GPU 输出超过预算。'));}});child.stderr.on('data',b=>err=(err+b).slice(-8000));
      child.on('error',finish);child.stdin.on('error',()=>{});child.on('close',code=>{if(signal?.aborted)return finish(Error('权益计算已取消。'));try{const value=JSON.parse(out);if(code||value.error)throw Error(value.error||err||'GPU 未完成');finish(null,value);}catch(e){finish(e);}});
      child.stdin.end(JSON.stringify({tasks:pending.map(i=>tasks[i])}));
    });pending.forEach((id,k)=>result[id]=d.results[k]);
  }catch(e){if(signal?.aborted)throw e;warnings.push('GPU 本次未完成，已使用 CPU 有限样本重新计算：'+e.message);}
  for(const i of pending){if(signal?.aborted)throw Error('权益计算已取消。');if(!result[i])result[i]=sampleMultiCPU(tasks[i].ranges,v.board,Math.min(30000,n),tasks[i].seed);}
  const base=result[0],players=s.players.map((p,i)=>{const r=v.ranges[i];return {...p,id:p.id||'p'+i,range:r,rangeText:p.range,...base.players[i],composition:composition(r,v.board),combos:r.live.map((c,j)=>({...c,...base.players[i].combos[j]}))};});
  const hero=result[1]?{seat:v.heroSeat,hand:v.hero.map(cardText).join(''),equity:result[1].players[v.heroSeat].equity,ci:result[1].players[v.heroSeat].ci,ciLow:result[1].players[v.heroSeat].ciLow,ciHigh:result[1].players[v.heroSeat].ciHigh,ciMethod:result[1].ciMethod,exact:result[1].exact,samples:result[1].samples}:null;
  return {id:crypto.randomUUID(),scenario:s,createdAt:new Date().toISOString(),engine:base.engine,exact:base.exact,ciMethod:base.ciMethod,ciLevel:base.ciLevel,ciCoverage:base.ciCoverage,ciSource:base.ciSource,samples:base.samples,milliseconds:performance.now()-started,kernelMilliseconds:base.milliseconds,seed:base.seed??null,assumptions,players,hero,warnings};
}
