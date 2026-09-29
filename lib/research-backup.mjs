import crypto from 'node:crypto';
import {prepareEquityExplorer} from './equity-explorer.mjs';
import {assertBoardContrast} from './board-contrast.mjs';
import {cards,cardText} from './poker.mjs';
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const id=x=>typeof x==='string'&&/^[a-f0-9-]{36}$/.test(x),time=x=>typeof x==='string'&&Number.isFinite(Date.parse(x));
export function restoreEquityExploration(entry){
 if(entry.kind!=='equity-exploration'||!time(entry.createdAt))throw Error('权益探索记录类型或时间无效。');
 const input=prepareEquityExplorer(entry.input),active=['running','queued','cancelling','cleanup-required'].includes(entry.status);
 return {id:entry.id,kind:entry.kind,createdAt:entry.createdAt,...(time(entry.finishedAt)?{finishedAt:entry.finishedAt}:{}),input,status:active?'interrupted':'restored-unverified',error:'保留原输入和未核验的历史输出；恢复没有重新计算权益，请载入参数后重新运行。',...(entry.result||entry.unverifiedResult?{unverifiedResult:entry.result??entry.unverifiedResult}:{}),restored:true};
}
export function restoreBoardContrast(entry,lookup,resolve){
 if(entry.kind!=='board-contrast'||!time(entry.createdAt)||!id(entry.sourceJobId)||!id(entry.alternativeJobId)||entry.sourceJobId===entry.alternativeJobId||typeof entry.sourceFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(entry.sourceFingerprint))throw Error('换牌实验来源不完整。');
 const route=entry.nodePath??[];if(!Array.isArray(route)||route.length>120||route.some(x=>typeof x!=='string'||x.length>256))throw Error('换牌实验路径无效。');
 const a=lookup('jobs',entry.sourceJobId),b=lookup('jobs',entry.alternativeJobId);if(!a?.scenario||!b?.scenario)throw Error('换牌实验缺少关联的原始模型。');
 const change=assertBoardContrast(a.scenario,b.scenario);if(a.settings?.locks?.length||b.settings?.locks?.length)throw Error('换牌备份不能隐含移植节点锁定。');
 const ra=resolve(a.id).result,rb=resolve(b.id).result,verified=!!(ra&&rb&&hash(ra)===entry.sourceFingerprint);
 if(!['seen','unseen','unknown'].includes(entry.reportedExposure)||typeof entry.prediction!=='string'||entry.prediction.length>5000)throw Error('换牌实验预测记录无效。');
 return {id:entry.id,kind:entry.kind,createdAt:entry.createdAt,title:String(entry.title??b.scenario.title).slice(0,200),sourceJobId:a.id,alternativeJobId:b.id,sourceFingerprint:entry.sourceFingerprint,change,prediction:entry.prediction,reportedExposure:entry.reportedExposure,nodePath:[...route],combo:entry.combo?cards(entry.combo,[2]).map(cardText).join(''):null,restored:true,requiresSourceVerification:!verified,meaning:'恢复时保留预测与模型身份；报告必须从实际保存的两份策略树重新整理。'};
}
