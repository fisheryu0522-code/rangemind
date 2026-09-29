import {cards,range,rankHand,cpuEquity} from '../lib/poker.mjs';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
const python=(process.env.POKERLAB_PYTHON||'python');
let seed=789123;const rnd=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return(seed>>>0)/4294967296;};
const rows=Array.from({length:10000},()=>{const a=[];while(a.length<7){const c=Math.floor(rnd()*52);if(!a.includes(c))a.push(c);}return a;});
function gpu(input){const p=spawnSync(python,['lib/gpu.py'],{input:JSON.stringify(input),encoding:'utf8',maxBuffer:10000000,timeout:60000});if(p.status!==0)throw Error(p.stdout+p.stderr);return JSON.parse(p.stdout);}
const gr=gpu({ranks:rows}).ranks;const mismatches=rows.filter((r,i)=>rankHand(r)!==gr[i]);if(mismatches.length)throw Error(mismatches.length+' rank mismatches');
// Independent seven-card verification by enumerating all 21 five-card subsets.
for(const r of rows.slice(0,1000)){let best=0;for(let a=0;a<7;a++)for(let b=a+1;b<7;b++)best=Math.max(best,rankHand(r.filter((_,i)=>i!==a&&i!==b)));if(best!==rankHand(r))throw Error('5-card subset mismatch');}
const board=cards('Qs Jh 2h 9c 3s'),a=range('AA,KK,QQ,JJ,TT,99,AKs,AQs,KQs,QJs',board).live,b=range('QQ-22,AQs-A2s,KQs,QJs,JTs,AhKh:0.25',board).live;
const exact=cpuEquity(a,b,board),sim=gpu({tasks:[{a,b,board,samples:3000000,seed:338791}]}).results[0];console.log({exact,sim});if(Math.abs(sim.equity-exact.equity)>.002)throw Error('Monte Carlo crosscheck failed');
const flop=cards('Qs Jh 2h'),fa=range('22+,ATs+,AJo+,KTs+,QJs,JTs',flop).live,fb=range('QQ-22,A2s+,ATo+,K9s+,QTs+,JTs,T9s,98s',flop).live;
const g=gpu({tasks:[{a:fa,b:fb,board:flop,samples:3000000,seed:20260928}]}).results[0],cpu=cpuEquity(fa,fb,flop,100000,55678);if(Math.abs(g.equity-cpu.equity)>.008)throw Error('CPU/GPU flop sampling mismatch');
const report={date:new Date().toISOString(),rankCrosschecks:10000,subsetChecks:1000,riverExact:exact,riverGPU:sim,riverDifference:sim.equity-exact.equity,flopGPU:g,flopCPU:cpu};fs.writeFileSync('validation.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
