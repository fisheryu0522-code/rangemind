import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {cards,range,rankHand,cardText} from './poker.mjs';

import {fixedCappedRake} from './river-rake.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),EPS=1e-8;
const round=x=>Math.round(x*1e6)/1e6;
const number=(v,name,lo,hi)=>{const n=Number(v);if(!Number.isFinite(n)||n<lo||n>hi)throw Error(`${name} 必须在 ${lo}–${hi} 之间。`);return n;};
const integer=(v,name,lo,hi)=>{const n=number(v,name,lo,hi);if(!Number.isInteger(n))throw Error(`${name} 必须是整数。`);return n;};
function sizes(v,fallback,name){if(v===undefined)v=fallback;if(typeof v==='string')v=v.split(/[,，\s]+/).filter(Boolean);if(!Array.isArray(v)||v.length>2)throw Error(`${name} 最多 2 个尺寸。`);return [...new Set(v.map(x=>number(x,name,.1,500)))].sort((a,b)=>a-b);}

/** Genuine two-street imperfect-information model. The future river card is
 * sampled by root chance in the mathematical representation, hidden during all
 * turn decisions, and disclosed only at a public chance node. */
export function prepareTurnGame(raw){
  const started=Date.now();if(!raw||typeof raw!=='object')throw Error('缺少转牌场景。');
  const board=cards(raw.board,[4]),pot=number(raw.pot,'转牌起始底池',.01,100000);
  const rakeModel=fixedCappedRake(raw,pot);
  if(raw.chanceMode&&raw.chanceMode!=='exact')throw Error('转牌→河牌首版只提供完整机会枚举，不支持近似chance模式。');
  if(!Array.isArray(raw.players)||raw.players.length<2||raw.players.length>4)throw Error('转牌→河牌引擎当前支持 2–4 人受控范围完整博弈；更多人数会明确拒绝。');
  const players=raw.players.map((p,i)=>({id:String(p.id??`p${i}`),name:String(p.name??p.position??`玩家 ${i+1}`),position:String(p.position??''),range:String(p.range??''),stack:round(number(p.stack,`玩家 ${i+1} 筹码`,0,100000))}));
  if(new Set(players.map(p=>p.id)).size!==players.length)throw Error('玩家 id 不得重复。');
  const n=players.length,toAct=integer(raw.toAct??0,'转牌行动玩家',0,n-1),riverToAct=integer(raw.riverToAct??toAct,'河牌第一位行动玩家',0,n-1);
  const betSizes=sizes(raw.sizes,[50],'转牌下注尺寸'),raiseSizes=sizes(raw.raiseSizes,[50],'转牌加注尺寸'),riverSizes=sizes(raw.riverSizes,[50],'河牌下注尺寸'),riverRaiseSizes=sizes(raw.riverRaiseSizes,[50],'河牌加注尺寸');
  const maxRaises=integer(raw.maxRaises??0,'转牌加注次数上限',0,2),riverMaxRaises=integer(raw.riverMaxRaises??0,'河牌加注次数上限',0,2),minBet=number(raw.minBet??1,'最小下注',.000001,10000),allIn=raw.allIn!==false;
  const iterations=integer(raw.iterations??1000,'迭代次数',1,1000000),averagingDelay=integer(raw.averagingDelay??Math.min(100,Math.floor(iterations/10)),'平均策略延迟',0,iterations-1),threads=integer(raw.threads??Math.min(12,os.availableParallelism()),'CPU 线程数',1,24);
  const algorithm=raw.algorithm??'alternating-cfr-plus';if(!['cfr-plus','dcfr','alternating-cfr-plus'].includes(algorithm))throw Error('algorithm 只支持 cfr-plus、alternating-cfr-plus 或 dcfr。');
  const maxNodes=integer(raw.maxNodes??20000,'节点预算',10,50000),maxDeals=integer(raw.maxDeals??1000000,'联合发牌预算',1,3000000);
  const ranges=players.map(p=>range(p.range,board).live),priorMass=ranges.map(r=>r.reduce((s,c)=>s+c.weight,0)),combinations=ranges.map(r=>r.map(c=>({combo:c.label,weight:c.weight,cards:c.cards})));
  const deals=[],selected=Array(n),rankCache=ranges.map(r=>r.map(()=>new Map())),possibleRivers=new Set();let totalWeight=0,holeDeals=0,attempts=0;
  const enumerate=(seat,used,weight)=>{
    if(seat===n){holeDeals++;const available=52-used.size;for(let river=0;river<52;river++)if(!used.has(river)){
      if(deals.length>=maxDeals)throw Error(`转牌联合手牌＋河牌发牌超过 ${maxDeals.toLocaleString()} 组；请缩小范围。`);
      const ranks=selected.map((c,p)=>{const cache=rankCache[p][c];if(!cache.has(river))cache.set(river,rankHand([...board,river,...ranges[p][c].cards]));return cache.get(river);});
      deals.push({hands:[...selected],ranks,river,weight:weight/available});totalWeight+=weight/available;possibleRivers.add(river);
    }return;}
    for(let c=0;c<ranges[seat].length;c++){if((++attempts&16383)===0&&Date.now()-started>30000)throw Error('转牌机会枚举准备超过 30 秒，请缩小范围。');const hand=ranges[seat][c];if(hand.cards.some(k=>used.has(k)))continue;selected[seat]=c;hand.cards.forEach(k=>used.add(k));enumerate(seat+1,used,weight*hand.weight/priorMass[seat]);hand.cards.forEach(k=>used.delete(k));}
  };
  enumerate(0,new Set(board),1);if(!deals.length)throw Error('范围之间没有可同时出现的合法发牌。');if(!(totalWeight>0))throw Error('范围权重发生数值下溢。');for(const d of deals)d.weight/=totalWeight;
  const marginalWeights=ranges.map(r=>Array(r.length).fill(0));for(const d of deals)d.hands.forEach((c,p)=>marginalWeights[p][c]+=d.weight);const marginals=players.map((p,i)=>({player:i,playerId:p.id,combos:combinations[i].map((c,j)=>({combo:c.combo,probability:marginalWeights[i][j],inputWeight:c.weight}))}));
  const nodes=[],riverCards=[...possibleRivers].sort((a,b)=>a-b);
  const next=(st,from)=>{for(let k=1;k<=n;k++){const p=(from+k)%n;if(st.pending[p]&&!st.folded[p]&&players[p].stack-st.contrib[p]>EPS)return p;}return -1;};
  const first=(st,from)=>{for(let k=0;k<n;k++){const p=(from+k)%n;if(!st.folded[p]&&players[p].stack-st.contrib[p]>EPS)return p;}return -1;};
  const build=(st,parent=-1)=>{
    if(nodes.length>=maxNodes)throw Error(`两街公开树超过 ${maxNodes.toLocaleString()} 节点。请减少尺寸/加注上限，或缩小筹码深度。`);
    const alive=players.map((_,i)=>i).filter(i=>!st.folded[i]),able=alive.filter(i=>players[i].stack-st.contrib[i]>EPS);
    let actor=st.actor,dealRiver=false;
    if(alive.length===1||!able.length||(able.length===1&&st.street[able[0]]>=st.currentBet-EPS))actor=-1;
    else if(actor<0){if(st.round==='turn'){actor=-2;dealRiver=true;}else actor=-1;}
    const id=nodes.length,node={id:`n${id}`,parentId:parent<0?null:`n${parent}`,actor,actorId:actor<0?null:players[actor].id,terminal:actor===-1,chance:actor===-2,street:st.round,riverCard:st.river,board:[...board,...(st.river===null?[]:[st.river])].map(cardText).join(''),pot:round(pot+st.contrib.reduce((a,b)=>a+b,0)),toCall:actor<0?0:round(Math.min(st.currentBet-st.street[actor],players[actor].stack-st.contrib[actor])),contributions:[...st.contrib],streetContributions:[...st.street],folded:[...st.folded],currentBet:st.currentBet,lastFullRaise:st.lastFullRaise,raises:st.raises,actions:[]};nodes.push(node);
    if(actor===-1)return id;
    if(dealRiver){
      for(const card of riverCards){const cs={...st,round:'river',river:card,street:Array(n).fill(0),pending:players.map((p,i)=>!st.folded[i]&&p.stack-st.contrib[i]>EPS),responded:Array(n).fill(-1),currentBet:0,lastFullRaise:minBet,raises:0};cs.actor=first(cs,riverToAct);const child=build(cs,id);node.actions.push({id:`river_${cardText(card)}`,label:cardText(card),type:'deal',card,amount:0,to:0,child,childId:`n${child}`});}return id;
    }
    const remain=players[actor].stack-st.contrib[actor],call=node.toCall,maxOther=Math.max(...alive.filter(i=>i!==actor).map(i=>st.street[i]+players[i].stack-st.contrib[i])),maxTarget=Math.min(st.street[actor]+remain,maxOther);
    const specs=call>EPS?[{type:'fold',label:'弃牌',target:st.street[actor]},{type:'call',isAllIn:call>=remain-EPS,label:call>=remain-EPS?'跟注 · 全下':'跟注',target:round(st.street[actor]+call)}]:[{type:'check',label:'过牌',target:st.street[actor]}];
    const canRaise=st.responded[actor]<0||st.currentBet-st.responded[actor]>=st.lastFullRaise-EPS,raiseCap=st.round==='turn'?maxRaises:riverMaxRaises;
    if(able.length>=2&&maxTarget>st.currentBet+EPS&&canRaise&&(st.currentBet<EPS||st.raises<raiseCap)){
      const minimum=st.currentBet<EPS?minBet:st.currentBet+st.lastFullRaise,targets=new Set(),bets=st.round==='turn'?betSizes:riverSizes,raises=st.round==='turn'?raiseSizes:riverRaiseSizes;
      for(const pct of(st.currentBet<EPS?bets:raises)){const target=st.currentBet<EPS?node.pot*pct/100:st.currentBet+(node.pot+call)*pct/100;const amount=round(Math.min(maxTarget,Math.max(minimum,target)));if(amount>st.currentBet+EPS)targets.add(amount);}if(allIn)targets.add(round(maxTarget));
      for(const target of [...targets].sort((a,b)=>a-b)){if(target<minimum-EPS&&target<st.street[actor]+remain-EPS)continue;const type=st.currentBet<EPS?'bet':'raise',isAllIn=target>=st.street[actor]+remain-EPS;specs.push({type,target,isAllIn,label:`${isAllIn?'全下':type==='bet'?'下注':'加注到'} ${target} BB`});}
    }
    for(const sp of specs){
      const cs={...st,contrib:[...st.contrib],street:[...st.street],folded:[...st.folded],pending:[...st.pending],responded:[...st.responded]};cs.pending[actor]=false;
      if(sp.type==='fold')cs.folded[actor]=true;if(sp.type==='check')cs.responded[actor]=st.currentBet;
      if(sp.type==='call'){cs.contrib[actor]=round(cs.contrib[actor]+sp.target-st.street[actor]);cs.street[actor]=sp.target;cs.responded[actor]=st.currentBet;}
      if(sp.type==='bet'||sp.type==='raise'){
        const inc=round(sp.target-st.currentBet);cs.contrib[actor]=round(cs.contrib[actor]+sp.target-st.street[actor]);cs.street[actor]=sp.target;cs.currentBet=sp.target;cs.responded[actor]=sp.target;if(inc>=st.lastFullRaise-EPS)cs.lastFullRaise=inc;if(sp.type==='raise')cs.raises++;
        for(const p of alive)if(p!==actor&&players[p].stack-cs.contrib[p]>EPS&&cs.street[p]<cs.currentBet-EPS)cs.pending[p]=true;
      }
      cs.actor=next(cs,actor);const action={id:sp.type==='bet'||sp.type==='raise'?`${sp.type}_${sp.target}`:sp.type,label:sp.label,type:sp.type,amount:round(sp.target-st.street[actor]),to:sp.target,allIn:!!sp.isAllIn};const child=build(cs,id);action.child=child;action.childId=`n${child}`;node.actions.push(action);
    }
    return id;
  };
  const st={round:'turn',river:null,actor:toAct,contrib:Array(n).fill(0),street:Array(n).fill(0),folded:Array(n).fill(false),pending:players.map(p=>p.stack>EPS),responded:Array(n).fill(-1),currentBet:0,lastFullRaise:minBet,raises:0};if(!st.pending[toAct])st.actor=first(st,toAct);build(st);
  const terminalNodes=nodes.filter(n=>n.terminal).length,infoSets=nodes.reduce((s,node)=>s+(node.actor>=0?combinations[node.actor].length:0),0),strategyCells=nodes.reduce((s,node)=>s+(node.actor>=0?combinations[node.actor].length*node.actions.length:0),0),riverDealCounts=Array(52).fill(0);deals.forEach(d=>riverDealCounts[d.river]++);
  const nodeDeals=node=>node.riverCard===null?deals.length:riverDealCounts[node.riverCard],payoffCells=nodes.reduce((s,node)=>s+(node.terminal?(node.folded.filter(x=>!x).length===1?1:nodeDeals(node)):0),0),visitsPerIteration=nodes.reduce((s,node)=>s+nodeDeals(node),0);
  if(payoffCells*n>600000000||infoSets>300000)throw Error('两街精确树超过当前压缩内存/逐组合报告预算；请缩小范围或尺寸树。');
  const work=visitsPerIteration*iterations*(algorithm==='alternating-cfr-plus'?n:1);if(work>number(raw.maxNodeVisits??200000000000,'节点访问预算',1000000,1000000000000))throw Error('两街精确计算超过访问预算；请减少迭代、范围或下注尺寸。');
  const locks=[];for(const lock of(raw.locks??[])){const node=nodes.find(n=>n.id===lock.nodeId);if(!node||node.actor<0)throw Error('只能锁定真实玩家决策节点。');const combo=lock.combo===undefined?-1:combinations[node.actor].findIndex(c=>c.combo===cards(lock.combo,[2]).sort((a,b)=>a-b).map(cardText).join(''));if(lock.combo!==undefined&&combo<0)throw Error('锁定组合不在范围中。');const probabilities=Array.isArray(lock.probabilities)?lock.probabilities:node.actions.map(a=>Number(lock.actions?.[a.id]??0));if(probabilities.length!==node.actions.length||probabilities.some(x=>!Number.isFinite(x)||x<0)||Math.abs(probabilities.reduce((a,b)=>a+b,0)-1)>1e-6)throw Error('锁定概率必须匹配动作并合计为 1。');locks.push({node:Number(node.id.slice(1)),combo,probabilities});}
  return {schemaVersion:1,evaluationOnly:raw.evaluationOnly===true,pot,fixedRake:rakeModel.fixedRake,rakeModel,players,combinations,deals,evaluationDeals:[],chance:{mode:'exact',exact:true,holeDeals,legalDeals:deals.length,publicRiverCards:riverCards.length,marginals,meaning:'Future river is hidden at turn information sets and disclosed only at public chance nodes.'},nodes,iterations,averagingDelay,threads,algorithm,zeroReachPruning:raw.zeroReachPruning!==false,locks,maxSeconds:number(raw.maxSeconds??1200,'运行秒数上限',1,14400),checkEvery:integer(raw.checkEvery??Math.max(25,Math.floor(iterations/10)),'检查间隔',1,10000),accuracy:raw.accuracy===undefined?null:number(raw.accuracy,'目标 NashConv / 初始底池百分比',0,1000),input:{...raw,players,toAct,riverToAct,sizes:betSizes,raiseSizes,riverSizes,riverRaiseSizes,maxRaises,riverMaxRaises,minBet,allIn,iterations,averagingDelay,threads,rake:rakeModel.ratePct,rakeCap:rakeModel.cap,chanceMode:'exact',algorithm},estimatedNodeVisits:work,estimatedMemoryBytes:payoffCells*n*8,payoffCells};
}

