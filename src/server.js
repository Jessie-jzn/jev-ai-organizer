import http from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Organizer } from './organizer.js';
import { classify } from './classifier.js';
import { fileTypeCategories } from './file-types.js';
import { categoryNames } from './categories.js';
import { pickFolder } from './folder-picker.js';
import { ensureMediaHelper } from './media-native.js';
import { InboxStore } from './inbox-store.js';
import { PendingStore } from './pending-store.js';

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const requestKeys = new Map([
  ['/api/pick-folder', ['root']],
  ['/api/inboxes', ['id', 'name', 'root', 'taxonomy']],
  ['/api/scan', ['root', 'resolveLocations', 'inboxId', 'mode']],
  ['/api/classify', ['scanId', 'itemIds']],
  ['/api/pending/update', ['id', 'changes']],
  ['/api/move', ['scanId', 'selections']],
  ['/api/undo', ['id']]
]);
const staticFiles = new Map([
  ['/media-paths.js', ['media-paths.js', 'text/javascript; charset=utf-8']]
]);
const assetTypes = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };

// 读取并限制 JSON 请求体，防止接口接收非 JSON 或过大的输入。
async function readBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('请求必须使用 JSON。');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024) throw new Error('请求过大。');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createApp({ dataDir = path.join(projectDir, '.data'), chooseFolder = pickFolder,
  scanOptions = {}, platform = process.platform, mediaHelper = ensureMediaHelper, classifyItems = classify } = {}) {
  // 创建本机 API 服务；所有文件扫描和移动都通过 Organizer 完成。
  const organizer = new Organizer(dataDir, scanOptions);
  const inboxes = new InboxStore(path.join(dataDir, 'inboxes.json'));
  const pending = new PendingStore(path.join(dataDir, 'pending.json'));
  let mediaSupport;
  const supportsMedia = () => mediaSupport ??= platform !== 'darwin' ? Promise.resolve(false)
    : Promise.resolve().then(() => mediaHelper()).then(() => true, () => false);
  const token = randomBytes(32).toString('hex');
  let classifying = false;
  let choosingFolder = false;
  // 请求处理器同时提供 Vite 构建产物、会话接口和整理 API。
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    const port = server.address()?.port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.host) ||
        (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) ||
        req.headers['sec-fetch-site'] === 'cross-site') {
      return json(403, { error: '仅允许本机同源访问。' });
    }
    try {
      const route = new URL(req.url, `http://${req.headers.host}`).pathname;
      if (req.method === 'GET' && route === '/') {
        const content = await fs.readFile(path.join(projectDir, 'dist', 'index.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(content);
      }
      if (req.method === 'GET' && /^\/assets\/[a-zA-Z0-9_-]+\.(js|css)$/.test(route)) {
        const content = await fs.readFile(path.join(projectDir, 'dist', route.slice(1)));
        res.writeHead(200, { 'Content-Type': assetTypes[path.extname(route).slice(1)] }); return res.end(content);
      }
      if (req.method === 'GET' && staticFiles.has(route)) {
        const [file, contentType] = staticFiles.get(route);
        const content = await fs.readFile(path.join(projectDir, 'public', file));
        res.writeHead(200, { 'Content-Type': contentType }); return res.end(content);
      }
      if (req.method === 'GET' && route === '/api/session') {
        return json(200, { token, categories: fileTypeCategories, aiEnabled: Boolean(process.env.TYPESAFE_API_KEY?.trim()), mediaSupported: await supportsMedia(), defaultRoot: path.join(os.homedir(), 'Downloads') });
      }
      if (!route.startsWith('/api/')) return json(404, { error: '页面不存在。' });
      if (req.headers['x-session-token'] !== token) return json(403, { error: '会话已过期，请刷新页面。' });
      if (req.method === 'GET' && route === '/api/history') return json(200, await organizer.history());
      if (req.method === 'GET' && route === '/api/inboxes') return json(200, await inboxes.list());
      if (req.method === 'GET' && route === '/api/pending') {
        return json(200, await pending.list(new URL(req.url, `http://${req.headers.host}`).searchParams.get('inboxId') || undefined));
      }
      if (req.method !== 'POST') return json(405, { error: '请求方法不支持。' });
      const body = await readBody(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求格式无效。');
      const allowedKeys = requestKeys.get(route);
      if (allowedKeys && Object.keys(body).some(key => !allowedKeys.includes(key))) throw new Error('请求包含不支持的字段。');
      if (route === '/api/pick-folder') {
        if (choosingFolder) return json(409, { error: '文件夹选择窗口已打开，请先完成选择。' });
        choosingFolder = true;
        try { return json(200, { root: await chooseFolder(body.root) }); }
        finally { choosingFolder = false; }
      }
      if (route === '/api/inboxes') {
        return json(200, await inboxes.save(body));
      }
      if (route === '/api/pending/update') {
        if (typeof body.id !== 'string' || !body.changes || typeof body.changes !== 'object' || Array.isArray(body.changes)
            || Object.keys(body.changes).some(key => !['category', 'destination', 'recommendationSource', 'status', 'confidence', 'error'].includes(key))) {
          throw new Error('待处理更新无效。');
        }
        return json(200, await pending.update(body.id, body.changes));
      }
      if (route === '/api/scan') {
        if (Object.hasOwn(body, 'resolveLocations') && typeof body.resolveLocations !== 'boolean') throw new Error('地点解析选项必须为布尔值。');
        const inbox = body.inboxId === undefined ? null : await inboxes.get(body.inboxId);
        const resolveLocations = body.resolveLocations === true;
        const scan = await organizer.scan(body.root, { resolveLocations, mode: body.mode, preserveFolders: true, categories: inbox ? taxonomyChoices(inbox.taxonomy) : fileTypeCategories });
        const retained = organizer.getScan(scan.id);
        retained.inboxId = body.inboxId;
        scan.root = retained.root;
        if (resolveLocations) {
          for (const item of scan.items) {
            const facts = retained.items.find(original => original.id === item.id)?.facts;
            if (item.type === 'media' && facts?.locationStatus === 'unresolved'
                && Number.isFinite(facts.latitude) && Number.isFinite(facts.longitude)) {
              item.displayCoordinates = `${facts.latitude.toFixed(4)}, ${facts.longitude.toFixed(4)}`;
            }
          }
        }
        if (body.inboxId) {
          for (const item of retained.items) {
            const member = item.type === 'media' ? item.members?.[0] : { name: item.name, path: item.path, identity: item.identity };
            if (!member) continue;
            await pending.upsert({ id: item.id, inboxId: body.inboxId, scanId: scan.id, name: item.name,
              type: item.type, source: member.path ?? path.join(retained.root, member.name), identity: member.identity,
              category: item.category ?? null, destination: null, recommendationSource: item.recommendationSource ?? 'unclassified', status: 'pending' });
          }
        }
        return json(200, scan);
      }
      if (route === '/api/classify') {
        if (classifying) return json(409, { error: '分类正在进行，请稍后重试。' });
        const scan = organizer.getScan(body.scanId);
        if (!Array.isArray(body.itemIds) || body.itemIds.length > 500 ||
            body.itemIds.some(id => !scan.items.some(item => item.id === id && item.type !== 'media'))) {
          throw new Error('分类范围无效，请重新扫描。');
        }
        const selectedIds = new Set(body.itemIds);
        const items = scan.items.filter(item => item.type !== 'media' && selectedIds.has(item.id));
        if (!items.length) return json(200, []);
        classifying = true;
        try {
          const inbox = scan.inboxId ? await inboxes.get(scan.inboxId) : null;
          const results = inbox
            ? await classifyItems(items, undefined, taxonomyChoiceDescriptions(inbox.taxonomy))
            : items.map(item => ({ id: item.id, category: item.category, confidence: 1 }));
          if (scan.inboxId) {
            for (const result of results) {
              const current = (await pending.list(scan.inboxId)).find(item => item.id === result.id);
              if (current) await pending.upsert({ ...current, ...result, recommendationSource: 'ai', status: 'pending' });
            }
          }
          return json(200, results);
        }
        finally { classifying = false; }
      }
      if (route === '/api/move') {
        validateSelections(organizer.getScan(body.scanId), body.selections);
        const scan = organizer.getScan(body.scanId);
        const batch = await organizer.move(body.scanId, body.selections);
        if (scan.inboxId) {
          const movedIds = new Set(batch.entries.filter(entry => entry.status === 'moved').map(entry => entry.scanItemId));
          const current = await pending.list(scan.inboxId);
          await pending.remove(current.filter(item => movedIds.has(item.id)).map(item => item.id));
        }
        return json(200, batch);
      }
      if (route === '/api/undo') return json(200, await organizer.undo(body.id));
      return json(404, { error: '接口不存在。' });
    } catch (error) {
      const message = error.code === 'ENOENT' ? '目录或记录不存在，请检查路径。'
        : ['EACCES', 'EPERM'].includes(error.code) ? '没有访问权限，请选择可读写的目录。'
        : error instanceof SyntaxError ? '请求格式错误。' : error.message;
      if (!res.headersSent) json(400, { error: message });
    }
  });
  server.requestTimeout = 30_000;
  return server;
}

