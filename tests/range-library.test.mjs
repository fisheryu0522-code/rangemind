import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {normalizeRangeSnippet,listRangeSnippets,saveRangeSnippet,archiveRangeSnippet} from '../lib/range-library.mjs';
import {range,cards,cardText} from '../lib/poker.mjs';
const withStore=run=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'pokerlab-ranges-'));try{return run(root);}finally{fs.rmSync(root,{recursive:true,force:true});}};
const weights=text=>new Map(range(text).live.map(c=>[c.label,c.weight]));

test('range notation preserves percent/decimal weights and later concrete-combo overrides',()=>{
 const raw='AA:50%, AcAd:0.25, AKs:0.4, AsKs:75%, AhKh:0';
 const item=normalizeRangeSnippet({title:'  BB 对 BTN  ',range:raw,position:'bb',notes:'我的研究假设'}),w=weights(item.range);
 assert.equal(item.title,'BB 对 BTN');assert.equal(item.position,'BB');assert.equal(item.range,raw);assert.equal(item.count,9);assert.ok(Math.abs(item.weighted-4.3)<1e-12);assert.equal(w.get('AcAd'),.25);assert.equal(w.get('AhAs'),.5);assert.equal(w.get('KsAs'),.75);assert.equal(w.has('KhAh'),false);assert.equal(item.source,'用户保存的范围假设');assert.equal(item.format,'study');assert.equal(item.archived,false);
});

test('full 1326-combo library is board independent and applying a board later removes cards',()=>{
 const all=[];for(let a=0;a<52;a++)for(let b=a+1;b<52;b++)all.push(cardText(a)+cardText(b));
 const item=normalizeRangeSnippet({title:'所有起手组合',range:all.join(','),board:'AcKdQhJsTc',count:1,weighted:1});assert.equal(item.count,1326);assert.equal(item.weighted,1326);assert.equal(range(item.range,cards('AcKdQhJsTc')).count,1081);
});

test('invalid, empty, zero-weight or malformed ranges and unsafe IDs reject without files',()=>withStore(root=>{
 for(const r of ['', '   ', 'AA:0','AcAc','AKs:101%','AA:not-a-number'])assert.throws(()=>saveRangeSnippet(root,{title:'无效',range:r}));
 assert.throws(()=>saveRangeSnippet(root,{id:'../../outside',title:'X',range:'AA'}),/UUID/);assert.throws(()=>saveRangeSnippet(root,{title:'',range:'AA'}),/名称/);assert.deepEqual(listRangeSnippets(root),[]);assert.equal(fs.existsSync(path.join(root,'data/pro/ranges')),false);
}));

test('editing keeps identity and original creation date, permits partial updates, and leaves neighbors untouched',()=>withStore(root=>{
 const first=saveRangeSnippet(root,{title:'范围甲',range:'AA:0.5',createdAt:'2020-01-02T03:04:05.000Z',updatedAt:'2020-01-02T03:04:05.000Z'}),second=saveRangeSnippet(root,{title:'范围乙',range:'AKs:25%',format:'online'}),secondFile=path.join(root,'data/pro/ranges',second.id+'.json'),before=fs.readFileSync(secondFile,'utf8');
 const changed=saveRangeSnippet(root,{id:first.id,title:'范围甲修订',range:'QQ:0.25,AcAd',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2000-01-01T00:00:00.000Z'});assert.equal(changed.id,first.id);assert.equal(changed.createdAt,first.createdAt);assert.notEqual(changed.updatedAt,first.updatedAt);assert.equal(changed.count,7);assert.equal(changed.weighted,2.5);
 const note=saveRangeSnippet(root,{id:first.id,notes:'只修改说明'});assert.equal(note.range,changed.range);assert.equal(note.createdAt,first.createdAt);assert.equal(fs.readFileSync(secondFile,'utf8'),before);assert.equal(listRangeSnippets(root).length,2);assert.deepEqual(fs.readdirSync(path.join(root,'data/pro/ranges')).sort(),[first.id+'.json',second.id+'.json'].sort());
 const saved=fs.readFileSync(path.join(root,'data/pro/ranges',first.id+'.json'),'utf8');assert.throws(()=>saveRangeSnippet(root,{id:first.id,range:'QQ:2'}));assert.equal(fs.readFileSync(path.join(root,'data/pro/ranges',first.id+'.json'),'utf8'),saved);
}));

test('archiving is reversible and never deletes the range or changes its original identity',()=>withStore(root=>{
 const item=saveRangeSnippet(root,{title:'归档练习',range:'A5s-A2s:40%'}),archived=archiveRangeSnippet(root,item.id,true);assert.equal(archived.archived,true);assert.equal(listRangeSnippets(root).length,0);assert.equal(listRangeSnippets(root,{includeArchived:true}).length,1);assert.equal(fs.existsSync(path.join(root,'data/pro/ranges',item.id+'.json')),true);
 const restored=archiveRangeSnippet(root,item.id,false);assert.equal(restored.archived,false);assert.equal(restored.createdAt,item.createdAt);assert.equal(restored.range,item.range);assert.equal(listRangeSnippets(root)[0].id,item.id);assert.throws(()=>archiveRangeSnippet(root,item.id,'false'),/状态/);
}));

test('backup normalization preserves supplied identity/timestamps and recomputes untrusted counts',()=>{
 const input={id:'00000000-0000-0000-0000-000000000001',title:'备份范围',range:'AKo:0.5',createdAt:'2022-02-03T04:05:06.000Z',updatedAt:'2023-03-04T05:06:07.000Z',count:999,weighted:999,archived:true};const item=normalizeRangeSnippet(input);for(const key of ['id','createdAt','updatedAt','archived'])assert.equal(item[key],input[key]);assert.equal(item.count,12);assert.equal(item.weighted,6);assert.throws(()=>normalizeRangeSnippet({...input,id:'00000000-0000-0000-0000-000000000002'},{old:item}),/编号/);
});

test('corrupted or mismatched records are reported without overwriting or silently hiding stored data',()=>withStore(root=>{
 const item=saveRangeSnippet(root,{title:'完整原件',range:'99'}),file=path.join(root,'data/pro/ranges',item.id+'.json');fs.writeFileSync(file,'{"broken":');assert.throws(()=>listRangeSnippets(root),/无法读取/);assert.throws(()=>saveRangeSnippet(root,{id:item.id,title:'覆盖',range:'AA'}),/无法读取/);assert.equal(fs.readFileSync(file,'utf8'),'{"broken":');
 fs.writeFileSync(file,JSON.stringify({...item,id:'00000000-0000-0000-0000-000000000001'}));assert.throws(()=>listRangeSnippets(root),/编号不一致/);
 const missingDate={...item};delete missingDate.createdAt;fs.writeFileSync(file,JSON.stringify(missingDate));assert.throws(()=>listRangeSnippets(root),/未知日期/);
}));
