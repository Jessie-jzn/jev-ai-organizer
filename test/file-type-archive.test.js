import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Organizer } from '../src/organizer.js';

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(),'jev-types-'));
  t.after(() => fs.rm(base,{recursive:true,force:true}));
  const root = path.join(base,'root');
  await fs.mkdir(path.join(root,'trip','day'),{recursive:true});
  const options = {now:()=>new Date('2026-11-09T12:00:00Z'),timeZone:'Asia/Shanghai',inspectMedia:async paths => paths.map(p => ({path:p,kind:'photo',capturedAt:'2025-02-01T12:00:00Z'}))};
  const app = new Organizer(path.join(base,'data'),options);
  return {base,root,app,options};
}

test('type scan suggests direct file types and preserves ordinary nested files and folders', async t => {
  const {root,app} = await fixture(t);
  for (const name of ['a.PDF','b.mp3','c.zip','d.dmg','e.xyz']) await fs.writeFile(path.join(root,name),name);
  await fs.writeFile(path.join(root,'trip','day','notes.pdf'),'nested');
  const scan = await app.scan(root,{preserveFolders:true});
  assert.equal(scan.items.length,5);
  assert.deepEqual(Object.fromEntries(scan.items.map(item => [item.name,item.category])),{'a.PDF':'文档','b.mp3':'音频','c.zip':'压缩包','d.dmg':'安装包','e.xyz':'其他'});
});

test('media moves into the shared type directory, cleans empty ancestors and undoes after restart', async t => {
  const {root,app,base,options} = await fixture(t);
  const source = path.join(root,'trip','day','a.jpg');
  await fs.writeFile(source,'photo');
  const scan = await app.scan(root,{preserveFolders:true});
  assert.deepEqual(scan.items[0].targetSegments,['整理_20261109','照片视频','2025','2025-02','2025-02-01']);
  const batch = await app.move(scan.id,[{id:scan.items[0].id,media:{}}]);
  assert.equal(batch.entries[0].status,'moved');
  await assert.rejects(fs.stat(path.join(root,'trip')),{code:'ENOENT'});
  assert.equal((await fs.stat(root)).isDirectory(),true);
  const restarted = new Organizer(path.join(base,'data'),options);
  assert.equal((await restarted.history())[0].entries[0].status,'moved');
  const undone = await restarted.undo(batch.id);
  assert.equal(undone.entries[0].status,'undone');
  assert.equal(await fs.readFile(source,'utf8'),'photo');
});

test('hidden and ordinary files keep source directories in place', async t => {
  const {root,app} = await fixture(t);
  await fs.writeFile(path.join(root,'trip','day','a.jpg'),'photo');
  await fs.writeFile(path.join(root,'trip','day','.keep'),'hidden');
  await fs.writeFile(path.join(root,'trip','notes.pdf'),'notes');
  const scan = await app.scan(root,{preserveFolders:true});
  const batch = await app.move(scan.id,[{id:scan.items[0].id,media:{}}]);
  assert.equal(batch.entries[0].status,'moved');
  assert.equal(await fs.readFile(path.join(root,'trip','day','.keep'),'utf8'),'hidden');
  assert.equal(await fs.readFile(path.join(root,'trip','notes.pdf'),'utf8'),'notes');
});

test('undo refuses an externally recreated cleaned directory', async t => {
  const {root,app} = await fixture(t);
  await fs.writeFile(path.join(root,'trip','day','a.jpg'),'photo');
  const scan = await app.scan(root,{preserveFolders:true});
  const batch = await app.move(scan.id,[{id:scan.items[0].id,media:{}}]);
  await fs.mkdir(path.join(root,'trip','day'),{recursive:true});
  await assert.rejects(app.undo(batch.id), /目录|身份/);
  assert.equal(await fs.readFile(path.join(root,'整理_20261109','照片视频','2025','2025-02','2025-02-01','a.jpg'),'utf8'),'photo');
});

