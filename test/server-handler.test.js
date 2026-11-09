import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';
import { interruptedLivePhoto } from './support/interrupted-live-photo.js';

// Exercise the real request handler without a listening socket. Socket and browser
// coverage remains in server.test.js and e2e/organizer.spec.js.
async function dispatch(server, url, body, token) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { url, method: body === undefined ? 'GET' : 'POST', headers: { host: 'localhost:3210', 'content-type': 'application/json', 'x-session-token': token } });
  return new Promise((resolve, reject) => {
    const res = { headersSent: false, setHeader() {}, writeHead(status) { this.status = status; this.headersSent = true; }, end(content) { resolve({ status: this.status, body: JSON.parse(content) }); } };
    Promise.resolve(server.listeners('request')[0](req, res)).catch(reject);
  });
}

async function fixture(t, options = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-handler-'));
  const root = path.join(temp, 'items');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'photo.jpg'), 'photo fixture');
  await fs.writeFile(path.join(root, 'doc.txt'), 'document fixture');
  let queries = 0, classifications = 0, inspections = 0, failed = false;
  const server = createApp({ dataDir: path.join(temp, 'data'), platform: 'darwin', mediaHelper: async () => '/fixture/helper',
    classifyItems: async items => { classifications++; return items.map(item => ({ id: item.id, category: '文档' })); },
    scanOptions: {
      inspectMedia: async paths => { inspections++; return paths.map(file => ({ path: file, kind: 'photo', capturedAt: '2026-09-21T14:30:00+08:00', latitude: 31.23045678, longitude: 121.47375678, assetIdentifier: 'private-asset' })); },
      reverseGeocode: async points => { queries++; return points.map(point => ({ key: point.key, status: failed ? 'unresolved' : 'resolved', country: '中国', city: '上海' })); },
      geocodeCache: { resolve: async (points, provider) => new Map((await provider(points)).map(place => [place.key, place])) }
    }, ...options });
  server.address = () => ({ port: 3210 });
  t.after(async () => { server.closeAllConnections(); await fs.rm(temp, { recursive: true, force: true }); });
  const session = (await dispatch(server, '/api/session')).body;
  return { root, session, get: route => dispatch(server, `/api/${route}`, undefined, session.token), post: (route, body) => dispatch(server, `/api/${route}`, body, session.token), queries: () => queries, inspections: () => inspections, classifications: () => classifications, fail: () => { failed = true; } };
}

test('fresh request handler recovers a partial Live Photo on scan before any history request', async t => {
  const f = await interruptedLivePhoto(t);
  const server = createApp(f);
  server.address = () => ({ port: 3210 });
  const { token } = (await dispatch(server, '/api/session')).body;
  const scanned = await dispatch(server, '/api/scan', { root: f.root }, token);
  assert.equal(scanned.status, 200);
  const mediaItem = scanned.body.items.find(item => item.type === 'media');
  assert.equal(mediaItem.mediaType, 'live-photo');
  assert.deepEqual(mediaItem.members.map(member => member.name).sort(), ['A.HEIC', 'B.MOV']);
  const moved = await dispatch(server, '/api/move', { scanId: scanned.body.id,
    selections: [{ id: mediaItem.id, media: f.media }] }, token);
  assert.equal(moved.status, 200);
  assert.equal(moved.body.entries[0].status, 'moved');
  for (const member of moved.body.entries[0].members) {
    assert.equal(await fs.readFile(member.target, 'utf8'), `original:${member.name}`);
  }
});

test('request handler reports media capability from platform and helper availability', async t => {
  for (const [options, expected] of [[{}, true], [{ platform: 'linux' }, false], [{ mediaHelper: async () => { throw new Error('missing'); } }, false]]) {
    assert.equal((await fixture(t, options)).session.mediaSupported, expected);
  }
});

test('request handler validates consent and protects precise GPS in every scan', async t => {
  const f = await fixture(t);
  for (const resolveLocations of ['true', 1, null, {}, []]) assert.equal((await f.post('scan', { root: f.root, resolveLocations })).status, 400);
  for (const consent of [{}, { resolveLocations: false }]) {
    const scan = (await f.post('scan', { root: f.root, ...consent })).body;
    assert.equal(scan.root, await fs.realpath(f.root));
    assert.equal(scan.items.find(item => item.name === 'photo.jpg').type, 'media');
    for (const secret of ['identity', 'latitude', 'longitude', 'assetIdentifier', 'private-asset', '31.230', '121.473', path.join(f.root, 'photo.jpg')]) assert.ok(!JSON.stringify(scan).includes(secret), secret);
  }
  assert.equal(f.queries(), 0);
  let scan = (await f.post('scan', { root: f.root, resolveLocations: true })).body;
  assert.equal(f.queries(), 1);
  assert.equal(scan.items.find(item => item.type === 'media').city, '上海');
  assert.ok(!JSON.stringify(scan).includes('31.230'));
  f.fail();
  scan = (await f.post('scan', { root: f.root, resolveLocations: true })).body;
  assert.equal(scan.items.find(item => item.type === 'media').displayCoordinates, '31.2305, 121.4738');
  assert.ok(!JSON.stringify(scan).includes('31.23045678'));
});

