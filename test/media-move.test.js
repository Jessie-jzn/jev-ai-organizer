import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Organizer } from '../src/organizer.js';

const media = { year: '2026', month: '09', country: '中国', city: '上海', mediaType: 'photo' };
const segments = ['照片视频', '2026', '2026-09', '2026-09-21'];
const digest = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const absent = async file => assert.rejects(fs.lstat(file), { code: 'ENOENT' });
const identity = stat => ({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs, type: stat.isDirectory() ? 'folder' : 'file' });
async function fixture(t, { single = false, rename } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'media-move-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(await fs.realpath(base), 'items'), data = path.join(base, 'journal');
  await fs.mkdir(root);
  const names = single ? ['A.HEIC'] : ['A.HEIC', 'B.MOV'];
  for (const name of names) await fs.writeFile(path.join(root, name), Buffer.from(`bytes:${name}\x00\xff`));
  const organizer = new Organizer(data, { rename, inspectMedia: async paths => paths.map(file => ({
    path: file, kind: file.endsWith('.MOV') ? 'video' : 'photo', assetIdentifier: single ? null : 'live-1',
    capturedAt: '2026-09-21T10:00:00+08:00'
  })) });
  const scan = await organizer.scan(root);
  const selection = { id: scan.items[0].id, media };
  const hashes = await Promise.all(names.map(name => digest(path.join(root, name))));
  return { base, root, data, organizer, scan, selection, names, hashes, target: path.join(root, ...segments) };
}
async function hashesAt(f, directory) {
  assert.deepEqual(await Promise.all(f.names.map(name => digest(path.join(directory, name)))), f.hashes);
}
async function interrupted(f, status, positions) {
  await fs.mkdir(f.target, { recursive: true });
  const containers = [];
  let container = f.root;
  for (const segment of segments) {
    container = path.join(container, segment);
    containers.push({ path: container, identity: identity(await fs.lstat(container)) });
  }
  const members = [];
  for (let i = 0; i < f.names.length; i++) {
    const name = f.names[i], source = path.join(f.root, name), target = path.join(f.target, name);
    members.push({ name, source, target, identity: identity(await fs.lstat(source)), status: 'ready' });
    if (positions[i] === 'target') await fs.rename(source, target);
  }
  const batch = { id: randomUUID(), root: f.root, rootIdentity: identity(await fs.lstat(f.root)), createdAt: new Date().toISOString(),
    entries: [{ name: f.names[0], type: 'media', kind: 'group', status, containers, members }] };
  await f.organizer.save(batch);
  return batch;
}

test('server builds structured media paths, moves stable groups and undoes with identical SHA-256', async t => {
  const renames = [];
  const f = await fixture(t, { rename: async (from, to) => { renames.push(path.basename(from)); await fs.rename(from, to); } });
  const batch = await f.organizer.move(f.scan.id, [{ ...f.selection, media: { ...media, mediaType: 'video' }, target: '/outside', members: [] }]);
  const entry = batch.entries[0];
  assert.equal(entry.status, 'moved'); assert.equal(entry.kind, 'group');
  assert.equal(entry.members.length, 2); assert.equal(entry.containers.length, 4);
  assert.deepEqual(renames, ['A.HEIC', 'B.MOV']);
  await hashesAt(f, f.target);
  const undone = await f.organizer.undo(batch.id);
  assert.equal(undone.entries[0].status, 'undone');
  assert.deepEqual(renames, ['A.HEIC', 'B.MOV', 'B.MOV', 'A.HEIC']);
  await hashesAt(f, f.root);
});

test('single media type override retains the shared monthly directory', async t => {
  const f = await fixture(t, { single: true });
  const batch = await f.organizer.move(f.scan.id, [{ ...f.selection, media: { ...media, mediaType: 'video' } }]);
  assert.equal(batch.entries[0].kind, 'single');
  await hashesAt(f, path.join(f.root, '照片视频/2026/2026-09/2026-09-21'));
  await f.organizer.undo(batch.id); await hashesAt(f, f.root);
});

