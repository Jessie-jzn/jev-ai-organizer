import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createApp } from '../src/server.js';
import { interruptedLivePhoto } from './support/interrupted-live-photo.js';

test('HTTP restart scans and moves a recovered Live Photo without first opening history', async t => {
  const f = await interruptedLivePhoto(t);
  const server = createApp(f);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(base + '/api/session')).json();
  const post = (route, body) => fetch(base + '/api/' + route, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-Session-Token': token
  }, body: JSON.stringify(body) });
  const scanned = await post('scan', { root: f.root });
  assert.equal(scanned.status, 200);
  const scan = await scanned.json(), item = scan.items.find(item => item.type === 'media');
  assert.equal(item.mediaType, 'live-photo');
  const moved = await post('move', { scanId: scan.id, selections: [{ id: item.id, media: f.media }] });
  assert.equal(moved.status, 200);
  const batch = await moved.json();
  assert.equal(batch.entries[0].members.length, 2);
  assert.equal(batch.entries[0].status, 'moved');
  for (const member of batch.entries[0].members) assert.equal(await fs.readFile(member.target, 'utf8'), `original:${member.name}`);
});

test('HTTP workflow and local request protection', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-http-'));
  const root = path.join(temp, 'items');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, '课程.pdf'), 'course');
  const server = createApp({ dataDir: path.join(temp, 'data') });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(temp, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base)).status, 200);
  const session = await (await fetch(base + '/api/session')).json();
  assert.ok(session.token);
  const headers = { 'Content-Type': 'application/json', 'X-Session-Token': session.token };
  const post = async (route, body, extra = {}) => fetch(base + route, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  assert.equal((await post('/api/scan', { root }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/scan', { root }, { 'X-Session-Token': 'bad' })).status, 403);
  // Node fetch normalizes Host; use the raw HTTP client to send the actual hostile header.
  const hostileStatus = await new Promise((resolve, reject) => {
    http.get(base + '/api/session', { headers: { Host: 'evil.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(hostileStatus, 403);
  const scan = await (await post('/api/scan', { root })).json();
  assert.equal(scan.items.length, 1);
  const noClassification = await post('/api/classify', { scanId: scan.id, itemIds: [] });
  assert.deepEqual(await noClassification.json(), []);
  assert.equal((await post('/api/classify', { scanId: scan.id, itemIds: ['fake'] })).status, 400);
  const batch = await (await post('/api/move', { scanId: scan.id, selections: [{ id: scan.items[0].id, category: '文档' }] })).json();
  assert.equal(batch.entries[0].status, 'moved');
  const undo = await (await post('/api/undo', { id: batch.id })).json();
  assert.equal(undo.entries[0].status, 'undone');
  assert.equal((await fetch(base + '/.env')).status, 404);
});

test('serves the built React entry and its Vite assets without exposing project files', async t => {
  const server = createApp();
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(base)).text();
  assert.match(html, /id="app-root"/);
  const jsPath = html.match(/src="(\/assets\/[^" ]+\.js)"/)?.[1];
  const cssPath = html.match(/href="(\/assets\/[^" ]+\.css)"/)?.[1];
  assert.ok(jsPath && cssPath, 'built HTML points to a Vite JS and CSS asset');
  for (const asset of [jsPath, cssPath]) {
    const response = await fetch(base + asset);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).length > 100);
  }
  assert.equal((await fetch(base + '/assets/../../.env')).status, 404);
});

async function mediaHttp(t, { platform = process.platform, helperAvailable = true } = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-media-http-'));
  const root = path.join(temp, 'items');
  await fs.mkdir(root);
  for (const name of ['photo.jpg', 'document.txt']) await fs.writeFile(path.join(root, name), name);
  let geocodes = 0, classifications = 0, failLocation = false;
  const server = createApp({ dataDir: path.join(temp, 'data'), platform,
    mediaHelper: async () => { if (!helperAvailable) throw new Error('unavailable'); return '/fixture/helper'; },
    classifyItems: async items => { classifications++; return items.map(item => ({ id: item.id, category: '学习', confidence: 0.9 })); },
    scanOptions: {
      inspectMedia: async paths => paths.map(location => ({ path: location, kind: 'photo', capturedAt: '2026-09-21T14:30:00+08:00', latitude: 31.23045678, longitude: 121.47375678, assetIdentifier: 'secret-asset' })),
      reverseGeocode: async points => { geocodes++; return points.map(point => ({ key: point.key, status: failLocation ? 'unresolved' : 'resolved', country: '中国', city: '上海' })); },
      geocodeCache: { resolve: async (points, provider) => new Map((await provider(points)).map(place => [place.key, place])) }
    }
  });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(temp, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = await (await fetch(base + '/api/session')).json();
  const post = async (route, body) => fetch(base + '/api/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': session.token }, body: JSON.stringify(body) });
  return { root, session, post, geocodes: () => geocodes, classifications: () => classifications, failLocation: () => { failLocation = true; } };
}

test('session reports media support only when platform and helper are available', async t => {
  for (const [platform, helperAvailable, expected] of [['darwin', true, true], ['darwin', false, false], ['linux', true, false]]) {
    const fixture = await mediaHttp(t, { platform, helperAvailable });
    assert.equal(fixture.session.mediaSupported, expected);
  }
});

test('HTTP scans require boolean consent and expose only opt-in failed rounded coordinates', async t => {
  const fixture = await mediaHttp(t);
  for (const resolveLocations of ['true', 1, null, {}, []]) assert.equal((await fixture.post('scan', { root: fixture.root, resolveLocations })).status, 400);
  for (const consent of [{}, { resolveLocations: false }]) {
    const response = await fixture.post('scan', { root: fixture.root, ...consent });
    assert.equal(response.status, 200);
    const scan = await response.json();
    assert.equal(scan.root, await fs.realpath(fixture.root));
    assert.equal(scan.items.find(item => item.name === 'photo.jpg').type, 'media');
    const serialized = JSON.stringify(scan);
    for (const secret of ['identity', 'latitude', 'longitude', 'assetIdentifier', 'secret-asset', '31.230', '121.473', path.join(fixture.root, 'photo.jpg')]) assert.ok(!serialized.includes(secret), secret);
  }
  assert.equal(fixture.geocodes(), 0);
  const resolved = await (await fixture.post('scan', { root: fixture.root, resolveLocations: true })).json();
  assert.equal(fixture.geocodes(), 1);
  assert.equal(resolved.items.find(item => item.type === 'media').city, '上海');
  assert.ok(!JSON.stringify(resolved).includes('31.230'));
  fixture.failLocation();
  const unresolved = await (await fixture.post('scan', { root: fixture.root, resolveLocations: true })).json();
  assert.equal(unresolved.items.find(item => item.type === 'media').displayCoordinates, '31.2305, 121.4738');
  assert.ok(!JSON.stringify(unresolved).includes('31.23045678'));
});

test('HTTP rejects media classification and arbitrary destinations before any move', async t => {
  const fixture = await mediaHttp(t);
  const scan = await (await fixture.post('scan', { root: fixture.root })).json();
  const media = scan.items.find(item => item.name === 'photo.jpg');
  const ordinary = scan.items.find(item => item.name === 'document.txt');
  assert.equal((await fixture.post('classify', { scanId: scan.id, itemIds: [ordinary.id, media.id] })).status, 400);
  assert.equal(fixture.classifications(), 0);
  assert.equal((await fixture.post('classify', { scanId: scan.id, itemIds: [ordinary.id] })).status, 200);
  assert.equal(fixture.classifications(), 0);
  const selections = [
    { id: media.id, media: {}, target: '/tmp/escape' },
    { id: media.id, media: {}, targetSegments: ['2026'] },
    { id: media.id, media: { target: '/tmp/escape' } },
    { id: media.id, media: { extra: true } },
    { id: media.id, media: { month: '13' } },
    { id: media.id, media: { month: 9 } },
    { id: media.id, media: [], category: '学习' },
    { id: ordinary.id, category: '学习', media: {} },
    { id: ordinary.id, category: '学习', target: '/tmp/escape' }
  ];
  for (const selection of selections) {
    const response = await fixture.post('move', { scanId: scan.id, selections: [selection] });
    assert.equal(response.status, 400, JSON.stringify(selection));
    assert.equal(await fs.readFile(path.join(fixture.root, 'photo.jpg'), 'utf8'), 'photo.jpg');
  }
  const response = await fixture.post('move', { scanId: scan.id, selections: [{ id: media.id, media: { year: '2026', month: '09', country: '中国', city: '杭州', mediaType: 'photo' } }] });
  assert.equal(response.status, 200);
  const batch = await response.json();
  assert.equal(batch.entries[0].status, 'moved');
  assert.equal(await fs.readFile(path.join(fixture.root, scan.outputDirectory, '照片视频/2026/2026-09/2026-09-21/photo.jpg'), 'utf8'), 'photo.jpg');
});
