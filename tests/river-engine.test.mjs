import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {prepareRiverGame,solveRiverGame} from '../lib/river-engine.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const close=(actual,expected,eps=1e-8)=>assert.ok(Math.abs(actual-expected)<=eps,`${actual} != ${expected} (tolerance ${eps})`);
const simple={board:'2c4d6h8sTc',pot:20,players:[{id:'a',range:'AcAd',stack:30},{id:'b',range:'KcKd',stack:20},{id:'c',range:'QcQd',stack:10}],sizes:[50],raiseSizes:[50],maxRaises:1,iterations:1000};
function native(prepared){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'river-test-'));try{const input=path.join(dir,'in.json'),output=path.join(dir,'out.json');fs.writeFileSync(input,JSON.stringify(prepared));execFileSync(path.join(root,'engines/RiverLab/river-engine.exe'),[input,output],{windowsHide:true,maxBuffer:1000000});return JSON.parse(fs.readFileSync(output));}finally{fs.rmSync(dir,{recursive:true,force:true});}}
function child(game,id,type){const node=game.nodes[Number(id.slice(1))];const a=node.actions.find(a=>a.id===type||a.type===type);assert.ok(a,`Missing ${type} at ${id}`);return game.nodes[Number(a.childId.slice(1))];}

// Independent terminal evaluator: award whole main/side pots from sorted
// contribution thresholds, with exact fractions and unconditional sunk costs.
function payoff(node,deal,pot){
  const n=deal.hands.length,out=node.contributions.map(c=>-c),eligible=node.folded.map((f,i)=>f?-1:i).filter(i=>i>=0);
  function award(money,people){let max=Math.max(...people.map(p=>deal.ranks[p])),winners=people.filter(p=>deal.ranks[p]===max);for(const p of winners)out[p]+=money/winners.length;}
  award(pot,eligible);
  let old=0;for(const level of [...new Set(node.contributions)].sort((a,b)=>a-b)){const people=Array.from({length:n},(_,i)=>i).filter(i=>node.contributions[i]>=level);const amount=(level-old)*people.length;if(people.length===1)out[people[0]]+=amount;else if(amount)award(amount,people.filter(i=>!node.folded[i]));old=level;}
  return out;
}
function evForDeal(result,game,deal,player,override=new Map(),id='n0'){
  const node=result.nodes[Number(id.slice(1))];if(node.terminal)return payoff(node,deal,game.pot-(game.fixedRake??0))[player];
  const key=`${id}:${deal.hands[node.actor]}`,forced=node.actor===player?override.get(key):undefined;
  if(forced!==undefined)return evForDeal(result,game,deal,player,override,node.actions[forced].childId);
  const probabilities=node.combos[deal.hands[node.actor]].probabilities;
  return node.actions.reduce((sum,a,i)=>sum+probabilities[i]*evForDeal(result,game,deal,player,override,a.childId),0);
}
function bruteBR(result,game,player){
  const infosets=[];for(const node of result.nodes)if(node.actor===player)for(let c=0;c<game.combinations[player].length;c++)infosets.push([`${node.id}:${c}`,node.actions.length]);
  const count=infosets.reduce((m,x)=>m*x[1],1);assert.ok(count<=100000,`Brute force budget ${count}`);let max=-Infinity;const policy=new Map();
  function visit(i){if(i===infosets.length){let ev=0;for(const d of game.deals)ev+=d.weight*evForDeal(result,game,d,player,policy);max=Math.max(max,ev);return;}for(let a=0;a<infosets[i][1];a++){policy.set(infosets[i][0],a);visit(i+1);}}visit(0);return max;
}
function kuhn(iterations=30000){
  const g=prepareRiverGame({...simple,algorithm:'cfr-plus',pot:2,players:simple.players.slice(0,2).map(p=>({...p,stack:1})),sizes:[50],allIn:false,maxRaises:0,iterations,averagingDelay:Math.floor(iterations/10),checkEvery:10000});
  g.combinations=Array.from({length:2},()=>['J','Q','K'].map(combo=>({combo,weight:1})));
  g.deals=[];for(let a=0;a<3;a++)for(let b=0;b<3;b++)if(a!==b)g.deals.push({hands:[a,b],ranks:[a+1,b+1],weight:1/6});
  return g;
}

