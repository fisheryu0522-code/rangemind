/** Track only child PIDs reported by this application's own workers.
 * Adaptive GPU verification has two live children at once. A legacy single-PID
 * notification remains supported, but an explicit snapshot is authoritative.
 */
export function createOwnedProcesses({kill=(pid,signal)=>process.kill(pid,signal),pollMs=25,timeoutMs=3000}={}){
 const owners=new Map();
 const valid=pid=>Number.isInteger(pid)&&pid>0;
 const alive=pid=>{try{kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;return true;}};
 function observe(owner,progress){
  if(Array.isArray(progress?.processIds)){
   if(progress.processIds.some(pid=>!valid(pid)))throw Error('子进程状态包含无效编号。');
   owners.set(owner,new Set(progress.processIds));
  }else if(progress&&Object.hasOwn(progress,'processId')){
   if(progress.processId!=null&&!valid(progress.processId))throw Error('子进程状态包含无效编号。');
   owners.set(owner,new Set(progress.processId==null?[]:[progress.processId]));
  }
 }
 const ids=owner=>[...(owners.get(owner)??[])];
 const stop=owner=>{for(const pid of ids(owner))try{kill(pid);}catch{}};
 async function drain(owner){
  stop(owner);const deadline=Date.now()+timeoutMs;
  while(true){
   const remaining=ids(owner).filter(alive);
   if(!remaining.length){owners.delete(owner);return true;}
   if(Date.now()>=deadline)return false;
   // Do not discard a newly reported child while waiting for an older one.
   for(const pid of remaining)try{kill(pid);}catch{}
   await new Promise(resolve=>setTimeout(resolve,pollMs));
  }
 }
 return {observe,ids,stop,drain,forget:owner=>owners.delete(owner),
  stopAll(){for(const owner of owners.keys())stop(owner);},
  async drainAll(){return (await Promise.all([...owners.keys()].map(drain))).every(Boolean);}};
}

/** Give workers a chance to report/close children before forced termination.
 * Draining PIDs must happen AFTER this resolves, when no later spawn can occur.
 */
export function stopWorkerGracefully(worker,{graceMs=2000}={}){
 if(worker.threadId===-1)return Promise.resolve();
 return new Promise((resolve,reject)=>{
  let timer,finished=false;
  const done=()=>{if(finished)return;finished=true;clearTimeout(timer);worker.off('exit',done);resolve();};
  worker.once('exit',done);
  timer=setTimeout(()=>{Promise.resolve(worker.terminate()).then(done,reject);},graceMs);
  try{worker.postMessage({cancel:true});}catch(error){if(worker.threadId===-1)done();else Promise.resolve(worker.terminate()).then(done,reject);}
  if(worker.threadId===-1)done();
 });
}
