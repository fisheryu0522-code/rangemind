import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createOwnedProcesses} from '../lib/owned-processes.mjs';

test('full child snapshots preserve GPU while independent CPU exits',()=>{
 const p=createOwnedProcesses(),owner={};p.observe(owner,{processIds:[11,12],processId:12});
 assert.deepEqual(p.ids(owner),[11,12]);p.observe(owner,{processIds:[11],processId:null,exitedProcessId:12});
 assert.deepEqual(p.ids(owner),[11]);p.observe(owner,{iterations:20});assert.deepEqual(p.ids(owner),[11]);
 p.observe(owner,{processIds:[],processId:null});assert.deepEqual(p.ids(owner),[]);
 assert.throws(()=>p.observe(owner,{processIds:[-1]}),/无效/);
});

test('legacy events are accepted and unrelated owners are not terminated',async()=>{
 const live=new Set([11,12,13]),stopped=[];
 const p=createOwnedProcesses({kill:(pid,signal)=>{if(!live.has(pid)){const e=Error();e.code='ESRCH';throw e;}if(signal!==0){stopped.push(pid);live.delete(pid);}}});
 p.observe('one',{processId:11});p.observe('two',{processIds:[12,13]});assert.equal(await p.drain('one'),true);
 assert.deepEqual(stopped,[11]);assert.deepEqual(p.ids('two'),[12,13]);assert.equal(await p.drainAll(),true);
});

test('failed termination stays tracked rather than claiming resources are free',async()=>{
 const p=createOwnedProcesses({kill:(_pid,signal)=>{if(signal!==0){const e=Error();e.code='EPERM';throw e;}},timeoutMs:10,pollMs:2});
 p.observe('blocked',{processIds:[17]});assert.equal(await p.drain('blocked'),false);assert.deepEqual(p.ids('blocked'),[17]);
});

test('two actual owned children close before resource release; unrelated child survives',async()=>{
 const children=Array.from({length:3},()=>spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'}));
 await Promise.all(children.map(child=>once(child,'spawn')));const closed=children.map(child=>once(child,'close'));
 const p=createOwnedProcesses();p.observe('calculation',{processIds:children.slice(0,2).map(c=>c.pid)});
 try{assert.equal(await p.drain('calculation'),true);await Promise.all(closed.slice(0,2));assert.doesNotThrow(()=>process.kill(children[2].pid,0));}
 finally{for(const child of children)child.kill();await Promise.all(closed);}
});
