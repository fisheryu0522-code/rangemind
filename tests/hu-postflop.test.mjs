import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareHUPostflop,huCommandFile,normalizeHUTree,solveHUPostflop} from '../lib/hu-postflop.mjs';
import {cards} from '../lib/poker.mjs';

const base={board:'Ks7h2d9c3s',hero:'AcKd',heroSeat:0,pot:10,toAct:0,players:[{id:'a',name:'OOP',position:'BB',stack:10,range:'AcKd,AhQh:0.3'},{id:'b',name:'IP',position:'BTN',stack:10,range:'KhQd,QcJc:0.7'}],sizes:[33],raiseSizes:[25],maxRaises:1,iterations:30,accuracy:.000001};
const near=(a,b,tolerance=1e-7)=>assert.ok(Math.abs(a-b)<tolerance,`${a} differs from ${b}`);

test('HU rejects unsupported model changes instead of silently ignoring them',()=>{
  assert.throws(()=>prepareHUPostflop({...base,rake:5}),/无抽水/);
  assert.throws(()=>prepareHUPostflop({...base,locks:[{nodeId:'n0'}]}),/锁定/);
  assert.throws(()=>prepareHUPostflop({...base,riverMaxRaises:2}),/相同/);
  assert.throws(()=>prepareHUPostflop({...base,algorithm:'cfr-plus'}),/DCFR/);
  assert.throws(()=>prepareHUPostflop({...base,board:'Ks7h2d',maxNodes:100,outputScope:'full'}),/不会静默截断/);
});

test('HU commands use explicit raise cap, all streets, same donk sizes and exact weighted combos',()=>{
  const prepared=prepareHUPostflop({...base,board:'Ks7h2d',sizes:[],raiseSizes:[],maxRaises:0,allIn:false,toAct:1});
  const text=huCommandFile(prepared);assert.match(text,/set_raise_limit 1/);assert.match(text,/set_dump_rounds 3/);assert.match(text,/set_range_ip KdAc:1,QhAh:0.3/);assert.match(text,/set_bet_sizes oop,river,donk\n/);assert.doesNotMatch(text,/,allin/);
  assert.equal(prepared.settings.oop,1);assert.equal(prepared.settings.ip,0);
});

test('HU normalization rejects omitted terminal children and absent reachable strategy',()=>{
  const p=prepareHUPostflop(base),raw={node_type:'action_node',player:1,actions:['CHECK'],strategy:{strategy:{AcKd:[1],AhQh:[1]}}};
  assert.throws(()=>normalizeHUTree(raw,p),/缺少行动子节点/);
  assert.throws(()=>normalizeHUTree({...raw,strategy:{strategy:{AcKd:[1]}}},p),/可达组合/);
});

test('HU range aggregation uses joint compatible reach rather than bare combo weights',()=>{
  const s={...base,players:[{...base.players[0],range:'AcKd,AhQh'},{...base.players[1],range:'AcQs,QcJc'}]};
  const raw={node_type:'action_node',player:1,actions:['CHECK','BET 10.000000'],strategy:{strategy:{AcKd:[1,0],AhQh:[0,1]}},childrens:{CHECK:{node_type:'terminal_node'},'BET 10.000000':{node_type:'terminal_node'}}};
  const r=normalizeHUTree(raw,prepareHUPostflop(s));near(r.nodes[0].actions[0].frequency,1/3);near(r.nodes[0].actions[1].frequency,2/3);assert.equal(r.nodes[0].actions[0].ev,null);assert.equal(r.diagnostics.nashConv,undefined);
});

