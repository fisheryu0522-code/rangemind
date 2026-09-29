import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {prepareTurnGame,solveTurnGame} from '../lib/turn-engine.mjs';
import {cards,rankHand} from '../lib/poker.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const close=(a,b,e=1e-8)=>assert.ok(Math.abs(a-b)<=e,`${a} != ${b}`);
const sample={board:'Ks7h2h9c',pot:20,players:[{id:'a',range:'AcKd,AhQh',stack:30},{id:'b',range:'KcQd,QhJh',stack:30},{id:'c',range:'9h9s,JhTh',stack:20}],sizes:[50],raiseSizes:[50],maxRaises:0,riverMaxRaises:0,allIn:false,iterations:500};
function native(g){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'turn-test-'));try{const inp=path.join(dir,'in.json'),out=path.join(dir,'out.json');fs.writeFileSync(inp,JSON.stringify(g));execFileSync(path.join(root,'engines/TurnLab/turn-engine.exe'),[inp,out],{windowsHide:true,maxBuffer:1000000});return JSON.parse(fs.readFileSync(out));}finally{fs.rmSync(dir,{recursive:true,force:true});}}
function child(g,node,type){const action=node.actions.find(a=>a.id===type||a.type===type);assert.ok(action,`${type} missing at ${node.id}`);return g.nodes[Number(action.childId.slice(1))];}
function payoff(node,d,pot){const out=node.contributions.map(c=>-c);const award=(amount,eligible)=>{const best=Math.max(...eligible.map(p=>d.ranks[p])),winners=eligible.filter(p=>d.ranks[p]===best);for(const p of winners)out[p]+=amount/winners.length;};award(pot,node.folded.map((f,i)=>f?-1:i).filter(p=>p>=0));let old=0;for(const level of [...new Set(node.contributions)].sort((a,b)=>a-b)){const contributors=node.contributions.map((c,p)=>c>=level?p:-1).filter(p=>p>=0),amount=(level-old)*contributors.length;if(contributors.length===1)out[contributors[0]]+=amount;else if(amount)award(amount,contributors.filter(p=>!node.folded[p]));old=level;}return out;}
function value(r,g,d,id='n0'){const n=r.nodes[Number(id.slice(1))];if(n.terminal)return payoff(n,d,g.pot-(g.fixedRake??0));if(n.chance)return value(r,g,d,n.actions.find(a=>a.card===d.river).childId);const out=g.players.map(()=>0),prob=n.combos[d.hands[n.actor]].probabilities;for(let a=0;a<n.actions.length;a++){const v=value(r,g,d,n.actions[a].childId);v.forEach((x,p)=>out[p]+=prob[a]*x);}return out;}

