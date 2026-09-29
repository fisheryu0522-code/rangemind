import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {prepareEquityExplorer} from './equity-explorer.mjs';
import {assertBoardContrast,compareBoards} from './board-contrast.mjs';
import {compareBoardMechanism} from './board-mechanism.mjs';
import {normalizeScenario} from './scenario.mjs';
import {cards,cardText} from './poker.mjs';
import {assertSolutionScenario} from './solution-identity.mjs';
import {createOwnedProcesses,stopWorkerGracefully} from './owned-processes.mjs';
const hash=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex'),uuid=()=>crypto.randomUUID(),now=()=>new Date().toISOString();
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
const atomic=(file,v)=>{const temp=file+'.'+uuid()+'.tmp';fs.writeFileSync(temp,JSON.stringify(v));fs.renameSync(temp,file);};
const activeStatus=s=>['running','cancelling','cleanup-required'].includes(s);
export function createResearchAPI({root,json,body,getJob,getResult,startPolicySolve,decisionDetails,policyBusy=()=>false,releaseGPU=async()=>{}}){
 const base=path.join(root,'data/pro'),folders=['equity-explorations','board-contrasts'],active=new Map(),owned=createOwnedProcesses();let closing=false,starting=false;
 for(const folder of folders)fs.mkdirSync(path.join(base,folder),{recursive:true});
 const file=(folder,id)=>{if(typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))throw Error('研究记录编号无效。');return path.join(base,folder,id+'.json');};
 const list=folder=>fs.readdirSync(path.join(base,folder)).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).map(n=>read(path.join(base,folder,n))).filter(Boolean).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
 const save=(folder,r)=>atomic(file(folder,r.id),r),get=(folder,id)=>{const r=read(file(folder,id));if(!r)throw Error('找不到这份研究记录。');return r;};
 const brief=r=>({id:r.id,kind:r.kind,title:r.input?.title??r.title,createdAt:r.createdAt,finishedAt:r.finishedAt,status:r.status,progress:r.progress,error:r.error,board:r.input?.board,stages:r.input?.stages?.map(s=>({id:s.id,label:s.label})),sourceJobId:r.sourceJobId,alternativeJobId:r.alternativeJobId});
 const busy=()=>starting||active.size>0,checkOpen=()=>{if(closing)throw Error('研究台正在关闭，请重新打开后操作。');};
 const relatedJob=id=>{try{return getJob(id);}catch{return {id,status:'unavailable',error:'找不到关联求解；保留历史实验，重新载入原模型后计算。'};}};
 for(const r of list('equity-explorations'))if(activeStatus(r.status)){r.status='interrupted';r.error='上次批处理未完成，未发布部分结果；可载入参数重新计算。';delete r.result;save('equity-explorations',r);}
 function stop(entry,status='cancelled'){
  entry.stopStatus=status;entry.record.status='cancelling';entry.record.progress={phase:'cancelling'};save('equity-explorations',entry.record);entry.worker.postMessage({cancel:true});owned.stop(entry.worker);
  clearTimeout(entry.killTimer);entry.killTimer=setTimeout(()=>entry.worker.terminate(),2000);
 }
 async function startEquity(input){
  checkOpen();const prepared=prepareEquityExplorer(input);if(busy()||policyBusy())throw Object.assign(Error('已有计算正在使用研究资源，请等待结束或取消。'),{statusCode:409});starting=true;
  try{
   if(prepared.engine==='gpu')await releaseGPU();checkOpen();if(policyBusy())throw Object.assign(Error('另一项计算刚开始，请稍后重试。'),{statusCode:409});
   const r={id:uuid(),kind:'equity-exploration',createdAt:now(),status:'running',input:prepared,progress:{phase:'preparing'}},worker=new Worker(new URL('./equity-explorer-worker.mjs',import.meta.url),{workerData:{input:prepared}}),entry={record:r,worker,stopStatus:null,settling:null};active.set(r.id,entry);save('equity-explorations',r);
   entry.timer=setTimeout(()=>stop(entry,'interrupted'),240000);
   const finish=(status,error,result)=>{if(entry.settling)return entry.settling;entry.settling=(async()=>{if(!await owned.drain(worker)){r.status='cleanup-required';r.error='权益计算尚未完全停止，请再次取消。';save('equity-explorations',r);entry.settling=null;return;}clearTimeout(entry.timer);clearTimeout(entry.killTimer);r.status=entry.stopStatus??status;r.finishedAt=now();if(error)r.error=error;if(result&&!entry.stopStatus)r.result=result;save('equity-explorations',r);active.delete(r.id);})();return entry.settling;};entry.finish=finish;
   worker.on('message',m=>{if(m.type==='progress'){owned.observe(worker,m.progress);if(entry.stopStatus)owned.stop(worker);const {processId,processIds,...visible}=m.progress;if(!entry.stopStatus&&Object.keys(visible).length)r.progress=visible;}if(m.type==='result')finish('complete',null,m.result);if(m.type==='error')finish('failed',m.error);});
   worker.on('error',e=>finish('failed',e.message));worker.on('exit',()=>finish('interrupted','权益批处理未完成。'));return brief(r);
  }finally{starting=false;}
 }
 async function handler(req,res,u){
  const p=u.pathname;if(!p.startsWith('/api/pro/equity-explorations')&&!p.startsWith('/api/pro/board-contrasts'))return false;checkOpen();
  if(p==='/api/pro/equity-explorations'){
   if(req.method==='GET')return json(res,list('equity-explorations').map(brief));
   if(req.method==='POST'){const b=await body(req);return json(res,await startEquity(b));}
  }
  const eq=p.match(/^\/api\/pro\/equity-explorations\/([a-f0-9-]{36})(?:\/(cancel|export))?$/);
  if(eq){const entry=active.get(eq[1]),r=entry?.record??get('equity-explorations',eq[1]);if(eq[2]==='cancel'&&req.method==='POST'){await body(req);if(entry)stop(entry);return json(res,brief(r));}if(!eq[2]&&req.method==='GET')return json(res,r);if(eq[2]==='export'&&req.method==='GET')return json(res,{app:'PokerLab',exportedAt:now(),record:r});}
  if(p==='/api/pro/board-contrasts'){
   if(req.method==='GET')return json(res,list('board-contrasts').map(r=>({...brief(r),status:relatedJob(r.alternativeJobId).status})));
   if(req.method==='POST'){
    const b=await body(req),source=getJob(b.sourceJobId),original=getResult(b.sourceJobId);if(source.status!=='complete')throw Error('请先完成原牌面的策略求解。');
    if(source.settings?.locks?.length)throw Error('当前换牌实验暂不复制节点锁定；请先保存一份无锁定的原模型，避免组合编号变化误移锁定。');
    assertSolutionScenario(source.scenario,original,{settings:source.settings});
    if(original.chance?.exact!==true)throw Error('换牌策略实验需要完整机会模型，请先用精确机会模式求解 A。');
    const nodePath=b.nodePath??[];if(!Array.isArray(nodePath)||nodePath.length>120||nodePath.some(x=>typeof x!=='string'||x.length>256))throw Error('对照路径无效。');
    const nodes=new Map(original.nodes.map(n=>[n.id,n]));let selected=nodes.get('n0');for(const step of nodePath){selected=nodes.get(selected?.actions?.find(a=>a.id===step)?.childId);if(!selected)throw Error('对照路径不存在于原模型。');}if(!selected||selected.actor<0||selected.terminal||selected.chance||selected.outOfScope)throw Error('请选择已完整导出的玩家决策节点。');
    const combo=b.combo?cards(b.combo,[2]).map(cardText).join(''):null;
    const scenario=normalizeScenario({...source.scenario,title:source.scenario.title+' · 换牌对照',format:'study',board:b.board}),change=assertBoardContrast(source.scenario,scenario),at=now();
    const prediction=String(b.prediction??'').trim().slice(0,5000),exposure=b.exposure??'unknown';if(!['unseen','seen','unknown'].includes(exposure))throw Error('答案暴露记录无效。');
    const inputContext=source.inputContext?.raw?{...source.inputContext,provenance:{kind:'hypothetical-fork',reason:`单因素换牌研究：${change.from} 替换为 ${change.to}，范围、筹码与树模板保持原输入。`}}:null;
    const newJob=await startPolicySolve({scenario,settings:source.settings,inputContext});
    const r={id:uuid(),kind:'board-contrast',title:scenario.title,createdAt:at,sourceJobId:source.id,alternativeJobId:newJob.id,sourceFingerprint:hash(original),change,prediction,reportedExposure:exposure,nodePath,combo,meaning:'先保存预测，再对仅更换一张公共牌的完整模型重新求解。'};save('board-contrasts',r);return json(res,{...r,status:newJob.status,job:newJob});
   }
  }
  const bc=p.match(/^\/api\/pro\/board-contrasts\/([a-f0-9-]{36})(?:\/(report|mechanism|export))?$/);
  if(bc){const r=get('board-contrasts',bc[1]);if(!bc[2]&&req.method==='GET'){const job=relatedJob(r.alternativeJobId);return json(res,{...r,status:job.status,job});}
   if(['report','mechanism'].includes(bc[2])&&req.method==='POST'){
    const b=await body(req),a=getJob(r.sourceJobId),alt=getJob(r.alternativeJobId);if(alt.status!=='complete')throw Error('两边求解完成后才能比较，尚未发布部分策略。');
    const resultA=getResult(a.id),resultB=getResult(alt.id);if(hash(resultA)!==r.sourceFingerprint)throw Error('原参考策略已改变，不能继续使用旧预测作同一实验。');
    const report=compareBoards(a.scenario,resultA,alt.scenario,resultB,{nodePath:b.nodePath??r.nodePath,combo:b.combo??r.combo,toleranceBB:b.toleranceBB??.1});
    if(bc[2]==='mechanism'){
     if(!report.focus?.scoreable)throw Error('先选择两边都有完整动作收益的共同组合。');if(busy()||policyBusy())throw Object.assign(Error('先等待当前计算结束，再独立重算两份收益账本。'),{statusCode:409});starting=true;
     try{const nodeId=result=>{const nodes=new Map(result.nodes.map(n=>[n.id,n]));let n=nodes.get('n0');for(const id of report.nodePath)n=nodes.get(n.actions.find(a=>a.id===id).childId);return n.id;};const settled=await Promise.allSettled([decisionDetails(a.id,nodeId(resultA),report.focus.combo),decisionDetails(alt.id,nodeId(resultB),report.focus.combo)]);for(const item of settled)if(item.status==='rejected')throw item.reason;checkOpen();return json(res,{record:r,report,mechanism:compareBoardMechanism(report,settled[0].value,settled[1].value,{baselineActionId:b.baselineActionId})});}finally{starting=false;}
    }
    return json(res,{record:r,report});
   }
   if(bc[2]==='export'&&req.method==='GET')return json(res,{app:'PokerLab',exportedAt:now(),record:r});
  }
  return false;
 }
 return {handler,get busy(){return busy();},get active(){return [...active.values()].map(x=>brief(x.record));},async shutdown(){closing=true;const entries=[...active.values()];entries.forEach(e=>stop(e,'interrupted'));await Promise.all(entries.map(e=>stopWorkerGracefully(e.worker)));return owned.drainAll();}};
}
