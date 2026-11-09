import { buildMediaSegments, validateMediaOverrides } from '../public/media-paths.js';

// 这些纯函数统一维护表格的筛选、校验、选择和目标路径预览规则。
export const isMedia = item => item.type === 'media';

// 将收件箱的嵌套分类树转换为 select 可用的稳定路径和值。
export function flattenTaxonomy(nodes, result = []) {
  for (const node of nodes ?? []) {
    if (node?.path && node?.name) result.push({ value: node.path, label: node.path.replaceAll('/', ' / ') });
    flattenTaxonomy(node?.children, result);
  }
  return result;
}

// 根据媒体覆盖字段生成相对目标目录；异常输入会由调用方转成表格错误。
export function mediaSegments(item) {
  return [...(item.outputDirectory ? [item.outputDirectory] : []), ...buildMediaSegments(item.dateEdited ? {} : item, validateMediaOverrides({
    ...(item.dateEdited ? { year: item.year, month: item.month, day: item.day } : {}),
    mediaType: item.mediaType
  }))];
}

export function mediaValidationError(item) {
  try { mediaSegments(item); return ''; }
  catch { return '目标路径无效：请检查年份、月份和日期。'; }
}

export function mediaFieldInvalid(field, value, item = { year: '2026', month: '01', day: '01', mediaType: 'photo' }) {
  try {
    buildMediaSegments(item, validateMediaOverrides({ [field]: value }));
    return false;
  } catch { return true; }
}

export const canMove = item => isMedia(item) ? !mediaValidationError(item) : Boolean(item.category);

// 判断媒体日期是否来自推断值或仍是未知值，需要用户复核。
export const dateReview = item => isMedia(item) && (!canMove(item) || item.year === '未知日期'
  || item.month === '未知月份' || item.day === '未知日期' || (!item.dateEdited && (item.inferredDate || item.dateSource === 'unknown')));

export const locationReview = item => isMedia(item) && !item.locationEdited && item.locationStatus !== 'resolved';

// 综合媒体日期/地点和普通项目的 AI 置信度，决定是否显示“待确认”。
export const needsReview = item => isMedia(item) ? dateReview(item)
  : !item.category || (!item.manual && (item.confidence < 0.85 || item.category === '其他'));

export const mediaLabel = item => item.mediaType === 'live-photo' ? 'Live Photo · 2 个文件'
  : item.mediaType === 'video' ? '视频' : '照片';

export function mediaDestinationPaths(item) {
  return item.members.map(member => [...mediaSegments(item), member.name].join(' / '));
}

export function targetFor(item) {
  return isMedia(item) ? `${mediaSegments(item).join(' / ')} / ${item.name}`
    : item.category ? [item.outputDirectory, item.category, item.name].filter(Boolean).join(' / ') : '选择类别后预览';
}

export function selectionFor(item) {
  return isMedia(item) ? { id: item.id, media: {
    ...(item.dateEdited ? { year: item.year, month: item.month, day: item.day } : {}),
    ...(item.mediaType === 'live-photo' ? {} : { mediaType: item.mediaType })
  } } : { id: item.id, category: item.category };
}

export function matchesFilter(item, filter) {
  return filter === 'all' || filter === item.type || (isMedia(item) && filter === item.mediaType)
    || filter === 'review' && needsReview(item) || filter === 'date-review' && dateReview(item)
    || filter === 'location-review' && locationReview(item);
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

// Derive completed items from durable journals; uncertain/failed/undone items
// must never appear successful. Preserve the batch ID for its undo action.
export function completedBatches(batches) {
  return batches.map(batch => ({ ...batch, entries: batch.entries.filter(entry => entry.status === 'moved') }))
    .filter(batch => batch.entries.length > 0);
}