test('turn chance enumerates every unblocked river with exact joint weights',()=>{
  const g=prepareTurnGame(sample);assert.equal(g.chance.holeDeals,5);assert.equal(g.deals.length,5*42);close(g.deals.reduce((s,d)=>s+d.weight,0),1);
  for(const d of g.deals){const all=[...cards(sample.board),...d.hands.flatMap((c,p)=>g.combinations[p][c].cards),d.river];assert.equal(new Set(all).size,all.length);d.ranks.forEach((v,p)=>assert.equal(v,rankHand([...cards(sample.board),d.river,...g.combinations[p][d.hands[p]].cards])));}
});
test('check-through across both streets equals direct exact showdown enumeration',async()=>{
  const s={...sample,sizes:[],riverSizes:[],raiseSizes:[],riverRaiseSizes:[],allIn:false,iterations:1},g=prepareTurnGame(s),r=await solveTurnGame(s),expected=s.players.map(()=>0);
  for(const d of g.deals){const best=Math.max(...d.ranks),winners=d.ranks.map((v,p)=>v===best?p:-1).filter(p=>p>=0);for(const p of winners)expected[p]+=d.weight*s.pot/winners.length;}
  expected.forEach((ev,p)=>close(ev,r.diagnostics.profileEV[p]));close(r.diagnostics.nashConv,0);assert.ok(r.nodes.some(n=>n.chance));assert.ok(r.nodes.some(n=>n.street==='river'));
});
test('turn betting contribution carries across the river; all remaining stacks are respected',()=>{
  const g=prepareTurnGame(sample);let n=child(g,g.nodes[0],'bet');n=child(g,n,'call');n=child(g,n,'call');assert.equal(n.chance,true);assert.deepEqual(n.contributions,[10,10,10]);n=child(g,n,'deal');assert.equal(n.street,'river');assert.equal(n.pot,50);assert.deepEqual(n.streetContributions,[0,0,0]);assert.deepEqual(n.contributions,[10,10,10]);
  for(const node of g.nodes)node.contributions.forEach((c,p)=>assert.ok(c<=g.players[p].stack+1e-9));
});
test('raises on both streets and cross-street unequal all-ins are real game actions',async()=>{
  const s={...sample,pot:10,players:[{id:'a',range:'AcKd',stack:20},{id:'b',range:'KcQd',stack:20},{id:'c',range:'9h9s',stack:10}],maxRaises:1,riverMaxRaises:1,maxNodes:50000,iterations:20};const g=prepareTurnGame(s),r=await solveTurnGame(s);
  assert.ok(g.nodes.some(n=>n.street==='turn'&&n.actions.some(a=>a.type==='raise')));assert.ok(g.nodes.some(n=>n.street==='river'&&n.actions.some(a=>a.type==='raise')));close(r.diagnostics.profileEV.reduce((a,b)=>a+b,0),10);
});
test('BR cannot see a future river before it is publicly dealt',()=>{
  const g=prepareTurnGame({...sample,players:sample.players.slice(0,2).map(p=>({...p,range:p.range.split(',')[0]})),iterations:1,sizes:[],riverSizes:[]});g.pot=2;g.combinations=[[{combo:'hero',weight:1}],[{combo:'villain',weight:1}]];g.deals=[{hands:[0,0],ranks:[2,1],river:5,weight:.5},{hands:[0,0],ranks:[1,2],river:6,weight:.5}];
  const decision=(id,parent,fold,call)=>({id:`n${id}`,parentId:parent,actor:0,terminal:false,chance:false,contributions:[0,1],folded:[false,false],actions:[{id:'fold',type:'fold',child:fold,childId:`n${fold}`},{id:'call',type:'call',child:call,childId:`n${call}`}]});
  const leaf=(id,parent,folded)=>({id:`n${id}`,parentId:parent,actor:-1,terminal:true,chance:false,contributions:folded?[0,1]:[1,1],folded:[folded,false],actions:[]});
  g.nodes=[decision(0,null,1,2),leaf(1,'n0',true),leaf(2,'n0',false)];const hidden=native(g);close(hidden.diagnostics.bestResponseEV[0],1);
  g.nodes=[{id:'n0',parentId:null,actor:-2,terminal:false,chance:true,contributions:[0,1],folded:[false,false],actions:[{id:'r5',type:'deal',card:5,child:1,childId:'n1'},{id:'r6',type:'deal',card:6,child:4,childId:'n4'}]},decision(1,'n0',2,3),leaf(2,'n1',true),leaf(3,'n1',false),decision(4,'n0',5,6),leaf(5,'n4',true),leaf(6,'n4',false)];const revealed=native(g);close(revealed.diagnostics.bestResponseEV[0],1.5);assert.ok(revealed.nodes[0].actions.every(a=>a.frequency===.5));
});
test('full two-street policy values match independent path evaluation and pot conservation',async()=>{
  const g=prepareTurnGame(sample),r=await solveTurnGame(sample);const expected=sample.players.map(()=>0);for(const d of g.deals){const v=value(r,g,d);v.forEach((x,p)=>expected[p]+=d.weight*x);}expected.forEach((x,p)=>close(x,r.diagnostics.profileEV[p]));close(expected.reduce((a,b)=>a+b,0),sample.pot);
  for(const n of r.nodes){if(n.chance&&n.reach>1e-10)close(n.actions.reduce((s,a)=>s+a.frequency,0),1);if(!n.terminal&&!n.chance)for(const c of n.combos){close(c.probabilities.reduce((s,x)=>s+x,0),1);const fold=n.actions.findIndex(a=>a.type==='fold');if(fold>=0&&c.counterfactualReach>1e-10)close(c.actionEV[fold],0);}}
});
test('zero-probability river/hand combinations have no fabricated conditional EV',async()=>{
  const r=await solveTurnGame({...sample,iterations:10});for(const n of r.nodes)if(n.street==='river'&&!n.terminal&&!n.chance){const river=cards(n.board).at(-1);for(const c of n.combos)if(cards(c.combo).includes(river)){assert.equal(c.counterfactualReach,0);assert.equal(c.ev,null);}}
});
test('turn scope and resource limits reject unsupported models',()=>{
  assert.throws(()=>prepareTurnGame({...sample,players:[...sample.players,{range:'AcAd',stack:30},{range:'QcQd',stack:30}]}),/2–4/);assert.throws(()=>prepareTurnGame({...sample,chanceMode:'sampled'}),/完整机会枚举/);assert.throws(()=>prepareTurnGame({...sample,rake:5}),/封顶/);assert.throws(()=>prepareTurnGame({...sample,maxDeals:10}),/超过/);assert.throws(()=>prepareTurnGame({...sample,maxNodes:100}),/公开树/);
});
test('alternating two-street CFR keeps hidden chance and yields independently correct values',async()=>{
  const s={...sample,algorithm:'alternating-cfr-plus',iterations:500},g=prepareTurnGame(s),r=await solveTurnGame(s),expected=s.players.map(()=>0);for(const d of g.deals)value(r,g,d).forEach((v,p)=>expected[p]+=d.weight*v);expected.forEach((v,p)=>close(v,r.diagnostics.profileEV[p]));assert.equal(r.stats.playerUpdatePasses,1500);assert.ok(r.diagnostics.nashConv>=0);assert.ok(r.stats.payoffMemoryBytes<1000000);
});