test('rejects traversal, invalid segments and forged media IDs before moving', async t => {
  const f = await fixture(t);
  for (const override of [{ year: '../2026' }, { month: '13' }, { country: '../escape' }, { city: 'a/b' }, { city: 'a\\b' }, { city: 'a\0b' }]) {
    await assert.rejects(f.organizer.move(f.scan.id, [{ ...f.selection, media: { ...media, ...override } }]));
  }
  await assert.rejects(f.organizer.move(f.scan.id, [{ id: 'fake', media }]));
  await assert.rejects(f.organizer.move(f.scan.id, [f.selection, f.selection]));
  await hashesAt(f, f.root);
});

for (const mode of ['symlink', 'file']) for (let depth = 0; depth < segments.length; depth++) {
  test(`rejects ${mode} target container at level ${depth + 1}`, async t => {
    const f = await fixture(t), parent = path.join(f.root, ...segments.slice(0, depth));
    await fs.mkdir(parent, { recursive: true });
    const blocked = path.join(parent, segments[depth]);
    if (mode === 'symlink') await fs.symlink(f.base, blocked); else await fs.writeFile(blocked, 'occupied');
    const batch = await f.organizer.move(f.scan.id, [f.selection]);
    assert.equal(batch.entries[0].status, 'skipped'); await hashesAt(f, f.root);
  });
}

test('a conflict in the last Live Photo member skips the complete group', async t => {
  const f = await fixture(t); await fs.mkdir(f.target, { recursive: true });
  await fs.writeFile(path.join(f.target, 'B.MOV'), 'occupied');
  const batch = await f.organizer.move(f.scan.id, [f.selection]);
  assert.equal(batch.entries[0].status, 'skipped'); await hashesAt(f, f.root);
  assert.equal(await fs.readFile(path.join(f.target, 'B.MOV'), 'utf8'), 'occupied');
  await absent(path.join(f.target, 'A.HEIC'));
});

test('all source identities are preflighted before any member is moved', async t => {
  const f = await fixture(t);
  await fs.rename(path.join(f.root, 'B.MOV'), path.join(f.base, 'original'));
  await fs.writeFile(path.join(f.root, 'B.MOV'), 'replacement');
  const batch = await f.organizer.move(f.scan.id, [f.selection]);
  assert.equal(batch.entries[0].status, 'skipped');
  assert.equal(await digest(path.join(f.root, 'A.HEIC')), f.hashes[0]);
});

test('root replacement after scan is rejected', async t => {
  const f = await fixture(t); await fs.rename(f.root, f.root + '-old'); await fs.mkdir(f.root);
  await assert.rejects(f.organizer.move(f.scan.id, [f.selection]));
  await hashesAt(f, f.root + '-old');
});

test('write-ahead journal exists for every member before the first rename', async t => {
  let f;
  f = await fixture(t, { rename: async (from, to) => {
    const [name] = (await fs.readdir(f.data)).filter(name => name.endsWith('.json'));
    const persisted = JSON.parse(await fs.readFile(path.join(f.data, name), 'utf8'));
    assert.equal(persisted.entries[0].status, 'pending');
    assert.equal(persisted.entries[0].members.length, 2);
    await fs.rename(from, to);
  } });
  assert.equal((await f.organizer.move(f.scan.id, [f.selection])).entries[0].status, 'moved');
});

test('failed pending journal save performs no member rename', async t => {
  const f = await fixture(t), save = f.organizer.save.bind(f.organizer);
  f.organizer.save = async batch => { if (batch.entries[0].status === 'pending') throw new Error('disk failure'); await save(batch); };
  await assert.rejects(f.organizer.move(f.scan.id, [f.selection]), /disk failure/); await hashesAt(f, f.root);
});

