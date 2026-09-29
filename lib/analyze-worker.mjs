import {parentPort,workerData} from 'node:worker_threads';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validState,cards,range,composition,cpuEquity,explain} from './poker.mjs';
try{
  const s=workerData.state,v=validState(s),tasks=[{a:v.oop.live,b:v.ip.live,board:v.board,samples:Math.min(3000000,Math.max(10000,Number(s.samples)||300000)),seed:20260928}];
  let heroOpponent=null;
  if(v.hero.length){heroOpponent=range(s.heroSeat==='oop'?s.ip:s.oop,[...v.board,...v.hero]);tasks.push({...tasks[0],a:[{cards:v.hero,weight:1}],b:heroOpponent.live,seed:20260929});}
  let results,warning=null;
  if(v.board.length<5&&s.engine!=='cpu'){
    const p=spawnSync(workerData.python,[fileURLToPath(new URL('./gpu.py',import.meta.url))],{input:JSON.stringify({tasks}),encoding:'utf8',timeout:60000,windowsHide:true,maxBuffer:4*1024*1024});
    try{const data=JSON.parse(p.stdout);if(p.status!==0||data.error)throw Error(data.error||p.stderr||'GPU 未返回结果');results=data.results;}catch(err){warning='GPU 本次不可用，已用 CPU 重算：'+err.message;}
  }
  if(!results)results=tasks.map(t=>cpuEquity(t.a,t.b,t.board,Math.min(100000,t.samples),t.seed));
  const explanation=explain(s,v,results[0],results[1]);
  if(heroOpponent){const before=s.heroSeat==='oop'?v.ip:v.oop;const changes=Object.entries(before.groups).map(([h,g])=>({hand:h,removed:g.weighted-(heroOpponent.groups[h]?.weighted??0)})).filter(x=>x.removed>1e-9).sort((a,b)=>b.removed-a.removed);explanation.lines.splice(3,0,{title:'具体阻断了哪些组合',body:`聚焦手牌使对手从 ${before.count} 个合法组合降至 ${heroOpponent.count} 个；加权组合减少 ${(before.weighted-heroOpponent.weighted).toFixed(2)}。主要变化：${changes.slice(0,8).map(x=>x.hand+' −'+Number(x.removed.toFixed(2))).join('，')||'无'}。阻断好坏取决于这些牌在对手行动线中属于价值、诈唬还是放弃部分。`});}
  parentPort.postMessage({ok:true,result:{state:s,oop:v.oop,ip:v.ip,heroOpponent,equity:results[0],heroEquity:results[1]??null,composition:{oop:composition(v.oop,v.board),ip:composition(v.ip,v.board)},explanation,warning,createdAt:new Date().toISOString()}});
}catch(e){parentPort.postMessage({ok:false,error:e.message});}
