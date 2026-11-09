import { test, expect } from '@playwright/test';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/server.js';

test('type suggestions preserve nested documents and move only confirmed direct files', async ({ page }, testInfo) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-types-ui-'));
  const root = path.join(temp, '待整理');
  const server = createApp({ dataDir: path.join(temp, 'data'), chooseFolder: async () => root });
  try {
    await fs.mkdir(path.join(root, '客户项目'), { recursive: true });
    await fs.writeFile(path.join(root, '客户项目', '合同.pdf'), 'nested document');
    await fs.writeFile(path.join(root, '课程安排.pdf'), 'document');
    await fs.writeFile(path.join(root, '录音.mp3'), 'audio');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await expect(page.locator('#scan-button')).toBeEnabled();
    await page.locator('#pick-folder').click();
    await page.locator('#scan-button').click();
    await expect(page.locator('#folder-rows tr')).toHaveCount(2);
    const outputDirectory = (await page.locator('#output-directory').textContent()).match(/整理_\d{8}/)[0];
    await expect(page.locator('#classify')).toHaveCount(0);
    const document = page.locator('#folder-rows tr').filter({ hasText: '课程安排.pdf' });
    await expect(document.locator('select')).toHaveValue('文档');
    await expect(document.locator('.destination')).toHaveText(`${outputDirectory} / 文档 / 课程安排.pdf`);
    await expect(page.locator('#select-all')).not.toBeChecked();
    await page.locator('#select-all').check();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath('desktop.png'), fullPage: true });
    await page.locator('#move').click();
    await page.getByRole('button', { name: '确认移动', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('已移动 2 个');
    expect(await fs.readFile(path.join(root, outputDirectory, '文档', '课程安排.pdf'), 'utf8')).toBe('document');
    expect(await fs.readFile(path.join(root, outputDirectory, '音频', '录音.mp3'), 'utf8')).toBe('audio');
    expect(await fs.readFile(path.join(root, '客户项目', '合同.pdf'), 'utf8')).toBe('nested document');
    await page.locator('#nav-history').click();
    await page.getByRole('button', { name: '撤销此批次' }).click();
    await expect(page.locator('#history-notice')).toContainText('撤销完成');
    expect(await fs.readFile(path.join(root, '课程安排.pdf'), 'utf8')).toBe('document');
    await page.locator('#nav-organize').click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath('mobile.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await page.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('AI retry clears stale errors and requests only items still in the preview (mock provider)', async ({ page }) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-ai-ui-'));
  const root = path.join(temp, 'items');
  const server = createApp({ dataDir: path.join(temp, 'data') });
  try {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'A.txt'), 'A');
    await fs.writeFile(path.join(root, 'B.txt'), 'B');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await page.route('**/api/session', async route => {
      const response = await route.fetch();
      await route.fulfill({ json: { ...await response.json(), aiEnabled: true } });
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const session = await (await fetch(base + '/api/session')).json();
    const inbox = await (await fetch(base + '/api/inboxes', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': session.token }, body: JSON.stringify({ name: '项目收件箱', root, taxonomy: [{ name: '工作' }, { name: '学习' }] }) })).json();
    let attempt = 0;
    let requestedIds;
    await page.route('**/api/classify', async route => {
      requestedIds = route.request().postDataJSON().itemIds;
      const id = await page.locator('[data-category]').first().getAttribute('data-category');
      attempt++;
      await route.fulfill({ json: [{ id, category: attempt > 1 ? '学习' : null, confidence: attempt === 1 ? null : attempt === 2 ? 0.4 : 0.9, ...(attempt === 1 ? { error: 'AI 分类失败' } : {}) }] });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await expect(page.locator('#app-root [data-react-app]')).toBeVisible();
    await expect(page.locator('#scan-button')).toBeEnabled();
    await expect(page.locator('#inbox')).toBeVisible();
    await page.locator('#inbox').selectOption(inbox.id);
    await page.locator('#scan-button').click();
    await expect(page.locator('#folder-rows tr')).toHaveCount(2);
    const outputDirectory = (await page.locator('#output-directory').textContent()).match(/整理_\d{8}/)[0];
    await page.locator('[data-category]').first().selectOption('工作');
    await page.locator('#move').click();
    await page.getByRole('button', { name: '确认移动', exact: true }).click();
    await expect(page.locator('#folder-rows tr')).toHaveCount(1);
    await page.locator('#classify').click();
    await expect(page.locator('#folder-rows')).toContainText('AI 分类失败');
    await page.locator('#classify').click();
    await expect(page.locator('[data-category]')).toHaveValue('学习');
    await expect(page.locator('#folder-rows')).not.toContainText('AI 分类失败');
    expect(requestedIds).toHaveLength(1);
    await expect(page.locator('[data-select]')).not.toBeChecked();
    expect(await fs.readFile(path.join(root, 'B.txt'), 'utf8')).toBe('B');
    await page.locator('#auto').check();
    await page.locator('#classify').click();
    await expect(page.locator('#folder-rows tr')).toHaveCount(0);
    expect(await fs.readFile(path.join(root, outputDirectory, '学习', 'B.txt'), 'utf8')).toBe('B');
  } finally {
    await page.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('mixed media consent, structured edits, filters and Live Photo move/undo', async ({ page }, testInfo) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-media-browser-'));
  const root = path.join(temp, 'items');
  let geocodes = 0;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  const server = createApp({ dataDir: path.join(temp, 'data'), mediaHelper: async () => '/fixture/helper', scanOptions: {
    inspectMedia: async paths => paths.map(location => ({ path: location, kind: /\.(mov|mp4)$/i.test(location) ? 'video' : 'photo',
      capturedAt: location.endsWith('broken.jpg') ? null : '2026-09-21T14:30:00+08:00', latitude: 31.2304, longitude: 121.4737,
      assetIdentifier: path.basename(location).startsWith('live.') ? 'paired-live' : null,
      error: location.endsWith('broken.jpg') ? 'unreadable metadata' : null })),
    reverseGeocode: async points => { geocodes++; return points.map(point => ({ key: point.key, country: '中国', city: '上海', status: 'resolved' })); }
  } });
  try {
    await fs.mkdir(path.join(root, '课程'), { recursive: true });
    await fs.mkdir(path.join(root, '积压', '旅行'), { recursive: true });
    for (const name of ['photo.jpg', 'video.mp4', 'live.heic', 'live.mov', 'document.txt', 'broken.jpg']) await fs.writeFile(path.join(root, ...(name.startsWith('live.') ? ['积压', '旅行'] : []), name), `fixture ${name}`);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await expect(page.locator('#app-root [data-react-app]')).toBeVisible();
    await expect(page.locator('#scan-button')).toBeEnabled();
    await expect(page.locator('#resolve-locations')).toHaveCount(0);
    await page.locator('#root').fill(root);
    await page.locator('#scan-button').click();
    await expect(page.locator('#folder-rows tr')).toHaveCount(5);
    const outputDirectory = (await page.locator('#output-directory').textContent()).match(/整理_\d{8}/)[0];
    expect(geocodes).toBe(0);
    await expect(page.getByText('Live Photo · 2 个文件', { exact: true })).toBeVisible();
    expect(geocodes).toBe(0);
    await expect(page.locator('#folder-rows tr').filter({ hasText: 'live.heic' }).locator('.media-target')).toHaveText([`${outputDirectory} / 照片视频 / 2026 / 2026-09 / 2026-09-21 / live.heic`, `${outputDirectory} / 照片视频 / 2026 / 2026-09 / 2026-09-21 / live.mov`]);
    for (const [filter, count] of [['photo', 2], ['video', 1], ['live-photo', 1], ['date-review', 1], ['all', 5]]) {
      await page.locator(`[data-filter="${filter}"]`).click();
      await expect(page.locator(`[data-filter="${filter}"]`)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('[data-filter][aria-pressed="true"]')).toHaveCount(1);
      await expect(page.locator('#folder-rows tr')).toHaveCount(count);
    }
    const live = page.locator('#folder-rows tr').filter({ hasText: 'live.heic' });
    await expect(live.locator('[data-field="mediaType"]')).toHaveCount(0);
    await live.getByLabel('月份', { exact: true }).selectOption('10');

    await expect(live.locator('.destination')).toContainText('照片视频 / 2026 / 2026-10');
    await expect(live.locator('[data-select]')).toBeChecked();
    const broken = page.locator('#folder-rows tr').filter({ hasText: 'broken.jpg' });
    await expect(broken.locator('.media-status')).toContainText('读取失败');
    await expect(broken.getByLabel('年份', { exact: true })).toBeEditable();
    await expect(broken.locator('.destination')).toContainText('日期待确认');
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath('media-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath('media-mobile.png'), fullPage: true });
    expect(await page.evaluate(() => ({ width: window.innerWidth, document: document.documentElement.scrollWidth }))).toEqual({ width: 390, document: 390 });
    await page.locator('#move').click();
    await page.getByRole('button', { name: '确认移动', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('已移动 1 个');
    for (const name of ['live.heic', 'live.mov']) expect(await fs.readFile(path.join(root, outputDirectory, '照片视频/2026/2026-10/2026-10-21', name), 'utf8')).toBe(`fixture ${name}`);
    await expect(fs.stat(path.join(root, '积压'))).rejects.toMatchObject({ code: 'ENOENT' });
    await page.locator('#nav-history').click();
    await expect(page.locator('#history-list')).toContainText('Live Photo');
    await expect(page.locator('#history-list')).toContainText('已清理 2 个空源目录');
    await page.setViewportSize({ width: 1440, height: 1080 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath('history.png'), fullPage: true });
    await page.getByRole('button', { name: '撤销此批次' }).click();
    await expect(page.locator('#history-notice')).toContainText('撤销完成');
    for (const name of ['live.heic', 'live.mov']) expect(await fs.readFile(path.join(root, '积压', '旅行', name), 'utf8')).toBe(`fixture ${name}`);
    expect(errors).toEqual([]);
  } finally {
    await page.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('reorganize mode previews old categories and daily media destinations without splitting projects', async ({ page }, testInfo) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-reorg-browser-'));
  const root = path.join(temp, '旧归档');
  const server = createApp({ dataDir: path.join(temp, 'data'), scanOptions: {
    now: () => new Date('2026-11-09T12:00:00Z'), timeZone: 'Asia/Shanghai',
    inspectMedia: async paths => paths.map(location => ({ path: location, kind: 'photo', capturedAt: '2024-02-29T23:30:00-08:00' }))
  } });
  try {
    for (const name of ['工作/客户项目', '整理_20260101/文档', '照片视频/2024/2024-02', '整理_20261109/文档']) await fs.mkdir(path.join(root, name), { recursive: true });
    for (const [name, contents] of [['工作/合同.pdf', 'contract'], ['工作/客户项目/设计.pdf', 'project'], ['整理_20260101/文档/笔记.txt', 'notes'], ['照片视频/2024/2024-02/旅行.jpg', 'photo'], ['整理_20261109/文档/已归档.txt', 'existing']]) await fs.writeFile(path.join(root, name), contents);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await expect(page.locator('#scan-button')).toBeEnabled();
    await page.locator('#root').fill(root);
    await page.locator('#scan-button').click();
    await expect(page.locator('#folder-rows tr')).toHaveCount(0);
    await page.locator('#scan-mode').selectOption('reorganize');
    await expect(page.locator('#output-directory')).toHaveCount(0);
    await page.locator('#scan-button').click();
    await expect(page.locator('#folder-rows tr')).toHaveCount(3);
    await expect(page.locator('#folder-rows')).not.toContainText('设计.pdf');
    await expect(page.locator('#folder-rows')).not.toContainText('已归档.txt');
    const photo = page.locator('#folder-rows tr').filter({ hasText: '旅行.jpg' });
    await expect(photo.getByLabel('日期', { exact: true })).toHaveValue('29');
    await expect(photo.locator('.destination')).toContainText('整理_20261109 / 照片视频 / 2024 / 2024-02 / 2024-02-29');
    await photo.getByLabel('年份', { exact: true }).fill('2023');
    await expect(photo.locator('.media-error')).toContainText('目标路径无效');
    await photo.getByLabel('年份', { exact: true }).fill('2024');
    await page.locator('#select-all').check();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath('reorganize.png'), fullPage: true });
    await page.locator('#move').click();
    await page.getByRole('button', { name: '确认移动', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('已移动 3 个');
    expect(await fs.readFile(path.join(root, '整理_20261109/照片视频/2024/2024-02/2024-02-29/旅行.jpg'), 'utf8')).toBe('photo');
    expect(await fs.readFile(path.join(root, '工作/客户项目/设计.pdf'), 'utf8')).toBe('project');
    await page.locator('#nav-history').click();
    await page.getByRole('button', { name: '撤销此批次' }).click();
    await expect(page.locator('#history-notice')).toContainText('撤销完成');
    expect(await fs.readFile(path.join(root, '工作/合同.pdf'), 'utf8')).toBe('contract');
    expect(await fs.readFile(path.join(root, '整理_20260101/文档/笔记.txt'), 'utf8')).toBe('notes');
    expect(await fs.readFile(path.join(root, '照片视频/2024/2024-02/旅行.jpg'), 'utf8')).toBe('photo');
  } finally {
    await page.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('completed view persists successful projects and excludes skipped or undone entries', async ({ page }, testInfo) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-completed-ui-'));
  const root = path.join(temp, '待整理');
  const server = createApp({ dataDir: path.join(temp, 'data') });
  try {
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, '成功.pdf'), 'document');
    await fs.writeFile(path.join(root, '冲突.txt'), 'keep source');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await expect(page.locator('#scan-button')).toBeEnabled();
    await page.locator('#root').fill(root); await page.locator('#scan-button').click();
    await expect(page.locator('#folder-rows tr')).toHaveCount(2);
    const outputDirectory = (await page.locator('#output-directory').textContent()).match(/整理_\d{8}/)[0];
    await fs.mkdir(path.join(root, outputDirectory, '文档'), { recursive: true });
    await fs.writeFile(path.join(root, outputDirectory, '文档', '冲突.txt'), 'existing');
    await page.locator('#select-all').check();
    await page.locator('#move').click();
    await page.getByRole('button', { name: '确认移动', exact: true }).click();
    await expect(page.locator('#folder-rows tr')).toHaveCount(1);
    await expect(page.locator('#folder-rows')).toContainText('冲突.txt');
    await expect(page.locator('#folder-rows')).not.toContainText('成功.pdf');
    await page.locator('#nav-completed').click();
    await expect(page.locator('#completed-list')).toContainText('成功.pdf');
    await expect(page.locator('#completed-list')).not.toContainText('冲突.txt');
    await expect(page.locator('#completed-list')).toContainText(path.join(root, outputDirectory));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: testInfo.outputPath('completed.png'), fullPage: true });
    await page.reload();
    await expect(page.locator('#nav-completed')).toBeEnabled();
    await page.locator('#nav-completed').click();
    await expect(page.locator('#completed-list')).toContainText('成功.pdf');
    await page.getByRole('button', { name: '撤销此批次' }).click();
    await expect(page.locator('#completed-notice')).toContainText('撤销完成');
    await expect(page.locator('#completed-list')).not.toContainText('成功.pdf');
    expect(await fs.readFile(path.join(root, '成功.pdf'), 'utf8')).toBe('document');
    expect(await fs.readFile(path.join(root, '冲突.txt'), 'utf8')).toBe('keep source');
  } finally {
    await page.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('execute action stays in view at the top middle and end of a thousand-item list', async ({ page }, testInfo) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-long-list-'));
  const root = path.join(temp, 'photos');
  const server = createApp({ dataDir: path.join(temp, 'data'), scanOptions: {
    inspectMedia: async paths => paths.map(location => ({ path: location, kind: 'photo', capturedAt: '2024-05-01T12:00:00Z' }))
  } });
  try {
    await fs.mkdir(root);
    await Promise.all(Array.from({ length: 1000 }, (_, index) => fs.writeFile(path.join(root, `photo-${String(index).padStart(4, '0')}.jpg`), 'fixture')));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await expect(page.locator('#scan-button')).toBeEnabled();
    await page.locator('#root').fill(root); await page.locator('#scan-button').click();
    await expect(page.locator('#folder-rows tr')).toHaveCount(1000);
    await page.locator('#select-all').check();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const fraction of [0, 0.5, 1]) {
        await page.evaluate(value => window.scrollTo(0, (document.documentElement.scrollHeight - window.innerHeight) * value), fraction);
        await expect(page.locator('#move')).toBeInViewport({ ratio: 1 });
        await expect(page.locator('#move')).toBeEnabled();
      }
      const last = await page.locator('#folder-rows tr').last().boundingBox();
      const bar = await page.locator('.execution-bar').boundingBox();
      expect(last.y + last.height).toBeLessThanOrEqual(bar.y);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 1440, height: 1080 });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
    await page.screenshot({ path: testInfo.outputPath('long-list.png') });
    await page.locator('#move').click();
    await expect(page.locator('#confirm-description')).toContainText('500 个项目');
    await page.getByRole('button', { name: '再检查一下' }).click();
  } finally {
    await page.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('same-target conflicts keep only the conflicting item pending and show paths for retry', async ({ page }) => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-conflict-ui-'));
  const root = path.join(temp, 'photos');
  const server = createApp({ dataDir: path.join(temp, 'data'), scanOptions: {
    inspectMedia: async paths => paths.map(location => ({ path: location, kind: 'photo', capturedAt: '2024-05-01T12:00:00Z' }))
  } });
  try {
    for (const folder of ['one', 'two']) {
      await fs.mkdir(path.join(root, folder), { recursive: true });
      await fs.writeFile(path.join(root, folder, 'a.jpg'), folder);
    }
    await fs.writeFile(path.join(root, 'unique.jpg'), 'unique');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await expect(page.locator('#scan-button')).toBeEnabled();
    await page.locator('#root').fill(root); await page.locator('#scan-button').click();
    await expect(page.locator('#folder-rows tr')).toHaveCount(3);
    const output = (await page.locator('#output-directory').textContent()).match(/整理_\d{8}/)[0];
    await page.locator('#select-all').check(); await page.locator('#move').click();
    await page.getByRole('button', { name: '确认移动', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('已移动 2 个，跳过 1 个');
    await expect(page.locator('#notice')).toContainText('one/a.jpg');
    await expect(page.locator('#notice')).toContainText('two/a.jpg');
    await expect(page.locator('#notice')).toContainText(`${output}/照片视频/2024/2024-05/2024-05-01/a.jpg`);
    await expect(page.locator('#folder-rows tr')).toHaveCount(1);
    await expect(page.locator('#folder-rows')).toContainText('目标文件冲突');
    const target = path.join(root, output, '照片视频/2024/2024-05/2024-05-01/a.jpg');
    const firstContents = await fs.readFile(target, 'utf8');
    await page.getByLabel('日期', { exact: true }).selectOption('02');
    await page.locator('#move').click();
    await page.getByRole('button', { name: '确认移动', exact: true }).click();
    await expect(page.locator('#notice')).toContainText('已移动 1 个，跳过 0 个');
    await expect(page.locator('#folder-rows tr')).toHaveCount(0);
    expect(await fs.readFile(target, 'utf8')).toBe(firstContents);
    expect(await fs.readFile(path.join(root, output, '照片视频/2024/2024-05/2024-05-02/a.jpg'), 'utf8')).not.toBe(firstContents);
  } finally {
    await page.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('operation progress stays visible during a request and clears after failure', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ json: { token: 'fixture', categories: [], defaultRoot: '/fixture', mediaSupported: false } }));
  await page.route('**/api/inboxes', route => route.fulfill({ json: [] }));
  let release;
  await page.route('**/api/scan', async route => { await new Promise(resolve => { release = resolve; }); await route.fulfill({ status: 400, json: { error: '测试扫描失败' } }); });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'jev-progress-'));
  const server = createApp({ dataDir: temp });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await expect(page.locator('#scan-button')).toBeEnabled();
    await page.locator('#scan-button').click();
    await expect(page.getByRole('progressbar')).toBeVisible();
    await expect(page.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    release();
    await expect(page.getByRole('progressbar')).toHaveCount(0);
    await expect(page.locator('#notice')).toContainText('测试扫描失败');
  } finally {
    if (release) release();
    await page.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await fs.rm(temp, { recursive: true, force: true });
  }
});
