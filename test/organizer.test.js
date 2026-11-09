import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Organizer } from '../src/organizer.js';

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-test-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'items');
  await fs.mkdir(root);
  const data = path.join(base, 'journal');
  const app = new Organizer(data);
  const folder = async name => { await fs.mkdir(path.join(root, name), { recursive: true }); };
  return { base, root, data, app, folder };
}

test('scan samples folder names, excludes links, hidden files and category containers', async t => {
  const { root, app, folder } = await fixture(t);
  await folder('摄影课程'); await folder('.secret'); await folder('学习');
  await fs.writeFile(path.join(root, '摄影课程', '第一课.mp4'), 'content stays local');
  await fs.symlink(path.join(root, '摄影课程'), path.join(root, 'link'));
  const scan = await app.scan(root);
  assert.deepEqual(scan.items.map(f => f.name), ['第一课.mp4']);
  assert.equal(scan.items[0].sourceRelativePath, '摄影课程/第一课.mp4');
  assert.ok(scan.items[0].id);
});

test('refuses a Photos library or its descendants as scan root, including aliases and mixed case', async t => {
  const { root, app, folder } = await fixture(t);
  await folder('Personal.PhOtOsLiBrArY/originals/one');
  const library = path.join(root, 'Personal.PhOtOsLiBrArY');
  await fs.writeFile(path.join(library, 'originals/one/private.txt'), 'must remain unexamined');
  await fs.symlink(path.join(library, 'originals'), path.join(root, 'alias'));
  for (const selected of [library, path.join(library, 'originals'), path.join(library, 'originals/one'), path.join(root, 'alias')]) {
    await assert.rejects(app.scan(selected), /照片图库/);
  }
  assert.equal(app.scans.size, 0);
  const parent = await app.scan(root);
  assert.deepEqual(parent.items, []);
  assert.ok(parent.skipped.includes('Personal.PhOtOsLiBrArY'));
  assert.equal(await fs.readFile(path.join(library, 'originals/one/private.txt'), 'utf8'), 'must remain unexamined');
});

test('moves whole folder, preserves contents and can undo after restart', async t => {
  const { root, data, app, folder } = await fixture(t);
  await folder('课程'); await fs.writeFile(path.join(root, '课程', 'notes.txt'), 'hello');
  const scan = await app.scan(root);
  const batch = await app.move(scan.id, [{ id: scan.items[0].id, category: '学习' }]);
  assert.equal(batch.entries[0].status, 'moved');
  assert.equal(await fs.readFile(path.join(root, '学习', '课程', 'notes.txt'), 'utf8'), 'hello');
  const restarted = new Organizer(data);
  assert.equal((await restarted.history()).length, 1);
  const undo = await restarted.undo(batch.id);
  assert.equal(undo.entries[0].status, 'undone');
  assert.equal(await fs.readFile(path.join(root, '课程', 'notes.txt'), 'utf8'), 'hello');
});

test('destination conflicts are skipped without overwriting', async t => {
  const { root, app, folder } = await fixture(t);
  await folder('课程'); await folder('学习/课程');
  const scan = await app.scan(root);
  const result = await app.move(scan.id, [{ id: scan.items[0].id, category: '学习' }]);
  assert.equal(result.entries[0].status, 'skipped');
  assert.ok((await fs.stat(path.join(root, '课程'))).isDirectory());
});

test('rejects forged categories, unknown IDs and duplicate selections', async t => {
  const { app, root, folder } = await fixture(t); await folder('A');
  const scan = await app.scan(root); const id = scan.items[0].id;
  await assert.rejects(app.move(scan.id, [{ id, category: '../escape' }]));
  await assert.rejects(app.move(scan.id, [{ id: 'fake', category: '工作' }]));
  await assert.rejects(app.move(scan.id, [{ id, category: '工作' }, { id, category: '工作' }]));
});

