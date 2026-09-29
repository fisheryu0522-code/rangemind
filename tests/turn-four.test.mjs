import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {prepareTurnGame,solveTurnGame} from '../lib/turn-engine.mjs';
import {cards} from '../lib/poker.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),exe=path.join(root,'engines/TurnLab/turn-engine.exe');
const close=(a,b,t=1e-8)=>assert.ok(Math.abs(a-b)<=t,`${a} != ${b}`);
const sample={board:'Ks7h2h9c',pot:20,players:['AcKd,AhQh,7c7d','KcQd,QhJh,9h9s','AdKh,AhJh,2c2d','KdQc,JhTh,7d7s'].map((range,i)=>({id:`p${i}`,range,stack:[12,18,25,30][i]})),sizes:[50],raiseSizes:[50],maxRaises:1,riverSizes:[50],riverRaiseSizes:[50],riverMaxRaises:0,allIn:false,iterations:100,accuracy:.5,maxNodes:50000};
function native(g){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'turn-four-test-'));try{const input=path.join(dir,'in.json'),output=path.join(dir,'out.json');fs.writeFileSync(input,JSON.stringify(g));execFileSync(exe,[input,output],{windowsHide:true,maxBuffer:1000000});return JSON.parse(fs.readFileSync(output));}finally{fs.rmSync(dir,{recursive:true,force:true});}}
function payoff(n,d,pot){const out=n.contributions.map(x=>-x),alive=n.folded.map((f,p)=>f?-1:p).filter(p=>p>=0);const award=(amount,people)=>{const best=Math.max(...people.map(p=>d.ranks[p])),win=people.filter(p=>d.ranks[p]===best);for(const p of win)out[p]+=amount/win.length;};award(pot,alive);let old=0;for(const level of [...new Set(n.contributions)].sort((a,b)=>a-b)){const contributors=n.contributions.map((x,p)=>x>=level?p:-1).filter(p=>p>=0),money=(level-old)*contributors.length;if(contributors.length===1)out[contributors[0]]+=money;else if(money)award(money,contributors.filter(p=>!n.folded[p]));old=level;}return out;}
function value(r,g,d,id='n0',target=-1,override=null){const n=r.nodes[Number(id.slice(1))];if(n.terminal)return payoff(n,d,g.pot-(g.fixedRake??0));if(n.chance)return value(r,g,d,n.actions.find(a=>a.card===d.river).childId,target,override);const forced=n.actor===target?override?.get(`${id}:${d.hands[target]}`):undefined;if(forced!==undefined)return value(r,g,d,n.actions[forced].childId,target,override);const v=g.players.map(()=>0),prob=n.combos[d.hands[n.actor]].probabilities;for(let a=0;a<n.actions.length;a++)value(r,g,d,n.actions[a].childId,target,override).forEach((x,p)=>v[p]+=prob[a]*x);return v;}

test('four-player exact chance contains all forty unblocked rivers and complete turn raises and river betting',()=>{
  const g=prepareTurnGame(sample);assert.equal(g.chance.holeDeals,36);assert.equal(g.deals.length,36*40);close(g.deals.reduce((s,d)=>s+d.weight,0),1);assert.equal(g.nodes.length,47748);assert.ok(g.nodes.some(n=>n.street==='turn'&&n.actions.some(a=>a.type==='raise')));assert.ok(g.nodes.some(n=>n.street==='river'&&n.actions.some(a=>a.type==='bet')));assert.ok(g.estimatedMemoryBytes<30000000);
  for(const d of g.deals){const all=[...cards(sample.board),d.river,...d.hands.flatMap((c,p)=>g.combinations[p][c].cards)];assert.equal(new Set(all).size,all.length);}
  assert.throws(()=>prepareTurnGame({...sample,players:[...sample.players,{range:'AcAd',stack:20}]}),/2–4/);
});

