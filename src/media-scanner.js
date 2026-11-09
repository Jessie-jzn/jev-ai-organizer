import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { buildMediaSegments, resolveMediaFacts } from './media-rules.js';
import { coordinateKey } from './geocode-cache.js';

const PHOTO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.heic', '.heif', '.png', '.tif', '.tiff', '.dng', '.cr2', '.nef', '.arw', '.raf']);
const VIDEO_EXTENSIONS = new Set(['.mov', '.mp4', '.m4v']);
const BATCH_SIZE = 100;

// 将直属文件拆成媒体和普通项目，读取元数据、地点，并合并 Live Photo。
export async function scanMedia(files, options = {}) {
  const candidates = Array.isArray(files) ? files.filter(isFileCandidate) : [];
  const candidateFiles = candidates.filter(isCandidate);
  const ordinaryPaths = candidates.filter(file => !isCandidate(file));
  const metadata = await inspectCandidates(candidateFiles, options.inspectMedia);
  const records = [];

  for (const file of candidateFiles) {
    const result = metadata.get(file.path);
    if (result?.kind === 'unsupported') {
      ordinaryPaths.push(file);
      continue;
    }
    const failed = !result || result.error || result.kind !== 'photo' && result.kind !== 'video';
    const raw = failed ? { kind: inferredKind(file) } : result;
    records.push({ file, raw, metadataStatus: failed ? 'failed' : 'ok', timeZone: options.timeZone });
  }

  await resolveRecordPlaces(records, options);
  return {
    mediaItems: groupLivePhotos(records),
    ordinaryPaths
  };
}

export function toPublicScan(scan, options = {}) {
  return {
    id: scan.id,
    items: (scan.items ?? []).map(item => item.type === 'media'
      ? { ...publicMediaItem(item), outputDirectory: scan.outputDirectory ?? '' }
      : { ...publicOrdinaryItem(item), outputDirectory: scan.outputDirectory ?? '' }),
    outputDirectory: scan.outputDirectory ?? '',
    mode: scan.mode ?? 'normal',
    skipped: [...(scan.skipped ?? [])]
  };
}

async function inspectCandidates(files, inspectMedia) {
  // 分批调用 Swift helper，任何一批失败都降级为手动确认而不中断整次扫描。
  const results = new Map();
  if (typeof inspectMedia !== 'function') return results;
  for (let start = 0; start < files.length; start += BATCH_SIZE) {
    const batch = files.slice(start, start + BATCH_SIZE);
    try {
      const response = await inspectMedia(batch.map(file => file.path));
      if (!Array.isArray(response)) throw new Error('invalid metadata response');
      const byPath = new Map(response.filter(result => result && typeof result.path === 'string')
        .map(result => [result.path, result]));
      for (const file of batch) results.set(file.path, byPath.get(file.path) ?? null);
    } catch {
      for (const file of batch) results.set(file.path, null);
    }
  }
  return results;
}

async function resolveRecordPlaces(records, options) {
  // 以坐标去重后反向地理编码；默认不开启，避免坐标离开本机。
  for (const record of records) record.facts = factsFor(record);
  if (options.resolveLocations !== true) return;
  const points = [];
  const seen = new Set();
  for (const record of records) {
    const { latitude, longitude } = record.facts;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    const key = coordinateKey({ latitude, longitude });
    if (!seen.has(key)) {
      seen.add(key);
      points.push({ key, latitude, longitude });
    }
  }
  if (!points.length) return;

  const places = await resolvePlaces(points, options);
  for (const record of records) {
    const { latitude, longitude } = record.facts;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    record.place = places.get(coordinateKey({ latitude, longitude }));
    record.facts = factsFor(record);
  }
}

async function resolvePlaces(points, { geocodeCache, reverseGeocode } = {}) {
  try {
    if (geocodeCache?.resolve) return await geocodeCache.resolve(points, reverseGeocode ?? (async () => []));
    if (typeof reverseGeocode !== 'function') return new Map();
    const places = await reverseGeocode(points);
    return new Map(Array.isArray(places) ? places.filter(place => place?.key).map(place => [place.key, place]) : []);
  } catch {
    return new Map();
  }
}

function groupLivePhotos(records) {
  // 只有同一标识的一张照片和一个视频才合并，避免误把普通文件绑在一起。
  const byIdentifier = new Map();
  for (const record of records) {
    const asset = validAssetIdentifier(record.raw.assetIdentifier);
    const identifier = asset ? `${path.dirname(record.file.path)}:${asset}` : null;
    if (!identifier) continue;
    const group = byIdentifier.get(identifier) ?? [];
    group.push(record);
    byIdentifier.set(identifier, group);
  }
  const grouped = new Set();
  const items = [];
  for (const recordsForIdentifier of byIdentifier.values()) {
    const photos = recordsForIdentifier.filter(record => record.raw.kind === 'photo');
    const videos = recordsForIdentifier.filter(record => record.raw.kind === 'video');
    if (photos.length === 1 && videos.length === 1 && recordsForIdentifier.length === 2) {
      const [photo] = photos;
      const [video] = videos;
      grouped.add(photo); grouped.add(video);
      items.push(livePhotoItem(photo, video));
    } else if (photos.length || videos.length) {
      for (const record of recordsForIdentifier) record.warning = 'Live Photo 配对标识不唯一，未合并。';
    }
  }
  for (const record of records) if (!grouped.has(record)) items.push(singleMediaItem(record));
  return items.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
}

