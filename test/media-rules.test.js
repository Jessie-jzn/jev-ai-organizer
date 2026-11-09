import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMediaSegments, resolveMediaFacts, sanitizeSegment } from '../src/media-rules.js';

test('uses an embedded timestamp with an offset before every fallback', () => {
  const facts = resolveMediaFacts({
    metadata: { kind: 'photo', capturedAt: '2026-10-01T00:30:00+08:00' },
    name: 'IMG_20240101_010101.jpg',
    birthtime: new Date('2020-01-01T00:00:00Z'),
    timeZone: 'UTC'
  });

  assert.equal(facts.dateSource, 'embedded');
  assert.equal(facts.inferredDate, false);
  assert.equal(facts.year, '2026');
  assert.equal(facts.month, '10');
  assert.deepEqual(buildMediaSegments({ ...facts, country: '中国', city: '上海' }),
    ['照片视频', '2026', '2026-10', '2026-10-01']);
});

test('interprets metadata without an offset as a local clock in the requested timezone', () => {
  const facts = resolveMediaFacts({
    metadata: { kind: 'video', capturedAt: '2026-09-30T16:30:00' },
    name: 'clip.mp4', birthtime: null, timeZone: 'Asia/Shanghai'
  });

  assert.equal(facts.year, '2026');
  assert.equal(facts.month, '09');
  assert.equal(facts.inferredDate, true);
});

test('offset-free embedded month and year boundaries preserve their wall-clock calendar in positive and negative zones', () => {
  for (const timeZone of ['Asia/Shanghai', 'Pacific/Kiritimati', 'America/Los_Angeles', 'Pacific/Honolulu']) {
    for (const capturedAt of ['2026-09-30T23:30:00', '2026-12-31T23:30:00', '2026-10-01T00:30:00', '2026-01-01T00:30:00']) {
      const facts = resolveMediaFacts({ metadata: { kind: 'photo', capturedAt }, timeZone });
      assert.equal(facts.year, capturedAt.slice(0, 4), `${timeZone} ${capturedAt}`);
      assert.equal(facts.month, capturedAt.slice(5, 7), `${timeZone} ${capturedAt}`);
      assert.equal(facts.capturedAt, capturedAt);
      assert.equal(facts.inferredDate, true);
    }
  }
});

test('explicit inline or separate offsets keep the embedded calendar without shifting it twice', () => {
  for (const [capturedAt, offsetMinutes] of [
    ['2026-01-01T00:30:00+14:00', 840], ['2026-12-31T23:30:00-10:00', -600],
    ['2026-09-30T23:30:00', 480], ['2026-01-01T00:30:00', -480]
  ]) {
    const facts = resolveMediaFacts({ metadata: { kind: 'photo', capturedAt, offsetMinutes }, timeZone: 'UTC' });
    assert.equal(facts.year, capturedAt.slice(0, 4));
    assert.equal(facts.month, capturedAt.slice(5, 7));
    assert.equal(facts.inferredDate, false);
  }
});

test('filesystem instants still convert across month and year boundaries into the requested zone', () => {
  for (const [birthtime, timeZone, year, month] of [
    ['2026-12-31T23:30:00Z', 'Asia/Shanghai', '2027', '01'],
    ['2026-01-01T00:30:00Z', 'America/Los_Angeles', '2025', '12']
  ]) {
    const facts = resolveMediaFacts({ metadata: { kind: 'photo' }, birthtime, timeZone });
    assert.equal(facts.dateSource, 'filesystem');
    assert.equal(facts.year, year);
    assert.equal(facts.month, month);
  }
});

test('recognizes only complete valid filename date formats', () => {
  const cases = [
    ['IMG_20260921_143000.jpg', '2026', '09'],
    ['trip 2026-10-02 03-04-05.mp4', '2026', '10'],
    ['scan-2024-02-29.png', '2024', '02']
  ];

  for (const [name, year, month] of cases) {
    const facts = resolveMediaFacts({ metadata: { kind: 'photo' }, name, birthtime: null, timeZone: 'UTC' });
    assert.equal(facts.dateSource, 'filename', name);
    assert.equal(facts.year, year, name);
    assert.equal(facts.month, month, name);
  }
});

