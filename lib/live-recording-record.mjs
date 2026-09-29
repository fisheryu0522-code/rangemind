import {replayLiveRecorder} from './live-recorder.mjs';

export function summarizeLiveRecording(draft,view){
 return {title:draft.title??'现场牌局记录',question:draft.question??'',players:draft.players.length,unit:draft.unit,smallBlind:draft.smallBlind,bigBlind:draft.bigBlind,street:view.street,board:view.board,pot:view.pot,actions:draft.actions.length,handComplete:view.handComplete,hero:draft.hero};
}

/** Rebuild every derived value; a manual ledger is never a training score. */
export function restoreLiveRecording(record){
 if(!record||record.kind!=='live-recording'||typeof record.id!=='string'||!/^[a-f0-9-]{36}$/.test(record.id)||!Number.isInteger(record.revision)||record.revision<0)throw Error('现场记录身份或修订编号无效。');
 if(typeof record.createdAt!=='string'||typeof record.updatedAt!=='string'||!Number.isFinite(Date.parse(record.createdAt))||!Number.isFinite(Date.parse(record.updatedAt))||Date.parse(record.updatedAt)<Date.parse(record.createdAt))throw Error('现场记录时间无效。');
 const replay=replayLiveRecorder(record.draft);
 const revisions=new Set(),snapshots=record.studySnapshots??[];
 if(!Array.isArray(snapshots)||snapshots.length>10000)throw Error('现场研究版本快照无效或过多。');
 const studySnapshots=snapshots.map(s=>{
  if(!s||!Number.isInteger(s.revision)||s.revision<0||s.revision>record.revision||revisions.has(s.revision)||typeof s.createdAt!=='string'||!Number.isFinite(Date.parse(s.createdAt))||Date.parse(s.createdAt)<Date.parse(record.createdAt))throw Error('现场研究快照版本或时间无效。');revisions.add(s.revision);
  const draft=replayLiveRecorder(s.draft).draft;
  if(s.revision===record.revision&&JSON.stringify(draft)!==JSON.stringify(replay.draft))throw Error('现场研究快照与同版本记录不一致。');
  return {revision:s.revision,createdAt:s.createdAt,draft};
 });
 return {id:record.id,kind:'live-recording',createdAt:record.createdAt,updatedAt:record.updatedAt,revision:record.revision,draft:replay.draft,summary:summarizeLiveRecording(replay.draft,replay.view),studySnapshots};
}
