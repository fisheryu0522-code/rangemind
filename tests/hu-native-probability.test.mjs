import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {solveHUPostflop} from '../lib/hu-postflop.mjs';
import {evaluateHUPolicy} from '../lib/hu-policy-evaluation.mjs';
const base={pot:10,toAct:0,players:[{id:'a',position:'BB',range:'AcKd,AhQh:0.3',stack:8},{id:'b',position:'BTN',range:'KhQd,QcJc:0.7',stack:8}],sizes:[50],raiseSizes:[50],maxRaises:0,allIn:false,iterations:20,accuracy:.000001,outputScope:'full',maxNodes:200000};

async function verify(input){
  const prefix=path.join(os.tmpdir(),'hu-native-probability-'),dir=fs.mkdtempSync(prefix);
  try{
    const raw=await solveHUPostflop(input,{workDir:dir}),exact=evaluateHUPolicy(raw,{maxNodes:200000}),log=fs.readFileSync(path.join(dir,'solver.log'),'utf8'),reports=[...log.matchAll(/player (\d) exploitability ([-\d.eE+]+)/g)].slice(-2);
    assert.equal(reports.length,2);for(const [,player,value] of reports){const seat=Number(player)===0?1-input.toAct:input.toAct,nativeBR=Number(value)+input.pot/2;assert.ok(Math.abs(nativeBR-exact.diagnostics.bestResponseEV[seat])<3e-5,`Native player ${player} BR ${nativeBR} versus independent ${exact.diagnostics.bestResponseEV[seat]}`);}
    assert.equal(exact.diagnostics.nativeReportConsistent,true);return exact;
  }finally{assert.ok(path.resolve(dir).startsWith(path.resolve(prefix)));fs.rmSync(dir,{recursive:true,force:true});}
}

test('native future-chance mass is one for a fixed legal private-card pair on flop and turn',async()=>{
  for(const board of ['Ks7h2d','Ks7h2d9c']){const r=await verify({...base,board,players:base.players.map(p=>({...p,range:p.range.split(',')[0]})),sizes:[],raiseSizes:[],iterations:1});assert.equal(r.diagnostics.nashConv,0);}
});

test('native weighted turn raises, early folds and all-ins agree with independent full-policy BR',async()=>{
  const r=await verify({...base,board:'Ks7h2d9c',players:base.players.map((p,i)=>({...p,stack:[12,18][i]})),maxRaises:1,allIn:true});assert.ok(r.nodes.some(n=>n.actions.some(a=>a.type==='raise')));assert.ok(r.nodes.some(n=>n.terminalKind==='fold'&&n.street==='turn'));
});

test('native flop policies with investment and all-ins on different future streets match exact BR',async()=>{
  const r=await verify({...base,board:'Ks7h2d'});assert.equal(r.nodes.length,116580);for(const street of ['flop','turn','river'])assert.ok(r.nodes.some(n=>n.street===street&&n.actions.some(a=>a.type==='bet')));assert.ok(r.nodes.some(n=>n.actions.some(a=>a.type==='call'&&a.allIn)));
});
