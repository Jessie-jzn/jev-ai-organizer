import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { inspectMedia } from '../src/media-native.js';
import { Organizer } from '../src/organizer.js';

const execFile = promisify(execFileCallback);
const generator = fileURLToPath(new URL('./native/create-media-fixtures.swift', import.meta.url));
const digest = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');

test('real native media metadata survives scan, grouped move and undo byte for byte', {
  skip: process.platform !== 'darwin' ? 'Native media requires macOS; generic tests run on every platform.' : false,
  timeout: 180_000
}, async t => {
  assert.equal(await fs.access(generator).then(() => true, () => false), true,
    'The programmatic native fixture generator must exist');
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'jev-media-integration-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'media');
  const binary = path.join(base, 'create-media-fixtures');
  await execFile('/usr/bin/xcrun', ['swiftc', '-parse-as-library', generator,
    '-module-cache-path', path.join(base, 'swift-module-cache'), '-o', binary], { timeout: 120_000 });
  const { stdout } = await execFile(binary, [root], { timeout: 60_000 });
  const manifest = JSON.parse(stdout);
  assert.equal(manifest.version, 1);
  assert.deepEqual(manifest.files.map(file => file.name).sort(),
    ['dated.jpg', 'live.HEIC', 'live.MOV', 'undated.png', 'video.MOV'].sort());
  const expectedByName = new Map(manifest.files.map(file => [file.name, file]));
  for (const file of manifest.files) {
    assert.equal(file.path, path.join(root, file.name));
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.equal(await digest(file.path), file.sha256);
  }

  const metadata = await inspectMedia(manifest.files.map(file => file.path));
  for (const result of metadata) {
    const expected = expectedByName.get(path.basename(result.path)).metadata;
    for (const key of ['kind', 'capturedAt', 'offsetMinutes', 'assetIdentifier']) {
      assert.equal(result[key], expected[key], `${path.basename(result.path)} ${key}`);
    }
    assert.equal(result.error, null, result.path);
    for (const key of ['latitude', 'longitude']) {
      if (expected[key] === null) assert.equal(result[key], null, `${result.path} ${key}`);
      else assert.ok(Math.abs(result[key] - expected[key]) < 0.0001, `${result.path} ${key}: ${result[key]}`);
    }
  }
  const dated = metadata.find(item => item.path.endsWith('/dated.jpg'));
  assert.equal(dated.capturedAt, '2026-09-21T14:30:00+08:00');
  assert.equal(dated.offsetMinutes, 480);
  assert.ok(Math.abs(dated.latitude - 31.2304) < 0.0001);
  assert.ok(Math.abs(dated.longitude - 121.4737) < 0.0001);
  for (const name of ['live.HEIC', 'live.MOV']) {
    assert.equal(metadata.find(item => item.path.endsWith(`/${name}`)).assetIdentifier, 'test-live-photo-1');
  }

  let geocodeCalls = 0;
  const organizer = new Organizer(path.join(base, 'journal'), {
    timeZone: 'Asia/Shanghai', reverseGeocode: async () => { geocodeCalls++; assert.fail('Apple geocoding is forbidden in native integration'); }
  });
  const scan = await organizer.scan(root, { resolveLocations: false });
  assert.equal(geocodeCalls, 0);
  assert.equal(scan.items.length, 4);
  assert.ok(scan.items.every(item => item.type === 'media' && item.metadataStatus === 'ok'));
  const live = scan.items.find(item => item.mediaType === 'live-photo');
  assert.deepEqual(live.members.map(item => item.name).sort(), ['live.HEIC', 'live.MOV']);
  assert.equal(live.dateSource, 'embedded');
  assert.equal(scan.items.find(item => item.name === 'undated.png').dateSource, 'filesystem');
  for (const item of scan.items) {
    assert.equal(item.country, '未知国家');
    assert.equal(item.city, '未知城市');
    assert.equal(Object.hasOwn(item, 'latitude'), false);
    assert.equal(Object.hasOwn(item, 'assetIdentifier'), false);
  }
  const selections = scan.items.map(item => ({ id: item.id, media: {
    year: item.year, month: item.month, country: '中国', city: '上海',
    mediaType: item.mediaType === 'video' ? 'video' : 'photo'
  } }));
  const batch = await organizer.move(scan.id, selections);
  assert.equal(batch.entries.length, 4);
  assert.equal(batch.entries.filter(entry => entry.kind === 'group').length, 1);
  for (const entry of batch.entries) {
    assert.equal(entry.status, 'moved');
    for (const member of entry.members) {
      assert.equal(await digest(member.target), expectedByName.get(member.name).sha256);
      assert.equal(await fs.access(member.source).then(() => true, () => false), false);
      assert.ok(/\/\d{4}\/\d{4}-\d{2}\//.test(member.target));
      if (entry.kind === 'group') assert.match(path.basename(path.dirname(member.target)), /^\d{4}-\d{2}-\d{2}$/);
    }
  }
  const undone = await new Organizer(path.join(base, 'journal')).undo(batch.id);
  assert.ok(undone.entries.every(entry => entry.status === 'undone'));
  for (const file of manifest.files) assert.equal(await digest(file.path), file.sha256);
  for (const entry of batch.entries) for (const member of entry.members) {
    assert.equal(await fs.access(member.target).then(() => true, () => false), false);
  }
  assert.equal(geocodeCalls, 0);
});
