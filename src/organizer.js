import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { categoryForFile, fileTypeCategories } from './file-types.js';
import { categoryNames } from './categories.js';
import { GeocodeCache } from './geocode-cache.js';
import { inspectMedia, reverseGeocode } from './media-native.js';
import { scanMedia, toPublicScan, isCandidate } from './media-scanner.js';
import { buildMediaSegments } from './media-rules.js';
import { validateMediaOverrides } from '../public/media-paths.js';

const archiveDirectory = name => name === '照片视频' || name === '日期待确认' || name === '未知日期';
const datedArchive = name => /^整理_\d{8}$/.test(name);
const knownContainer = name => categoryNames.includes(name) || fileTypeCategories.includes(name) || archiveDirectory(name) || datedArchive(name) || /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/.test(name);
const ignored = new Set(['node_modules', '.git', ...categoryNames, ...fileTypeCategories]);
// 文件系统安全基础函数：只接受真实文件/目录，并记录身份防止扫描后被替换。
const kind = stat => stat.isDirectory() ? 'folder' : stat.isFile() ? 'file' : null;
const identity = stat => ({ dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs, type: kind(stat) });
// Older journal entries lack type and were always directories.
const same = (stat, id) => stat && kind(stat) === (id.type || 'folder') && !stat.isSymbolicLink() &&
  stat.dev === id.dev && stat.ino === id.ino && stat.birthtimeMs === id.birthtimeMs;
async function statOrNull(file) {
  try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function checkDirectory(file, id) {
  const stat = await statOrNull(file);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || (id && !same(stat, id)) || await fs.realpath(file) !== file) {
    throw new Error('目录已变化、不存在或包含符号链接，请重新扫描。');
  }
  return stat;
}
async function checkItem(file, id) {
  const stat = await statOrNull(file);
  if (!stat || !kind(stat) || stat.isSymbolicLink() || (id && !same(stat, id)) || await fs.realpath(file) !== file) {
    throw new Error('文件或文件夹已变化、不存在或包含符号链接，请重新扫描。');
  }
  return stat;
}
async function samplesFor(root) {
  // 只读取目录名和最多两层、40 条样本，供分类模型判断；不读取文件内容。
  const samples = [];
  const queue = [{ relative: '', depth: 0 }];
  while (queue.length && samples.length < 40) {
    const { relative, depth } = queue.shift();
    const location = path.join(root, relative);
    await checkDirectory(location);
    const directory = await fs.opendir(location);
    for await (const entry of directory) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
      const name = path.join(relative, entry.name);
      samples.push(name + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory() && depth < 1) queue.push({ relative: name, depth: depth + 1 });
      if (samples.length >= 40) break;
    }
  }
  return samples;
}

export class Organizer {
  constructor(dataDir, options = {}) {
    this.dataDir = path.resolve(dataDir);
    this.scans = new Map();
    this.queue = Promise.resolve();
    this.inspectMedia = options.inspectMedia ?? inspectMedia;
    this.reverseGeocode = options.reverseGeocode ?? reverseGeocode;
    this.geocodeCache = options.geocodeCache ?? new GeocodeCache(path.join(this.dataDir, 'geocode-cache.json'));
    this.timeZone = options.timeZone;
    this.rename = options.rename ?? fs.rename;
    this.now = options.now ?? (() => new Date());
  }

  exclusive(fn) {
    // 将扫描、移动、撤销和日志恢复串行化，避免同时改动同一目录。
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }

