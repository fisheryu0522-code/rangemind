import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createProAPI} from '../lib/pro-server.mjs';
import {exportUserData,restoreUserData} from '../lib/backup.mjs';
const scenario={title:'范围待补的实战牌谱',board:'Ks7h2d9c3s',pot:20,hero:'AcKd',heroSeat:1,toAct:0,players:[{id:'bb',name:'对手',position:'BB',range:'',stack:80},{id:'btn',name:'Hero',position:'BTN',range:'',stack:90}]};
const setup=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'pokerlab-case-draft-'));const api=createProAPI({root,json:(res,value)=>{res.value=value;},body:async req=>req.payload});t.after(()=>{api.shutdown();fs.rmSync(root,{recursive:true,force:true});});return {root,api};};
const call=async(api,route,payload)=>{const res={};await api.handler({method:payload?'POST':'GET',payload},res,new URL(route,'http://localhost'));return res.value;};
test('incomplete ranges save as a draft with source and settings, restore intact, but never solve',async t=>{
 const {root,api}=setup(t),other=setup(t),settings={algorithm:'dcfr',sizes:[50],raiseSizes:[100],iterations:3000,accuracy:.1,maxNodeVisits:200000000000},context={raw:'本地原文',sourceHandId:'99999999-9999-4999-8999-999999999999'};
 const entry=await call(api,'/api/pro/cases',{scenario,settings,inputContext:context});assert.equal(entry.draft,true);assert.equal(entry.needsRanges,true);assert.deepEqual(entry.settings,settings);assert.deepEqual(entry.inputContext,context);
 await assert.rejects(call(api,'/api/pro/solve',{scenario,settings}),/范围尚未指定/);const restored=restoreUserData(other.root,exportUserData(root));assert.equal(restored.imported,1);const cases=await call(other.api,'/api/pro/cases');assert.equal(cases[0].draft,true);assert.equal(cases[0].inputContext.raw,'本地原文');
 const complete=structuredClone(scenario);complete.players[0].range='AhQh';complete.players[1].range='AcKd';const updated=await call(api,'/api/pro/cases',{id:entry.id,scenario:complete});assert.equal(updated.draft,false);assert.deepEqual(updated.settings,settings);assert.deepEqual(updated.inputContext,context);
});