test('partial move failure safely rolls back in reverse order without copy fallback', async t => {
  let count = 0; const calls = [];
  const f = await fixture(t, { rename: async (from, to) => {
    calls.push(path.basename(from)); if (++count === 2) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
    await fs.rename(from, to);
  } });
  const batch = await f.organizer.move(f.scan.id, [f.selection]);
  assert.equal(batch.entries[0].status, 'skipped'); assert.deepEqual(calls, ['A.HEIC', 'B.MOV', 'A.HEIC']);
  await hashesAt(f, f.root); for (const name of f.names) await absent(path.join(f.target, name));
});

test('unsafe rollback preserves occupied source and reports uncertain', async t => {
  let count = 0, f;
  f = await fixture(t, { rename: async (from, to) => {
    if (++count === 2) { await fs.writeFile(path.join(f.root, 'A.HEIC'), 'new'); throw new Error('failure'); }
    await fs.rename(from, to);
  } });
  const batch = await f.organizer.move(f.scan.id, [f.selection]);
  assert.equal(batch.entries[0].status, 'uncertain');
  assert.equal(await fs.readFile(path.join(f.root, 'A.HEIC'), 'utf8'), 'new');
  assert.equal(await digest(path.join(f.target, 'A.HEIC')), f.hashes[0]);
});

for (const action of ['pending', 'undoing']) for (const positions of [['source', 'source'], ['target', 'target'], ['target', 'source']]) {
  test(`restart recovers ${action} group at ${positions.join('/')}`, async t => {
    const f = await fixture(t); await interrupted(f, action, positions);
    const [batch] = await new Organizer(f.data).history();
    const destination = positions.every(p => p === 'target') || (action === 'undoing' && positions[0] !== positions[1]);
    assert.equal(batch.entries[0].status, destination ? 'moved' : action === 'undoing' ? 'undone' : 'skipped');
    await hashesAt(f, destination ? f.target : f.root);
  });
}

for (const action of ['pending', 'undoing']) {
  test(`restart scan recovers a partial ${action} Live Photo before inspecting media without history`, { timeout: 5000 }, async t => {
    const f = await fixture(t);
    const interruptedBatch = await interrupted(f, action, ['target', 'source']);
    const organizer = new Organizer(f.data, { inspectMedia: async paths => {
      await hashesAt(f, action === 'pending' ? f.root : f.target);
      return f.organizer.inspectMedia(paths);
    } });
    const scan = await organizer.scan(f.root);
    const mediaItems = scan.items.filter(item => item.type === 'media');
    assert.equal(mediaItems.length, action === 'pending' ? 1 : 0);
    const recovered = await organizer.readBatch(interruptedBatch.id);
    assert.equal(recovered.entries[0].status, action === 'pending' ? 'skipped' : 'moved');
    if (action === 'pending') {
      assert.equal(mediaItems[0].mediaType, 'live-photo');
      const batch = await organizer.move(scan.id, [{ id: mediaItems[0].id, media }]);
      assert.equal(batch.entries[0].members.length, 2);
      await hashesAt(f, f.target);
    }
  });
}

test('move recovers interrupted work under its barrier before admitting a retained selection', { timeout: 5000 }, async t => {
  const f = await fixture(t);
  const pending = await interrupted(f, 'pending', ['target', 'source']);
  const batch = await f.organizer.move(f.scan.id, [f.selection]);
  assert.equal((await f.organizer.readBatch(pending.id)).entries[0].status, 'skipped');
  assert.equal(batch.entries[0].status, 'moved');
  await hashesAt(f, f.target);
});