test('refuses symlink category and replaced source folder', async t => {
  const { app, root, base, folder } = await fixture(t); await folder('A');
  const scan = await app.scan(root);
  await fs.symlink(base, path.join(root, '工作'));
  let result = await app.move(scan.id, [{ id: scan.items[0].id, category: '工作' }]);
  assert.equal(result.entries[0].status, 'skipped');
  await fs.rename(path.join(root, 'A'), path.join(root, 'old'));
  await folder('A');
  result = await app.move(scan.id, [{ id: scan.items[0].id, category: '学习' }]);
  assert.equal(result.entries[0].status, 'skipped');
});

test('undo preserves both items when original location is occupied', async t => {
  const { app, root, folder } = await fixture(t); await folder('A');
  const scan = await app.scan(root);
  const batch = await app.move(scan.id, [{ id: scan.items[0].id, category: '工作' }]);
  await folder('A');
  const undone = await app.undo(batch.id);
  assert.equal(undone.entries[0].status, 'moved');
  assert.match(undone.entries[0].error, /已存在/);
  assert.ok((await fs.stat(path.join(root, '工作', 'A'))).isDirectory());
});

test('write-ahead journal recovers a move whose completion could not be saved', async t => {
  const { app, root, data, folder } = await fixture(t); await folder('A');
  const scan = await app.scan(root);
  const save = app.save.bind(app);
  app.save = async batch => {
    if (batch.entries.some(e => e.status === 'moved')) throw new Error('simulated disk error');
    return save(batch);
  };
  await assert.rejects(app.move(scan.id, [{ id: scan.items[0].id, category: '工作' }]), /disk error/);
  const restarted = new Organizer(data);
  const [batch] = await restarted.history();
  assert.equal(batch.entries[0].status, 'moved');
  assert.equal((await restarted.undo(batch.id)).entries[0].status, 'undone');
  assert.ok((await fs.stat(path.join(root, 'A'))).isDirectory());
});

test('serializes duplicate move requests and moves each source once', async t => {
  const { app, root, folder } = await fixture(t); await folder('A');
  const scan = await app.scan(root);
  const results = await Promise.all([
    app.move(scan.id, [{ id: scan.items[0].id, category: '工作' }]),
    app.move(scan.id, [{ id: scan.items[0].id, category: '学习' }])
  ]);
  assert.deepEqual(results.map(r => r.entries[0].status), ['moved', 'skipped']);
});

test('undo refuses to follow a replaced category directory', async t => {
  const { app, root, base, folder } = await fixture(t); await folder('A');
  const scan = await app.scan(root);
  const batch = await app.move(scan.id, [{ id: scan.items[0].id, category: '工作' }]);
  await fs.rename(path.join(root, '工作'), path.join(base, 'relocated'));
  await fs.symlink(path.join(base, 'relocated'), path.join(root, '工作'));
  const result = await app.undo(batch.id);
  assert.equal(result.entries[0].status, 'moved');
  assert.ok(result.entries[0].error);
  assert.ok((await fs.stat(path.join(base, 'relocated', 'A'))).isDirectory());
});

test('scans mixed files and folders, moves both and restores bytes after restart', async t => {
  const { app, root, data, folder } = await fixture(t);
  await folder('课程');
  await fs.writeFile(path.join(root, '课程', 'notes.txt'), 'inside');
  const bytes = Buffer.from([0, 255, 3, 17]);
  await fs.writeFile(path.join(root, '报告.PDF'), bytes);
  await fs.writeFile(path.join(root, '.hidden'), 'hidden');
  await fs.symlink(path.join(root, '报告.PDF'), path.join(root, 'alias.pdf'));
  const scan = await app.scan(root);
  assert.equal(scan.items.length, 2);
  const file = scan.items.find(item => item.type === 'file');
  assert.equal(file.name, '报告.PDF');
  assert.equal(file.extension, '.pdf');
  assert.equal(file.sizeBytes, 4);
  assert.deepEqual(file.samples, []);
  const batch = await app.move(scan.id, scan.items.map(item => ({ id: item.id, category: '学习' })));
  assert.ok(batch.entries.every(entry => entry.status === 'moved'));
  assert.deepEqual(await fs.readFile(path.join(root, '学习', '报告.PDF')), bytes);
  const undone = await new Organizer(data).undo(batch.id);
  assert.ok(undone.entries.every(entry => entry.status === 'undone'));
  assert.deepEqual(await fs.readFile(path.join(root, '报告.PDF')), bytes);
  assert.equal(await fs.readFile(path.join(root, '课程', 'notes.txt'), 'utf8'), 'inside');
});

