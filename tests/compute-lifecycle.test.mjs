import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createProAPI} from '../lib/pro-server.mjs';

test('cancellation holds the computation gate until owned children finish, then a fresh solve succeeds',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pokerlab-lifecycle-'));let payload,status;
 const api=createProAPI({root,json:(_res,value,code=200)=>{payload=value;status=code;},body:async req=>req.body??{}});
 const request=async(route,body,method=body===undefined?'GET':'POST')=>{payload=undefined;status=undefined;await api.handler({method,body},{},new URL('http://localhost'+route));return {value:payload,status};};
 const scenario={title:'Lifecycle test',format:'study',board:'Ks 7h 2h 9c 3s',pot:20,hero:'AcKd',heroSeat:0,toAct:0,players:[{id:'oop',name:'OOP',position:'BB',stack:50,range:'AA,KK,77,22,AKs,AKo,AQs,AJs,QJs'},{id:'ip',name:'IP',position:'BTN',stack:50,range:'AA,KK,99,77,22,AKs,AKo,AQs,AJs,QJs'}]};
 const settings={iterations:1000000,accuracy:0,checkEvery:1000,sizes:[.5],raiseSizes:[1],maxRaises:1,allIn:false,maxSeconds:30,threads:1};
 try{
  const first=(await request('/api/pro/solve',{scenario,settings})).value;assert.equal(first.status,'running');
  // Cancel before child launch as well as allowing any late process-start
  // notification to be captured and stopped by the cancellation state.
  const cancel=await request(`/api/pro/jobs/${first.id}/cancel`,{});assert.equal(cancel.value.status,'cancelling');
  assert.equal((await request('/api/pro/solve',{scenario,settings})).status,409);
  let current;const deadline=Date.now()+10000;
  while(Date.now()<deadline){current=(await request(`/api/pro/jobs/${first.id}`)).value;if(current.status==='cancelled')break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(current.status,'cancelled');assert.equal(current.result,undefined);assert.equal(JSON.stringify(current).includes('processId'),false);
  assert.equal((await request('/api/pro/status')).value.activeJobs.length,0);
  const second=(await request('/api/pro/solve',{scenario,settings:{...settings,iterations:100,accuracy:null}})).value;
  assert.equal(second.status,'running');
  const nextDeadline=Date.now()+10000;while(Date.now()<nextDeadline){current=(await request(`/api/pro/jobs/${second.id}`)).value;if(current.status!=='running')break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(current.status,'complete',current.error);assert.equal(current.result.stats.iterations,100);
 }finally{await api.shutdown();if(root.startsWith(path.resolve(os.tmpdir())+path.sep))fs.rmSync(root,{recursive:true,force:true});}
});