function verifyTree(result){
  const byId=new Map(result.nodes.map(n=>[n.id,n])),startPot=result.input.pot,effective=Math.min(...result.input.players.map(p=>p.stack));
  near(result.nodes[0].reach,1);
  for(const node of result.nodes){
    near(node.pot,startPot+node.contributions.reduce((a,b)=>a+b,0),2e-5);
    node.contributions.forEach(x=>assert.ok(x>=0&&x<=effective+1e-5));
    assert.equal(new Set(cards(node.board)).size,cards(node.board).length);
    if(node.terminal){assert.equal(node.actor,-1);assert.equal(node.actions.length,0);continue;}
    if(node.outOfScope){assert.equal(node.chance,true);assert.equal(node.terminal,false);assert.equal(node.actions.length,0);continue;}
    const children=node.actions.map(a=>byId.get(a.childId));assert.ok(children.every(Boolean));
    near(children.reduce((sum,c)=>sum+c.reach,0),node.reach,2e-7);
    if(node.reach>1e-14)near(node.actions.reduce((sum,a)=>sum+a.frequency,0),1,1e-6);
    if(node.chance){assert.equal(node.actor,-2);for(const child of children){assert.equal(cards(child.board).length,cards(node.board).length+1);assert.deepEqual(child.streetContributions,[0,0]);near(child.pot,node.pot);}continue;}
    assert.ok(node.actor>=0);near(node.combos.reduce((sum,c)=>sum+c.reach,0),node.reach,1e-7);
    for(const c of node.combos){assert.ok(!cards(c.combo).some(k=>cards(node.board).includes(k)));near(c.probabilities.reduce((a,b)=>a+b,0),1);assert.ok(c.actionEV.every(v=>v===null));}
    node.actions.forEach((a,i)=>{near(children[i].contributions[node.actor]-node.contributions[node.actor],a.amount,2e-5);near(a.to,node.streetContributions[node.actor]+a.amount,2e-5);});
  }
}

test('native HU river retains decimal amounts, legal raises and final-report iteration',async()=>{
  const result=await solveHUPostflop(base);verifyTree(result);
  assert.equal(result.stats.iterations,30);assert.equal(result.stats.publicNodes,result.estimate.publicNodes);
  near(result.nodes[0].actions.find(a=>a.type==='bet'&&!a.allIn).amount,3.3);
  assert.ok(result.nodes.some(n=>n.actions.some(a=>a.type==='raise'&&Math.abs(a.to-7.45)<1e-6)));
  assert.ok(Number.isFinite(result.diagnostics.reportedExploitabilityPctPot));assert.equal(result.diagnostics.independentlyVerified,false);
});

test('native HU flop fully exposes both future streets with joint-card-aware chance probabilities',async()=>{
  const input={...base,board:'Ks7h2d',toAct:1,players:base.players.map(p=>({...p,stack:2})),sizes:[],raiseSizes:[],maxRaises:0,allIn:true,iterations:20,maxNodes:100000};
  const result=await solveHUPostflop(input);verifyTree(result);assert.equal(result.nodes[0].actor,1);assert.equal(result.stats.publicNodes,result.estimate.publicNodes);
  assert.deepEqual([...new Set(result.nodes.map(n=>n.street))].sort(),['flop','river','turn']);
  const first=result.nodes.find(n=>n.chance&&cards(n.board).length===3);assert.equal(first.actions.length,49);
  const absentFromAllHoles=first.actions.find(a=>a.label==='2c');near(absentFromAllHoles.frequency,1/45);
  assert.ok(first.actions.find(a=>a.label==='Ac').frequency<1/45);
  assert.ok(result.nodes.some(n=>n.street==='river'&&n.actor>=0));assert.equal(result.stats.iterations,20);
});

test('native HU small pots never trigger preflop blind rules, short all-in is retained',async()=>{
  const result=await solveHUPostflop({...base,pot:1,players:base.players.map(p=>({...p,stack:2.5})),sizes:[1],raiseSizes:[1],maxRaises:2,iterations:2});verifyTree(result);
  near(result.nodes[0].actions.find(a=>a.type==='bet'&&!a.allIn).amount,1);
  assert.ok(result.nodes.some(n=>n.actions.some(a=>a.type==='raise'&&a.to===2.5&&a.allIn)));
});

test('native HU conventional deep flop solves all streets and clearly marks current-street export boundary',async()=>{
  const input={...base,board:'Ks7h2d',pot:6,players:base.players.map(p=>({...p,stack:97})),sizes:[33,75],raiseSizes:[50],maxRaises:1,iterations:2};
  const p=prepareHUPostflop(input);assert.equal(p.settings.outputScope,'current-street');assert.ok(p.estimate.publicNodes>7000000);
  const result=await solveHUPostflop(input);verifyTree(result);assert.equal(result.outputScope,'current-street');assert.equal(result.capabilities.fullTree,false);assert.equal(result.capabilities.actionEV,false);assert.deepEqual(result.scope.solvedStreets,['flop','turn','river']);assert.deepEqual(result.scope.exportedStreets,['flop']);
  assert.ok(result.nodes.some(n=>n.outOfScope));assert.ok(result.nodes.every(n=>n.board===input.board));assert.ok(result.nodes.length<100);assert.equal(result.stats.iterations,2);
});