test('scan waits for an active group move instead of inspecting its partial members', { timeout: 5000 }, async t => {
  let release, started;
  const blocked = new Promise(resolve => { release = resolve; });
  const firstRename = new Promise(resolve => { started = resolve; });
  let count = 0;
  const f = await fixture(t, { rename: async (from, to) => {
    await fs.rename(from, to);
    if (++count === 1) { started(); await blocked; }
  } });
  let inspections = 0;
  const inspect = f.organizer.inspectMedia;
  f.organizer.inspectMedia = async paths => { inspections++; return inspect(paths); };
  const moving = f.organizer.move(f.scan.id, [f.selection]);
  await firstRename;
  const scanning = f.organizer.scan(f.root);
  try {
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(inspections, 0);
  } finally { release(); }
  await moving;
  assert.equal((await scanning).items.filter(item => item.type === 'media').length, 0);
});

test('uncertain interrupted groups block overlapping scans and moves while other roots remain usable', async t => {
  const f = await fixture(t);
  const pending = await interrupted(f, 'pending', ['target', 'source']);
  await fs.writeFile(path.join(f.root, 'A.HEIC'), 'occupied');
  const organizer = new Organizer(f.data, { inspectMedia: f.organizer.inspectMedia });
  await assert.rejects(organizer.scan(f.root), /中断|核对/);
  assert.equal((await organizer.readBatch(pending.id)).entries[0].status, 'uncertain');
  await assert.rejects(organizer.scan(f.target), /中断|核对/);
  await assert.rejects(f.organizer.move(f.scan.id, [f.selection]), /中断|核对/);
  assert.equal(await digest(path.join(f.root, 'B.MOV')), f.hashes[1]);
  assert.equal(await digest(path.join(f.target, 'A.HEIC')), f.hashes[0]);
  const other = path.join(f.base, 'other');
  await fs.mkdir(other);
  assert.equal((await organizer.scan(other)).items.length, 0);
});

test('restart refuses replaced containers and ambiguous member locations', async t => {
  const f = await fixture(t); await interrupted(f, 'pending', ['target', 'source']);
  await fs.rename(f.target, f.target + '-old'); await fs.symlink(f.target + '-old', f.target);
  assert.equal((await new Organizer(f.data).history())[0].entries[0].status, 'uncertain');
  assert.equal(await digest(path.join(f.target + '-old', 'A.HEIC')), f.hashes[0]);
});

test('undo preflights all source vacancies before restoring any member', async t => {
  const f = await fixture(t), batch = await f.organizer.move(f.scan.id, [f.selection]);
  await fs.writeFile(path.join(f.root, 'A.HEIC'), 'occupied');
  const undone = await f.organizer.undo(batch.id);
  assert.equal(undone.entries[0].status, 'moved'); await hashesAt(f, f.target);
  await absent(path.join(f.root, 'B.MOV'));
});

test('partial undo failure rolls restored members forward to targets', async t => {
  let count = 0;
  const f = await fixture(t, { rename: async (from, to) => {
    if (++count === 4) throw new Error('undo failure'); await fs.rename(from, to);
  } });
  const batch = await f.organizer.move(f.scan.id, [f.selection]);
  const undone = await f.organizer.undo(batch.id);
  assert.equal(undone.entries[0].status, 'moved'); await hashesAt(f, f.target);
  for (const name of f.names) await absent(path.join(f.root, name));
});

test('unsafe undo roll-forward reports uncertain without replacing new target', async t => {
  let count = 0, f;
  f = await fixture(t, { rename: async (from, to) => {
    if (++count === 4) { await fs.writeFile(path.join(f.target, 'B.MOV'), 'new'); throw new Error('undo failure'); }
    await fs.rename(from, to);
  } });
  const batch = await f.organizer.move(f.scan.id, [f.selection]);
  assert.equal((await f.organizer.undo(batch.id)).entries[0].status, 'uncertain');
  assert.equal(await digest(path.join(f.root, 'B.MOV')), f.hashes[1]);
  assert.equal(await fs.readFile(path.join(f.target, 'B.MOV'), 'utf8'), 'new');
});