test('joint chance excludes every collision and renormalizes range weights',()=>{
  const p=prepareRiverGame({...simple,players:[{range:'AcAd:0.5,AcKd:1',stack:10},{range:'KcKd:0.25,AcQd:1',stack:10}]});
  assert.equal(p.deals.length,1);assert.deepEqual(p.deals[0].hands,[0,0]);close(p.deals[0].weight,1);
  assert.throws(()=>prepareRiverGame({...simple,players:[{range:'AcAd',stack:10},{range:'AcKd',stack:10}]}),/没有可同时/);
});
test('action tree includes bet, raise, re-raise, all-in, fold/call/check',()=>{
  const p=prepareRiverGame({...simple,players:simple.players.map(p=>({...p,stack:300})),maxRaises:2,allIn:true});
  let n=child(p,'n0','bet');assert.equal(n.toCall,10);n=child(p,n.id,'raise');assert.ok(n.actions.some(a=>a.type==='raise'));const reraised=child(p,n.id,'raise');assert.equal(reraised.raises,2);assert.ok(reraised.actions.every(a=>a.type!=='raise'));
  const kinds=new Set(p.nodes.flatMap(n=>n.actions.map(a=>a.type)));for(const kind of ['check','bet','raise','fold','call'])assert.ok(kinds.has(kind));
});
test('short all-in does not reopen earlier caller, but a full raise does',()=>{
  const p=prepareRiverGame({...simple,players:[{...simple.players[0],stack:100},{...simple.players[1],stack:100},{...simple.players[2],stack:15}],maxRaises:3});
  let n=child(p,'n0','bet_10');n=child(p,n.id,'call');n=child(p,n.id,'raise_15');assert.equal(n.actor,0);assert.equal(n.toCall,5);assert.ok(n.actions.every(a=>a.type!=='raise'));
  const p2=prepareRiverGame({...simple,players:simple.players.map(p=>({...p,stack:100})),maxRaises:2});let m=child(p2,'n0','bet_10');m=child(p2,m.id,'call');m=child(p2,m.id,'raise');assert.equal(m.actor,0);assert.ok(m.actions.some(a=>a.type==='raise'));
});
test('a short opening all-in does not reopen a checker; an unacted player can raise',()=>{
  const p=prepareRiverGame({...simple,minBet:10,players:[{...simple.players[0],stack:100},{...simple.players[1],stack:5},{...simple.players[2],stack:100}],maxRaises:2});
  let n=child(p,'n0','check');n=child(p,n.id,'bet_5');assert.equal(n.actor,2);assert.ok(n.actions.some(a=>a.type==='raise'));n=child(p,n.id,'call');assert.equal(n.actor,0);assert.ok(n.actions.every(a=>a.type!=='raise'));
});
test('known Kuhn equilibrium value and independently enumerated information-set best responses',()=>{
  const g=kuhn(),r=native(g);close(r.diagnostics.profileEV[0],1-1/18,0.0005);close(r.diagnostics.profileEV[1],1+1/18,0.0005);
  assert.ok(r.diagnostics.nashConv<.003);
  for(let p=0;p<2;p++)close(r.diagnostics.bestResponseEV[p],bruteBR(r,g,p),1e-10);
  const firstBet=r.nodes[0].actions.findIndex(a=>a.type==='bet');const bluff=r.nodes[0].combos[0].probabilities[firstBet],value=r.nodes[0].combos[2].probabilities[firstBet];close(value,3*bluff,.025);
});
test('best response cannot choose fold/call by seeing opponent private card',()=>{
  const g=kuhn(1);g.averagingDelay=0;g.combinations=[[{combo:'Q',weight:1}],[{combo:'J',weight:1},{combo:'K',weight:1}]];g.deals=[{hands:[0,0],ranks:[2,1],weight:.5},{hands:[0,1],ranks:[2,3],weight:.5}];
  g.nodes=[{id:'n0',actor:0,parentId:null,terminal:false,pot:3,toCall:1,contributions:[0,1],folded:[false,false],actions:[{id:'fold',type:'fold',label:'fold',child:1,childId:'n1'},{id:'call',type:'call',label:'call',child:2,childId:'n2'}]},{id:'n1',actor:-1,parentId:'n0',terminal:true,contributions:[0,1],folded:[true,false],actions:[]},{id:'n2',actor:-1,parentId:'n0',terminal:true,contributions:[1,1],folded:[false,false],actions:[]}];
  const r=native(g);close(r.diagnostics.bestResponseEV[0],1);assert.notEqual(r.diagnostics.bestResponseEV[0],1.5);close(r.nodes[0].combos[0].actionEV[0],0);close(r.nodes[0].combos[0].actionEV[1],1);
  const locked=native({...g,locks:[{node:0,combo:-1,probabilities:[.6,.4]}]});close(locked.diagnostics.profileEV[0],.4);close(locked.diagnostics.bestResponseEV[0],1);close(locked.diagnostics.constrainedBestResponseEV[0],.4);close(locked.diagnostics.constrainedGain[0],0);assert.equal(locked.diagnostics.residualForStopping,'constrainedNashConvPctPot');
});
test('three-way unequal all-in side pots, folds, ties, and chip conservation',()=>{
  const g=prepareRiverGame({...simple,iterations:1});
  // Direct terminal games isolate payoffs from strategy quality.
  for(const sample of [
    {contributions:[30,20,10],folded:[false,false,false],ranks:[1,2,3],expected:[-20,0,40]},
    {contributions:[30,20,10],folded:[false,false,false],ranks:[3,2,1],expected:[50,-20,-10]},
    {contributions:[30,20,10],folded:[false,false,false],ranks:[3,3,1],expected:[15,15,-10]},
    {contributions:[10,10,10],folded:[true,false,false],ranks:[9,2,1],expected:[-10,40,-10]},
    {contributions:[30,10,10],folded:[false,true,true],ranks:[1,9,8],expected:[40,-10,-10]},
  ]){
    const h={...g,nodes:[{id:'n0',parentId:null,actor:-1,terminal:true,actions:[],...sample}],deals:[{hands:[0,0,0],ranks:sample.ranks,weight:1}]};const r=native(h);r.diagnostics.profileEV.forEach((x,i)=>close(x,sample.expected[i]));close(r.diagnostics.profileEV.reduce((a,b)=>a+b,0),20);close(r.diagnostics.nashConv,0);
  }
});
test('reported profile EV and conditional action values match an independent evaluator',async()=>{
  const s={...simple,players:[{...simple.players[0],range:'AcAd,KhQh:0.5'},{...simple.players[1],range:'KcKd,Jh9h'},{...simple.players[2],range:'QcQd,AhJh'}],iterations:2000};
  const g=prepareRiverGame(s),r=await solveRiverGame(s);for(let p=0;p<3;p++){const ev=g.deals.reduce((sum,d)=>sum+d.weight*evForDeal(r,g,d,p),0);close(ev,r.diagnostics.profileEV[p]);}close(r.diagnostics.profileEV.reduce((a,b)=>a+b,0),s.pot);
  for(const n of r.nodes)if(!n.terminal){for(const c of n.combos){close(c.probabilities.reduce((a,b)=>a+b,0),1);if(c.ev!==null)close(c.ev,c.probabilities.reduce((v,p,i)=>v+p*c.actionEV[i],0));if(c.counterfactualReach>1e-12){const i=n.actions.findIndex(a=>a.type==='fold');if(i>=0)close(c.actionEV[i],0);}}}
  for(const n of r.nodes)if(!n.terminal&&n.reach>1e-12)close(n.profileEV,n.actions.reduce((sum,a)=>sum+(a.frequency||0)*(a.selectedEV||0),0));
});
test('node locks are exact and diagnostics disclose unrestricted BR',async()=>{
  const s={...simple,iterations:100,locks:[{nodeId:'n0',actions:{check:1}}]},r=await solveRiverGame(s);for(const c of r.nodes[0].combos)assert.deepEqual(c.probabilities,[1,0,0]);assert.equal(r.diagnostics.locksPresent,true);assert.equal(r.diagnostics.bestResponseIgnoresLocks,true);
});
test('unsupported assumptions and unsafe budgets are rejected explicitly',()=>{
  assert.throws(()=>prepareRiverGame({...simple,rake:5}),/封顶/);assert.throws(()=>prepareRiverGame({...simple,board:'AsKdQc'}));assert.throws(()=>prepareRiverGame({...simple,maxNodes:10}),/节点/);assert.throws(()=>prepareRiverGame({...simple,players:simple.players.map(p=>({...p,range:'AA,KK,QQ'})),maxDeals:2}),/合法发牌/);
});
test('six players retain private ranges, legal betting, and constant-sum accounting',async()=>{
  const s={...simple,players:['AcAd','KcKd','QcQd','JcJd','9c9d','7c7d'].map((range,i)=>({id:`p${i}`,range,stack:5+i*2})),sizes:[],raiseSizes:[],maxRaises:1,iterations:200};
  const g=prepareRiverGame(s),r=await solveRiverGame(s);assert.equal(g.deals.length,1);assert.equal(r.diagnostics.gain.length,6);close(r.diagnostics.profileEV.reduce((a,b)=>a+b,0),20);assert.ok(r.nodes.some(n=>n.actor===5));
});
test('parallel full traversal agrees with serial strategy and diagnostics',async()=>{
  const s={...simple,players:simple.players.map((p,i)=>({...p,range:['AA,KK','QQ,JJ','99,77'][i]})),iterations:300};
  const serial=await solveRiverGame({...s,threads:1}),parallel=await solveRiverGame({...s,threads:4});
  assert.equal(parallel.stats.threads,4);serial.diagnostics.profileEV.forEach((v,i)=>close(v,parallel.diagnostics.profileEV[i],1e-9));close(serial.diagnostics.nashConv,parallel.diagnostics.nashConv,1e-9);
});
test('three-player BR matches exhaustive information-set pure strategies for every player',async()=>{
  const s={...simple,pot:2,players:['AcAd,JcJd','KcKd,9c9d','QcQd,7c7d'].map((range,i)=>({id:`p${i}`,range,stack:1})),sizes:[50],allIn:false,maxRaises:0,iterations:1000};const g=prepareRiverGame(s),r=await solveRiverGame(s);
  for(let p=0;p<3;p++)close(r.diagnostics.bestResponseEV[p],bruteBR(r,g,p),1e-10);
});
test('explicit chance sampling is reproducible, collision-free, weighted, and independently evaluated',async()=>{
  const s={...simple,players:[{...simple.players[0],range:'AcAd:0.5,AcKd'},{...simple.players[1],range:'KcKd:0.2,QcQd'},{...simple.players[2],range:'JcJd,AcQd:0.5'}],chanceMode:'sampled',chanceSamples:50000,evaluationSamples:20000,seed:188,iterations:500};
  const exact=prepareRiverGame({...s,chanceMode:'exact'}),g=prepareRiverGame(s),repeat=prepareRiverGame(s);assert.deepEqual(g.deals,repeat.deals);assert.deepEqual(g.evaluationDeals,repeat.evaluationDeals);assert.notEqual(g.chance.training.seed,g.chance.holdout.seed);
  const truth=new Map(exact.deals.map(d=>[d.hands.join(':'),d.weight]));for(const d of g.deals){assert.ok(truth.has(d.hands.join(':')));close(d.weight,truth.get(d.hands.join(':')),.01);}close(g.deals.reduce((sum,d)=>sum+d.weight,0),1);
  const r=await solveRiverGame(s);assert.equal(r.chance.exact,false);assert.equal(r.stats.chanceSampling,true);assert.ok(r.diagnostics.verifiedBy.includes('empirical'));
  for(let p=0;p<3;p++){const ev=g.evaluationDeals.reduce((sum,d)=>sum+d.weight*evForDeal(r,g,d,p),0);close(ev,r.validation.holdout.profileEV[p]);}
  assert.equal(r.validation.holdout.sameFixedStrategy,true);assert.ok(r.validation.holdout.profileEVSamplingCI.every(c=>c.standardError>=0));
});
test('impossible own combinations have zero reach and no fabricated action EV',async()=>{
  const r=await solveRiverGame({...simple,players:[{range:'AcAd,KcKd',stack:10},{range:'AcQd',stack:10}],iterations:10});const impossible=r.nodes[0].combos.find(c=>c.combo==='AcAd');assert.equal(impossible.reach,0);assert.equal(impossible.counterfactualReach,0);assert.equal(impossible.ev,null);assert.ok(impossible.actionEV.every(v=>v===null));
});
test('alternating CFR+ and DCFR satisfy known Kuhn value and independent BR verification',()=>{
  for(const algorithm of ['alternating-cfr-plus','dcfr']){const g={...kuhn(),algorithm},r=native(g);close(r.diagnostics.profileEV[0],1-1/18,.0001);for(let p=0;p<2;p++)close(r.diagnostics.bestResponseEV[p],bruteBR(r,g,p),1e-10);if(algorithm==='alternating-cfr-plus'){assert.ok(r.diagnostics.nashConv<.00005);assert.equal(r.stats.playerUpdatePasses,60000);}else assert.ok(r.diagnostics.nashConv<.003);}
});
test('exact zero-reach pruning preserves strategies, conditional EV, and BR',async()=>{
  for(const algorithm of ['cfr-plus','alternating-cfr-plus']){const s={...simple,players:[{...simple.players[0],range:'AcAd,JcJd'},{...simple.players[1],range:'KcKd,9c9d'},{...simple.players[2],range:'QcQd,7c7d'}],iterations:500,algorithm,threads:1};const a=await solveRiverGame({...s,zeroReachPruning:false}),b=await solveRiverGame({...s,zeroReachPruning:true});a.diagnostics.bestResponseEV.forEach((v,p)=>close(v,b.diagnostics.bestResponseEV[p],1e-11));for(let i=0;i<a.nodes.length;i++)for(let c=0;c<a.nodes[i].combos.length;c++){a.nodes[i].combos[c].probabilities.forEach((v,j)=>close(v,b.nodes[i].combos[c].probabilities[j],1e-11));a.nodes[i].combos[c].actionEV.forEach((v,j)=>v===null?assert.equal(b.nodes[i].combos[c].actionEV[j],null):close(v,b.nodes[i].combos[c].actionEV[j],1e-11));}}
});
test('root marginals are collision-conditioned and match root combo reaches',async()=>{
  const s={...simple,players:[{range:'AcAd,AcKd',stack:10},{range:'KcKd,QcQd',stack:10}],iterations:10},r=await solveRiverGame(s);for(const m of r.chance.marginals)close(m.combos.reduce((s,c)=>s+c.probability,0),1);r.nodes[0].combos.forEach((c,i)=>close(c.reach,r.chance.marginals[0].combos[i].probability));close(r.chance.marginals[0].combos[0].probability,2/3);close(r.chance.marginals[0].combos[1].probability,1/3);
});

