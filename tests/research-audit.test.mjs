import test from 'node:test';
import assert from 'node:assert/strict';
import {parseScenario,validateScenario,normalizeScenario} from '../lib/scenario.mjs';
import {prepareRiverGame,solveRiverGame} from '../lib/river-engine.mjs';
import {explainDecision} from '../lib/decision-explanation.mjs';
import {observedPath} from '../lib/observed-path.mjs';
import {runSensitivity} from '../lib/sensitivity.mjs';
import {cards,range} from '../lib/poker.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
const sample={board:'2c4d6h8sTc',pot:10,hero:'KcKd',heroSeat:1,toAct:0,players:[{id:'s',position:'SB',name:'Short',range:'AcAd',stack:5},{id:'h',position:'BB',name:'Hero',range:'KcKd',stack:20},{id:'b',position:'BTN',name:'Button',range:'QcQd',stack:20}],sizes:[50],raiseSizes:[50],maxRaises:1,allIn:false,iterations:2};
const next=(g,n,type)=>g.nodes.find(x=>x.id===n.actions.find(a=>a.type===type).childId);

test('a losing showdown plus return of unmatched chips is not labeled a showdown win',async()=>{
 const g=prepareRiverGame(sample),h=next(g,g.nodes[0],'bet'),b=next(g,h,'raise');
 const result=await solveRiverGame({...sample,locks:[{nodeId:'n0',actions:{bet_5:1}},{nodeId:b.id,actions:{fold:1}}]});
 const report=explainDecision(sample,result,{nodeId:h.id,combo:sample.hero}),raise=report.actions.find(a=>a.type==='raise');
 assert.equal(raise.ev,-5);assert.equal(raise.outcomes.find(o=>o.id==='loss')?.probability,1);assert.equal(raise.outcomes.some(o=>o.id==='win'),false);
 assert.equal(raise.expectedUncalledRefund,10);
});

test('shorthand seating order is canonicalized and hero/to-act follow player identity',()=>{
 const raw='单位：BB\n公共牌：2c4d6h8sTc\n底池：10\nHero：BTN QcQd\nBTN：筹码20 范围QcQd\nBB：筹码20 范围KcKd\nSB：筹码20 范围AcAd\n先行动：SB\nSB 过牌\nBB 下注5\nBTN 加注到15\nSB 弃牌\nBB 跟注10';
 const parsed=parseScenario(raw);assert.equal(parsed.ok,true);assert.deepEqual(parsed.scenario.players.map(p=>p.position),['SB','BB','BTN']);assert.equal(parsed.scenario.heroSeat,2);assert.equal(parsed.scenario.toAct,0);
 const result=prepareRiverGame({...parsed.scenario,sizes:[50],raiseSizes:[50],maxRaises:1,allIn:false});
 const path=observedPath(parsed.scenario,result,parsed);assert.equal(path.decisions.length,5);assert.deepEqual(path.target.path,['check','bet_5']);assert.equal(path.target.recordedAction,'raise_15');
});

test('JSON seat normalization preserves indexed identities and range statistics',()=>{
 const s=structuredClone(sample);s.players=[s.players[2],s.players[1],s.players[0]];s.heroSeat=1;s.toAct=2;
 const v=validateScenario(s);assert.equal(v.ok,true);assert.deepEqual(v.scenario.players.map(p=>p.id),['s','h','b']);assert.equal(v.scenario.heroSeat,1);assert.equal(v.scenario.toAct,0);for(const row of v.rangeStats)assert.equal(v.scenario.players[row.seat].id,row.id);
 s.players[2].range='';const missing=validateScenario(s);assert.equal(missing.issues.find(i=>i.code==='missing_range').field,'players.0.range');
});

test('pre-existing side pots survive street import and cannot become a common-pot solver root',()=>{
 const raw='现场，盲注0.5/1 BB。BTN 30 BB，SB 5 BB，BB 30 BB。BTN 加注到10 BB，SB 跟注，BB 跟注。翻牌 2c4d6h。';
 const imported=parseScenario(raw);assert.equal(imported.ok,false);assert.ok(imported.issues.some(i=>i.code==='preexisting_sidepot'));assert.equal(imported.scenario.pot,25);assert.equal(imported.scenario.preexistingSidePot,true);
 assert.throws(()=>normalizeScenario({...imported.scenario,players:imported.scenario.players.map((p,i)=>({...p,range:['AcAd','KcKd','QcQd'][i]}))}),/边池/);
 const safe=parseScenario(raw.replace('BTN 加注到10 BB','BTN 加注到5 BB'));assert.equal(safe.issues.some(i=>i.code==='preexisting_sidepot'),false);
});

test('changed range or stack cannot reuse old action explanations, observed paths or sensitivity baseline',async()=>{
 const s={...sample,players:sample.players.slice(1).map(p=>({...p,stack:20})),heroSeat:0,toAct:0},baseline=await solveRiverGame(s),changed=structuredClone(s);changed.players[1].range='QhQs';
 assert.throws(()=>explainDecision(changed,baseline,{combo:s.hero}),/局面|范围|不一致/);
 await assert.rejects(runSensitivity({scenario:changed,settings:s,baseline,player:1,subset:'QhQs',combo:s.hero,scales:[.5,1]}),/局面|范围|不一致/);
 const context={ledger:[{type:'street',street:'river',board:s.board,potBefore:10},{type:'check',street:'river',player:'h',potBefore:10,potAfter:10,stackAfter:20}]};
 assert.throws(()=>observedPath(changed,baseline,context),/局面|范围|不一致/);
});

