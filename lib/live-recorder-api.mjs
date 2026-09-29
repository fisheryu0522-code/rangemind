import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {summarizeLiveRecording} from './live-recording-record.mjs';

const idOK=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
const atomic=(file,value)=>{const temp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(value));fs.renameSync(temp,file);};
const now=()=>new Date().toISOString();

/** Persistent manual hand records are input material, never training scores.
 * Every action is reconstructed by the same betting ledger rules. Revision
 * checks make retries/double clicks harmless instead of duplicating chips.
 */
export function createLiveRecorderAPI({root,json,body}){
 const directory=path.join(root,'data','pro','live-recordings');fs.mkdirSync(directory,{recursive:true});
 const file=id=>{if(!idOK(id))throw Error('现场记录编号无效。');return path.join(directory,id+'.json');};
 const get=id=>{const record=read(file(id));if(!record)throw Error('找不到这份现场记录。');return record;};
 const save=record=>atomic(file(record.id),record);
 const checkRevision=(record,value)=>{if(!Number.isInteger(value)||value!==record.revision)throw Error('记录已更新，请重新打开当前记录后操作；本次没有重复添加行动。');};
 const summary=record=>({id:record.id,kind:record.kind,createdAt:record.createdAt,updatedAt:record.updatedAt,revision:record.revision,...record.summary});
 const brief=summarizeLiveRecording;
 async function handler(req,res,u){
  const p=u.pathname;if(!p.startsWith('/api/pro/live-recordings'))return false;
  const engine=await import('./live-recorder.mjs');
  const expose=record=>{const reconstructed=engine.replayLiveRecorder(record.draft);return {...record,...reconstructed,draft:reconstructed.draft??record.draft};};
  if(p==='/api/pro/live-recordings/options'&&req.method==='GET')return json(res,{positionsByCount:Object.fromEntries(Array.from({length:8},(_,i)=>[i+2,engine.liveRecorderPositions(i+2)])),defaults:{unit:'currency',smallBlind:1,bigBlind:3,playerCount:6,stack:300},limits:['标准无 ante、无 straddle 的无限注德州扑克现金局。','发牌前筹码须不少于一个大盲；本轮不建模不足大盲的强制盲注。','缺失的前序行动不自动推断，可保存草稿或另建明确的街起点假设。']});
  if(p==='/api/pro/live-recordings'){
   if(req.method==='GET'){
    const all=fs.readdirSync(directory).filter(f=>/^[a-f0-9-]{36}\.json$/.test(f)).map(f=>read(path.join(directory,f))).filter(Boolean).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
    const offset=Math.max(0,Math.floor(Number(u.searchParams.get('offset'))||0)),limit=Math.max(1,Math.min(100,Math.floor(Number(u.searchParams.get('limit'))||30)));
    return json(res,{items:all.slice(offset,offset+limit).map(summary),total:all.length,offset,limit});
   }
   if(req.method==='POST'){
    const config=await body(req),draft=engine.createLiveRecorder(config.config??config),reconstructed=engine.replayLiveRecorder(draft),at=now();
    const record={id:crypto.randomUUID(),kind:'live-recording',createdAt:at,updatedAt:at,revision:0,draft:reconstructed.draft??draft,summary:brief(draft,reconstructed.view)};save(record);return json(res,{...record,...reconstructed,draft:record.draft});
   }
  }
  const match=p.match(/^\/api\/pro\/live-recordings\/([a-f0-9-]{36})(?:\/(actions|undo|study|export))?$/);if(!match)return false;
  const [,id,action]=match;
  if(!action&&req.method==='GET')return json(res,expose(get(id)));
  if(action==='export'&&req.method==='GET'){
   const record=get(id),view=expose(record);res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="pokerlab-live-${id}.json"`});res.end(JSON.stringify({app:'PokerLab',kind:'live-recording-export',exportedAt:now(),record,raw:view.inputContext?.raw??view.parse?.raw??null},null,2));return true;
  }
  if(['actions','undo','study'].includes(action)&&req.method==='POST'){
   const b=await body(req),record=get(id);checkRevision(record,b.revision);
   if(action==='study'){
    const study=engine.buildLiveRecorderStudy(record.draft,{actionIndex:b.actionIndex,street:b.street});
    if(!(record.studySnapshots??[]).some(s=>s.revision===record.revision)){record.studySnapshots=[...(record.studySnapshots??[]),{revision:record.revision,createdAt:now(),draft:structuredClone(record.draft)}];save(record);}
    const inputContext={...study.inputContext,sourceRecordingId:record.id,sourceRecordingRevision:record.revision,...(Number.isInteger(study.targetLedgerIndex)?{studyTarget:{ledgerIndex:study.targetLedgerIndex}}:{})};
    return json(res,{...study,inputContext,recording:{id:record.id,revision:record.revision,createdAt:record.createdAt,updatedAt:record.updatedAt},meaning:'按这份手工记录还原所选街起点，范围仍由你填写。记录本身不是求解答案，也不会记入训练成绩。'});
   }
   const nextDraft=action==='undo'?engine.undoLiveRecorderAction(record.draft):engine.applyLiveRecorderAction(record.draft,b.action),reconstructed=engine.replayLiveRecorder(nextDraft);
   const next={...record,draft:reconstructed.draft??nextDraft,updatedAt:now(),revision:record.revision+1,summary:brief(nextDraft,reconstructed.view)};save(next);return json(res,{...next,...reconstructed,draft:next.draft});
  }
  return false;
 }
 return {handler};
}