test('legacy single folder journals remain byte-identical on history and support undo', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, '工作')); await fs.mkdir(path.join(f.root, '工作', 'old'));
  const target = path.join(f.root, '工作', 'old'), id = identity(await fs.lstat(target)); delete id.type;
  const batch = { id: randomUUID(), root: f.root, rootIdentity: identity(await fs.lstat(f.root)), createdAt: new Date().toISOString(), entries: [{
    name: 'old', source: path.join(f.root, 'old'), target, identity: id,
    containerIdentity: identity(await fs.lstat(path.dirname(target))), status: 'moved'
  }] };
  await f.organizer.save(batch); const file = path.join(f.data, `${batch.id}.json`), before = await fs.readFile(file);
  await new Organizer(f.data).history(); assert.deepEqual(await fs.readFile(file), before);
  assert.equal((await new Organizer(f.data).undo(batch.id)).entries[0].status, 'undone');
  assert.equal((await fs.lstat(path.join(f.root, 'old'))).isDirectory(), true);
});

test('recovery refuses journal targets outside the recorded root', async t => {
  const f = await fixture(t), batch = await interrupted(f, 'pending', ['source', 'source']);
  batch.entries[0].members[0].target = path.join(f.base, 'outside'); await f.organizer.save(batch);
  assert.equal((await new Organizer(f.data).history())[0].entries[0].status, 'uncertain'); await hashesAt(f, f.root);
});

test('blank place overrides use unknown directories', async t => {
  const f = await fixture(t, { single: true });
  const batch = await f.organizer.move(f.scan.id, [{ ...f.selection, media: { ...media, country: '  ', city: '' } }]);
  assert.equal(batch.entries[0].status, 'moved');
  await hashesAt(f, path.join(f.root, '照片视频/2026/2026-09/2026-09-21'));
});

test('changed ancestor after pending journal is never followed', async t => {
  const f = await fixture(t), save = f.organizer.save.bind(f.organizer);
  let swapped = false;
  f.organizer.save = async batch => {
    await save(batch);
    if (batch.entries[0].status === 'pending' && !swapped) {
      swapped = true;
      await fs.rename(path.join(f.root, '照片视频'), path.join(f.base, 'relocated'));
      await fs.symlink(path.join(f.base, 'relocated'), path.join(f.root, '照片视频'));
    }
  };
  const batch = await f.organizer.move(f.scan.id, [f.selection]);
  assert.equal(batch.entries[0].status, 'uncertain'); await hashesAt(f, f.root);
  await absent(path.join(f.base, 'relocated/2026/2026-09/2026-09-21/A.HEIC'));
});

test('all source identities are checked again after the pending journal write', async t => {
  const f = await fixture(t), save = f.organizer.save.bind(f.organizer);
  let swapped = false;
  f.organizer.save = async batch => {
    await save(batch);
    if (batch.entries[0].status === 'pending' && !swapped) {
      swapped = true;
      await fs.rename(path.join(f.root, 'B.MOV'), path.join(f.base, 'original'));
      await fs.writeFile(path.join(f.root, 'B.MOV'), 'new');
    }
  };
  const batch = await f.organizer.move(f.scan.id, [f.selection]);
  assert.equal(batch.entries[0].status, 'uncertain');
  assert.equal(await digest(path.join(f.root, 'A.HEIC')), f.hashes[0]);
  await absent(path.join(f.target, 'A.HEIC'));
});

test('all target vacancies are checked again after the pending journal write', async t => {
  const f = await fixture(t), save = f.organizer.save.bind(f.organizer);
  let swapped = false;
  f.organizer.save = async batch => {
    await save(batch);
    if (batch.entries[0].status === 'pending' && !swapped) {
      swapped = true; await fs.writeFile(path.join(f.target, 'B.MOV'), 'new');
    }
  };
  const batch = await f.organizer.move(f.scan.id, [f.selection]);
  assert.equal(batch.entries[0].status, 'uncertain'); await hashesAt(f, f.root);
  await absent(path.join(f.target, 'A.HEIC'));
});

