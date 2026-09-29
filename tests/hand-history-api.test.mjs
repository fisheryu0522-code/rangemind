import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createHandHistoryAPI} from '../lib/hand-history-api.mjs';
import {IMPORT_EXAMPLES} from '../lib/scenario.mjs';
import {exportUserData,restoreUserData} from '../lib/backup.mjs';
const stars=IMPORT_EXAMPLES.find(x=>x.id==='stars-example').text;
const setup=t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'pokerlab-inbox-test-')),api=createHandHistoryAPI({root,json:(res,value,status=200)=>{res.value=value;res.status=status;},body:async req=>req.payload});t.after(()=>{api.shutdown();fs.rmSync(root,{recursive:true,force:true});});return {root,api};};
async function call(api,url,payload){const res={};const handled=await api.handler({method:payload?'POST':'GET',payload},res,new URL(url,'http://localhost'));assert.equal(handled,true);return res;}
async function importText(api,text){const response=await call(api,'/api/pro/hands/import',{text,fileName:'C:\\cards\\cash.txt'});assert.equal(response.status,200);const id=response.value.id;for(let n=0;n<500;n++){const r=(await call(api,'/api/pro/hand-imports/'+id)).value;if(r.status!=='running')return r;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Import timed out');}

test('async inbox preserves source, filters street players, links saved studies and survives restart',async t=>{
 const {root,api}=setup(t),receipt=await importText(api,stars);assert.equal(receipt.status,'complete');assert.equal(receipt.stats.imported,1);assert.equal(receipt.raw,undefined);
 const list=(await call(api,'/api/pro/hands?street=flop&players=3')).value;assert.equal(list.total,1);assert.equal(list.items[0].summary.streets[1].scenario,undefined);assert.equal(list.items[0].reviewed,false);
 assert.equal((await call(api,'/api/pro/hands?street=turn&players=3')).value.total,0);const id=list.items[0].id,full=(await call(api,'/api/pro/hands/'+id)).value;assert.equal(full.raw,stars);assert.ok(full.summary.streets[1].scenario);assert.equal(JSON.stringify(full.summary).includes('Ah Qh'),false);
 const caseId=crypto.randomUUID();fs.mkdirSync(path.join(root,'data/pro/cases'),{recursive:true});fs.writeFileSync(path.join(root,'data/pro/cases',caseId+'.json'),JSON.stringify({id:caseId,scenario:full.summary.streets[1].scenario,inputContext:{sourceHandId:id}}));assert.deepEqual((await call(api,'/api/pro/hands/'+id)).value.caseIds,[caseId]);
 api.shutdown();const restarted=createHandHistoryAPI({root,json:(res,v)=>res.value=v,body:async req=>req.payload});t.after(()=>restarted.shutdown());assert.equal((await call(restarted,'/api/pro/hands?q=20260928001')).value.total,1);
});

test('cross-file duplicates deduplicate; conflicting source ID blocks first without overwriting raw',async t=>{
 const {api}=setup(t),first=await importText(api,stars),again=await importText(api,'\uFEFF'+stars.replace(/\n/g,'\r\n'));assert.equal(again.stats.imported,0);assert.equal(again.stats.duplicates,1);
 const conflict=await importText(api,stars.replace('Total pot $11.25','Total pot $99.25'));assert.equal(conflict.stats.imported,0);assert.equal(conflict.stats.rejected,1);assert.equal(conflict.rejected[0].raw,undefined);const h=(await call(api,'/api/pro/hands/'+first.handIds[0])).value;assert.equal(h.raw,stars);assert.equal(h.status,'needs-review');assert.equal(h.eligibleForStudy,false);assert.ok(h.summary.streets.every(s=>!s.canOpenStudy));
});

test('unsupported neighbors remain in recoverable import records and backups restore entire inbox',async t=>{
 const {root,api}=setup(t),dst=setup(t),unsupported=stars.replace('#20260928001','#PLO').replace("Hold'em No Limit",'Omaha Pot Limit'),receipt=await importText(api,stars+'\n'+unsupported);assert.equal(receipt.stats.imported,1);assert.equal(receipt.stats.rejected,1);
 const saved=JSON.parse(fs.readFileSync(path.join(root,'data/pro/imports',receipt.id+'.json')));assert.equal(saved.rejected[0].raw,unsupported);const data=exportUserData(root);assert.equal(data.records.hands.length,1);assert.equal(data.records.imports.length,1);
 const restored=restoreUserData(dst.root,data);assert.equal(restored.imported,2);dst.api.invalidateIndex();assert.equal((await call(dst.api,'/api/pro/hands')).value.total,1);assert.equal((await call(dst.api,'/api/pro/hands/'+receipt.handIds[0])).value.raw,stars+'\n');
});

test('oversized and empty submissions create no import; running receipts recover as interrupted',async t=>{
 const {root,api}=setup(t);await assert.rejects(call(api,'/api/pro/hands/import',{text:''}),/牌谱/);await assert.rejects(call(api,'/api/pro/hands/import',{text:'x'.repeat(16*1024*1024+1)}),/16 MB/);assert.equal((await call(api,'/api/pro/hand-imports')).value.length,0);
 const id=crypto.randomUUID();fs.writeFileSync(path.join(root,'data/pro/imports',id+'.json'),JSON.stringify({id,status:'running',createdAt:new Date().toISOString(),raw:stars,handIds:[]}));const recovered=createHandHistoryAPI({root,json:(res,v)=>res.value=v,body:async req=>req.payload});t.after(()=>recovered.shutdown());assert.equal((await call(recovered,'/api/pro/hand-imports/'+id)).value.status,'interrupted');
});