  scan(input, options = {}) {
    return this.exclusive(() => this.#scanUnlocked(input, options));
  }

  async #scanUnlocked(input, options = {}) {
    // 扫描直属项目，识别媒体并保存带私有路径的内存快照供后续移动使用。
    if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error('请输入父目录的绝对路径。');
    const root = await fs.realpath(input);
    assertRecoveredRoot(root, await this.#recoverJournalsUnlocked());
    if ([path.resolve(input), root].some(location => location.split(path.sep).some(segment => segment.toLowerCase().endsWith('.photoslibrary')))) {
      throw new Error('不能整理照片图库或图库内部目录，请先导出到普通文件夹。');
    }
    const rootIdentity = identity(await checkDirectory(root));
    // Never let the organizer move its own journal or runtime directory.
    if (root === path.parse(root).root || this.dataDir === root || this.dataDir.startsWith(root + path.sep)) {
      throw new Error('请选择具体的待整理目录，不能扫描根目录或包含本工具运行数据的目录。');
    }
    const mode = options.mode ?? 'normal';
    if (!['normal', 'reorganize'].includes(mode)) throw new Error('整理模式无效。');
    const reorganize = mode === 'reorganize';
    const customContainers = new Set((options.categories ?? []).flatMap(category => category.split('/')));
    const isContainer = name => knownContainer(name) || customContainers.has(name);
    // Freeze the local run date in the scan snapshot; a midnight move must use
    // the exact destination the user reviewed, rather than calculate a new one.
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: this.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(this.now());
    const datePart = type => parts.find(part => part.type === type).value;
    const outputDirectory = options.preserveFolders ? `整理_${datePart('year')}${datePart('month')}${datePart('day')}` : '';
    const outputPath = outputDirectory ? path.join(root, outputDirectory) : null;
    const ordinaryItems = [], fileCandidates = [], skipped = [];
    const directory = await fs.opendir(root);
    for await (const entry of directory) {
      if ((!entry.isDirectory() && !entry.isFile()) || entry.isSymbolicLink()) continue;
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name.toLowerCase().endsWith('.photoslibrary')
          || path.join(root, entry.name) === outputPath
          || (!reorganize && entry.isDirectory() && (ignored.has(entry.name) || customContainers.has(entry.name) || archiveDirectory(entry.name) || datedArchive(entry.name)))) {
        skipped.push(entry.name); continue;
      }
      const location = path.join(root, entry.name);
      try {
        const stat = await checkItem(location);
        const type = kind(stat);
        let samples = [], warning = null;
        if (type === 'folder' && !options.preserveFolders) {
          try { samples = await samplesFor(location); } catch { warning = '部分内部目录无法读取，分类仅使用可获得的信息。'; }
        }
        const item = { id: randomUUID(), name: entry.name, type, extension: type === 'file' ? path.extname(entry.name).toLowerCase() : '',
          sizeBytes: type === 'file' ? stat.size : null, samples, warning, identity: identity(stat) };
        if (type === 'file') fileCandidates.push({ ...item, path: location, birthtime: stat.birthtime });
        else ordinaryItems.push(item);
      } catch { skipped.push(entry.name); }
    }
    const nestedTopFolders = new Set();
    const archiveYears = new Set();
    const visit = async (directoryPath, sourceDirectories = [], ordinaryContainer = false) => {
      const stat = await checkDirectory(directoryPath);
      const chain = [...sourceDirectories, { path: directoryPath, identity: identity(stat) }];
      for await (const entry of await fs.opendir(directoryPath)) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const location = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
          const oldMonth = /^\d{4}$/.test(path.basename(directoryPath)) && entry.name.startsWith(path.basename(directoryPath) + '-') && /^\d{4}-(0[1-9]|1[0-2])$/.test(entry.name);
          if (!reorganize && oldMonth) archiveYears.add(path.relative(root, directoryPath).split(path.sep)[0]);
          if (location === outputPath || entry.name === 'node_modules' || entry.name.toLowerCase().endsWith('.photoslibrary')
              || (!reorganize && (oldMonth || ignored.has(entry.name) || customContainers.has(entry.name) || archiveDirectory(entry.name) || datedArchive(entry.name)))) continue;
          try { await visit(location, chain, ordinaryContainer && isContainer(entry.name)); } catch { skipped.push(path.relative(root, location)); }
        } else if (entry.isFile() && (isCandidate({name:entry.name}) || reorganize && ordinaryContainer)) {
          try {
            const fileStat = await checkItem(location);
            const relative = path.relative(root, location);
            fileCandidates.push({ id: randomUUID(), name: entry.name, path: location, type: 'file', extension: path.extname(entry.name).toLowerCase(), sizeBytes: fileStat.size, samples: [], identity: identity(fileStat),
              birthtime: fileStat.birthtime, sourceRelativePath: relative, sourceDirectories: chain, allowOrdinary: ordinaryContainer });
          } catch { skipped.push(path.relative(root, location)); }
        }
      }
    };
    for (const folder of ordinaryItems) {
      try { await visit(path.join(root, folder.name), [], reorganize && isContainer(folder.name)); } catch { skipped.push(folder.name); }
    }
    const scannedMedia = await scanMedia(fileCandidates, {
      inspectMedia: this.inspectMedia,
      reverseGeocode: this.reverseGeocode,
      geocodeCache: this.geocodeCache,
      resolveLocations: options.resolveLocations === true,
      timeZone: options.timeZone ?? this.timeZone
    });
    for (const item of scannedMedia.mediaItems) {
      for (const member of item.members) {
        const relative = path.relative(root, member.path);
        if (relative.includes(path.sep)) nestedTopFolders.add(relative.split(path.sep)[0]);
      }
    }
    const ordinaryFiles = scannedMedia.ordinaryPaths.filter(item => !item.sourceRelativePath || reorganize && item.allowOrdinary).map(({ birthtime, ...item }) => item);
    const availableCategories = options.categories?.length ? options.categories : options.preserveFolders ? fileTypeCategories : categoryNames;
    if (options.preserveFolders) for (const item of ordinaryFiles) {
      const category = categoryForFile(item.name);
      if (availableCategories.includes(category)) Object.assign(item, { category, confidence: 1, recommendationSource: 'file-type' });
    }
    const items = [...ordinaryItems.filter(item => !options.preserveFolders && !nestedTopFolders.has(item.name) && !archiveYears.has(item.name)), ...ordinaryFiles, ...scannedMedia.mediaItems];
    if (items.filter(item => item.type !== 'media').length > 500) throw new Error('直属文件和文件夹超过 500 项，请分批选择更小的父目录。');
    items.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    for (const item of scannedMedia.mediaItems) item.targetSegments = [...(outputDirectory ? [outputDirectory] : []), ...item.targetSegments];
    const scan = { id: randomUUID(), root, rootIdentity, items, skipped, outputDirectory, mode,
      allowedCategories: [...availableCategories], cleanupEmptySources: options.preserveFolders === true };
    this.scans.set(scan.id, scan);
    if (this.scans.size > 20) this.scans.delete(this.scans.keys().next().value);
    return toPublicScan(scan, { exposeCoordinates: options.resolveLocations === true });
  }

  getScan(id) {
    const scan = this.scans.get(id);
    if (!scan) throw new Error('扫描已失效，请重新扫描。');
    return scan;
  }

  async save(batch) {
    // 以临时文件 + rename 写入操作日志，保证中断后可恢复。
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const target = path.join(this.dataDir, `${batch.id}.json`);
    const temp = target + '.tmp';
    const handle = await fs.open(temp, 'w', 0o600);
    try { await handle.writeFile(JSON.stringify(batch, null, 2)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temp, target);
    const directory = await fs.open(this.dataDir, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async readBatch(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('操作记录无效。');
    return JSON.parse(await fs.readFile(path.join(this.dataDir, `${id}.json`), 'utf8'));
  }

  async recoverEntry(entry, batch) {
    // 根据成员实际位置推断中断操作的结果，必要时补偿性恢复。
    const interrupted = entry.status;
    try {
      const locations = await locateMembers(batch, entry);
      if (locations.every(location => location === 'source')) {
        setEntryStatus(entry, interrupted === 'undoing' ? 'undone' : 'skipped', 'source');
      } else if (locations.every(location => location === 'target')) {
        setEntryStatus(entry, 'moved', 'target');
      } else {
        // Undo failures restore the pre-undo state; move failures restore the sources.
        const destination = interrupted === 'undoing' ? 'target' : 'source';
        await this.restoreEntry(batch, entry, destination);
        setEntryStatus(entry, destination === 'target' ? 'moved' : 'skipped', destination);
      }
    } catch (error) {
      entry.status = 'uncertain';
      entry.error = `中断后状态不确定，请按记录手动核对。${error.message}`;
    }
  }

  async recover(batch) {
    let changed = false;
    for (const directory of batch.cleanupDirectories ?? []) {
      if (!['removing', 'restoring'].includes(directory.state)) continue;
      contained(batch.root, directory.path);
      const stat = await statOrNull(directory.path);
      if (directory.state === 'removing') {
        if (!stat) directory.state = 'removed';
        else if (same(stat, directory.identity)) directory.state = 'kept';
        else directory.state = 'uncertain';
      } else {
        // A crash after mkdir but before recording identity cannot be guessed safe.
        directory.state = stat ? 'uncertain' : 'removed';
      }
      changed = true;
    }
    await this.propagateRestoredDirectories(batch);
    for (const entry of batch.entries) {
      if (!['pending', 'undoing'].includes(entry.status)) continue;
      await this.recoverEntry(entry, batch);
      changed = true;
    }
    // Reading an ordinary legacy journal must not migrate or rewrite its schema.
    if (changed) await this.save(batch);
    return batch;
  }

  // Call only while holding exclusive: recovery itself performs filesystem renames.
  async #recoverJournalsUnlocked() {
    let names;
    try { names = await fs.readdir(this.dataDir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const batches = [];
    for (const name of names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
      batches.push(await this.recover(await this.readBatch(name.slice(0, -5))));
    }
    return batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  history() {
    return this.exclusive(() => this.#recoverJournalsUnlocked());
  }

  async restoreEntry(batch, entry, destination) {
    // Prove every member has exactly one safe location before compensating any rename.
    await locateMembers(batch, entry);
    const members = orderedMembers(entry);
    if (destination === 'source') members.reverse();
    for (const member of members) {
      const locations = await locateMembers(batch, entry);
      if (locations[entryMembers(entry).indexOf(member)] === destination) continue;
      const origin = destination === 'source' ? 'target' : 'source';
      await this.rename(member[origin], member[destination]);
      member.status = destination === 'source' ? 'undone' : 'moved';
    }
    const finalLocations = await locateMembers(batch, entry);
    if (!finalLocations.every(location => location === destination)) throw new Error('成员位置不一致。');
  }

  move(scanId, selections) {
    // 预检所有项目后逐个移动；任何失败都写入日志并尝试回滚。
    return this.exclusive(async () => {
      const scan = this.getScan(scanId);
      assertRecoveredRoot(scan.root, await this.#recoverJournalsUnlocked());
      if (!Array.isArray(selections) || !selections.length || selections.length > 500) throw new Error('请选择需要整理的文件或文件夹。');
      const seen = new Set();
      const entries = selections.map(selection => {
        if (seen.has(selection?.id)) throw new Error('分类选择无效，请重新扫描。');
        seen.add(selection?.id);
        return prepareSelection(scan, selection);
      });
      checkSelectionIndependence(scan, entries);
      await checkDirectory(scan.root, scan.rootIdentity);
      const batch = { id: randomUUID(), root: scan.root, rootIdentity: scan.rootIdentity, createdAt: new Date().toISOString(), entries, mode: scan.mode, ...(scan.cleanupEmptySources ? { cleanupDirectories: [] } : {}) };
      await this.save(batch);
      for (const entry of entries) {
        try {
          await checkDirectory(batch.root, batch.rootIdentity);
          for (const member of entry.members) await checkItem(member.source, member.identity);
          entry.containers = await createContainers(batch, entry);
          // Retain the old convenience fields for existing history consumers.
          entry.containerIdentity = entry.containers.at(-1).identity;
          await preflight(batch, entry, 'source');
        } catch (error) {
          entry.status = 'skipped'; entry.error = error.message;
          await this.save(batch); continue;
        }
        entry.status = 'pending';
        await this.save(batch); // Write-ahead: never rename before the complete group is durable.
        try {
          await preflight(batch, entry, 'source');
          for (const member of orderedMembers(entry)) {
            await checkEntryDirectories(batch, entry);
            await checkItem(member.source, member.identity);
            if (await statOrNull(member.target)) throw new Error(targetConflictMessage(batch, member));
            await this.rename(member.source, member.target);
            member.status = 'moved';
          }
          setEntryStatus(entry, 'moved', 'target');
        } catch (error) {
          entry.error = error.message;
          try {
            await this.restoreEntry(batch, entry, 'source');
            setEntryStatus(entry, 'skipped', 'source');
          } catch (rollbackError) {
            entry.status = 'uncertain'; entry.error += ` 回滚状态不确定：${rollbackError.message}`;
          }
        }
        // Keep completion-save failures outside compensation: durable pending enables recovery.
        await this.save(batch);
      }
      if (batch.cleanupDirectories) await this.cleanupSources(batch);
      return batch;
    });
  }

  // 清理只发生在移动结果已落盘之后；不得递归删除，也不清理原本就空的目录。
  async cleanupSources(batch) {
    const candidates = new Map();
    for (const entry of batch.entries) {
      if ((entry.type !== 'media' && !(batch.mode === 'reorganize' && entry.type === 'file')) || entry.status !== 'moved') continue;
      for (const member of entry.members) for (const directory of member.sourceDirectories ?? []) {
        contained(batch.root, directory.path);
        candidates.set(directory.path, directory);
      }
    }
    for (const directory of [...candidates.values()].sort((a, b) => b.path.split(path.sep).length - a.path.split(path.sep).length)) {
      const record = { path: directory.path, identity: directory.identity, state: 'removing' };
      try {
        await checkDirectory(batch.root, batch.rootIdentity);
        await checkDirectory(directory.path, directory.identity);
        // rmdir is deliberately non-recursive and will preserve even hidden files.
        batch.cleanupDirectories.push(record);
        await this.save(batch);
        // A journal write yields to other processes. Recheck the entire source
        // ancestry afterwards; a replacement empty directory is not ours to delete.
        await validateSourceAncestors(batch, directory.path, true);
        await fs.rmdir(directory.path);
        record.state = 'removed';
      } catch (error) {
        if (!batch.cleanupDirectories.includes(record)) batch.cleanupDirectories.push(record);
        record.state = 'kept';
        if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) record.error = error.message;
      }
      await this.save(batch);
    }
  }

  // 删除空目录会改变 inode。撤销必须重建目录、更新所有相关批次的身份，
  // 不能把用户后来创建的同名目录当成原目录，也不能依赖撤销顺序。
  async restoreSourceDirectories(batch, findOtherBatches = true) {
    await this.propagateRestoredDirectories(batch);
    if (findOtherBatches) {
      // A later batch can remove a shared directory after an earlier batch only
      // emptied some of its files. The removal journal, not the undo order, owns
      // permission to recreate that directory.
      const missing = [];
      for (const reference of sourceDirectoryReferences(batch)) {
        if (!await statOrNull(reference.path)
            && !batch.cleanupDirectories?.some(directory => directory.path === reference.path && directory.state === 'removed')) missing.push(reference);
      }
      if (missing.length) {
        for (const name of await fs.readdir(this.dataDir)) {
          if (!/^[a-f0-9-]{36}\.json$/.test(name) || name === `${batch.id}.json`) continue;
          const other = await this.recover(await this.readBatch(name.slice(0, -5)));
          if (other.root !== batch.root || !equalIdentity(other.rootIdentity, batch.rootIdentity)) continue;
          if (other.cleanupDirectories?.some(directory => directory.state === 'removed'
              && missing.some(reference => reference.path === directory.path && equalIdentity(reference.identity, directory.identity)))) {
            await this.restoreSourceDirectories(other, false);
          }
        }
        // Other journals have updated this batch's source inode references.
        Object.assign(batch, await this.readBatch(batch.id));
      }
    }
    const removed = (batch.cleanupDirectories ?? []).filter(directory => directory.state === 'removed')
      .sort((a, b) => a.path.split(path.sep).length - b.path.split(path.sep).length);
    if (batch.cleanupDirectories?.some(directory => directory.state === 'uncertain')) throw new Error('源目录身份无法确认，请手动核对操作记录。');
    for (const directory of removed) {
      contained(batch.root, directory.path);
      await checkDirectory(batch.root, batch.rootIdentity);
      if (await statOrNull(directory.path)) throw new Error('已清理的源目录被重新创建，身份无法确认。');
      const references = sourceDirectoryReferences(batch);
      await validateSourceAncestors(batch, directory.path);
      directory.state = 'restoring';
      await this.save(batch);
      // Revalidate after the durable intent write: mkdir must never follow a
      // source parent swapped for a symlink while the journal was being saved.
      await validateSourceAncestors(batch, directory.path);
      await fs.mkdir(directory.path);
      directory.previousIdentity = directory.identity;
      directory.propagated = false;
      directory.identity = identity(await checkDirectory(directory.path));
      directory.state = 'restored';
      for (const reference of references) if (reference.path === directory.path) reference.identity = directory.identity;
      await this.save(batch);
    }
    await this.propagateRestoredDirectories(batch);
  }

  // 先持久化旧/新身份及未传播标记，再幂等更新其他日志，最后标记完成。
  // 任一步中断都能重试；mkdir 后身份尚未落盘的窗口则保守标为 uncertain。
  async propagateRestoredDirectories(batch) {
    for (const directory of batch.cleanupDirectories ?? []) {
      if (directory.state !== 'restored' || directory.propagated !== false) continue;
      contained(batch.root, directory.path);
      await checkDirectory(batch.root, batch.rootIdentity);
      await checkDirectory(directory.path, directory.identity);
      // Persist both identities before fan-out. Repeating this loop after any
      // crash is safe: only references to the old inode are changed.
      for (const name of await fs.readdir(this.dataDir)) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name) || name === `${batch.id}.json`) continue;
        const other = await this.readBatch(name.slice(0, -5));
        if (other.root !== batch.root || !equalIdentity(other.rootIdentity, batch.rootIdentity)) continue;
        let changed = false;
        for (const reference of sourceDirectoryReferences(other)) {
          if (reference.path === directory.path && equalIdentity(reference.identity, directory.previousIdentity)) {
            reference.identity = directory.identity; changed = true;
          }
        }
        if (changed) await this.save(other);
      }
      directory.propagated = true;
      await this.save(batch);
    }
  }

  undo(id) {
    return this.exclusive(async () => {
      const batch = await this.recover(await this.readBatch(id));
      if (batch.cleanupDirectories || sourceDirectoryReferences(batch).length) await this.restoreSourceDirectories(batch);
      for (const entry of [...batch.entries].reverse()) {
        if (entry.status !== 'moved') continue;
        try {
          await preflight(batch, entry, 'target');
        } catch (error) { entry.error = error.message; await this.save(batch); continue; }
        entry.status = 'undoing'; await this.save(batch);
        try {
          await preflight(batch, entry, 'target');
          for (const member of orderedMembers(entry).reverse()) {
            await checkEntryDirectories(batch, entry);
            await checkItem(member.target, member.identity);
            if (await statOrNull(member.source)) throw new Error('原位置已存在同名项目，未覆盖。');
            await this.rename(member.target, member.source);
            member.status = 'undone';
          }
          setEntryStatus(entry, 'undone', 'source'); delete entry.error;
        } catch (error) {
          entry.error = error.message;
          try {
            await this.restoreEntry(batch, entry, 'target');
            setEntryStatus(entry, 'moved', 'target');
          } catch (rollbackError) {
            entry.status = 'uncertain'; entry.error += ` 撤销恢复状态不确定：${rollbackError.message}`;
          }
        }
        await this.save(batch);
      }
      return batch;
    });
  }
}

function assertRecoveredRoot(root, batches) {
  const contains = (parent, child) => child === parent || child.startsWith(parent + path.sep);
  for (const batch of batches) {
    if ((batch.entries.some(entry => ['pending', 'undoing', 'uncertain'].includes(entry.status)) || batch.cleanupDirectories?.some(directory => directory.state === 'uncertain'))
        && (contains(root, batch.root) || contains(batch.root, root))) {
      throw new Error('此目录存在中断后状态不确定的操作，请先在操作记录中手动核对，暂不能继续扫描或整理。');
    }
  }
}

function safeSegment(value) {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/\0]/.test(value)) {
    throw new Error('路径段无效。');
  }
  return value;
}

