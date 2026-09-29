import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {cards,range,rankHand} from './poker.mjs';

import {fixedCappedRake} from './river-rake.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const EPS=1e-8;
const round=x=>Math.round(x*1e6)/1e6;
const number=(v,name,lo,hi)=>{const n=Number(v);if(!Number.isFinite(n)||n<lo||n>hi)throw Error(`${name} 必须在 ${lo}–${hi} 之间。`);return n;};
const integer=(v,name,lo,hi)=>{const n=number(v,name,lo,hi);if(!Number.isInteger(n))throw Error(`${name} 必须是整数。`);return n;};
function sizes(v,fallback,name){if(v===undefined)v=fallback;if(typeof v==='string')v=v.split(/[,，\s]+/).filter(Boolean);if(!Array.isArray(v)||v.length>3)throw Error(`${name} 最多 3 个尺寸。`);return [...new Set(v.map(x=>number(x,name,.1,500)))].sort((a,b)=>a-b);}

// Draw independent weighted ranges, then reject the entire deal on collision.
// Sequentially renormalizing each player's range after previous cards would
// produce a different joint distribution and is deliberately not used here.
function sampledChance(ranges,samples,initialSeed){
  let seed=initialSeed>>>0,attempts=0;const rng=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
  const cdfs=ranges.map(r=>{let mass=0;return r.map(c=>mass+=c.weight);}),counts=new Map(),observations=ranges.map(r=>Array(r.length).fill(0));
  const pick=p=>{const x=rng()*cdfs[p].at(-1);let lo=0,hi=cdfs[p].length-1;while(lo<hi){const m=(lo+hi)>>1;if(x<cdfs[p][m])hi=m;else lo=m+1;}return lo;};
  const masks=ranges.map(r=>r.map(c=>{let lo=0,hi=0;for(const card of c.cards)if(card<32)lo|=1<<card;else hi|=1<<(card-32);return [lo,hi];}));
  for(let accepted=0;accepted<samples;){
    if(++attempts>Math.max(100000,samples*200))throw Error('范围互相阻断过多，无法在抽样预算内生成合法发牌；请缩小范围。');
    const hands=[],ranks=[];let lo=0,hi=0,ok=true;
    for(let p=0;p<ranges.length;p++){const c=pick(p),mask=masks[p][c];if((lo&mask[0])||(hi&mask[1])){ok=false;break;}lo|=mask[0];hi|=mask[1];hands.push(c);ranks.push(ranges[p][c].rank);}
    if(!ok)continue;accepted++;hands.forEach((c,p)=>observations[p][c]++);const key=hands.join(':');if(counts.has(key))counts.get(key).count++;else counts.set(key,{hands,ranks,count:1});
  }
  return {deals:[...counts.values()].map(({count,...d})=>({...d,weight:count/samples})),metadata:{samples,seed:initialSeed,attempts,acceptanceRate:samples/attempts,uniqueDeals:counts.size,coverage:observations.map((obs,p)=>({player:p,rangeCombos:obs.length,seenCombos:obs.filter(x=>x>0).length,minimumObservations:Math.min(...obs)}))}};
}

/** All amounts are BB. pot is dead money at the start of the river, and stack is
 * the remaining stack then. Ranges are independent priors conditioned jointly on
 * no card collision. This intentionally does not model folded-card bunching. */
