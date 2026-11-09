import React, { useEffect, useRef, useState } from 'react';
import { MediaRow, OrdinaryRow } from './Rows.jsx';
import {
  canMove, completedBatches, dateReview, flattenTaxonomy, isMedia, matchesFilter, needsReview, selectionFor, targetFor, mediaLabel
} from './item-model.js';

// 页面筛选项和历史状态的显示文案集中定义，避免 JSX 中散落字符串。
const filters = [
  ['all', '全部项目'], ['file', '文件'], ['folder', '文件夹'], ['photo', '照片'],
  ['video', '视频'], ['live-photo', 'Live Photo'],
  ['date-review', '日期待确认'], ['review', '待确认']
];
const statuses = { moved: '已移动', skipped: '已跳过', undone: '已撤销', ready: '未执行', pending: '待恢复', undoing: '撤销中', uncertain: '需手动核对' };

// 调用本地 Node API；token 只在本机同源会话中使用。
async function api(route, body, token) {
  const response = await fetch(`/api/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Token': token || '' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败，请重试。');
  return data;
}

// 操作记录页：展示批次、每个项目的结果，并提供整批撤销入口。
function History({ batches, busy, onRefresh, onUndo, completed = false }) {
  const prefix = completed ? 'completed' : 'history';
  const shown = completed ? completedBatches(batches) : batches;
  return <section id={`${prefix}-view`}><div className="page-heading"><div><div className="eyebrow">EVERY MOVE HAS A WAY BACK</div>
    <h1>{completed ? '已经归位的文件' : '每一步，都有迹可循'}<span>。</span></h1><p>{completed ? '只展示已成功移动的项目和归档位置。失败、跳过及已撤销的项目不会出现在这里。' : '查看完整整理结果；撤销会将文件或文件夹移回原位置。'}</p>
    </div><button id={`refresh-${prefix}`} className="secondary" disabled={busy} onClick={onRefresh}>刷新记录</button></div>
    <div id={`${prefix}-list`}>{shown.length ? shown.map(batch => <article className="panel history-card" key={batch.id}>
      <div className="history-head"><div><h2>{new Date(batch.createdAt).toLocaleString('zh-CN')} · {batch.entries.length} 个项目</h2>
        <div className="history-root">{batch.root}</div>
        {batch.cleanupDirectories?.length > 0 && <p className="subtle">已清理 {batch.cleanupDirectories.filter(directory => directory.state === 'removed').length} 个空源目录 · 撤销时恢复目录</p>}
        {batch.cleanupDirectories?.filter(directory => directory.error || directory.state === 'uncertain').map(directory => <p className="media-error" key={directory.path}>{directory.path}：{directory.error || '目录状态需要手动核对'}</p>)}</div>
        {batch.entries.some(entry => entry.status === 'moved') && <button className="secondary" data-undo={batch.id} disabled={busy}
          onClick={() => onUndo(batch.id)}>↶ 撤销此批次</button>}
      </div><ul className="history-entries">{batch.entries.map((entry, index) => <li key={`${entry.name}-${index}`}>
        <span>{entry.type === 'media' ? mediaLabel(entry) : entry.type === 'file' ? '文件' : '文件夹'} · {entry.name} → {entry.targetSegments?.join(' / ') || entry.category}</span>
        <span className="history-status">{statuses[entry.status] || entry.status}</span>
        <small>{entry.source} → {entry.target}</small>{entry.error && <small className="entry-error">{entry.error}</small>}
      </li>)}</ul></article>) : <div className="panel empty"><div className="empty-icon">◷</div><h3>{completed ? '还没有已整理项目' : '还没有整理记录'}</h3><p>{completed ? '成功整理的项目会从待整理列表移到这里。' : '执行整理后，每一次移动都会记录在这里。'}</p></div>}</div>
  </section>;
}

export default function App() {
  // 主页面同时承载扫描、分类预览、移动确认和历史记录两个视图。
  const [session, setSession] = useState(null);
  const [inboxes, setInboxes] = useState([]);
  const [inboxId, setInboxId] = useState('');
  const [pending, setPending] = useState([]);
  const [root, setRoot] = useState('');
  const [mode, setMode] = useState('normal');
  const [scan, setScan] = useState(null);
  const [items, setItems] = useState([]);
  const [view, setView] = useState('organize');
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState({ text: '', error: false });
  const [metadataStatus, setMetadataStatus] = useState('拍摄信息：等待扫描');
  const [auto, setAuto] = useState(false);
  const [history, setHistory] = useState([]);
  const [pendingMove, setPendingMove] = useState([]);
  const dialog = useRef(null);

  // 统一显示成功、提示和错误消息，避免异步操作直接改 DOM。
  const showNotice = (text, error = false) => setNotice({ text, error });
  // 串行化用户操作并锁定按钮，避免重复提交扫描、分类或移动请求。
  const run = async (task, message) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    if (message) showNotice(message);
    try { await task(); }
    catch (error) { showNotice(error.message || '连接失败，请确认本地服务仍在运行。', true); }
    finally { busyRef.current = false; setBusy(false); }
  };

  useEffect(() => {
    api('session').then(value => {
      setSession(value);
      setRoot(value.defaultRoot);
      if (!value.mediaSupported) setMetadataStatus('拍摄信息：自动读取需要 macOS，当前不可用，可手动调整');
      return api('inboxes', undefined, value.token).then(available => setInboxes(available));
    }).catch(error => showNotice(error.message || '连接失败，请确认本地服务仍在运行。', true));
  }, []);

  useEffect(() => {
    if (session && !session.aiEnabled) showNotice('在项目 .env 中设置 TYPESAFE_API_KEY 并重启服务，即可使用 AI 推荐。当前可以扫描、手动分类、移动和撤销。');
  }, [session]);

  const selectedInbox = inboxes.find(inbox => inbox.id === inboxId) ?? null;
  const taxonomyCategories = selectedInbox ? flattenTaxonomy(selectedInbox.taxonomy).map(category => category.value) : (session?.categories ?? []);

  const loadPending = async selectedId => {
    if (!selectedId || !session) { setPending([]); return []; }
    const saved = await api(`pending?inboxId=${encodeURIComponent(selectedId)}`, undefined, session.token);
    setPending(saved);
    return saved;
  };

  const chooseInbox = event => {
    const nextId = event.target.value;
    setInboxId(nextId);
    const next = inboxes.find(inbox => inbox.id === nextId);
    setRoot(next?.root ?? session?.defaultRoot ?? '');
    setScan(null); setItems([]);
    loadPending(nextId);
  };

  const selected = items.filter(item => item.selected && canMove(item));
  const selectable = items.filter(canMove);
  const visible = items.filter(item => matchesFilter(item, filter) && item.name.toLowerCase().includes(query.toLowerCase()));
  const reviewCount = items.filter(needsReview).length;
  const fileCount = items.filter(item => item.type === 'file').length;
  const folderCount = items.filter(item => item.type === 'folder').length;
  const mediaCount = items.filter(isMedia).length;

  // 打开 macOS 原生目录选择器，并将返回的绝对路径写入输入框。
  const pickFolder = () => run(async () => {
    const result = await api('pick-folder', { root: root.trim() }, session.token);
    if (!result.root) { showNotice('已取消选择，保留原目录。'); return; }
    setRoot(result.root);
    setScan(null); setItems([]);
    showNotice('已选择目录，点击「扫描文件夹」查看其中的文件与文件夹。');
  }, '请在系统弹出的窗口中选择本机文件夹…');

  // 扫描直属文件和文件夹，同时读取媒体拍摄时间和可选地点。
  const scanFolder = event => {
    event.preventDefault();
    run(async () => {
      setScan(null); setItems([]);
      setMetadataStatus('拍摄信息：正在读取…');
      let result;
      try { result = await api('scan', { root: root.trim(), mode, resolveLocations: false, ...(inboxId ? { inboxId } : {}) }, session.token); }
      catch (error) {
        setMetadataStatus('拍摄信息：扫描未完成');
        throw error;
      }
      setScan(result); setRoot(result.root || root.trim());
      const savedPending = inboxId ? await loadPending(inboxId) : [];
      const savedById = new Map(savedPending.map(item => [item.id, item]));
      setItems(result.items.map(item => {
        const saved = savedById.get(item.id);
        return { ...item, category: saved?.category ?? item.category ?? null, confidence: saved?.confidence ?? item.confidence ?? null,
          manual: saved?.recommendationSource === 'manual', selected: false, error: saved?.error ?? null };
      }));
      const failed = result.items.filter(item => isMedia(item) && item.metadataStatus === 'failed').length;
      setMetadataStatus(session.mediaSupported ? `拍摄信息：读取完成${failed ? ` · ${failed} 项需手动确认` : ''}` : '拍摄信息：自动读取需要 macOS，当前不可用，可手动调整');
      showNotice(`扫描完成：${result.items.length} 个项目。${result.skipped.length ? `已跳过 ${result.skipped.length} 个分类容器、隐藏、链接或不可读项目。` : ''}${result.items.length ? selectedInbox ? '可使用收件箱分类建议，也可手动选择。' : '已按文件类型和媒体时间生成建议，请检查后勾选确认。' : ''}`);
    }, '正在扫描文件并递归提取媒体…');
  };

  // 把当前勾选项提交给后端；后端负责校验、写日志和实际移动。
  const performMove = async moving => {
    showNotice(`正在移动 ${moving.length} 个项目并保存操作记录…`);
    const batch = await api('move', { scanId: scan.id, selections: moving.map(selectionFor) }, session.token);
    const moved = batch.entries.filter(entry => entry.status === 'moved');
    const movedIds = new Set(moved.map(entry => entry.scanItemId));
    setItems(previous => previous.filter(item => !movedIds.has(item.id)).map(item => {
      const skipped = batch.entries.find(entry => entry.scanItemId === item.id && entry.status !== 'moved');
      return skipped ? { ...item, error: skipped.error, selected: false } : item;
    }));
    const skipped = batch.entries.filter(entry => entry.status !== 'moved');
    await loadPending(inboxId);
    showNotice(`整理完成：已移动 ${moved.length} 个，跳过 ${skipped.length} 个。可在「已整理」查看成功项目，在「操作记录」查看完整结果或撤销。${skipped.length ? '\n' + skipped.map(entry => `${entry.name}：${entry.error}`).join('\n') : ''}`, skipped.length > 0);
  };

  // 将普通文件/文件夹的名称和样本交给 TypeSafe，回填推荐分类与评分。
  const classify = () => run(async () => {
    const results = await api('classify', { scanId: scan.id, itemIds: items.filter(item => !isMedia(item) && !item.manual).map(item => item.id) }, session.token);
    let failed = 0;
    const updated = items.map(item => {
      const result = results.find(value => value.id === item.id);
      if (!result || isMedia(item) || item.manual) return item;
      if (result.error) failed++;
      const next = { ...item, ...result, error: result.error || null };
      return { ...next, selected: !needsReview(next) };
    });
    setItems(updated);
    await loadPending(inboxId);
    if (auto) {
      const automatic = updated.filter(item => !isMedia(item) && !item.manual && item.category && item.category !== '其他' && item.confidence >= 0.85);
      if (automatic.length) {
        await performMove(automatic);
        if (failed) showNotice(`自动整理已完成，另有 ${failed} 个项目 AI 分类失败，请手动选择标签或重试。`, true);
        return;
      }
    }
    showNotice(failed ? `${failed} 个项目分类失败，请检查 Key、网络或额度。其他结果可继续整理，失败项支持手动选择。` : '推荐完成。高置信度结果已勾选；请检查目标位置，低置信度结果可手动确认后勾选。', failed > 0);
  }, 'AI 正在逐个分析项目，数量较多时需要稍等。名称、扩展名与目录样本会发送至 TypeSafe。');

  // 修改媒体的年月、国家、城市或类型，并实时重新计算可移动状态。
  const updateMedia = (id, field, value) => setItems(previous => previous.map(item => {
    if (item.id !== id) return item;
    const next = { ...item, [field]: value };
    if (field === 'year' || field === 'month' || field === 'day') next.dateEdited = true;
    if (field === 'country' || field === 'city') next.locationEdited = Boolean(next.country?.trim() && next.city?.trim() && !next.country.startsWith('未知') && !next.city.startsWith('未知'));
    next.selected = canMove(next);
    return next;
  }));
  // 修改普通项目分类；手动选择会覆盖 AI 结果并自动勾选。
  const updateCategory = (id, value) => {
    setItems(previous => previous.map(item => item.id !== id ? item : {
      ...item, category: value || null, manual: Boolean(value), selected: Boolean(value)
    }));
    if (inboxId && session) api('pending/update', { id, changes: {
      category: value || null, recommendationSource: value ? 'manual' : 'unclassified', status: 'pending'
    } }, session.token).catch(error => showNotice(error.message, true));
  };
  // 更新单项勾选状态，实际移动前仍由后端重新验证路径和文件身份。
  const selectItem = (id, checked) => setItems(previous => previous.map(item => item.id === id ? { ...item, selected: checked } : item));

  // 读取并恢复未完成的操作日志，用于历史页和启动后的安全恢复。
  const loadHistory = async () => setHistory(await api('history', undefined, session.token));
  const showHistory = () => { setView('history'); run(loadHistory); };
  const showCompleted = () => { setView('completed'); run(loadHistory); };
  // 请求后端按日志批次撤销；撤销后清空旧扫描，要求用户重新确认当前目录。
  const undo = id => run(async () => {
    const batch = await api('undo', { id }, session.token);
    const remaining = batch.entries.filter(entry => entry.status === 'moved' || entry.status === 'uncertain');
    setScan(null); setItems([]);
    await loadHistory();
    showNotice(remaining.length ? `有 ${remaining.length} 项无法撤销，请查看记录中的原因。` : '撤销完成，项目已回到原位置。继续整理前请重新扫描。', remaining.length > 0);
  }, '正在撤销并检查原位置是否可用…');

  // 将当前扫描和目标路径导出为本地 JSON 方案，不上传文件内容。
  const exportPlan = () => {
    const data = { root: scan.root, createdAt: new Date().toISOString(), items: items.map(item => ({
      name: item.name, type: item.type, ...selectionFor(item),
      destination: canMove(item) ? `${scan.root}/${targetFor(item).replaceAll(' / ', '/')}` : null
    })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = '文件与文件夹分类方案.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return <div data-react-app>
    <aside className="sidebar"><a className="brand" href="/" aria-label="Jev AI 归屿首页"><span className="brand-icon">▧</span><span>Jev AI 归屿<small>LOCAL ORGANIZER</small></span></a>
      <p className="nav-label">我的空间</p><nav aria-label="主导航">
        <button className={`nav-item ${view === 'organize' ? 'active' : ''}`} id="nav-organize" onClick={() => setView('organize')}><span>▦</span> 待整理 {view === 'organize' && <span className="nav-dot" />}</button>
        <button className={`nav-item ${view === 'completed' ? 'active' : ''}`} id="nav-completed" disabled={busy || !session} onClick={showCompleted}><span>✓</span> 已整理</button>
        <button className={`nav-item ${view === 'history' ? 'active' : ''}`} id="nav-history" onClick={showHistory}><span>◷</span> 操作记录</button>
      </nav><div className="sidebar-note"><span className="note-icon">↳</span><strong>让每个项目，各归其位。</strong><p>文件按类型分类，媒体按日期归档，<br />只改变它们所在的位置。</p></div>
      <div className="local-badge"><i /> 本地运行 <span>Node.js</span></div>
    </aside>
    <main><header className="topbar"><span>我的空间 <b>/</b> <span id="breadcrumb">{view === 'history' ? '操作记录' : view === 'completed' ? '已整理' : '待整理'}</span></span><span className="powered">{selectedInbox ? <>Powered by <strong>TypeSafe AI</strong></> : '本机处理 · 预览确认 · 支持撤销'}</span></header>
      {view === 'organize' && <section id="organize-view">
        <div className="page-heading"><div><div className="eyebrow">A LITTLE ORDER, A LITTLE CALM</div><h1>给散落的文件，一个好去处<span>。</span></h1><p>从杂乱到有序。普通文件按类型分类，照片和视频按拍摄年月日归档。确认后移动，并清理空的源目录。</p></div><span className="heading-mark" aria-hidden="true">▱</span></div>
        <section className="panel source-panel" aria-labelledby="source-title"><div className="section-title"><span className="step">01</span><h2 id="source-title">选择整理范围</h2><span className="subtle">普通文件保留层级 · 媒体递归提取</span></div>
          {inboxes.length > 0 && <label className="inbox-select">收件箱<select id="inbox" value={inboxId} onChange={chooseInbox} disabled={busy}>
            <option value="">临时扫描（不保存待处理列表）</option>{inboxes.map(inbox => <option key={inbox.id} value={inbox.id}>{inbox.name}</option>)}
          </select></label>}
          <label className="mode-select">整理模式<select id="scan-mode" value={mode} disabled={busy} onChange={event => {
            setMode(event.target.value); setScan(null); setItems([]); setNotice({ text: '', error: false });
          }}><option value="normal">日常整理</option><option value="reorganize">重新整理已有分类</option></select></label>
          <p className="subtle">{mode === 'reorganize' ? '读取旧分类目录直属文件，保留更深的项目文件夹；媒体可递归提取。当前输出目录始终跳过。' : '只整理直属普通文件，媒体递归提取；已有分类和整理目录保持原位。'}</p>
          {scan?.outputDirectory && <p id="output-directory" className="subtle">本次输出：{scan.outputDirectory} / · 媒体按拍摄年 / 年月 / 年月日归档</p>}
          <form id="scan-form" onSubmit={scanFolder}><label htmlFor="root">父目录路径</label><div className="path-row"><span aria-hidden="true">▱</span>
            <input id="root" placeholder="选择文件夹，或输入绝对路径" autoComplete="off" required value={root} onChange={event => setRoot(event.target.value)} disabled={busy} />
            <button type="button" className="secondary" id="pick-folder" onClick={pickFolder} disabled={busy || !session}>选择文件夹</button>
            <button type="submit" className="primary" id="scan-button" disabled={busy || !session}>扫描文件夹 <span>→</span></button></div></form>
          <div className="scan-status" aria-live="polite"><span id="metadata-status">{metadataStatus}</span>{inboxId && <span id="pending-status">待处理：{pending.filter(item => item.status === 'pending').length}</span>}</div>
          <div className="source-footer"><span>按类型分类无需 AI · 普通子文件夹保持原位 · 媒体内容留在本机</span><span id="ai-status" className="status-pill">{!session ? '正在连接…' : !selectedInbox ? '本机类型规则 · 无需 API Key' : session.aiEnabled ? '✧ API Key 已配置' : '未配置 API Key · 可手动整理'}</span></div>
        </section>
        <div id="notice" className={`notice${notice.error ? ' error' : ''}`} role="status" aria-live="polite" hidden={!notice.text}>{notice.text}</div>
        <section className="workspace" aria-labelledby="preview-title"><div className="workspace-heading"><div className="section-title"><span className="step">02</span><h2 id="preview-title">整理预览</h2><span className="count" id="folder-count">{items.length} 个项目 · {mediaCount} 媒体 / {fileCount} 文件 / {folderCount} 文件夹</span></div>
          <div className="actions"><button id="export" className="secondary" disabled={busy || !items.length} onClick={exportPlan}>↓ 导出结果</button>
            {selectedInbox && <button id="classify" className="primary" disabled={busy || !items.some(item => !isMedia(item)) || !session?.aiEnabled}
              title={session?.aiEnabled ? '根据名称和文件名样本推荐类别' : '请在 .env 设置 TYPESAFE_API_KEY 后重启服务'} onClick={classify}>✧ AI 推荐标签</button>}</div></div>
          <div className="summary-grid"><div className="summary-card"><span className="summary-icon purple">▦</span><div><span>待整理项目</span><strong id="total-count">{scan ? items.length : '—'}</strong></div></div>
            <div className="summary-card"><span className="summary-icon green">✓</span><div><span>已确定位置</span><strong id="ready-count">{scan ? items.length - reviewCount : '—'}</strong></div></div>
            <div className="summary-card"><span className="summary-icon amber">◎</span><div><span>需要你确认</span><strong id="review-count">{scan ? reviewCount : '—'}</strong></div></div></div>
          <div className="panel table-panel"><div className="table-toolbar"><div className="filters">{filters.map(([key, label]) => <button key={key} className={`filter${filter === key ? ' active' : ''}`} data-filter={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}</div>
            <label className="search"><span>⌕</span><input id="search" placeholder="搜索文件或文件夹…" aria-label="搜索文件或文件夹" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
            <div className="table-scroll"><table><thead><tr><th className="checkbox-cell"><input id="select-all" type="checkbox" aria-label="选择全部可整理项目"
              checked={Boolean(selectable.length && selected.length === selectable.length)} ref={element => { if (element) element.indeterminate = selected.length > 0 && selected.length < selectable.length; }}
              disabled={busy || !selectable.length} onChange={event => setItems(previous => previous.map(item => ({ ...item, selected: Boolean(canMove(item) && event.target.checked) })))} /></th>
              <th>名称与类型</th><th>分类 / 调整位置</th><th>来源与状态</th><th>整理后的位置</th></tr></thead>
              <tbody id="folder-rows">{visible.map(item => isMedia(item)
                ? <MediaRow key={item.id} item={item} root={scan.root} busy={busy} onEdit={updateMedia} onSelect={selectItem} />
                : <OrdinaryRow key={item.id} item={item} root={scan.root} categories={taxonomyCategories} busy={busy} onCategory={updateCategory} onSelect={selectItem} />)}</tbody></table></div>
            <div id="empty" className="empty" hidden={visible.length > 0}><div className="empty-icon">▱</div><h3>{scan ? items.length ? '没有符合条件的项目' : '这里已经很整齐了' : '有序，从选择一个目录开始'}</h3>
              <p>{scan ? items.length ? '试试其他搜索词或切换到全部项目。' : '未发现待整理项目。隐藏目录、符号链接、照片图库和已有归档目录会跳过。' : '选择本机文件夹或输入路径，扫描后为每个项目找到合适的标签。'}</p>
              {!scan && <div className="empty-tags">{['文档', '照片视频', '音频', '压缩包', '安装包', '其他'].map(name => <span key={name}>{name}</span>)}</div>}</div>
            <div className="table-bottom"><span id="selection-count">{scan ? `已选择 ${selected.length} / ${items.length} 个项目` : '尚未选择项目'}</span><span>每批最多 500 项 · 同名不覆盖 · 可撤销</span></div></div>
          <div className="execution-bar" role="region" aria-label="整理操作"><div className="execution-summary"><strong>已选择 {selected.length} 项</strong><span>{selected.length > 500 ? '本次处理前 500 项，其余保留待下一批' : '检查预览后确认移动，支持撤销'}</span></div>{selectedInbox && <label className="auto-option"><input id="auto" type="checkbox" checked={auto} disabled={busy || !session?.aiEnabled} onChange={event => setAuto(event.target.checked)} />
            <span>自动整理高置信度结果<small>开启后，AI 推荐完成即移动置信度 ≥ 85% 且非「其他」的项目。</small></span></label>}
            <button id="move" className="primary" disabled={busy || !selected.length} onClick={() => { setPendingMove(selected.slice(0, 500)); dialog.current.showModal(); }}>执行整理{selected.length ? `（${Math.min(selected.length, 500)}）` : ''} <span>→</span></button></div>
        </section><footer>内容保持完整，改变的只是位置。<span>LOCAL FIRST · THOUGHTFULLY ORGANIZED</span></footer>
      </section>}
      {view === 'completed' && <><History batches={history} busy={busy} onRefresh={() => run(loadHistory)} onUndo={undo} completed />
        <div id="completed-notice" className={`notice${notice.error ? ' error' : ''}`} role="status" aria-live="polite" hidden={!notice.text}>{notice.text}</div></>}
      {view === 'history' && <><History batches={history} busy={busy} onRefresh={() => run(loadHistory)} onUndo={undo} />
        <div id="history-notice" className={`notice${notice.error ? ' error' : ''}`} role="status" aria-live="polite" hidden={!notice.text}>{notice.text}</div></>}
    </main>
    {busy && <div className="operation-progress" role="status" aria-live="polite"><span>{notice.text || '正在处理，请稍候…'}</span><progress aria-label="操作进行中" /></div>}
    <dialog ref={dialog} id="confirm-dialog" onClose={event => {
      if (event.currentTarget.returnValue === 'confirm') run(() => performMove(pendingMove));
      setPendingMove([]);
    }}><form method="dialog"><span className="dialog-icon">↳</span><h2>准备好让它们各归其位了吗？</h2>
      <p id="confirm-description">将 {pendingMove.length} 个项目移至「{scan?.root}」下预览的位置。媒体提取成功后会清理变空的源目录；撤销时重建目录。</p>
      <p className="subtle">文件内容与文件夹内部结构不会改变。遇到同名目标会跳过，你可以在操作记录中撤销。</p>
      <div className="dialog-actions"><button value="cancel" className="secondary">再检查一下</button><button value="confirm" className="primary">确认移动</button></div></form></dialog>
  </div>;
}
