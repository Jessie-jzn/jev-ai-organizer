import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Organizer } from '../src/organizer.js';
import { buildMediaSegments } from '../public/media-paths.js';

test('archive uses year/month and holds unreliable dates for review', () => {
  assert.deepEqual(buildMediaSegments({year:'2024',month:'01',day:'01',mediaType:'photo'}), ['照片视频','2024','2024-01','2024-01-01']);
  assert.deepEqual(buildMediaSegments({year:'2024',month:'01',day:'01',mediaType:'video',dateSource:'filesystem'}), ['照片视频', '日期待确认']);
  assert.deepEqual(buildMediaSegments({year:'未知日期',month:'未知月份',mediaType:'photo'}), ['照片视频', '日期待确认']);
});

test('nested media moves and undoes without moving the containing folder or scanning archives', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'jev-recursive-'));
  try {
    const root = path.join(temp,'photos');
    await fs.mkdir(path.join(root,'trip','day'),{recursive:true});
    await fs.mkdir(path.join(root,'2024','2024-01'),{recursive:true});
    await fs.writeFile(path.join(root,'2024','2024-01','archived.jpg'),'archived');
    const source = path.join(root,'trip','day','image.jpg');
    await fs.writeFile(source,'original');
    await fs.writeFile(path.join(root,'trip','notes.txt'),'notes');
    await fs.symlink(path.join(root,'trip'),path.join(root,'link'));
    const organizer = new Organizer(path.join(temp,'data'), {inspectMedia: async paths => paths.map(p => ({path:p,kind:'photo',capturedAt:'2025-02-01T12:00:00Z'}))});
    const scan = await organizer.scan(root);
    assert.equal(scan.items.length,1);
    assert.equal(scan.items[0].sourceRelativePath,'trip/day/image.jpg');
    const batch = await organizer.move(scan.id,[{id:scan.items[0].id,media:{}}]);
    assert.equal(batch.entries[0].status,'moved');
    assert.equal(await fs.readFile(path.join(root,'照片视频','2025','2025-02','2025-02-01','image.jpg'),'utf8'),'original');
    await organizer.undo(batch.id);
    assert.equal(await fs.readFile(source,'utf8'),'original');
    assert.equal(await fs.readFile(path.join(root,'trip','notes.txt'),'utf8'),'notes');
  } finally { await fs.rm(temp,{recursive:true,force:true}); }
});

test('nested source directory replacement blocks moving a retained file', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'jev-source-safety-'));
  try {
    const root = path.join(temp,'root');
    await fs.mkdir(path.join(root,'2024','trip'),{recursive:true});
    const source = path.join(root,'2024','trip','a.jpg');
    await fs.writeFile(source,'original');
    const organizer = new Organizer(path.join(temp,'journal'), {inspectMedia:async paths => paths.map(p => ({path:p,kind:'photo',capturedAt:'2025-02-01T12:00:00Z'}))});
    const scan = await organizer.scan(root);
    assert.equal(scan.items.length,1);
    await fs.rename(path.join(root,'2024','trip'),path.join(root,'2024','old'));
    await fs.mkdir(path.join(root,'2024','trip'));
    await fs.rename(path.join(root,'2024','old','a.jpg'),source);
    const batch = await organizer.move(scan.id,[{id:scan.items[0].id,media:{}}]);
    assert.equal(batch.entries[0].status,'skipped');
    assert.equal(await fs.readFile(source,'utf8'),'original');
  } finally { await fs.rm(temp,{recursive:true,force:true}); }
});

test('same-name nested media never overwrites a shared monthly target', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'jev-nested-conflict-'));
  try {
    const root = path.join(temp,'root');
    for (const folder of ['one','two']) {
      await fs.mkdir(path.join(root,folder),{recursive:true});
      await fs.writeFile(path.join(root,folder,'a.jpg'),folder);
    }
    const organizer = new Organizer(path.join(temp,'journal'), {inspectMedia:async paths => paths.map(p => ({path:p,kind:'photo',capturedAt:'2025-02-01T12:00:00Z'}))});
    const scan = await organizer.scan(root);
    assert.equal(scan.items.length,2);
    await fs.writeFile(path.join(root,'one','unique.jpg'),'unique');
    const updated = await organizer.scan(root);
    const batch = await organizer.move(updated.id,updated.items.map(item => ({id:item.id,media:{}})));
    assert.equal(batch.entries.filter(entry => entry.status === 'moved').length,2);
    const conflict = batch.entries.find(entry => entry.status === 'skipped');
    assert.ok(conflict);
    assert.match(conflict.error,/目标.*冲突/);
    assert.match(conflict.error,/one[\/]a.jpg/);
    assert.match(conflict.error,/two[\/]a.jpg/);
    assert.match(conflict.error,/照片视频[\/]2025[\/]2025-02[\/]2025-02-01[\/]a.jpg/);
    await organizer.undo(batch.id);
    for (const folder of ['one','two']) assert.equal(await fs.readFile(path.join(root,folder,'a.jpg'),'utf8'),folder);
  } finally { await fs.rm(temp,{recursive:true,force:true}); }
});

test('same-batch Live Photo target conflicts skip the whole later pair and still undo safely', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'jev-pair-conflict-'));
  try {
    const root = path.join(temp,'root');
    for (const folder of ['one','two']) {
      await fs.mkdir(path.join(root,folder),{recursive:true});
      for (const name of ['pair.heic','pair.mov']) await fs.writeFile(path.join(root,folder,name),`${folder}:${name}`);
    }
    const organizer = new Organizer(path.join(temp,'data'), {inspectMedia:async paths => paths.map(p => ({path:p,kind:p.endsWith('.mov')?'video':'photo',assetIdentifier:'pair',capturedAt:'2025-02-01T12:00:00Z'}))});
    const scan = await organizer.scan(root);
    assert.equal(scan.items.length,2);
    const batch = await organizer.move(scan.id,scan.items.map(item => ({id:item.id,media:{}})));
    assert.deepEqual(batch.entries.map(entry=>entry.status).sort(),['moved','skipped']);
    const skipped = batch.entries.find(entry=>entry.status==='skipped');
    for (const member of skipped.members) assert.equal(await fs.readFile(member.source,'utf8'),`${path.basename(path.dirname(member.source))}:${member.name}`);
    await organizer.undo(batch.id);
    for (const folder of ['one','two']) for (const name of ['pair.heic','pair.mov']) assert.equal(await fs.readFile(path.join(root,folder,name),'utf8'),`${folder}:${name}`);
  } finally { await fs.rm(temp,{recursive:true,force:true}); }
});
