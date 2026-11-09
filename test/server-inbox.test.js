import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server.js';

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-server-inbox-'));
  const root = path.join(temp, 'Downloads');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, '发票.pdf'), 'invoice');
  const server = createApp({ dataDir: path.join(temp, 'data'), classifyItems: async items => items.map(item => ({
    id: item.id, category: '财务/待报销', confidence: 0.96
  })) });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(temp, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = await (await fetch(base + '/api/session')).json();
  const headers = { 'Content-Type': 'application/json', 'X-Session-Token': session.token };
  const post = (route, body) => fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) });
  return { root, base, headers, post };
}

test('creates an inbox and persists scan and classification as pending review', async t => {
  const f = await fixture(t);
  const created = await f.post('/api/inboxes', { name: '下载', root: f.root, taxonomy: [{ name: '财务', children: [{ name: '待报销' }] }] });
  assert.equal(created.status, 200);
  const inbox = await created.json();
  const scanResponse = await f.post('/api/scan', { root: f.root, inboxId: inbox.id });
  assert.equal(scanResponse.status, 200);
  const scan = await scanResponse.json();
  const pendingBefore = await (await fetch(`${f.base}/api/pending?inboxId=${inbox.id}`, { headers: f.headers })).json();
  assert.equal(pendingBefore.length, 1);
  assert.equal(pendingBefore[0].status, 'pending');
  const classified = await f.post('/api/classify', { scanId: scan.id, itemIds: [scan.items[0].id] });
  assert.equal(classified.status, 200);
  const pendingAfter = await (await fetch(`${f.base}/api/pending?inboxId=${inbox.id}`, { headers: f.headers })).json();
  assert.equal(pendingAfter[0].category, '财务/待报销');
  assert.equal(pendingAfter[0].status, 'pending');
  const edited = await f.post('/api/pending/update', { id: pendingAfter[0].id, changes: { category: '财务/待报销', recommendationSource: 'manual' } });
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).recommendationSource, 'manual');
  const moved = await f.post('/api/move', { scanId: scan.id, selections: [{ id: scan.items[0].id, category: '财务/待报销' }] });
  assert.equal(moved.status, 200);
  assert.equal((await moved.json()).entries[0].status, 'moved');
  assert.equal((await fs.stat(path.join(f.root, scan.outputDirectory, '财务', '待报销', '发票.pdf'))).isFile(), true);
  const pendingAfterMove = await (await fetch(`${f.base}/api/pending?inboxId=${inbox.id}`, { headers: f.headers })).json();
  assert.deepEqual(pendingAfterMove, []);
});

test('pending and inbox endpoints require the local session token', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.base + '/api/inboxes')).status, 403);
  assert.equal((await fetch(f.base + '/api/pending')).status, 403);
});