test('cleanup revalidates directory identity after its write-ahead journal save', async t => {
  const {root,app} = await fixture(t);
  await fs.writeFile(path.join(root,'trip','day','a.jpg'),'photo');
  const scan = await app.scan(root,{preserveFolders:true});
  const save = app.save.bind(app);
  let replaced = false;
  app.save = async batch => {
    await save(batch);
    if (!replaced && batch.cleanupDirectories?.some(directory => directory.state === 'removing')) {
      replaced = true;
      await fs.rename(path.join(root,'trip','day'),path.join(root,'trip','original-day'));
      await fs.mkdir(path.join(root,'trip','day'));
    }
  };
  await app.move(scan.id,[{id:scan.items[0].id,media:{}}]);
  assert.equal((await fs.stat(path.join(root,'trip','day'))).isDirectory(),true);
});

async function twoBatches(t) {
  const f = await fixture(t);
  for (const name of ['a.jpg','b.jpg']) await fs.writeFile(path.join(f.root,'trip','day',name),name);
  const scan = await f.app.scan(f.root,{preserveFolders:true});
  const first = await f.app.move(scan.id,[{id:scan.items[0].id,media:{}}]);
  const second = await f.app.move(scan.id,[{id:scan.items[1].id,media:{}}]);
  return {...f,first,second};
}

test('older batch undo restores directories removed by a later batch', async t => {
  const {root,app,first,second} = await twoBatches(t);
  assert.equal((await app.undo(first.id)).entries[0].status,'undone');
  assert.equal((await app.undo(second.id)).entries[0].status,'undone');
  for (const name of ['a.jpg','b.jpg']) assert.equal(await fs.readFile(path.join(root,'trip','day',name),'utf8'),name);
});

test('directory identity propagation resumes after a journal write failure and restart', async t => {
  const {root,app,base,options,first,second} = await twoBatches(t);
  const save = app.save.bind(app);
  let failed = false;
  app.save = async batch => {
    if (!failed && batch.id === first.id) { failed = true; throw new Error('injected propagation write failure'); }
    return save(batch);
  };
  await assert.rejects(app.undo(second.id), /injected/);
  const restarted = new Organizer(path.join(base,'data'),options);
  assert.equal((await restarted.undo(second.id)).entries[0].status,'undone');
  assert.equal((await restarted.undo(first.id)).entries[0].status,'undone');
  for (const name of ['a.jpg','b.jpg']) assert.equal(await fs.readFile(path.join(root,'trip','day',name),'utf8'),name);
});

test('undo revalidates parents after saving its directory recreation intent', async t => {
  const {root,app,base} = await fixture(t);
  await fs.writeFile(path.join(root,'trip','day','a.jpg'),'photo');
  const scan = await app.scan(root,{preserveFolders:true});
  const batch = await app.move(scan.id,[{id:scan.items[0].id,media:{}}]);
  const outside = path.join(base,'outside');
  await fs.mkdir(outside);
  const save = app.save.bind(app);
  let replaced = false;
  app.save = async value => {
    await save(value);
    if (!replaced && value.cleanupDirectories?.some(directory => directory.state === 'restoring' && directory.path.endsWith('/day'))) {
      replaced = true;
      await fs.rename(path.join(root,'trip'),path.join(root,'original-trip'));
      await fs.symlink(outside,path.join(root,'trip'));
    }
  };
  await assert.rejects(app.undo(batch.id), /目录/);
  assert.deepEqual(await fs.readdir(outside),[]);
});

test('failed media moves never trigger empty-directory cleanup', async t => {
  const {root,app} = await fixture(t);
  await fs.writeFile(path.join(root,'trip','day','a.jpg'),'photo');
  await fs.mkdir(path.join(root,'整理_20261109','照片视频','2025','2025-02','2025-02-01'),{recursive:true});
  await fs.writeFile(path.join(root,'整理_20261109','照片视频','2025','2025-02','2025-02-01','a.jpg'),'existing');
  const scan = await app.scan(root,{preserveFolders:true});
  const batch = await app.move(scan.id,[{id:scan.items[0].id,media:{}}]);
  assert.equal(batch.entries[0].status,'skipped');
  assert.equal(await fs.readFile(path.join(root,'trip','day','a.jpg'),'utf8'),'photo');
  assert.equal(await fs.readFile(path.join(root,'整理_20261109','照片视频','2025','2025-02','2025-02-01','a.jpg'),'utf8'),'existing');
  assert.deepEqual(batch.cleanupDirectories,[]);
});