test('request handler blocks media classification and non-schema moves before filesystem changes', async t => {
  const f = await fixture(t);
  const scan = (await f.post('scan', { root: f.root })).body;
  const media = scan.items.find(item => item.name === 'photo.jpg');
  const ordinary = scan.items.find(item => item.name === 'doc.txt');
  assert.equal((await f.post('classify', { scanId: scan.id, itemIds: [ordinary.id, media.id] })).status, 400);
  assert.equal(f.classifications(), 0);
  assert.equal((await f.post('classify', { scanId: scan.id, itemIds: [ordinary.id] })).status, 200);
  assert.equal(f.classifications(), 0);
  for (const selection of [
    { id: media.id, media: {}, target: '/tmp/escape' }, { id: media.id, media: {}, targetSegments: ['2026'] },
    { id: media.id, media: { target: '/tmp/escape' } }, { id: media.id, media: { extra: true } },
    { id: media.id, media: { month: '13' } }, { id: media.id, media: { month: 9 } },
    { id: ordinary.id, category: '文档', media: {} }, { id: ordinary.id, category: '文档', extra: true }
  ]) {
    assert.equal((await f.post('move', { scanId: scan.id, selections: [selection] })).status, 400, JSON.stringify(selection));
    assert.equal(await fs.readFile(path.join(f.root, 'photo.jpg'), 'utf8'), 'photo fixture');
  }
  const moved = await f.post('move', { scanId: scan.id, selections: [{ id: media.id, media: { year: '2026', month: '09', country: '中国', city: '杭州', mediaType: 'photo' } }] });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.entries[0].status, 'moved');
  assert.equal(await fs.readFile(path.join(f.root, scan.outputDirectory, '照片视频/2026/2026-09/2026-09-21/photo.jpg'), 'utf8'), 'photo fixture');
  assert.equal((await f.post('undo', { id: moved.body.id })).body.entries[0].status, 'undone');
  assert.equal(await fs.readFile(path.join(f.root, 'photo.jpg'), 'utf8'), 'photo fixture');
});

test('move request rejects extra fields on the envelope as well as selections', async t => {
  const f = await fixture(t);
  const scan = (await f.post('scan', { root: f.root })).body;
  const media = scan.items.find(item => item.type === 'media');
  for (const extra of [{ target: '/tmp/escape' }, { targetSegments: ['2026'] }, { extra: true }]) {
    assert.equal((await f.post('move', { scanId: scan.id, selections: [{ id: media.id, media: {} }], ...extra })).status, 400);
    assert.equal(await fs.readFile(path.join(f.root, 'photo.jpg'), 'utf8'), 'photo fixture');
  }
});

for (const route of ['pick-folder', 'scan', 'classify', 'undo']) {
  test(`${route} rejects unknown request keys before dispatch`, async t => {
    let picks = 0;
    const f = await fixture(t, { chooseFolder: async root => { picks++; return root; } });
    const scan = (await f.post('scan', { root: f.root })).body;
    const item = scan.items.find(item => item.type === 'file');
    const moved = (await f.post('move', { scanId: scan.id, selections: [{ id: item.id, category: '文档' }] })).body;
    const before = f.inspections();
    const valid = { 'pick-folder': { root: f.root }, scan: { root: f.root, resolveLocations: true }, classify: { scanId: scan.id, itemIds: [item.id] }, undo: { id: moved.id } }[route];
    for (const extra of [{ extra: true }, { target: '/tmp/escape' }]) {
      assert.equal((await f.post(route, { ...valid, ...extra })).status, 400);
      assert.equal(picks, 0);
      assert.equal(f.inspections(), before);
      assert.equal(f.queries(), 0);
      assert.equal(f.classifications(), 0);
      assert.equal(await fs.readFile(path.join(f.root, scan.outputDirectory, '文档/doc.txt'), 'utf8'), 'document fixture');
    }
    assert.equal((await f.post(route, valid)).status, 200);
  });
}


test('reorganize inbox pending entries retain the exact nested ordinary source', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, '文档'));
  await fs.writeFile(path.join(f.root, '文档', 'doc.txt'), 'nested document');
  const inbox = (await f.post('inboxes', { name: '重整测试', root: f.root, taxonomy: [{ name: '文档' }] })).body;
  const response = await f.post('scan', { root: f.root, inboxId: inbox.id, mode: 'reorganize' });
  assert.equal(response.status, 200);
  const nested = response.body.items.find(item => item.sourceRelativePath === '文档/doc.txt');
  assert.ok(nested);
  assert.equal(JSON.stringify(nested).includes('sourceDirectories'), false);
  const pending = (await f.get(`pending?inboxId=${inbox.id}`)).body.find(item => item.id === nested.id);
  assert.equal(pending.source, path.join(await fs.realpath(f.root), '文档', 'doc.txt'));
});