test('fixed capped rake is removed once, preserving side pots, ties, and uncalled refunds',()=>{
  const g=prepareRiverGame({...simple,rake:5,rakeCap:1,iterations:1});
  assert.equal(g.fixedRake,1);assert.equal(g.nodes[0].pot,20);assert.ok(g.nodes[0].actions.some(a=>a.id==='bet_10'));
  for(const [ranks,folded,expected] of [
    [[1,2,3],[false,false,false],[-20,0,39]],
    [[3,3,1],[false,false,false],[14.5,14.5,-10]],
    [[1,9,8],[false,true,true],[49,-20,-10]],
  ]){
    const h={...g,nodes:[{id:'n0',parentId:null,actor:-1,terminal:true,actions:[],contributions:[30,20,10],folded}],deals:[{hands:[0,0,0],ranks,weight:1}]},r=native(h);
    r.diagnostics.profileEV.forEach((v,p)=>close(v,expected[p]));close(r.diagnostics.profileEV.reduce((a,b)=>a+b,0),19);close(r.diagnostics.constantSum,19);assert.equal(r.rakeModel.type,'fixed-cap-reached-at-root');
  }
});

test('capped-rake policies and unrestricted best responses match independent information-set evaluation',async()=>{
  const s={...simple,pot:2,rake:5,rakeCap:.1,players:['AcAd,JcJd','KcKd,9c9d'].map((range,i)=>({id:`p${i}`,range,stack:1})),allIn:false,maxRaises:0,iterations:3000,algorithm:'alternating-cfr-plus'};
  const g=prepareRiverGame(s),r=await solveRiverGame(s);for(let p=0;p<2;p++){const ev=g.deals.reduce((sum,d)=>sum+d.weight*evForDeal(r,g,d,p),0);close(ev,r.diagnostics.profileEV[p]);close(r.diagnostics.bestResponseEV[p],bruteBR(r,g,p),1e-10);}close(r.diagnostics.profileEV.reduce((a,b)=>a+b,0),1.9);
  assert.equal(r.input.rake,5);assert.equal(r.input.rakeCap,.1);for(const n of r.nodes)if(n.actor>=0)for(const c of n.combos){const a=n.actions.findIndex(a=>a.type==='fold');if(a>=0&&c.counterfactualReach>1e-10)close(c.actionEV[a],0);}
});