// 在移动前验证客户端提交的项目 ID、分类字段和媒体覆盖字段。
function validateSelections(scan, selections) {
  if (!Array.isArray(selections)) throw new Error('整理选择无效。');
  for (const selection of selections) {
    const item = scan.items.find(item => item.id === selection?.id);
    if (!item || !selection || typeof selection !== 'object' || Array.isArray(selection)) throw new Error('整理选择无效。');
    const allowed = item.type === 'media' ? ['id', 'media'] : ['id', 'category'];
    if (Object.keys(selection).some(key => !allowed.includes(key))) throw new Error('整理选择包含不支持的字段。');
    if (item.type !== 'media') continue;
    const media = selection.media;
    if (!media || typeof media !== 'object' || Array.isArray(media)
        || Object.keys(media).some(key => !['year', 'month', 'day', 'country', 'city', 'mediaType'].includes(key))
        || Object.values(media).some(value => typeof value !== 'string')) throw new Error('媒体调整字段无效。');
    if (item.mediaType === 'live-photo' && media.mediaType !== undefined && media.mediaType !== 'live-photo') throw new Error('Live Photo 必须一起归入照片。');
  }
}

function taxonomyChoices(nodes, choices = {}) {
  for (const node of nodes ?? []) {
    choices[node.path] = node.name;
    taxonomyChoices(node.children, choices);
  }
  return Object.keys(choices);
}

function taxonomyChoiceDescriptions(nodes, choices = {}) {
  for (const node of nodes ?? []) {
    choices[node.path] = node.name;
    taxonomyChoiceDescriptions(node.children, choices);
  }
  return choices;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1–65535 之间的整数。');
  const server = createApp();
  server.on('error', error => { console.error(`启动失败：${error.message}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Jev AI 归屿已启动：http://127.0.0.1:${port}`));
}