test('does not accept invalid calendar values or dates embedded in longer numbers', () => {
  for (const name of ['IMG_20260229_120000.jpg', 'IMG_20261301_120000.jpg', 'x20260921_1430009.jpg', '2026-02-30.jpg', '2026-09-21 14-30-009.jpg']) {
    const facts = resolveMediaFacts({ metadata: { kind: 'photo' }, name, birthtime: null, timeZone: 'UTC' });
    assert.equal(facts.dateSource, 'unknown', name);
    assert.equal(facts.year, '未知日期', name);
    assert.equal(facts.month, '未知月份', name);
  }
});

test('does not treat ISO-shaped timestamp continuations as date-only filenames', () => {
  const malformed = resolveMediaFacts({
    metadata: { kind: 'photo' }, name: 'IMG_2026-09-21T99:99:99.jpg', birthtime: null, timeZone: 'UTC'
  });
  const unsupported = resolveMediaFacts({
    metadata: { kind: 'photo' }, name: 'IMG_2026-09-21T12:00:00.jpg',
    birthtime: new Date('2025-04-03T00:00:00Z'), timeZone: 'UTC'
  });

  assert.equal(malformed.dateSource, 'unknown');
  assert.equal(unsupported.dateSource, 'filesystem');
});

test('uses a valid filesystem birthtime only after embedded and filename dates', () => {
  const facts = resolveMediaFacts({
    metadata: { kind: 'video' }, name: 'clip.mp4',
    birthtime: new Date('2025-04-03T00:00:00Z'), timeZone: 'Asia/Shanghai'
  });

  assert.equal(facts.dateSource, 'filesystem');
  assert.equal(facts.inferredDate, true);
  assert.equal(facts.year, '2025');
  assert.equal(facts.month, '04');
});

test('uses unknown date segments only after every date source is unavailable', () => {
  const facts = resolveMediaFacts({ metadata: { kind: 'photo', capturedAt: 'not-a-date' }, name: 'clip.mp4', birthtime: null, timeZone: 'UTC' });

  assert.equal(facts.dateSource, 'unknown');
  assert.deepEqual(buildMediaSegments(facts), ['照片视频', '日期待确认']);
});

test('keeps only valid coordinates and applies an optional resolved place', () => {
  const resolved = resolveMediaFacts({
    metadata: { kind: 'video', latitude: 31.2304, longitude: 121.4737 }, name: 'clip.mp4', birthtime: null,
    timeZone: 'UTC', place: { country: ' 中国 ', city: ' 上海 ', status: 'resolved' }
  });
  const invalid = resolveMediaFacts({
    metadata: { kind: 'photo', latitude: 91, longitude: 121 }, name: 'photo.jpg', birthtime: null, timeZone: 'UTC'
  });

  assert.equal(resolved.latitude, 31.2304);
  assert.equal(resolved.locationStatus, 'resolved');
  assert.equal(resolved.country, '中国');
  assert.equal(resolved.city, '上海');
  assert.equal(invalid.latitude, null);
  assert.equal(invalid.longitude, null);
  assert.equal(invalid.locationStatus, 'unknown');
});

test('sanitizes path segments without retaining traversal or forbidden characters', () => {
  assert.equal(sanitizeSegment('../上/海\0', '未知城市'), '上_海');
  assert.equal(sanitizeSegment('  e\u0301::a\\b  ', '未知城市'), 'é_a_b');
  assert.equal(sanitizeSegment('..', '未知城市'), '未知城市');
  assert.equal(sanitizeSegment('', '未知城市'), '未知城市');
  assert.equal(sanitizeSegment('', '../未知城市'), '未知城市');
});

test('limits path segments to 80 Unicode code points', () => {
  const value = '中'.repeat(81);
  assert.equal([...sanitizeSegment(value, '未知城市')].length, 80);
});

test('rejects invalid year and month values and permits a Live Photo directory override', () => {
  assert.throws(() => buildMediaSegments({ year: '..', month: '09', day: '21', country: '中国', city: '上海', mediaType: 'photo' }), /invalid year/);
  assert.throws(() => buildMediaSegments({ year: '2026', month: '13', country: '中国', city: '上海', mediaType: 'photo' }), /invalid month/);
  assert.deepEqual(buildMediaSegments({ year: '2026', month: '09', day: '21', country: '中国', city: '上海', mediaType: 'video' }, { mediaType: 'live-photo' }),
    ['照片视频', '2026', '2026-09', '2026-09-21']);
});