export async function solveTurnGame(input,{onProgress=()=>{},signal,outputFile,enginePath}={}){
  const prepared=prepareTurnGame(input);onProgress({phase:'prepared',legalDeals:prepared.deals.length,holeDeals:prepared.chance.holeDeals,publicNodes:prepared.nodes.length,estimatedNodeVisits:prepared.estimatedNodeVisits});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pokerlab-turn-')),inFile=path.join(dir,'input.json'),outFile=path.join(dir,'result.json'),exe=enginePath??path.join(ROOT,'engines/TurnLab/turn-engine.exe');fs.writeFileSync(inFile,JSON.stringify(prepared));
  try{return await new Promise((resolve,reject)=>{
    let stderr='',pending='',settled=false;const child=spawn(exe,[inFile,outFile],{windowsHide:true});onProgress({phase:'running',processId:child.pid});
    const abort=()=>child.kill();if(signal?.aborted){child.kill();reject(Error('求解已取消。'));return;}signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(()=>child.kill(),(prepared.maxSeconds+120)*1000);
    const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
    child.stdout.on('data',chunk=>{pending+=chunk.toString();const lines=pending.split(/\r?\n/);pending=lines.pop();for(const line of lines)try{onProgress(JSON.parse(line));}catch{}});child.stderr.on('data',chunk=>stderr=(stderr+chunk.toString()).slice(-10000));
    child.on('error',error=>{if(settled)return;settled=true;cleanup();reject(error);});child.on('close',code=>{if(settled)return;settled=true;cleanup();if(signal?.aborted)return reject(Error('求解已取消。'));if(code!==0)return reject(Error(stderr||`转牌求解器退出 ${code}。`));try{const result=JSON.parse(fs.readFileSync(outFile));result.input=prepared.input;if(outputFile){fs.mkdirSync(path.dirname(outputFile),{recursive:true});fs.writeFileSync(outputFile,JSON.stringify(result));}resolve(result);}catch(error){reject(error);}});
  });}finally{fs.rmSync(dir,{recursive:true,force:true});}
}