test('undo preflights the identities of every target before restoring members', async t => {
  const f = await fixture(t), batch = await f.organizer.move(f.scan.id, [f.selection]);
  await fs.rename(path.join(f.target, 'A.HEIC'), path.join(f.base, 'original'));
  await fs.writeFile(path.join(f.target, 'A.HEIC'), 'new');
  assert.equal((await f.organizer.undo(batch.id)).entries[0].status, 'moved');
  assert.equal(await digest(path.join(f.target, 'B.MOV')), f.hashes[1]);
  await absent(path.join(f.root, 'B.MOV'));
});

for (const action of ['pending', 'undoing']) {
  test(`restart marks ambiguous ${action} member identity uncertain without partial repairs`, async t => {
    const f = await fixture(t); await interrupted(f, action, ['target', 'source']);
    await fs.writeFile(path.join(f.root, 'A.HEIC'), 'new');
    const [batch] = await new Organizer(f.data).history();
    assert.equal(batch.entries[0].status, 'uncertain');
    assert.equal(await digest(path.join(f.target, 'A.HEIC')), f.hashes[0]);
    assert.equal(await digest(path.join(f.root, 'B.MOV')), f.hashes[1]);
    assert.equal(await fs.readFile(path.join(f.root, 'A.HEIC'), 'utf8'), 'new');
  });
}

test('rollback rename failure reports uncertain and leaves every original byte reachable', async t => {
  let count = 0;
  const f = await fixture(t, { rename: async (from, to) => {
    if (++count >= 2) throw new Error('device failure'); await fs.rename(from, to);
  } });
  assert.equal((await f.organizer.move(f.scan.id, [f.selection])).entries[0].status, 'uncertain');
  assert.equal(await digest(path.join(f.target, 'A.HEIC')), f.hashes[0]);
  assert.equal(await digest(path.join(f.root, 'B.MOV')), f.hashes[1]);
});

test('group completion save failure is recoverable with unchanged hashes', async t => {
  const f = await fixture(t), save = f.organizer.save.bind(f.organizer);
  f.organizer.save = async batch => { if (batch.entries[0].status === 'moved') throw new Error('disk failure'); await save(batch); };
  await assert.rejects(f.organizer.move(f.scan.id, [f.selection]), /disk failure/);
  const restarted = new Organizer(f.data), [batch] = await restarted.history();
  assert.equal(batch.entries[0].status, 'moved'); await hashesAt(f, f.target);
  assert.equal((await restarted.undo(batch.id)).entries[0].status, 'undone'); await hashesAt(f, f.root);
});

test('undo completion save failure recovers all sources as undone', async t => {
  const f = await fixture(t), batch = await f.organizer.move(f.scan.id, [f.selection]), save = f.organizer.save.bind(f.organizer);
  f.organizer.save = async value => { if (value.entries[0].status === 'undone') throw new Error('disk failure'); await save(value); };
  await assert.rejects(f.organizer.undo(batch.id), /disk failure/);
  assert.equal((await new Organizer(f.data).history())[0].entries[0].status, 'undone'); await hashesAt(f, f.root);
});

test('history ignores geocode cache JSON while preserving operation journals', async t => {
  const f = await fixture(t); await f.organizer.move(f.scan.id, [f.selection]);
  await fs.writeFile(path.join(f.data, 'geocode-cache.json'), '{}');
  assert.equal((await f.organizer.history()).length, 1);
});

test('ordinary scanned filenames keep legal backslashes without interpreting them as target segments', async t => {
  const f = await fixture(t), name = 'notes\\draft.txt';
  await fs.writeFile(path.join(f.root, name), 'ordinary');
  const scan = await f.organizer.scan(f.root), item = scan.items.find(item => item.name === name);
  const batch = await f.organizer.move(scan.id, [{ id: item.id, category: '工作' }]);
  assert.equal(batch.entries[0].status, 'moved');
  assert.equal(await fs.readFile(path.join(f.root, '工作', name), 'utf8'), 'ordinary');
  assert.equal((await f.organizer.undo(batch.id)).entries[0].status, 'undone');
  assert.equal(await fs.readFile(path.join(f.root, name), 'utf8'), 'ordinary');
});

