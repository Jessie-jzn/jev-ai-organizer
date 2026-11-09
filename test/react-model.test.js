import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canMove, flattenTaxonomy, mediaDestinationPaths, matchesFilter, selectionFor } from '../ui/item-model.js';

const live = { id: 'live', type: 'media', name: 'live.heic', mediaType: 'live-photo',
  members: [{ name: 'live.heic' }, { name: 'live.mov' }], year: '2026', month: '09', day: '21',
  country: '中国', city: '杭州:', locationStatus: 'resolved', dateSource: 'embedded' };

test('React media preview and structured selection follow the shared server path rules', () => {
  assert.deepEqual(mediaDestinationPaths(live), [
    '照片视频 / 2026 / 2026-09 / 2026-09-21 / live.heic',
    '照片视频 / 2026 / 2026-09 / 2026-09-21 / live.mov'
  ]);
  assert.deepEqual(selectionFor(live), { id: 'live', media: {} });
  assert.equal(canMove({ ...live, year: '../escape' }), false);
  assert.equal(matchesFilter(live, 'live-photo'), true);
  assert.equal(matchesFilter(live, 'video'), false);
});

test('React retains ordinary provider confidence review and filter semantics', () => {
  const ordinary = { id: 'doc', type: 'file', name: 'doc.txt', category: '学习', confidence: 0.42, manual: false };
  assert.equal(matchesFilter(ordinary, 'review'), true);
  assert.equal(matchesFilter({ ...ordinary, confidence: 0.9 }, 'review'), false);
  assert.deepEqual(selectionFor(ordinary), { id: 'doc', category: '学习' });
});

test('React flattens the selected inbox taxonomy into stable category paths', () => {
  assert.deepEqual(flattenTaxonomy([{ name: '工作', path: '工作', children: [{ name: '会议', path: '工作/会议', children: [] }] }]), [
    { value: '工作', label: '工作' }, { value: '工作/会议', label: '工作 / 会议' }
  ]);
});

test('completed groups contain only successful moves and retain batch identity', async () => {
  const { completedBatches } = await import('../ui/item-model.js');
  const batches = [{ id: 'mixed', root: '/example', entries: [{ name: 'done', status: 'moved' }, { name: 'failed', status: 'skipped' }, { name: 'ambiguous', status: 'uncertain' }] }, { id: 'undone', entries: [{ name: 'restored', status: 'undone' }] }];
  assert.deepEqual(completedBatches(batches), [{ id: 'mixed', root: '/example', entries: [{ name: 'done', status: 'moved' }] }]);
  assert.equal(batches[0].entries.length, 3);
});
