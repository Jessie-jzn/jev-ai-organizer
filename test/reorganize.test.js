import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Organizer } from '../src/organizer.js';
import { resolveMediaFacts, buildMediaSegments } from '../src/media-rules.js';

async function fixture(t) {
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'jev-reorg-'));
 t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const root=path.join(base,'root'); await fs.mkdir(root);
 const app=new Organizer(path.join(base,'data'),{timeZone:'Asia/Shanghai',now:()=>new Date('2026-11-09T12:00:00Z'),inspectMedia:async paths=>paths.map(p=>({path:p,kind:'photo',capturedAt:'2024-02-29T23:30:00-08:00'}))});
 return {base,root,app};
}

test('capture calendar day is retained across timezones and invalid days are rejected',()=>{
 const facts=resolveMediaFacts({metadata:{kind:'photo',capturedAt:'2024-02-29T23:30:00-08:00'}});
 assert.equal(facts.day,'29');
 assert.deepEqual(buildMediaSegments(facts),['照片视频','2024','2024-02','2024-02-29']);
 assert.throws(()=>buildMediaSegments(facts,{year:'2023',month:'02',day:'29'}),/day|date/);
});

test('reorganize extracts direct files from known containers but preserves project files',async t=>{
 const {root,app}=await fixture(t);
 for(const dir of ['工作/客户项目','整理_20260101/文档/项目','照片视频/2024/2024-02','整理_20261109/文档']) await fs.mkdir(path.join(root,dir),{recursive:true});
 for(const [name,body] of [['工作/合同.pdf','old'],['工作/客户项目/设计.pdf','project'],['整理_20260101/文档/笔记.txt','notes'],['整理_20260101/文档/项目/内部.txt','project2'],['照片视频/2024/2024-02/a.jpg','photo'],['整理_20261109/文档/already.txt','existing']]) await fs.writeFile(path.join(root,name),body);
 const normal=await app.scan(root,{preserveFolders:true}); assert.equal(normal.items.length,0);
 const scan=await app.scan(root,{preserveFolders:true,mode:'reorganize'});
 assert.equal(scan.outputDirectory,'整理_20261109');
 assert.deepEqual(scan.items.map(i=>i.name).sort(),['a.jpg','合同.pdf','笔记.txt'].sort());
 const batch=await app.move(scan.id,scan.items.map(i=>i.type==='media'?{id:i.id,media:{}}:{id:i.id,category:i.category}));
 assert.ok(batch.entries.every(e=>e.status==='moved'));
 assert.equal(await fs.readFile(path.join(root,'整理_20261109/照片视频/2024/2024-02/2024-02-29/a.jpg'),'utf8'),'photo');
 assert.equal(await fs.readFile(path.join(root,'工作/客户项目/设计.pdf'),'utf8'),'project');
 await app.undo(batch.id);
 assert.equal(await fs.readFile(path.join(root,'工作/合同.pdf'),'utf8'),'old');
 assert.equal(await fs.readFile(path.join(root,'照片视频/2024/2024-02/a.jpg'),'utf8'),'photo');
});

test('mode is validated and the scan date is frozen for the move',async t=>{
 const {root,app}=await fixture(t); await fs.writeFile(path.join(root,'a.txt'),'a');
 await assert.rejects(app.scan(root,{preserveFolders:true,mode:'invalid'}),/模式/);
 const scan=await app.scan(root,{preserveFolders:true});
 app.now=()=>new Date('2026-11-10T12:00:00Z');
 const batch=await app.move(scan.id,[{id:scan.items[0].id,category:'文档'}]);
 assert.equal(await fs.readFile(path.join(root,'整理_20261109/文档/a.txt'),'utf8'),'a');
 assert.equal(batch.entries[0].status,'moved');
});

test('custom inbox container chains are recognized without extracting project documents',async t=>{
 const {root,app}=await fixture(t);
 await fs.mkdir(path.join(root,'财务/待报销/客户项目'),{recursive:true});
 await fs.writeFile(path.join(root,'财务/待报销/发票.pdf'),'receipt');
 await fs.writeFile(path.join(root,'财务/待报销/客户项目/合同.pdf'),'project');
 const scan=await app.scan(root,{preserveFolders:true,mode:'reorganize',categories:['财务/待报销']});
 assert.deepEqual(scan.items.map(item=>item.name),['发票.pdf']);
 const batch=await app.move(scan.id,[{id:scan.items[0].id,category:'财务/待报销'}]);
 assert.equal(batch.entries[0].status,'moved');
 assert.equal(await fs.readFile(path.join(root,'整理_20261109/财务/待报销/发票.pdf'),'utf8'),'receipt');
 assert.equal(await fs.readFile(path.join(root,'财务/待报销/客户项目/合同.pdf'),'utf8'),'project');
});