for (const sourceType of ['file']) for (const order of ['ordinary-first', 'media-first']) {
  test(`rejects overlapping ${sourceType} archive source and media target before any mutation (${order})`, async t => {
    const f = await fixture(t), source = path.join(f.root, '照片视频');
    if (sourceType === 'folder') {
      await fs.mkdir(source); await fs.writeFile(path.join(source, 'notes.txt'), 'original notes');
    } else await fs.writeFile(source, 'original notes');
    const beforeRoot = await fs.readdir(f.root);
    const beforeIdentity = identity(await fs.lstat(source));
    const scan = await f.organizer.scan(f.root);
    const ordinary = { id: scan.items.find(item => item.name === '照片视频').id, category: '工作' };
    const selection = { id: scan.items.find(item => item.type === 'media').id, media };
    const choices = order === 'ordinary-first' ? [ordinary, selection] : [selection, ordinary];
    await assert.rejects(f.organizer.move(scan.id, choices), /路径.*冲突/);
    assert.deepEqual(await fs.readdir(f.root), beforeRoot);
    assert.deepEqual(identity(await fs.lstat(source)), beforeIdentity);
    assert.equal(await fs.readFile(sourceType === 'folder' ? path.join(source, 'notes.txt') : source, 'utf8'), 'original notes');
    if (sourceType === 'folder') assert.deepEqual(await fs.readdir(source), ['notes.txt']);
    await hashesAt(f, f.root);
    await absent(f.data); // No initial journal save (which would create this directory).
    await absent(path.join(f.root, '工作'));
  });
}

for (const order of ['ordinary-first', 'media-first']) {
  test(`independent mixed entries retain journal targets and fully undo (${order})`, async t => {
    const f = await fixture(t);
    await fs.mkdir(path.join(f.root, '2026-notes'));
    await fs.writeFile(path.join(f.root, '2026-notes', 'notes.txt'), 'folder notes');
    await fs.writeFile(path.join(f.root, 'ordinary.txt'), 'ordinary bytes');
    // A second media item exercises the legitimate shared destination-container case.
    await fs.writeFile(path.join(f.root, 'C.PNG'), 'second photo');
    f.organizer.inspectMedia = async paths => paths.map(file => ({ path: file,
      kind: file.endsWith('.MOV') ? 'video' : 'photo', assetIdentifier: file.endsWith('.PNG') ? null : 'live-1',
      capturedAt: '2026-09-21T10:00:00+08:00' }));
    const scan = await f.organizer.scan(f.root);
    const ordinary = scan.items.filter(item => item.type !== 'media').map(item => ({ id: item.id, category: '工作' }));
    const selections = scan.items.filter(item => item.type === 'media').map(item => ({ id: item.id, media }));
    const batch = await f.organizer.move(scan.id, order === 'ordinary-first' ? [...ordinary, ...selections] : [...selections, ...ordinary]);
    assert.equal(batch.entries.length, 4);
    for (const entry of batch.entries) {
      assert.equal(entry.status, 'moved');
      for (const member of entry.members) {
        assert.deepEqual(identity(await fs.lstat(member.target)), member.identity);
        await absent(member.source);
      }
    }
    await hashesAt(f, f.target);
    const undone = await f.organizer.undo(batch.id);
    assert.ok(undone.entries.every(entry => entry.status === 'undone'));
    await hashesAt(f, f.root);
    assert.equal(await fs.readFile(path.join(f.root, 'C.PNG'), 'utf8'), 'second photo');
    assert.equal(await fs.readFile(path.join(f.root, 'ordinary.txt'), 'utf8'), 'ordinary bytes');
    assert.equal(await fs.readFile(path.join(f.root, '2026-notes', 'notes.txt'), 'utf8'), 'folder notes');
  });
}
