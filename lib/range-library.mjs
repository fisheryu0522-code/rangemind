import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {range as parseRange} from './poker.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const own=(object,key)=>Object.hasOwn(object,key);
function id(value){if(typeof value!=='string'||!UUID.test(value))throw Error('范围编号必须是有效的 UUID。');return value;}
function text(value,name,max,{required=false}={}){
 if(typeof value!=='string')throw Error(`${name}必须是文字。`);
 const result=value.trim();if(required&&!result)throw Error(`请填写${name}。`);if(result.length>max)throw Error(`${name}最多 ${max.toLocaleString()} 个字符。`);return result;
}
function timestamp(value,name){if(typeof value!=='string'||value.length>50||!/^\d{4}-\d{2}-\d{2}T/.test(value)||!Number.isFinite(Date.parse(value)))throw Error(`${name}必须是有效的 ISO 日期时间。`);return value;}

/** Board-independent range hypotheses. Preserve the user's range notation and
 * last-token-wins combo overrides; never infer equilibrium or population data.
 * Without old, supplied IDs/timestamps survive backup validation unchanged.
 * With old, this is an edit: identity/creation time stay fixed, update time moves. */
export function normalizeRangeSnippet(input,{old}={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('范围资料必须是对象。');
 if(old!==undefined&&(!old||typeof old!=='object'||Array.isArray(old)))throw Error('原范围资料格式无效。');
 const value={...old,...input},now=new Date().toISOString();
 const snippetId=old?id(old.id):input.id==null||input.id===''?crypto.randomUUID():id(input.id);
 if(old&&input.id!=null&&input.id!==snippetId)throw Error('编辑范围时不能更改原编号。');
 const range=text(value.range,'范围',100000,{required:true}),parsed=parseRange(range,[]);
 const format=value.format??'study';if(!['online','live','study'].includes(format))throw Error('范围类型只能是 online、live 或 study。');
 const archived=value.archived??false;if(typeof archived!=='boolean')throw Error('归档状态必须为 true 或 false。');
 return {id:snippetId,title:text(value.title,'范围名称',160,{required:true}),range,notes:text(value.notes??'','备注',20000),format,position:text(value.position??'','位置',32).toUpperCase(),source:text(value.source??'用户保存的范围假设','来源',1000,{required:true}),createdAt:timestamp(old?old.createdAt:input.createdAt??now,'创建时间'),updatedAt:old?now:timestamp(input.updatedAt??now,'更新时间'),count:parsed.count,weighted:parsed.weighted,archived};
}

function directory(root,create){
 if(typeof root!=='string'||!root.trim())throw Error('范围库目录无效。');
 let dir=path.resolve(root);if(create)fs.mkdirSync(dir,{recursive:true});if(!fs.existsSync(dir))return null;
 for(const part of ['data','pro','ranges']){dir=path.join(dir,part);if(fs.existsSync(dir)){const info=fs.lstatSync(dir);if(!info.isDirectory()||info.isSymbolicLink())throw Error('范围库路径必须是本地普通目录，不能是文件或符号链接。');}else if(create)fs.mkdirSync(dir);else return null;}
 return dir;
}
function read(file,expectedId){
 const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.size>1024*1024)throw Error('范围文件必须是小于 1 MB 的本地普通文件。');
 let raw;try{raw=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw Error(`范围资料 ${expectedId} 无法读取；原文件已保留，请从备份核对。`);}
 if(raw?.id!==expectedId)throw Error(`范围资料 ${expectedId} 的文件名与内部编号不一致。`);
 if(typeof raw.createdAt!=='string'||typeof raw.updatedAt!=='string')throw Error(`范围资料 ${expectedId} 缺少原始创建或更新时间；不会用今天覆盖未知日期。`);
 const value=normalizeRangeSnippet(raw);if(value.id!==expectedId)throw Error(`范围资料 ${expectedId} 的文件名与内部编号不一致。`);return value;
}
function atomic(file,value){
 const temp=file+'.'+crypto.randomUUID()+'.tmp';let fd;
 try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,file);}
 finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp);}
}

export function listRangeSnippets(root,{includeArchived=false}={}){
 if(typeof includeArchived!=='boolean')throw Error('includeArchived 必须为布尔值。');
 const dir=directory(root,false);if(!dir)return [];
 return fs.readdirSync(dir).filter(name=>name.endsWith('.json')&&UUID.test(name.slice(0,-5))).map(name=>read(path.join(dir,name),name.slice(0,-5))).filter(item=>includeArchived||!item.archived).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt)||a.id.localeCompare(b.id));
}

export function saveRangeSnippet(root,input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('范围资料必须是对象。');
 const supplied=input.id==null||input.id===''?null:id(input.id),existingDir=directory(root,false),file=supplied&&existingDir?path.join(existingDir,supplied+'.json'):null;
 const old=file&&fs.existsSync(file)?read(file,supplied):undefined;
 const value=normalizeRangeSnippet(input,{old}),dir=directory(root,true),target=path.join(dir,value.id+'.json');
 // A generated ID should never overwrite an unrelated record, even on the
 // astronomically unlikely UUID collision or an externally created file.
 if(!old&&!supplied&&fs.existsSync(target))throw Error('新范围编号冲突，请重新保存。');
 atomic(target,value);return value;
}

export function archiveRangeSnippet(root,snippetId,archived=true){
 id(snippetId);if(typeof archived!=='boolean')throw Error('归档状态必须为 true 或 false。');
 const dir=directory(root,false),file=dir&&path.join(dir,snippetId+'.json');if(!file||!fs.existsSync(file))throw Error('找不到这个范围资料。');
 const old=read(file,snippetId),value=normalizeRangeSnippet({id:snippetId,archived},{old});atomic(file,value);return value;
}
