import test from 'node:test';
import assert from 'node:assert/strict';
import {createAcceleratorStatus,parseNvidiaGPUCSV,queryNvidiaGPU} from '../lib/hardware.mjs';

test('driver output is parsed without inventing a device or unavailable memory',()=>{
  assert.deepEqual(parseNvidiaGPUCSV('0, NVIDIA GeForce RTX 4090, 24564\r\n1, NVIDIA GB10, [N/A]\r\n'),[
    {index:0,name:'NVIDIA GeForce RTX 4090',memoryMiB:24564},{index:1,name:'NVIDIA GB10',memoryMiB:null}]);
  assert.deepEqual(parseNvidiaGPUCSV('0, "NVIDIA, test", 12000'),[{index:0,name:'NVIDIA, test',memoryMiB:12000}]);
  for(const value of ['', 'x, GPU, 1024','0, GPU','0, "GPU, 1024'])assert.throws(()=>parseNvidiaGPUCSV(value));
});

test('probe uses bounded direct execution without shell and propagates failure',async()=>{
  const devices=await queryNvidiaGPU({execute:(file,args,options,done)=>{
    assert.equal(file,'nvidia-smi');assert.deepEqual(args,['--query-gpu=index,name,memory.total','--format=csv,noheader,nounits']);
    assert.equal(options.shell,false);assert.equal(options.windowsHide,true);assert.equal(options.timeout,2500);
    done(null,'0, NVIDIA GB10, [N/A]');
  }});
  assert.equal(devices[0].name,'NVIDIA GB10');
  await assert.rejects(queryNvidiaGPU({execute:(_file,_args,_options,done)=>done(Error('ENOENT'))}),/ENOENT/);
});

test('simultaneous status requests share a probe and cache expires',async()=>{
  let time=1700000000000,calls=0,finish;
  const status=createAcceleratorStatus({now:()=>time,cacheMs:60000,probe:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}});
  const first=status(),second=status();assert.equal(first,second);assert.equal(calls,1);
  finish([{index:0,name:'Reported GPU',memoryMiB:1024}]);
  const actual=await first;assert.equal(actual.status,'detected');assert.equal(actual.devices[0].name,'Reported GPU');
  assert.ok(Object.isFrozen(actual.devices[0]));await status();assert.equal(calls,1);
  time+=60001;const refresh=status();assert.equal(calls,2);finish([{index:0,name:'New GPU',memoryMiB:null}]);
  assert.equal((await refresh).devices[0].name,'New GPU');
});

test('missing driver fails closed and caches failure without leaking diagnostics',async()=>{
  let calls=0;const status=createAcceleratorStatus({probe:async()=>{calls++;throw Error('private filesystem diagnostic');}});
  const result=await status();assert.equal(result.status,'unavailable');assert.deepEqual(result.devices,[]);
  assert.ok(!JSON.stringify(result).includes('private filesystem'));await status();assert.equal(calls,1);
});
