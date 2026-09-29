import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {Worker} from 'node:worker_threads';
const idOK=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
const read=(file,fallback=null)=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fallback;}};
const atomic=(file,value)=>{const tmp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value));fs.renameSync(tmp,file);};
const digest=text=>crypto.createHash('sha256').update(text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').trim()).digest('hex');
const stripRaw=entry=>{const {raw,...rest}=entry;return rest;};
const receiptSummary=record=>{const {raw,...rest}=record;return {...rest,rejected:(rest.rejected??[]).map(stripRaw),unassigned:(rest.unassigned??[]).map(stripRaw)};};
const listSummary=record=>({id:record.id,sourceKey:record.sourceKey,site:record.site,handId:record.handId,status:record.status,eligibleForStudy:record.eligibleForStudy,importedAt:record.importedAt,summary:{...record.summary,streets:record.summary.streets.map(({scenario,...s})=>s)}});

/** Local, append-preserving inbox. Raw histories never leave this server. */
export function createHandHistoryAPI({root,json,body}) {
 const base=path.join(root,'data','pro');for(const dir of ['hands','imports'])fs.mkdirSync(path.join(base,dir),{recursive:true});
 const file=(folder,id)=>{if(!idOK(id))throw Error('无效牌谱编号。');return path.join(base,folder,id+'.json');};
 const list=folder=>fs.existsSync(path.join(base,folder))?fs.readdirSync(path.join(base,folder)).filter(f=>/^[a-f0-9-]{36}\.json$/.test(f)).map(f=>read(path.join(base,folder,f))).filter(Boolean):[];
 let cached=null,receiptCache=null,active=null;
 const invalidateIndex=()=>{cached=null;receiptCache=null;};
 const index=()=>cached??=list('hands').map(listSummary).sort((a,b)=>b.importedAt.localeCompare(a.importedAt));
 const links=()=>{const byHand=new Map();for(const c of list('cases')){const id=c.inputContext?.sourceHandId??c.scenario?.inputContext?.sourceHandId;if(idOK(id)){if(!byHand.has(id))byHand.set(id,[]);byHand.get(id).push(c.id);}}return byHand;};
 const send=(res,value,status=200)=>{json(res,value,status);return true;};
 for(const receipt of list('imports'))if(receipt.status==='running'){receipt.status='interrupted';receipt.error='上次导入在完成前中断；原文已保留，可重新导入并自动去重。';atomic(file('imports',receipt.id),receipt);}
 function shutdown(){if(active){active.record.status='interrupted';active.record.error='工作台关闭，导入中断。原文已保留。';atomic(file('imports',active.record.id),active.record);receiptCache=null;active.worker.terminate();active=null;}}
 function persistBatch(record,batch){
  const bySource=new Map(index().map(h=>[h.sourceKey,h]));
  record.rejected=batch.rejected;record.duplicates=batch.duplicates;record.unassigned=batch.unassigned;record.warnings=batch.warnings;record.assumptions=batch.assumptions;record.handIds=[];
  for(const hand of batch.hands){
   const prior=bySource.get(hand.sourceKey),rawHash=digest(hand.raw);
   if(prior){const original=read(file('hands',prior.id));
    if((original.rawHash??digest(original.raw))===rawHash){record.duplicates.push({index:hand.index,sourceKey:hand.sourceKey,handId:hand.handId,site:hand.site,existingId:prior.id,reason:'这一手已在收件箱中，原文一致；已跳过重复导入。'});continue;}
    const reason='收件箱中已有同一来源编号的不同原文。原记录保留，冲突版本保存在本次导入报告中；请核对后再研究。';
    original.status='needs-review';original.eligibleForStudy=false;original.parse.ok=false;original.parse.issues.push({code:'conflicting_hand_id',severity:'error',message:reason});original.summary.streets.forEach(s=>s.canOpenStudy=false);original.conflictingImports=[...new Set([...(original.conflictingImports??[]),record.id])];atomic(file('hands',prior.id),original);
    record.rejected.push({index:hand.index,sourceKey:hand.sourceKey,handId:hand.handId,site:hand.site,existingId:prior.id,raw:hand.raw,code:'conflicting_hand_id',reason});continue;
   }
   const id=crypto.randomUUID(),saved={...hand,id,rawHash,importId:record.id,importedAt:record.createdAt};atomic(file('hands',id),saved);record.handIds.push(id);bySource.set(saved.sourceKey,listSummary(saved));
  }
  invalidateIndex();record.stats={...batch.stats,imported:record.handIds.length,rejected:record.rejected.length,duplicates:record.duplicates.length};
  const imported=record.handIds.map(id=>read(file('hands',id)));record.stats.parsed=imported.filter(h=>h.status==='parsed').length;record.stats.needsReview=imported.filter(h=>h.status==='needs-review').length;record.stats.preflopOnly=imported.filter(h=>h.status==='preflop-only').length;
 }
 async function handler(req,res,u){
  const p=u.pathname;
  if(p==='/api/pro/hands/import'&&req.method==='POST'){
   if(active)return send(res,{error:'已有牌谱导入正在进行，请稍后再试。'},409);
   const b=await body(req,24*1024*1024);if(typeof b.text!=='string'||!b.text.trim())throw Error('请选择牌谱文本或粘贴原始牌谱。');if(Buffer.byteLength(b.text,'utf8')>16*1024*1024)throw Error('每次导入的原文上限为 16 MB，请分批导入。');if(active)return send(res,{error:'已有牌谱导入正在进行，请稍后再试。'},409);
   const id=crypto.randomUUID(),record={id,status:'running',fileName:String(b.fileName||'粘贴的牌谱').split(/[\\/]/).at(-1).slice(0,256),createdAt:new Date().toISOString(),bytes:Buffer.byteLength(b.text,'utf8'),raw:b.text,handIds:[],rejected:[],duplicates:[],warnings:[],stats:null};
   atomic(file('imports',id),record);receiptCache=null;const worker=new Worker(new URL('./hand-history-worker.mjs',import.meta.url),{workerData:{text:b.text,fileName:record.fileName}});active={record,worker};let finished=false;
   const finish=(status,error)=>{if(finished)return;finished=true;if(record.status==='running')record.status=status;record.finishedAt=new Date().toISOString();if(error&&!record.error)record.error=error;atomic(file('imports',id),record);receiptCache=null;if(active?.record.id===id)active=null;};
   worker.on('message',m=>{if(finished||record.status!=='running')return;if(!m.ok){finish('failed',m.error);return;}try{persistBatch(record,m.result);finish('complete');}catch(e){invalidateIndex();finish('failed',e.message);}});
   worker.on('error',e=>finish('failed',e.message));worker.on('exit',()=>{if(!finished)finish(record.status==='cancelled'?'cancelled':'interrupted',record.error||'导入进程提前结束；原文已保留，重新导入会跳过已有记录。');});
   return send(res,receiptSummary(record));
  }
  if(p==='/api/pro/hand-imports'&&req.method==='GET'){if(!receiptCache)receiptCache=list('imports').sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(receiptSummary);return send(res,receiptCache);}
  const match=p.match(/^\/api\/pro\/hand-imports\/([a-f0-9-]{36})(?:\/(download|cancel))?$/);
  if(match){const [,id,action]=match,record=active?.record.id===id?active.record:read(file('imports',id));if(!record)throw Error('没有找到这次导入。');
   if(action==='download'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="pokerlab-import-${id}.json"`});res.end(JSON.stringify(record,null,2));return true;}
   if(action==='cancel'&&req.method==='POST'&&active?.record.id===id){record.status='cancelled';record.error='导入已取消；原文仍保存在导入报告中。';atomic(file('imports',id),record);receiptCache=null;active.worker.terminate();active=null;}
   if(req.method==='GET'||action==='cancel')return send(res,receiptSummary(record));
  }
  if(p==='/api/pro/hands'&&req.method==='GET'){
   const all=index(),q=(u.searchParams.get('q')??'').trim().toLowerCase(),street=u.searchParams.get('street'),players=Number(u.searchParams.get('players')),site=u.searchParams.get('site'),status=u.searchParams.get('status');
   const offset=Math.max(0,Math.floor(Number(u.searchParams.get('offset'))||0)),limit=Math.min(100,Math.max(1,Math.floor(Number(u.searchParams.get('limit'))||30))),byHand=links();
   const matches=all.filter(h=>(!site||h.site===site)&&(!status||h.status===status)&&(!q||`${h.summary.title} ${h.summary.heroPosition??''} ${h.summary.heroHand??''} ${h.summary.heroName??''} ${h.summary.tableName??''} ${h.handId}`.toLowerCase().includes(q))&&(!street&&!players||h.summary.streets.some(s=>(!street||s.street===street)&&(!players||s.players.length===players))));
   return send(res,{items:matches.slice(offset,offset+limit).map(h=>({...h,caseIds:byHand.get(h.id)??[],reviewed:byHand.has(h.id)})),total:matches.length,offset,limit,facets:{sites:[...new Set(all.map(h=>h.site))].sort(),players:[...new Set(all.flatMap(h=>h.summary.streets.map(s=>s.players.length)))].sort((a,b)=>a-b),streets:['preflop','flop','turn','river'].filter(st=>all.some(h=>h.summary.streets.some(s=>s.street===st)))}});
  }
  const handMatch=p.match(/^\/api\/pro\/hands\/([a-f0-9-]{36})(?:\/(download))?$/);
  if(handMatch&&req.method==='GET'){const [,id,action]=handMatch,record=read(file('hands',id));if(!record)throw Error('没有找到这手牌。');if(action==='download'){res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':`attachment; filename="pokerlab-hand-${id}.txt"`});res.end(record.raw);return true;}return send(res,{...record,caseIds:links().get(id)??[],reviewed:links().has(id)});}
  return false;
 }
 return {handler,shutdown,invalidateIndex,get busy(){return !!active;},get status(){return active?receiptSummary(active.record):null;}};
}