test('capped rake is charged once across both streets and agrees with independent terminal accounting',async()=>{
  const s={...sample,rake:5,rakeCap:1,algorithm:'alternating-cfr-plus',iterations:200},g=prepareTurnGame(s),r=await solveTurnGame(s),expected=s.players.map(()=>0);
  for(const d of g.deals)value(r,g,d).forEach((v,p)=>expected[p]+=d.weight*v);expected.forEach((v,p)=>close(v,r.diagnostics.profileEV[p]));close(expected.reduce((a,b)=>a+b,0),19);close(r.diagnostics.constantSum,19);
  assert.equal(r.rakeModel.fixedRake,1);assert.equal(r.input.rakeCap,1);assert.ok(g.nodes[0].actions.some(a=>a.id==='bet_10'));
  assert.throws(()=>prepareTurnGame({...sample,rake:5,rakeCap:2}),/尚未达到/);
});

test('two-street BR matches exhaustive whole-information-set pure policies with private cards and future chance',()=>{
  for(const ranges of [['AcAd,JcJh','KcKd,9c9d'],['AcAd','KcKd','QcQd']]){
    // Condition a genuine betting tree on two future cards, to keep the number
    // of pure policies small enough for independent exhaustive enumeration.
    const rivers=cards(ranges.length===2?'Js9h':'KhQh'),g=prepareTurnGame({board:'2c4d6h8s',pot:2,players:ranges.map((range,i)=>({id:`p${i}`,range,stack:1})),sizes:[50],riverSizes:[50],allIn:false,maxRaises:0,riverMaxRaises:0,iterations:500,algorithm:'alternating-cfr-plus'});
    g.deals=g.deals.filter(d=>rivers.includes(d.river));const mass=g.deals.reduce((sum,d)=>sum+d.weight,0);g.deals.forEach(d=>d.weight/=mass);
    const old=g.nodes,nodes=[];function copy(index,parentId=null){const source=old[index],id=nodes.length,node={...source,id:`n${id}`,parentId,actions:[]};nodes.push(node);for(const a of source.actions)if(!source.chance||rivers.includes(a.card)){const child=copy(a.child,node.id);node.actions.push({...a,child,childId:`n${child}`});}return id;}copy(0);g.nodes=nodes;
    const r=native(g);
    for(let player=0;player<ranges.length;player++){
      const sets=r.nodes.filter(n=>n.actor===player).flatMap(n=>n.combos.map((_,c)=>({node:n.id,combo:c,actions:n.actions.length}))),count=sets.reduce((n,s)=>n*s.actions,1);assert.ok(count<=65536,`Exhaustive BR budget ${count}`);
      const policy=new Map();let best=-Infinity;
      const valueForDeal=(d,id='n0')=>{const n=r.nodes[Number(id.slice(1))];if(n.terminal)return payoff(n,d,g.pot)[player];if(n.chance)return valueForDeal(d,n.actions.find(a=>a.card===d.river).childId);if(n.actor===player)return valueForDeal(d,n.actions[policy.get(`${id}:${d.hands[player]}`)].childId);return n.actions.reduce((sum,a,i)=>sum+n.combos[d.hands[n.actor]].probabilities[i]*valueForDeal(d,a.childId),0);};
      function enumerate(i){if(i===sets.length){best=Math.max(best,g.deals.reduce((sum,d)=>sum+d.weight*valueForDeal(d),0));return;}const s=sets[i];for(let a=0;a<s.actions;a++){policy.set(`${s.node}:${s.combo}`,a);enumerate(i+1);}}
      enumerate(0);close(r.diagnostics.bestResponseEV[player],best,1e-10);
    }
  }
});

test('turn evaluation-only agrees with fully locked one-round evaluation',()=>{
  const g=prepareTurnGame({...sample,iterations:10}),solved=native(g),locks=solved.nodes.flatMap((n,node)=>n.combos.map((c,combo)=>({node,combo,probabilities:c.probabilities}))),full={...g,iterations:1,averagingDelay:0,locks};
  const one=native(full),evaluated=native({...full,evaluationOnly:true});assert.equal(evaluated.stats.iterations,0);assert.equal(evaluated.diagnostics.constrainedNashConv,undefined);for(let p=0;p<3;p++){close(one.diagnostics.profileEV[p],evaluated.diagnostics.profileEV[p],1e-12);close(one.diagnostics.bestResponseEV[p],evaluated.diagnostics.bestResponseEV[p],1e-12);}assert.deepEqual(evaluated.nodes,one.nodes);
});