export function prepareRiverGame(raw){
  const preparationStarted=Date.now();
  if(!raw||typeof raw!=='object')throw Error('缺少河牌场景。');
  const board=cards(raw.board,[5]),pot=number(raw.pot,'本街起始底池',.01,100000);
  const rakeModel=fixedCappedRake(raw,pot);
  if(!Array.isArray(raw.players)||raw.players.length<2||raw.players.length>6)throw Error('河牌引擎支持 2–6 名仍在底池中的玩家。');
  const players=raw.players.map((p,i)=>({id:String(p.id??`p${i}`),name:String(p.name??p.position??`玩家 ${i+1}`),position:String(p.position??''),range:String(p.range??''),stack:round(number(p.stack,`玩家 ${i+1} 筹码`,0,100000))}));
  if(new Set(players.map(p=>p.id)).size!==players.length)throw Error('玩家 id 不得重复。');
  const n=players.length,toAct=integer(raw.toAct??0,'行动玩家',0,n-1),betSizes=sizes(raw.sizes,[50,100],'下注尺寸'),raiseSizes=sizes(raw.raiseSizes,[50],'加注尺寸');
  const maxRaises=integer(raw.maxRaises??1,'加注次数上限',0,3),minBet=number(raw.minBet??1,'最小下注',.000001,10000),allIn=raw.allIn!==false;
  const iterations=integer(raw.iterations??1000,'迭代次数',1,100000),averagingDelay=integer(raw.averagingDelay??Math.min(100,Math.floor(iterations/10)),'平均策略延迟',0,iterations-1);
  const algorithm=raw.algorithm??'alternating-cfr-plus';if(!['cfr-plus','dcfr','alternating-cfr-plus'].includes(algorithm))throw Error('algorithm 只支持 cfr-plus、alternating-cfr-plus 或 dcfr。');
  const maxNodes=integer(raw.maxNodes??12000,'节点预算',10,50000),maxDeals=integer(raw.maxDeals??1000000,'发牌预算',1,2000000);
  const threads=integer(raw.threads??Math.min(12,os.availableParallelism()),'CPU 线程数',1,24);
  const ranges=players.map(p=>range(p.range,board).live.map(c=>({...c,rank:rankHand([...board,...c.cards])})));
  const priorMass=ranges.map(r=>r.reduce((s,c)=>s+c.weight,0));
  const combinations=ranges.map(r=>r.map(c=>({combo:c.label,weight:c.weight,cards:c.cards,rank:c.rank})));
  let deals=[],evaluationDeals=[],chance;const selected=Array(n),ranks=Array(n);let totalWeight=0,attempts=0;
  const mode=raw.chanceMode??'exact';if(!['exact','sampled'].includes(mode))throw Error('chanceMode 只支持 exact 或 sampled。');
  if(mode==='sampled'){
    const seed=integer(raw.seed??20260928,'随机种子',1,4294967295),samples=integer(raw.chanceSamples??50000,'训练发牌抽样数',100,500000),evaluationSamples=integer(raw.evaluationSamples??Math.min(samples,50000),'独立验证抽样数',100,500000);
    const train=sampledChance(ranges,samples,seed),holdout=sampledChance(ranges,evaluationSamples,(seed^0x9e3779b9)>>>0||1);deals=train.deals;evaluationDeals=holdout.deals;
    chance={mode:'sampled',exact:false,training:train.metadata,holdout:holdout.metadata,meaning:'Strategies are solved against the empirical training deal distribution. NashConv is exact only for that empirical game, not the complete original ranges.'};
  }else{
    const enumerate=(seat,used,weight)=>{if(seat===n){if(deals.length>=maxDeals)throw Error(`合法发牌超过 ${maxDeals.toLocaleString()} 组。请先缩小范围，当前模式不以随机抽样冒充精确求解。`);deals.push({hands:[...selected],ranks:[...ranks],weight});totalWeight+=weight;return;}for(let i=0;i<ranges[seat].length;i++){if((++attempts&16383)===0&&Date.now()-preparationStarted>30000)throw Error('精确发牌准备超过 30 秒；请缩小范围或主动选择近似抽样模式。');const c=ranges[seat][i];if(c.cards.some(k=>used.has(k)))continue;selected[seat]=i;ranks[seat]=c.rank;c.cards.forEach(k=>used.add(k));enumerate(seat+1,used,weight*(c.weight/priorMass[seat]));c.cards.forEach(k=>used.delete(k));}};
    enumerate(0,new Set(board),1);if(!deals.length)throw Error('这些范围之间没有可同时存在的合法发牌。');if(!(totalWeight>0))throw Error('范围权重的数量级差异过大，合法发牌概率发生数值下溢。');for(const d of deals)d.weight/=totalWeight;
    chance={mode:'exact',exact:true,legalDeals:deals.length,jointPriorMass:totalWeight};
  }
  const marginals=ranges.map(r=>Array(r.length).fill(0));for(const d of deals)d.hands.forEach((c,p)=>marginals[p][c]+=d.weight);chance.marginals=players.map((p,i)=>({player:i,playerId:p.id,combos:combinations[i].map((c,j)=>({combo:c.combo,probability:marginals[i][j],inputWeight:c.weight}))}));
  const nodes=[];
  const next=(st,from)=>{for(let k=1;k<=n;k++){const s=(from+k)%n;if(st.pending[s]&&!st.folded[s]&&players[s].stack-st.contrib[s]>EPS)return s;}return -1;};
  const build=(st,parent=-1,incoming=null)=>{
    if(nodes.length>=maxNodes)throw Error(`公开行动树超过 ${maxNodes.toLocaleString()} 个节点。请减少尺寸/加注次数，或在更浅筹码的场景研究。`);
    const alive=players.map((_,i)=>i).filter(i=>!st.folded[i]),able=alive.filter(i=>players[i].stack-st.contrib[i]>EPS);
    let actor=st.actor;
    if(alive.length===1||!able.length||actor<0||(able.length===1&&st.contrib[able[0]]>=st.currentBet-EPS))actor=-1;
    const index=nodes.length,node={id:`n${index}`,parentId:parent<0?null:`n${parent}`,actor,actorId:actor<0?null:players[actor].id,terminal:actor<0,pot:round(pot+st.contrib.reduce((a,b)=>a+b,0)),toCall:actor<0?0:round(Math.min(st.currentBet-st.contrib[actor],players[actor].stack-st.contrib[actor])),contributions:[...st.contrib],folded:[...st.folded],currentBet:st.currentBet,lastFullRaise:st.lastFullRaise,raises:st.raises,actions:[]};nodes.push(node);
    if(actor<0)return index;
    const remain=players[actor].stack-st.contrib[actor],call=node.toCall,maxOther=Math.max(...alive.filter(i=>i!==actor).map(i=>players[i].stack)),maxTarget=Math.min(players[actor].stack,maxOther);
    const specs=call>EPS?[{type:'fold',label:'弃牌',target:st.contrib[actor]},{type:'call',isAllIn:call>=remain-EPS,label:call>=remain-EPS?'跟注 · 全下':'跟注',target:round(st.contrib[actor]+call)}]:[{type:'check',label:'过牌',target:st.contrib[actor]}];
    const raiseOpen=st.responded[actor]<0||st.currentBet-st.responded[actor]>=st.lastFullRaise-EPS;
    const mayRaise=able.length>=2&&maxTarget>st.currentBet+EPS&&raiseOpen&&(st.currentBet<EPS||st.raises<maxRaises);
    if(mayRaise){
      const minimum=st.currentBet<EPS?minBet:st.currentBet+st.lastFullRaise;
      const targets=new Map();
      for(const pct of (st.currentBet<EPS?betSizes:raiseSizes)){
        const target=st.currentBet<EPS?node.pot*pct/100:st.currentBet+(node.pot+call)*pct/100;
        const amount=round(Math.min(maxTarget,Math.max(minimum,target)));if(amount>st.currentBet+EPS)targets.set(amount,{pct});
      }
      if(allIn)targets.set(round(maxTarget),{});
      for(const [target,detail] of [...targets].sort((a,b)=>a[0]-b[0])){
        // A sub-minimum raise is legal only when the acting player is truly all-in.
        if(target<minimum-EPS&&target<players[actor].stack-EPS)continue;
        const type=st.currentBet<EPS?'bet':'raise',isAllIn=target>=players[actor].stack-EPS;
        specs.push({type,target,isAllIn,pct:detail.pct,label:`${isAllIn?'全下':type==='bet'?'下注':'加注到'} ${target} BB`});
      }
    }
    for(const sp of specs){
      const cs={...st,contrib:[...st.contrib],folded:[...st.folded],pending:[...st.pending],responded:[...st.responded]};cs.pending[actor]=false;
      if(sp.type==='fold')cs.folded[actor]=true;
      if(sp.type==='check')cs.responded[actor]=st.currentBet;
      if(sp.type==='call'){cs.contrib[actor]=sp.target;cs.responded[actor]=st.currentBet;}
      if(sp.type==='bet'||sp.type==='raise'){
        const increment=round(sp.target-st.currentBet);cs.contrib[actor]=sp.target;cs.currentBet=sp.target;cs.responded[actor]=sp.target;
        if(increment>=st.lastFullRaise-EPS)cs.lastFullRaise=increment;
        if(sp.type==='raise')cs.raises++;
        for(const i of alive)if(i!==actor&&players[i].stack-cs.contrib[i]>EPS&&cs.contrib[i]<cs.currentBet-EPS)cs.pending[i]=true;
      }
      cs.actor=next(cs,actor);
      const action={id:sp.type==='bet'||sp.type==='raise'?`${sp.type}_${sp.target}`:sp.type,label:sp.label,type:sp.type,amount:round(sp.target-st.contrib[actor]),to:sp.target,allIn:!!sp.isAllIn};
      const child=build(cs,index,action);action.childId=`n${child}`;action.child=child;node.actions.push(action);
    }
    return index;
  };
  const start={actor:toAct,contrib:Array(n).fill(0),folded:Array(n).fill(false),pending:players.map(p=>p.stack>EPS),responded:Array(n).fill(-1),currentBet:0,lastFullRaise:minBet,raises:0};if(!start.pending[toAct])start.actor=next(start,toAct);build(start);
  const work=deals.length*nodes.length*iterations*(algorithm==='alternating-cfr-plus'?n:1);
  if(deals.length*nodes.length*n>720000000)throw Error('范围与树的联合规模超过当前精确模式的内存预算。请缩小范围或行动树。');
  if(work>number(raw.maxNodeVisits??200000000000,'节点访问预算',1000000,1000000000000))throw Error(`预计 ${Math.round(work/1e9)} 十亿次节点访问，超过单次精确研究预算。请先减少迭代/范围/尺寸。`);
  const locks=raw.locks??[];if(!Array.isArray(locks))throw Error('locks 必须是数组。');
  const preparedLocks=[];
  for(const lock of locks){const node=nodes.find(x=>x.id===lock.nodeId);if(!node||node.terminal)throw Error(`锁定节点不存在：${lock.nodeId}`);const ci=lock.combo===undefined?-1:combinations[node.actor].findIndex(x=>x.combo===cards(lock.combo,[2]).sort((a,b)=>a-b).map(c=>'23456789TJQKA'[c>>2]+'cdhs'[c%4]).join(''));if(lock.combo!==undefined&&ci<0)throw Error(`锁定组合不在节点玩家范围：${lock.combo}`);const probabilities=Array.isArray(lock.probabilities)?lock.probabilities:node.actions.map(a=>Number(lock.actions?.[a.id]??0));if(probabilities.length!==node.actions.length||probabilities.some(x=>!Number.isFinite(x)||x<0)||Math.abs(probabilities.reduce((a,b)=>a+b,0)-1)>1e-6)throw Error('锁定频率须与节点动作一一对应，且合计为 1。');preparedLocks.push({node:Number(node.id.slice(1)),combo:ci,probabilities});}
  const terminalNodes=nodes.filter(n=>n.terminal).length,strategyCells=nodes.reduce((sum,node)=>sum+(node.terminal?0:combinations[node.actor].length*node.actions.length),0),infoSets=nodes.reduce((sum,node)=>sum+(node.terminal?0:combinations[node.actor].length),0);
  if(infoSets>300000)throw Error('逐组合策略输出超过 300,000 个信息集的报告预算，请减少尺寸、加注次数或范围。');
  if(terminalNodes*Math.max(deals.length,evaluationDeals.length)*n>450000000||strategyCells>20000000)throw Error('终局矩阵超过内存预算，请缩小范围或减少尺寸。');
  return {schemaVersion:1,evaluationOnly:raw.evaluationOnly===true,pot,fixedRake:rakeModel.fixedRake,rakeModel,players,combinations,deals,evaluationDeals,chance,nodes,iterations,averagingDelay,threads,algorithm,zeroReachPruning:raw.zeroReachPruning!==false,checkEvery:integer(raw.checkEvery??Math.max(25,Math.floor(iterations/10)),'检查间隔',1,10000),accuracy:raw.accuracy===undefined?null:number(raw.accuracy,'目标 NashConv / 底池百分比',0,1000),locks:preparedLocks,maxSeconds:number(raw.maxSeconds??1200,'运行秒数上限',1,14400),input:{...raw,board:raw.board,players,toAct,sizes:betSizes,raiseSizes,maxRaises,minBet,allIn,rake:rakeModel.ratePct,rakeCap:rakeModel.cap,iterations,averagingDelay,threads,chanceMode:mode,algorithm},estimatedNodeVisits:work};
}

