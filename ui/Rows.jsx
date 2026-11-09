import React from 'react';
import {
  canMove, formatBytes, mediaDestinationPaths, mediaFieldInvalid, mediaLabel,
  mediaValidationError, needsReview, targetFor
} from './item-model.js';

// 媒体编辑表单使用的月份选项，未知月份保留为可选值。
const months = ['未知月份', ...Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0'))];

// 单个媒体字段：负责展示值、校验状态并把修改交回页面状态。
function MediaField({ item, field, label, onEdit, disabled, ...inputProps }) {
  return <label>{label}<input data-media={item.id} data-field={field} aria-label={label}
    aria-invalid={mediaFieldInvalid(field, item[field], item)} value={item[field] ?? ''}
    onChange={event => onEdit(item.id, field, event.target.value)} disabled={disabled} {...inputProps} /></label>;
}

export function MediaRow({ item, root, busy, onEdit, onSelect }) {
  const error = mediaValidationError(item);
  const source = { embedded: '元数据', filename: '文件名', filesystem: '文件创建时间', unknown: '日期待确认' }[item.dateSource];
  const paths = error ? [] : mediaDestinationPaths(item);
  const names = item.members?.map(member => member.name).join('、') ?? item.name;
  return <tr className="media-row">
    <td><input type="checkbox" data-select={item.id} aria-label={`选择 ${item.name}`} checked={Boolean(item.selected)}
      onChange={event => onSelect(item.id, event.target.checked)} disabled={busy || !canMove(item)} /></td>
    <td><div className="folder-name"><span className="folder-icon file-icon" aria-hidden="true">▧</span><div>
      <strong title={item.name}>{item.name}</strong><small>{mediaLabel(item)}</small><small>{item.sourceRelativePath ?? item.name}</small>
      <small title={names}>{item.capturedAt ? item.capturedAt.replace('T', ' ').slice(0, 16) : '拍摄时间未知'}</small>
    </div></div>{item.error && <p className="media-error">{item.error}</p>}{item.warning && <p className="media-error">{item.warning}</p>}</td>
    <td><div className="media-controls">
      <MediaField item={item} field="year" label="年份" onEdit={onEdit} disabled={busy} maxLength={4} inputMode="numeric" />
      <label>月份<select data-media={item.id} data-field="month" aria-label="月份" value={item.month}
        onChange={event => onEdit(item.id, 'month', event.target.value)} disabled={busy}>
        {months.map(month => <option key={month} value={month}>{month}</option>)}
      </select></label>
      <label>日期<select data-media={item.id} data-field="day" aria-label="日期" value={item.day ?? '未知日期'}
        aria-invalid={mediaFieldInvalid('day', item.day ?? '未知日期', item)} disabled={busy}
        onChange={event => onEdit(item.id, 'day', event.target.value)}>
        {['未知日期', ...Array.from({ length: 31 }, (_, index) => String(index + 1).padStart(2, '0'))].map(day => <option key={day} value={day}>{day}</option>)}
      </select></label>
    </div></td>
    <td><div className="media-status"><span>{item.metadataStatus === 'failed' ? '拍摄信息：读取失败' : '拍摄信息：已读取'}</span>
      <span>{item.dateEdited ? '日期：手动确认' : item.inferredDate ? `推断时间 · ${source}` : source}</span>

    </div></td>
    <td className="destination" title={error ? '' : `${root}/${paths[0].replaceAll(' / ', '/')}`}>
      {error ? <p className="media-error" role="alert">{error}</p>
        : paths.map(itemPath => <span className="media-target" key={itemPath}>{itemPath}</span>)}
    </td>
  </tr>;
}

export function OrdinaryRow({ item, root, categories, busy, onCategory, onSelect }) {
  const type = item.type === 'file' ? `文件${item.extension ? ` · ${item.extension.slice(1).toUpperCase()}` : ''} · ${formatBytes(item.sizeBytes)}` : '文件夹';
  const sample = item.error || item.warning || (item.type === 'file' ? type : item.samples?.length
    ? `${type} · ${item.samples.length} 条样本 · ${item.samples.slice(0, 3).join('、')}` : '空文件夹或没有可读取的样本');
  const target = targetFor(item);
  return <tr><td><input type="checkbox" data-select={item.id} aria-label={`选择 ${item.name}`}
    checked={Boolean(item.selected)} onChange={event => onSelect(item.id, event.target.checked)} disabled={busy || !item.category} /></td>
    <td><div className="folder-name"><span className={`folder-icon ${item.type === 'file' ? 'file-icon' : ''}`} aria-hidden="true">{item.type === 'file' ? '▤' : '▱'}</span><div>
      <strong title={item.name}>{item.name}</strong><small title={sample}>{sample}</small>{item.sourceRelativePath && <small title={item.sourceRelativePath}>{item.sourceRelativePath}</small>}
    </div></div></td>
    <td><select className="category-select" data-category={item.id} aria-label={`${item.name} 的分类`}
      value={item.category ?? ''} onChange={event => onCategory(item.id, event.target.value)} disabled={busy}>
      <option value="">待选择分类</option>{categories.map(category => <option key={category} value={category}>{category}</option>)}
    </select></td>
    <td><span className={`confidence ${item.manual ? 'manual' : needsReview(item) ? 'low' : ''}`}>
      {item.manual ? '手动确认' : item.recommendationSource === 'file-type' ? '文件类型规则' : item.confidence == null ? '—' : `${Math.round(item.confidence * 100)}%${needsReview(item) ? ' · 待确认' : ''}`}
    </span></td>
    <td className="destination" title={`${root}/${target}`}>{target}</td>
  </tr>;
}