function singleMediaItem(record) {
  const facts = record.facts;
  return {
    id: randomUUID(),
    type: 'media',
    name: record.file.name,
    sourceRelativePath: record.file.sourceRelativePath,
    mediaType: facts.mediaType,
    mediaDirectory: facts.mediaType === 'video' ? '视频' : '照片',
    members: [memberFor(record)],
    facts,
    targetSegments: buildMediaSegments(facts),
    metadataStatus: record.metadataStatus,
    warning: record.warning ?? null
  };
}

function livePhotoItem(photo, video) {
  const metadata = {
    ...photo.raw,
    capturedAt: photo.raw.capturedAt || video.raw.capturedAt || null,
    offsetMinutes: photo.raw.offsetMinutes ?? video.raw.offsetMinutes ?? null,
    latitude: validCoordinatePair(photo.raw) ? photo.raw.latitude : video.raw.latitude,
    longitude: validCoordinatePair(photo.raw) ? photo.raw.longitude : video.raw.longitude,
    assetIdentifier: photo.raw.assetIdentifier
  };
  const facts = resolveMediaFacts({
    metadata,
    name: photo.file.name,
    birthtime: photo.file.birthtime,
    timeZone: photo.timeZone,
    place: photo.place ?? video.place
  });
  facts.mediaType = 'live-photo';
  facts.mediaDirectory = '照片';
  return {
    id: randomUUID(),
    type: 'media',
    name: photo.file.name,
    sourceRelativePath: photo.file.sourceRelativePath,
    mediaType: 'live-photo',
    mediaDirectory: '照片',
    members: [memberFor(photo), memberFor(video)],
    facts,
    targetSegments: buildMediaSegments(facts),
    metadataStatus: photo.metadataStatus === 'failed' || video.metadataStatus === 'failed' ? 'failed' : 'ok',
    warning: photo.warning ?? video.warning ?? null
  };
}

function factsFor(record) {
  return resolveMediaFacts({
    metadata: record.raw,
    name: record.file.name,
    birthtime: record.file.birthtime,
    timeZone: record.timeZone,
    place: record.place
  });
}

function memberFor(record) {
  return { name: record.file.name, path: record.file.path, identity: record.file.identity, sourceDirectories: record.file.sourceDirectories };
}

function publicMediaItem(item) {
  // 删除真实路径、坐标等内部字段，只把页面需要的安全数据返回浏览器。
  const facts = item.facts ?? {};
  const publicFacts = {
    mediaType: item.mediaType,
    capturedAt: facts.capturedAt ?? null,
    dateSource: facts.dateSource ?? 'unknown',
    inferredDate: Boolean(facts.inferredDate),
    year: facts.year,
    month: facts.month,
    day: facts.day,
    country: facts.country,
    city: facts.city,
    locationStatus: facts.locationStatus ?? 'unknown',
    hasCoordinates: Number.isFinite(facts.latitude) && Number.isFinite(facts.longitude)
  };
  return {
    id: item.id,
    type: 'media',
    name: item.name,
    sourceRelativePath: item.sourceRelativePath ?? item.name,
    mediaType: item.mediaType,
    mediaDirectory: item.mediaDirectory,
    members: (item.members ?? []).map(member => ({ name: member.name })),
    ...publicFacts,
    targetSegments: [...(item.targetSegments ?? [])],
    metadataStatus: item.metadataStatus,
    warning: item.warning ?? null
  };
}

function publicOrdinaryItem(item) {
  const { identity, path: privatePath, sourceDirectories, allowOrdinary, ...publicItem } = item;
  return { ...publicItem, samples: [...(item.samples ?? [])] };
}

function isFileCandidate(file) {
  return file && typeof file.path === 'string' && typeof file.name === 'string';
}

export function isCandidate(file) {
  const extension = path.extname(file.name).toLowerCase();
  return PHOTO_EXTENSIONS.has(extension) || VIDEO_EXTENSIONS.has(extension);
}

function inferredKind(file) {
  return VIDEO_EXTENSIONS.has(path.extname(file.name).toLowerCase()) ? 'video' : 'photo';
}

function validAssetIdentifier(value) {
  const identifier = typeof value === 'string' ? value.trim() : '';
  return identifier && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(identifier) ? identifier : null;
}

function validCoordinatePair(metadata) {
  return Number.isFinite(metadata.latitude) && Number.isFinite(metadata.longitude)
    && metadata.latitude >= -90 && metadata.latitude <= 90 && metadata.longitude >= -180 && metadata.longitude <= 180;
}