test('uncapped or malformed rake is rejected without silently reverting to zero',()=>{
  for(const rake of [-1,Infinity,NaN,21])assert.throws(()=>prepareRiverGame({...simple,rake}),/抽水/);
  assert.throws(()=>prepareRiverGame({...simple,rake:5,rakeCap:2}),/尚未达到/);
  assert.throws(()=>prepareRiverGame({...simple,rake:5,rakeCap:0}),/封顶/);
  assert.throws(()=>prepareRiverGame({...simple,rake:5,rakeCap:-1}),/封顶/);
  assert.equal(prepareRiverGame({...simple,rake:0,rakeCap:2}).fixedRake,0);
  assert.equal(prepareRiverGame({...simple,rake:5,cap:1}).fixedRake,1);
});

test('evaluation-only independently verifies a complete given policy without training or constrained BR',()=>{
  const g=kuhn(500),solved=native(g),locks=solved.nodes.flatMap((n,node)=>n.combos.map((c,combo)=>({node,combo,probabilities:c.probabilities}))),full={...g,iterations:1,averagingDelay:0,locks};
  const one=native(full),evaluated=native({...full,evaluationOnly:true});assert.equal(evaluated.evaluationOnly,true);assert.equal(evaluated.stats.iterations,0);assert.equal(evaluated.stats.playerUpdatePasses,0);assert.equal(evaluated.stopReason,'policy_evaluated');assert.equal(evaluated.diagnostics.constrainedNashConv,undefined);
  for(let p=0;p<2;p++){close(one.diagnostics.profileEV[p],evaluated.diagnostics.profileEV[p],1e-12);close(one.diagnostics.bestResponseEV[p],evaluated.diagnostics.bestResponseEV[p],1e-12);}assert.deepEqual(evaluated.nodes,one.nodes);
  assert.throws(()=>native({...full,evaluationOnly:true,locks:locks.slice(1)}),/complete locked policy/);
});
