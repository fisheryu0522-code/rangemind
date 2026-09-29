import {execFile} from 'node:child_process';

// Device discovery is intentionally separate from kernel compatibility. A PTX
// file on disk and a successful nvidia-smi query do not prove a solve will run.
export function parseNvidiaGPUCSV(text) {
  const lines=String(text).trim().split(/\r?\n/).filter(Boolean);
  if(!lines.length)throw Error('No NVIDIA GPU reported');
  return lines.map(line=>{
    const fields=[];let field='',quoted=false;
    for(let i=0;i<line.length;i++){
      const char=line[i];
      if(char==='"'&&quoted&&line[i+1]==='"'){field+='"';i++;}
      else if(char==='"')quoted=!quoted;
      else if(char===','&&!quoted){fields.push(field.trim());field='';}
      else field+=char;
    }
    fields.push(field.trim());
    if(quoted||fields.length!==3)throw Error('Malformed NVIDIA GPU report');
    const [rawIndex,name,rawMemory]=fields,index=Number(rawIndex),memoryMiB=Number(rawMemory);
    if(!/^\d+$/.test(rawIndex)||!Number.isSafeInteger(index)||!name||name.length>256)throw Error('Invalid NVIDIA GPU report');
    return {index,name,memoryMiB:/^\d+(?:\.\d+)?$/.test(rawMemory)&&memoryMiB>0?memoryMiB:null};
  });
}

export function queryNvidiaGPU({execute=execFile}={}) {
  return new Promise((resolve,reject)=>{
    execute('nvidia-smi',['--query-gpu=index,name,memory.total','--format=csv,noheader,nounits'],
      {windowsHide:true,timeout:2500,maxBuffer:64*1024,encoding:'utf8',shell:false},
      (error,stdout)=>{if(error)reject(error);else{try{resolve(parseNvidiaGPUCSV(stdout));}catch(e){reject(e);}}});
  });
}

export function createAcceleratorStatus({probe=queryNvidiaGPU,now=Date.now,cacheMs=60000}={}) {
  let cache=null,expiresAt=0,pending=null;
  return function acceleratorStatus(){
    if(cache&&now()<expiresAt)return Promise.resolve(cache);
    if(pending)return pending;
    pending=(async()=>{
      let devices=[],status='unavailable';
      try{devices=await probe();if(!Array.isArray(devices)||!devices.length)throw Error('No devices');status='detected';}
      catch{devices=[];}
      const queriedAt=new Date(now()).toISOString();
      cache=Object.freeze({status,source:'nvidia-smi',queriedAt,devices:Object.freeze(devices.map(x=>Object.freeze({...x}))),
        note:status==='detected'?'设备由本机驱动报告；内核兼容性和性能以实际任务验证为准。':'未取得本机 NVIDIA GPU 信息；未推定设备型号或 CUDA 可用性。'});
      expiresAt=now()+cacheMs;
      return cache;
    })().finally(()=>{pending=null;});
    return pending;
  };
}