export async function solveRiverGame(input,{onProgress=()=>{},signal,outputFile,enginePath}={}){
  const prepared=prepareRiverGame(input);onProgress({phase:'prepared',legalDeals:prepared.deals.length,publicNodes:prepared.nodes.length,estimatedNodeVisits:prepared.estimatedNodeVisits});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pokerlab-river-')),inFile=path.join(dir,'input.json'),outFile=path.join(dir,'result.json');fs.writeFileSync(inFile,JSON.stringify(prepared));
  const exe=enginePath??path.join(ROOT,'engines','RiverLab','river-engine.exe');if(!fs.existsSync(exe))throw Error('河牌原生引擎尚未编译。请查看 engines/RiverLab/README.md。');
  try{return await new Promise((resolve,reject)=>{
    let stderr='',pending='',settled=false;const child=spawn(exe,[inFile,outFile],{windowsHide:true});onProgress({phase:'running',processId:child.pid});
    const abort=()=>child.kill();if(signal?.aborted){child.kill();reject(Error('求解已取消。'));return;}signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{child.kill();},(prepared.maxSeconds+90)*1000);
    child.stdout.on('data',chunk=>{pending+=chunk.toString();const lines=pending.split(/\r?\n/);pending=lines.pop();for(const line of lines)try{onProgress(JSON.parse(line));}catch{}});
    child.stderr.on('data',chunk=>stderr=(stderr+chunk.toString()).slice(-10000));
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    child.on('error',error=>{if(settled)return;settled=true;cleanup();reject(error);});
    child.on('close',code=>{if(settled)return;settled=true;cleanup();if(signal?.aborted)return reject(Error('求解已取消。'));if(code!==0)return reject(Error(stderr||`河牌引擎异常退出 ${code}。`));try{const result=JSON.parse(fs.readFileSync(outFile,'utf8'));result.input=prepared.input;if(outputFile){fs.mkdirSync(path.dirname(outputFile),{recursive:true});fs.writeFileSync(outputFile,JSON.stringify(result));}resolve(result);}catch(error){reject(error);}});
  });}finally{fs.rmSync(dir,{recursive:true,force:true});}
}

export function riverNode(result,id='n0'){const n=result.nodes.find(x=>x.id===id);if(!n)throw Error('节点不存在。');return n;}