function contained(root, location) {
  const relative = path.relative(root, location);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
      || path.resolve(location) !== location) throw new Error('路径必须位于扫描目录内。');
}

function prepareSelection(scan, selection) {
  // 把公开选择转换为带真实源路径、目标路径和身份快照的日志条目。
  const item = scan.items.find(candidate => candidate.id === selection?.id);
  if (!item) throw new Error('分类选择无效，请重新扫描。');
  let segments, originals;
  if (item.type === 'media') {
    if (!selection.media || typeof selection.media !== 'object' || Array.isArray(selection.media)) throw new Error('媒体选择无效。');
    const overrides = validateMediaOverrides(selection.media);
    if (item.mediaType === 'live-photo') overrides.mediaType = 'live-photo';
    else if (overrides.mediaType !== undefined && !['photo', 'video'].includes(overrides.mediaType)) throw new Error('媒体类型无效。');
    segments = buildMediaSegments(item.facts, overrides).map(safeSegment);
    originals = item.members;
  } else {
    const allowedCategories = scan.allowedCategories ?? categoryNames;
    if (!allowedCategories.includes(selection.category)) throw new Error('分类选择无效，请重新扫描。');
    segments = [selection.category];
    originals = [{ name: item.name, path: item.path, identity: item.identity, sourceDirectories: item.sourceDirectories }];
  }
  if (scan.outputDirectory) segments.unshift(safeSegment(scan.outputDirectory));
  const members = originals.map(original => {
    // A basename from the retained scan is not a client-supplied directory segment.
    if (typeof original.name !== 'string' || path.basename(original.name) !== original.name
        || original.name === '.' || original.name === '..' || original.name.includes('\0')) throw new Error('源文件名无效。');
    const source = original.path ?? path.join(scan.root, original.name), target = path.join(scan.root, ...segments, original.name);
    contained(scan.root, source); contained(scan.root, target);
    return { name: original.name, source, target, identity: original.identity, ...(original.sourceDirectories ? { sourceDirectories: original.sourceDirectories } : {}), status: 'ready' };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (!members.length || new Set(members.map(member => member.name)).size !== members.length) throw new Error('媒体成员无效。');
  return { name: item.name, scanItemId: item.id, type: item.type, kind: members.length > 1 ? 'group' : 'single',
    ...(item.type === 'media' ? { mediaType: item.mediaType, targetSegments: segments } : { category: selection.category }),
    source: members[0].source, target: members[0].target, identity: members[0].identity, members, status: 'ready' };
}

// Old journals are one-member views, without adding members to their persisted schema.
const entryMembers = entry => entry.members ?? [entry];
const sourceDirectoryReferences = batch => batch.entries.flatMap(entry => entryMembers(entry).flatMap(member => member.sourceDirectories ?? []));
const equalIdentity = (left, right) => left && right && ['dev', 'ino', 'birthtimeMs', 'type'].every(key => left[key] === right[key]);
const orderedMembers = entry => [...entryMembers(entry)].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
function setEntryStatus(entry, status, location) {
  entry.status = status;
  if (entry.members) for (const member of entry.members) member.status = location === 'target' ? 'moved' : status;
}

function containerPaths(batch, entry) {
  const members = entryMembers(entry);
  if (!members.length) throw new Error('操作记录缺少成员。');
  const directories = [];
  const sources = new Set(), targets = new Set();
  for (const member of members) {
    contained(batch.root, member.source); contained(batch.root, member.target);
    if ((path.dirname(member.source) !== batch.root && !member.sourceDirectories?.length) || path.basename(member.source) !== member.name
        || path.basename(member.target) !== member.name || !member.identity
        || sources.has(member.source) || targets.has(member.target)) throw new Error('操作记录路径无效。');
    sources.add(member.source); targets.add(member.target);
    let current = batch.root;
    for (const segment of path.relative(batch.root, path.dirname(member.target)).split(path.sep)) {
      current = path.join(current, safeSegment(segment));
      if (!directories.includes(current)) directories.push(current);
    }
  }
  return directories;
}

function checkSelectionIndependence(scan, entries) {
  const members = entries.flatMap(entryMembers);
  const containers = [...new Set(entries.flatMap(entry => containerPaths(scan, entry)))];
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  };
  const overlaps = (left, right) => contains(left, right) || contains(right, left);
  const reject = (left, right, reason) => {
    throw new Error(`所选项目路径存在不安全的重叠冲突，本批尚未开始移动。\n原因：${reason}\n路径一：${path.relative(scan.root, left)}\n路径二：${path.relative(scan.root, right)}\n请取消选择互相包含的项目，或重新选择整理范围。`);
  };
  for (let i = 0; i < members.length; i++) {
    const left = members[i];
    // A selected source must never be reused or recreated as any destination container.
    const container = containers.find(candidate => overlaps(left.source, candidate));
    if (container) reject(left.source, container, '源项目与将创建或使用的归档目录重叠');
    for (let j = i; j < members.length; j++) {
      const right = members[j];
      if (overlaps(left.source, right.target)) reject(left.source, right.target, '源项目与目标位置互相包含');
      if (overlaps(left.target, right.source)) reject(left.target, right.source, '目标位置与源项目互相包含');
      if (i !== j && overlaps(left.source, right.source)) reject(left.source, right.source, '源项目被重复选择或互相包含');
      // 同名目标只放行逐项空位检查，不覆盖、不拆组；真正的目录重叠仍整批拒绝。
      // Equal target files are safe to attempt sequentially: the first successful
      // entry reserves the name on disk, then the later entry's vacancy check
      // skips its entire group. Ancestor/descendant target overlaps stay unsafe.
      if (i !== j && left.target !== right.target && overlaps(left.target, right.target)) reject(left.target, right.target, '两个目标位置互相包含');
    }
  }
}

async function createContainers(batch, entry) {
  const containers = [];
  for (const directory of containerPaths(batch, entry)) {
    await checkDirectory(batch.root, batch.rootIdentity);
    for (const container of containers) await checkDirectory(container.path, container.identity);
    try { await fs.mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    containers.push({ path: directory, identity: identity(await checkDirectory(directory)) });
  }
  return containers;
}

async function checkEntryDirectories(batch, entry) {
  await checkDirectory(batch.root, batch.rootIdentity);
  for (const member of entryMembers(entry)) {
    if (path.dirname(member.source) === batch.root) continue;
    const chain = member.sourceDirectories;
    let current = batch.root;
    for (const segment of path.relative(batch.root, path.dirname(member.source)).split(path.sep)) {
      current = path.join(current, safeSegment(segment));
      const recorded = chain?.find(directory => directory.path === current);
      if (!recorded?.identity) throw new Error('操作记录缺少源目录身份。');
      const removed = batch.cleanupDirectories?.find(directory => directory.path === current && directory.state === 'removed');
      if (removed && !await statOrNull(current)) continue;
      await checkDirectory(current, recorded.identity);
    }
  }
  const paths = containerPaths(batch, entry);
  for (const directory of paths) {
    const recorded = entry.containers?.find(container => container.path === directory);
    if (entry.members && !recorded?.identity) throw new Error('操作记录缺少目录身份。');
    await checkDirectory(directory, recorded?.identity ?? (directory === path.dirname(entry.target) ? entry.containerIdentity : undefined));
  }
}

// Validate the whole source chain, not just the leaf inode. A genuine leaf can
// be moved underneath a replacement parent without changing its own identity.
async function validateSourceAncestors(batch, location, includeSelf = false) {
  await checkDirectory(batch.root, batch.rootIdentity);
  const references = sourceDirectoryReferences(batch);
  const parent = includeSelf ? location : path.dirname(location);
  let current = batch.root;
  for (const segment of path.relative(batch.root, parent).split(path.sep).filter(Boolean)) {
    current = path.join(current, safeSegment(segment));
    const recorded = references.find(directory => directory.path === current);
    if (!recorded) throw new Error('缺少源目录身份。');
    await checkDirectory(current, recorded.identity);
  }
}

function targetConflictMessage(batch, member) {
  const other = batch.entries.filter(entry => entry.status === 'moved').flatMap(entryMembers)
    .find(candidate => candidate.target === member.target && candidate.source !== member.source);
  return `目标已存在（目标文件冲突），已跳过，未覆盖。\n来源：${path.relative(batch.root, member.source)}\n目标：${path.relative(batch.root, member.target)}`
    + (other ? `\n本批已归档的另一来源：${path.relative(batch.root, other.source)}` : '')
    + '\n请重命名源文件，或调整分类/日期后重试。重命名后需要重新扫描。';
}

async function preflight(batch, entry, origin) {
  await checkEntryDirectories(batch, entry);
  for (const member of entryMembers(entry)) {
    await checkItem(member[origin], member.identity);
    if (await statOrNull(member[origin === 'source' ? 'target' : 'source'])) {
      throw new Error(origin === 'source' ? targetConflictMessage(batch, member) : '原位置已存在同名项目，未覆盖，可解决冲突后再次撤销。');
    }
  }
}

async function locateMembers(batch, entry) {
  await checkEntryDirectories(batch, entry);
  const locations = [];
  for (const member of entryMembers(entry)) {
    const source = await statOrNull(member.source), target = await statOrNull(member.target);
    if (same(source, member.identity) && !target) locations.push('source');
    else if (same(target, member.identity) && !source) locations.push('target');
    else throw new Error('成员身份或位置不能安全确认。');
  }
  return locations;
}
