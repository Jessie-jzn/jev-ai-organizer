import { sanitizeSegment } from '../public/media-paths.js';
export { sanitizeSegment, buildMediaSegments } from '../public/media-paths.js';

const UNKNOWN_DATE = '未知日期';
const UNKNOWN_MONTH = '未知月份';
const UNKNOWN_COUNTRY = '未知国家';
const UNKNOWN_CITY = '未知城市';

const COMPACT_FILENAME_DATE = /(?:^|[^0-9])(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?=$|[^0-9])/;
const SEPARATED_FILENAME_DATE = /(?:^|[^0-9])(\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2})-(\d{2})(?=$|[^0-9])/;
const DATE_ONLY_FILENAME = /(?:^|[^0-9])(\d{4})-(\d{2})-(\d{2})(?!T|\s+\d)(?=$|[^0-9])/;
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

export function resolveMediaFacts(input = {}) {
  // 按嵌入元数据、文件名、文件创建时间的优先级推断年月，并规范地点字段。
  const metadata = input.metadata ?? {};
  const embedded = parseEmbeddedDate(metadata.capturedAt, metadata.offsetMinutes);
  const filename = embedded ? null : parseFilenameDate(input.name);
  const filesystem = embedded || filename ? null : parseFilesystemDate(input.birthtime, input.timeZone);
  const date = embedded ?? filename ?? filesystem;
  const coordinates = validCoordinates(metadata.latitude, metadata.longitude)
    ? { latitude: metadata.latitude, longitude: metadata.longitude }
    : { latitude: null, longitude: null };
  const place = input.place ?? input.resolvedPlace;
  const resolvedPlace = place?.status === 'resolved'
    && typeof place.country === 'string' && typeof place.city === 'string';

  return {
    mediaType: metadata.kind === 'video' ? 'video' : 'photo',
    capturedAt: date?.capturedAt ?? null,
    dateSource: date?.source ?? 'unknown',
    inferredDate: date?.inferred ?? false,
    year: date?.year ?? UNKNOWN_DATE,
    month: date?.month ?? UNKNOWN_MONTH,
    day: date?.day ?? '未知日期',
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    country: resolvedPlace ? sanitizeSegment(place.country, UNKNOWN_COUNTRY) : UNKNOWN_COUNTRY,
    city: resolvedPlace ? sanitizeSegment(place.city, UNKNOWN_CITY) : UNKNOWN_CITY,
    locationStatus: resolvedPlace ? 'resolved' : coordinates.latitude === null ? 'unknown' : 'unresolved',
    assetIdentifier: typeof metadata.assetIdentifier === 'string' && metadata.assetIdentifier.trim()
      ? metadata.assetIdentifier : null
  };
}

function parseEmbeddedDate(value, offsetMinutes) {
  if (typeof value !== 'string') return null;
  const match = ISO_DATE_TIME.exec(value);
  if (!match || !validDateAndTime(match.slice(1, 7))) return null;
  if (match[7] && !parseIsoDate(value, match[7])) return null;
  const hasOffset = Boolean(match[7])
    || Number.isInteger(offsetMinutes) && offsetMinutes >= -1439 && offsetMinutes <= 1439;
  // Embedded fields are the camera's local clock. With no recorded offset the
  // configured/current zone is inferred, but its calendar fields do not shift.
  return dateFact(match[1], match[2], value, 'embedded', !hasOffset);
}

function parseFilenameDate(name) {
  if (typeof name !== 'string') return null;
  for (const expression of [COMPACT_FILENAME_DATE, SEPARATED_FILENAME_DATE, DATE_ONLY_FILENAME]) {
    const match = expression.exec(name);
    if (!match) continue;
    const [year, month, day, hour = '00', minute = '00', second = '00'] = match.slice(1);
    if (validDateAndTime([year, month, day, hour, minute, second])) {
      return dateFact(year, month, `${year}-${month}-${day}T${hour}:${minute}:${second}`, 'filename', false);
    }
  }
  return null;
}

function parseFilesystemDate(value, timeZone) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const parts = yearMonthInTimeZone(date, timeZone);
  return parts && { ...dateFact(parts.year, parts.month, date.toISOString(), 'filesystem', true), day: parts.day };
}

function parseIsoDate(value, zone) {
  const normalized = zone !== 'Z' && !zone.includes(':')
    ? `${value.slice(0, -5)}${zone.slice(0, 3)}:${zone.slice(3)}`
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function validDateAndTime([yearText, monthText, dayText, hourText, minuteText, secondText]) {
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText ?? '0');
  if (!Number.isInteger(year) || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  return calendarDate.getUTCFullYear() === year && calendarDate.getUTCMonth() === month - 1 && calendarDate.getUTCDate() === day;
}

function yearMonthInTimeZone(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    return { year: parts.find(part => part.type === 'year')?.value, month: parts.find(part => part.type === 'month')?.value, day: parts.find(part => part.type === 'day')?.value };
  } catch {
    return null;
  }
}

function dateFact(year, month, capturedAt, source, inferred) {
  return { year, month, day: capturedAt.slice(8, 10), capturedAt, source, inferred };
}

function validCoordinates(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}