test('sensitivity rejects hidden lock changes and other model overrides before launching variants',async()=>{
 const s={...sample,players:sample.players.slice(1).map(p=>({...p,stack:20})),heroSeat:0,toAct:0},settings={sizes:[50],raiseSizes:[50],maxRaises:1,allIn:false,iterations:2,locks:[{nodeId:'n0',actions:{check:1}}]},baseline=await solveRiverGame({...s,...settings});let calls=0;
 const input={scenario:s,settings:{...settings,locks:[]},baseline,player:1,subset:'QcQd',combo:s.hero,scales:[.5,1]};
 await assert.rejects(runSensitivity(input,{solve:async()=>{calls++;return baseline;}}),/锁定|模型|不一致/);assert.equal(calls,0);
 await assert.rejects(runSensitivity({...input,settings:{...settings,pot:99}},{solve:async()=>{calls++;return baseline;}}),/模型|覆盖|不一致/);assert.equal(calls,0);
});

test('repeating an experiment from saved full-input settings does not overwrite the new weighted range',async()=>{
 const s={...sample,players:sample.players.slice(1).map(p=>({...p,stack:20})),heroSeat:0,toAct:0};s.players[1].range='QcQd,QhQs';const baseline=await solveRiverGame(s),seen=[];
 const result=await runSensitivity({scenario:s,settings:baseline.input,baseline,player:1,subset:'QcQd',combo:s.hero,scales:[.5,1]},{solve:async input=>{seen.push(input);return solveRiverGame(input);}});
 const weighted=range(seen[0].players[1].range,cards(s.board)).live;assert.equal(weighted.find(c=>c.label==='QcQd').weight,.5);assert.equal(weighted.find(c=>c.label==='QhQs').weight,1);assert.equal(result.rows.length,2);
});

test('single-hand import rejects ambiguous decimal commas and mixed currencies as batch import does',()=>{
 const raw='单位：美元\n盲注：1/2\n公共牌：2c4d6h8sTc\n底池：$2,50\nSB：筹码$100 范围AcAd\nBB：筹码$100 范围KcKd\n先行动：SB';
 assert.equal(parseScenario(raw).ok,false);assert.ok(parseScenario(raw).issues.some(i=>i.code==='unsupported_numeric_format'));
 const mixed=parseScenario(raw.replace('$2,50','$20').replace('SB：筹码$100','SB：筹码€100'));assert.equal(mixed.ok,false);assert.ok(mixed.issues.some(i=>i.code==='mixed_currency'));
 const valid=parseScenario(raw.replace('$2,50','$2,500'));assert.equal(valid.ok,true);assert.equal(valid.scenario.pot,1250);
});

test('decision snapshots and known folded cards cannot silently become a clean new-street root',()=>{
 for(const extra of [{currentBet:5},{toCall:5},{streetContributions:[5,0,0]}]){const v=validateScenario({...sample,...extra});assert.equal(v.ok,false);assert.ok(v.issues.some(i=>i.code==='not_street_root'));assert.equal(validateScenario(v.scenario).ok,false);}
 const folded=structuredClone(sample);folded.players[0].folded=true;assert.ok(validateScenario(folded).issues.some(i=>i.code==='folded_root_player'));
 assert.ok(validateScenario({...sample,deadCards:'AhAs'}).issues.some(i=>i.code==='unsupported_dead_cards'));
});

test('saved sensitivity jobs preserve solver settings and measured completion time without scenario overrides',async()=>{
 const s={...sample,players:sample.players.slice(1).map(p=>({...p,stack:20})),heroSeat:0,toAct:0},baseline=await solveRiverGame(s),dir=fs.mkdtempSync(path.join(os.tmpdir(),'pokerlab-audit-')),resultFile=path.join(dir,'baseline.json');fs.writeFileSync(resultFile,JSON.stringify(baseline));
 try{const messages=await new Promise((resolve,reject)=>{const out=[],worker=new Worker(new URL('../lib/sensitivity-worker.mjs',import.meta.url),{workerData:{input:{scenario:s,settings:baseline.input,player:1,subset:'QcQd',combo:s.hero,scales:[.5,1]},resultFile,jobsDir:dir,sourceJobId:'00000000-0000-0000-0000-000000000001',experimentId:'audit'}});worker.on('message',m=>out.push(m));worker.on('error',reject);worker.on('exit',code=>code?reject(Error(`worker exit ${code}`)):resolve(out));});assert.equal(messages.some(m=>m.type==='error'),false);assert.ok(messages.some(m=>m.type==='result'));const {job}=messages.find(m=>m.type==='variant');assert.equal('players' in job.settings,false);assert.equal('board' in job.settings,false);assert.equal(job.settings.iterations,2);assert.equal(job.seconds,job.result.stats.seconds);assert.ok(Number.isFinite(Date.parse(job.finishedAt)));assert.ok(job.seconds>0);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