test('four-player unequal all-ins, dead main pot, multiple side pots, ties and refunds conserve chips',()=>{
  const g=prepareTurnGame({...sample,iterations:1});for(const [ranks,folded,expected] of [[[1,2,3,4],[false,false,false,false],[-20,0,5,35]],[[1,4,3,4],[false,false,false,false],[-20,35,-10,15]],[[1,2,3,4],[false,false,true,false],[-20,15,-10,35]]]){const h={...g,nodes:[{id:'n0',parentId:null,actor:-1,terminal:true,chance:false,contributions:[30,20,10,5],folded,actions:[]}],deals:[{hands:[0,0,0,0],ranks,river:0,weight:1}]},r=native(h);r.diagnostics.profileEV.forEach((v,p)=>close(v,expected[p]));close(r.diagnostics.profileEV.reduce((a,b)=>a+b,0),20);close(r.diagnostics.nashConv,0);}
});

test('four-player full two-street profile and selected information-set action EV match an independent path evaluator',async()=>{
  const g=prepareTurnGame(sample),r=await solveTurnGame(sample,{enginePath:exe}),expected=sample.players.map(()=>0);for(const d of g.deals)value(r,g,d).forEach((v,p)=>expected[p]+=d.weight*v);expected.forEach((v,p)=>close(v,r.diagnostics.profileEV[p]));close(expected.reduce((a,b)=>a+b,0),20);
  const selected=[r.nodes[0],...sample.players.map((_,p)=>r.nodes.find(n=>n.actor===p&&n.street==='river'&&n.reach>1e-8)).filter(Boolean)];
  for(const n of selected){const p=n.actor,denom=Array(g.combinations[p].length).fill(0),totals=denom.map(()=>n.actions.map(()=>0));for(const d of g.deals){let w=d.weight,child=n;while(child.parentId!==null&&w){const parent=r.nodes[Number(child.parentId.slice(1))],a=parent.actions.findIndex(a=>a.childId===child.id);if(parent.chance){if(parent.actions[a].card!==d.river)w=0;}else if(parent.actor!==p)w*=parent.combos[d.hands[parent.actor]].probabilities[a];child=parent;}if(!w)continue;const c=d.hands[p];denom[c]+=w;for(let a=0;a<n.actions.length;a++)totals[c][a]+=w*(value(r,g,d,n.actions[a].childId)[p]+n.contributions[p]);}for(let c=0;c<denom.length;c++)if(denom[c])totals[c].forEach((v,a)=>close(v/denom[c],n.combos[c].actionEV[a]));}
});

test('four-player information-set BR agrees with exhaustive pure policies while hiding future river and opponent cards',()=>{
  const g=prepareTurnGame({board:'2c4d6h8s',pot:2,players:['AcAd,9c9d','KcKd','QcQd','JcJd'].map((range,i)=>({id:`p${i}`,range,stack:1})),sizes:[50],riverSizes:[50],allIn:false,maxRaises:0,riverMaxRaises:0,iterations:300,maxNodes:50000});
  const rivers=cards('KhQh');g.deals=g.deals.filter(d=>rivers.includes(d.river));const mass=g.deals.reduce((s,d)=>s+d.weight,0);g.deals.forEach(d=>d.weight/=mass);
  // A legal smaller action abstraction keeps exhaustive pure policies tractable:
  // only seat 0 may open a bet, all other seats retain check / fold / call.
  const old=g.nodes,nodes=[];function copy(index,parentId=null){const source=old[index],id=nodes.length,node={...source,id:`n${id}`,parentId,actions:[]};nodes.push(node);for(const a of source.actions)if((!source.chance||rivers.includes(a.card))&&(a.type!=='bet'||source.actor===0)){const child=copy(a.child,node.id);node.actions.push({...a,child,childId:`n${child}`});}return id;}copy(0);g.nodes=nodes;const r=native(g);
  for(let p=0;p<4;p++){const sets=r.nodes.filter(n=>n.actor===p&&n.actions.length>1).flatMap(n=>n.combos.map((_,c)=>[`${n.id}:${c}`,n.actions.length])),count=sets.reduce((n,x)=>n*x[1],1);assert.ok(count<=65536,`Exhaustive count ${count}`);const policy=new Map();let best=-Infinity;function enumerate(i){if(i===sets.length){best=Math.max(best,g.deals.reduce((s,d)=>s+d.weight*value(r,g,d,'n0',p,policy)[p],0));return;}const [key,count]=sets[i];for(let a=0;a<count;a++){policy.set(key,a);enumerate(i+1);}}enumerate(0);close(best,r.diagnostics.bestResponseEV[p],1e-10);}
});