test('file conflicts preserve source and target, including conflicts during undo', async t => {
  const { app, root, folder } = await fixture(t);
  await folder('工作');
  await fs.writeFile(path.join(root, 'a.txt'), 'source');
  await fs.writeFile(path.join(root, '工作', 'a.txt'), 'target');
  const scan = await app.scan(root);
  const skipped = await app.move(scan.id, [{ id: scan.items[0].id, category: '工作' }]);
  assert.equal(skipped.entries[0].status, 'skipped');
  assert.equal(await fs.readFile(path.join(root, '工作', 'a.txt'), 'utf8'), 'target');
  const batch = await app.move(scan.id, [{ id: scan.items[0].id, category: '学习' }]);
  await fs.writeFile(path.join(root, 'a.txt'), 'replacement');
  const undone = await app.undo(batch.id);
  assert.equal(undone.entries[0].status, 'moved');
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'replacement');
  assert.equal(await fs.readFile(path.join(root, '学习', 'a.txt'), 'utf8'), 'source');
});

test('a file replaced by a directory is not moved using a stale scan', async t => {
  const { app, root, folder } = await fixture(t);
  await fs.writeFile(path.join(root, 'a.txt'), 'source');
  const scan = await app.scan(root);
  await fs.rename(path.join(root, 'a.txt'), path.join(root, 'original.txt'));
  await folder('a.txt');
  const batch = await app.move(scan.id, [{ id: scan.items[0].id, category: '工作' }]);
  assert.equal(batch.entries[0].status, 'skipped');
  assert.ok((await fs.stat(path.join(root, 'a.txt'))).isDirectory());
});

test('file write-ahead recovery supports undo after interrupted completion', async t => {
  const { app, root, data } = await fixture(t);
  await fs.writeFile(path.join(root, 'a.txt'), 'source');
  const scan = await app.scan(root), save = app.save.bind(app);
  app.save = async batch => {
    if (batch.entries.some(e => e.status === 'moved')) throw new Error('disk error');
    return save(batch);
  };
  await assert.rejects(app.move(scan.id, [{ id: scan.items[0].id, category: '工作' }]), /disk error/);
  const restarted = new Organizer(data);
  const [batch] = await restarted.history();
  assert.equal(batch.entries[0].status, 'moved');
  assert.equal((await restarted.undo(batch.id)).entries[0].status, 'undone');
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'source');
});

test('scan keeps media private, returns public media and ordinary Jev candidates', async t => {
  const { root, data } = await fixture(t);
  await fs.writeFile(path.join(root, 'IMG_1.HEIC'), 'photo');
  await fs.writeFile(path.join(root, 'IMG_1.MOV'), 'motion');
  await fs.writeFile(path.join(root, 'notes.txt'), 'ordinary');
  await fs.mkdir(path.join(root, 'Library.photoslibrary'));
  const app = new Organizer(data, {
    inspectMedia: async paths => paths.map(file => ({
      path: file,
      kind: file.endsWith('.MOV') ? 'video' : 'photo',
      assetIdentifier: 'live-1',
      capturedAt: '2026-09-21T10:00:00+08:00',
      latitude: 31.2304,
      longitude: 121.4737
    })),
    timeZone: 'Asia/Shanghai'
  });
  const scan = await app.scan(root, { resolveLocations: false });
  assert.equal(scan.root, undefined);
  assert.deepEqual(scan.skipped, ['Library.photoslibrary']);
  assert.deepEqual(scan.items.map(item => item.type).sort(), ['file', 'media']);
  const media = scan.items.find(item => item.type === 'media');
  assert.equal(media.mediaType, 'live-photo');
  assert.equal(media.hasCoordinates, true);
  assert.equal(JSON.stringify(scan).includes(path.join(root, 'IMG_1.HEIC')), false);
  const privateScan = app.getScan(scan.id);
  assert.equal(privateScan.items.find(item => item.type === 'media').members[0].path,
    path.join(await fs.realpath(root), 'IMG_1.HEIC'));
});
