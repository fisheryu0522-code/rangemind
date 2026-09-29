import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createProAPI} from '../lib/pro-server.mjs';
import {parseScenario,IMPORT_EXAMPLES} from '../lib/scenario.mjs';
import {parseHandHistoryBatch} from '../lib/hand-history-batch.mjs';
import {solveRiverGame} from '../lib/river-engine.mjs';
import {solveSettings} from '../lib/solve-settings.mjs';

function setup(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pokerlab-input-api-'));
 const api=createProAPI({root,json:(res,value,status=200)=>Object.assign(res,{value,status}),body:async req=>req.body??{}});
 const call=async(route,body)=>{const res={};await api.handler({method:body===undefined?'GET':'POST',body},res,new URL(route,'http://localhost'));return res.value;};
 t.after(async()=>{await api.shutdown();assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});
 const write=(folder,id,value)=>{const file=path.join(root,'data/pro',folder,id+'.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
 return {root,api,call,write};
}
const raw='六人桌现金局，SB/BB 为 0.5/1 BB。BTN 100 BB，SB 100 BB，BB 100 BB。其他人弃牌。BTN 加注到 3 BB，SB 跟注，BB 弃牌。翻牌 Qh Ts 7h，SB 过牌，BTN 下注 6 BB，SB 加注 18 BB。我在 SB，持 Ah Jh。';
const riverRaw=IMPORT_EXAMPLES.find(e=>e.id==='heads-up-river')?.text??IMPORT_EXAMPLES.find(e=>e.format==='notation'&&!e.id.includes('three')).text;
const context=(text,parsed)=>({raw:text,sourceUnit:'BB',sourceBigBlind:1,ledger:parsed.ledger,issues:parsed.issues});

test('unresolved imported input can be saved, but cannot launch solve, equity or evidence coaching',async t=>{
 const h=setup(t),parsed=parseScenario(raw,{unit:'BB'}),scenario=structuredClone(parsed.scenario),ctx={...context(raw,parsed),issues:[],checked:true};
 scenario.players[0].range='AhJh';scenario.players[1].range='AcAd';
 const saved=await h.call('/api/pro/cases',{scenario,inputContext:ctx});assert.ok(saved.id);
 for(const route of ['/api/pro/solve','/api/pro/analyze','/api/pro/coach'])await assert.rejects(h.call(route,{scenario,inputContext:ctx,engine:'cpu',localModel:false}),/未解决.*加注/);
 assert.equal((await h.call('/api/pro/jobs')).length,0);assert.equal((await h.call('/api/pro/status')).analyzing,false);
});

test('the API uses a locally stored hand and canonical ledger rather than a supplied hand or checked flag',async t=>{
 const h=setup(t),text=IMPORT_EXAMPLES.find(e=>e.id==='stars-example').text,id=crypto.randomUUID(),hand={...parseHandHistoryBatch(text).hands[0],id};
 const parsed=await h.call('/api/pro/parse',{text,format:'auto',bigBlind:1});assert.equal(parsed.metadata.bigBlind,.25);
 const ctx={...context(text,parsed),sourceHandId:id,ledger:[{type:'fold',amount:999}],issues:[],checked:true};
 await assert.rejects(h.call('/api/pro/input-provenance',{scenario:parsed.scenario,inputContext:ctx,hand}),/找不到这个本地/);
 h.write('hands',id,hand);const checked=await h.call('/api/pro/input-provenance',{scenario:parsed.scenario,inputContext:ctx});
 assert.equal(checked.sourceVerified,true);assert.equal(checked.inputContext.sourceBigBlind,.25);assert.notDeepEqual(checked.inputContext.ledger,ctx.ledger);assert.equal(checked.inputContext.checked,undefined);
});

test('stored hypothetical provenance cannot be replaced by a client original-hand context during navigation',async t=>{
 const h=setup(t),parsed=parseScenario(riverRaw,{unit:'BB'}),scenario=parsed.scenario,ctx=context(riverRaw,parsed),fork={...ctx,provenance:{kind:'hypothetical-fork',reason:'检验同一街起点的另一组范围，不代表原牌已经核实。'}};
 const result=await solveRiverGame({...scenario,sizes:[50],raiseSizes:[],maxRaises:0,iterations:100}),id=crypto.randomUUID();
 h.write('jobs',id,{id,status:'complete',scenario,inputContext:fork,settings:solveSettings(result.input)});
 const dir=path.join(h.root,'data/pro/jobs',id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result));
 await assert.rejects(h.call(`/api/pro/jobs/${id}/observed-path`,{inputContext:ctx}),/假设模型|手动或假设/);
 const node=await h.call(`/api/pro/jobs/${id}/node`,{path:[]});assert.equal(node.inputProvenance.kind,'hypothetical-fork');assert.equal(node.inputProvenance.sourceVerified,false);
});

test('old source errors remain visible as model-only history and cannot launch a new real-hand sensitivity study',async t=>{
 const h=setup(t),parsed=parseScenario(riverRaw,{unit:'BB'}),scenario=parsed.scenario;
 const result=await solveRiverGame({...scenario,sizes:[50],raiseSizes:[],maxRaises:0,iterations:100}),id=crypto.randomUUID();
 h.write('jobs',id,{id,status:'complete',scenario,inputContext:{raw,issues:[],sourceUnit:'BB',sourceBigBlind:1},settings:solveSettings(result.input)});
 const dir=path.join(h.root,'data/pro/jobs',id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result));
 const node=await h.call(`/api/pro/jobs/${id}/node`,{path:[]});assert.equal(node.inputProvenance.kind,'unverified-legacy');assert.equal(node.inputProvenance.sourceVerified,false);assert.ok(node.node.actions.length);
 await assert.rejects(h.call(`/api/pro/jobs/${id}/sensitivity`,{player:1,subset:'AA',combo:scenario.hero,scales:[.5,1]}),/未解决/);
 assert.equal((await h.call('/api/pro/status')).activeExperiments.length,0);
});
