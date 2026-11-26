window.__ModuleLoader__.load({
  id: 'dsh-oracle',
  factory(require) {
    const React = require('react');
    const { createElement: h, Fragment, useCallback, useEffect, useId, useRef, useState } = React;
    const ID = 'oracle-server';
    const NS = 'oracleDsh';
    const CHAT_SLOT = 'oracle.conversation';
    const READ_URL = '/_oracle-dsh/read';
    const CHAT_URL = '/api/oracle-dsh/chat';
    const HEADERS = { 'X-Oracle-DSH': '1' };
    const PREVIEW_LIMIT = 32 * 1024;
    const RESPONSE_LIMIT = 1024 * 1024;
    const DEFAULT_ROOT = '/home/ubuntu';
    const MAX_FOLDERS = 128;
    const MAX_FOLDER_ENTRIES = 1000;
    const MAX_FOLDER_PAGES = 20;
    const MAX_LIST_REQUESTS = 3;
    /** Server-enforced page ceiling; fewer requests per folder. */
    const LIST_LIMIT = 100;

    const en = {
      title: 'Oracle', description: 'View the Oracle server status, browse its shared files, or open a chat.',
      overview: 'Overview', files: 'Files', chat: 'Chat', tabs: 'Oracle views',
      refresh: 'Refresh', refreshing: 'Refreshing…', updated: 'Last loaded: {time}',
      host: 'Hostname', platform: 'Platform', uptime: 'Uptime', cpuUsage: 'CPU usage', cpu: 'Logical CPUs',
      memory: 'Memory', disk: 'Disk', scope: 'Read scope',
      capacity: '{available} available of {total}', usage: '{percent} used',
      usageWarn: 'High usage', usageCritical: 'Very high usage',
      requestBusy: 'Other folders are loading. Try again in a moment.',
      rootStale: 'Oracle needs a restart to browse folders. Quit DeepSeek Harness completely (⌘Q), reopen it, and try again.',
      rootMismatch: 'Oracle returned a different folder than the one requested. Reload the page and try again.',
      cpuSample: 'A short snapshot across all CPUs. Select Refresh to measure again.', cpuUnavailable: 'CPU usage could not be measured.',
      duration: '{days}d {hours}h {minutes}m', unavailable: '—',
      requestFailed: 'Could not read from Oracle. Try again.',
      denied: 'Access was denied. Check your Harness connection and permissions.',
      badReply: 'Oracle returned an invalid or oversized response.',
      readError: 'Oracle could not complete the request.',
      rootPath: 'Remote folder path', openFolder: 'Open folder', homeFolder: 'Home',
      rootHelp: 'Enter an absolute path on Oracle, for example /var/www. SSH permissions apply; hidden and sensitive items are filtered out.',
      loadFolder: 'Load folder', retryFolder: 'Try loading {folder} again',
      previewHelp: 'Previews are available for supported text files.',
      rootInvalid: 'Enter an absolute directory path without . or .. components.',
      explorer: 'Explorer', resetTree: 'Refresh tree', empty: 'No visible files or folders.',
      more: 'Load more', retry: 'Try again', folderLimit: 'Folder limit reached. Open a more specific starting folder.',
      pageLimit: 'Only the first {count} listed items are shown for this folder.',
      loading: 'Loading…', preview: 'Text preview', close: 'Close preview',
      chooseFile: 'Select a file in Explorer to preview it here.', fileDetails: '{size} · Modified {date}',
      clipped: 'Preview truncated. File size: {size}.', emptyFile: 'No text to display.',
      chatPending: 'Opening Oracle Chat…', chatFailed: 'Oracle Chat could not open. Try Reconnect.',
      reconnect: 'Reconnect', newChat: 'New chat',
      chatStale: 'Oracle\'s background service is older than this page. Quit DeepSeek Harness completely (⌘Q), reopen it, and try again.',
    };
    const zh = {
      title: 'Oracle', description: '查看 Oracle 服务器状态、浏览共享文件，或发起对话。',
      overview: '概览', files: '文件', chat: '对话', tabs: 'Oracle 页面',
      refresh: '刷新', refreshing: '正在刷新…', updated: '上次加载：{time}',
      host: '主机名', platform: '平台', uptime: '运行时间', cpuUsage: 'CPU 使用率', cpu: '逻辑 CPU 数量',
      memory: '内存', disk: '磁盘', scope: '读取范围',
      capacity: '{total} 中可用 {available}', usage: '已使用 {percent}',
      usageWarn: '使用率较高', usageCritical: '使用率很高',
      requestBusy: '其他文件夹正在加载，请稍后重试。',
      rootStale: 'Oracle 需要重启后才能浏览文件夹。请按 ⌘Q 完全退出 DeepSeek Harness，重新打开后再试。',
      rootMismatch: 'Oracle 返回的文件夹与请求的不一致。请重新加载页面后再试。',
      cpuSample: '所有 CPU 的短时采样。选择刷新可重新测量。', cpuUnavailable: '无法测量 CPU 使用率。',
      duration: '{days} 天 {hours} 小时 {minutes} 分钟', unavailable: '—',
      requestFailed: '无法读取 Oracle 数据，请重试。',
      denied: '访问被拒绝，请检查 Harness 连接和权限。',
      badReply: 'Oracle 返回的响应无效或过大。', readError: 'Oracle 未能完成请求。',
      rootPath: '远程文件夹路径', openFolder: '打开文件夹', homeFolder: '主目录',
      rootHelp: '请输入 Oracle 上的绝对路径，例如 /var/www。受 SSH 权限限制，并会过滤隐藏或敏感项目。',
      loadFolder: '加载文件夹', retryFolder: '重新加载 {folder}',
      previewHelp: '仅支持预览指定格式的文本文件。',
      rootInvalid: '请输入不含 . 或 .. 的绝对文件夹路径。',
      explorer: '文件资源管理器', resetTree: '刷新目录树', empty: '没有可见的文件或文件夹。',
      more: '加载更多', retry: '重试', folderLimit: '已达到文件夹限制。请打开更具体的起始文件夹。',
      pageLimit: '此文件夹仅显示前 {count} 个已列出的项目。',
      loading: '正在加载…', preview: '文本预览', close: '关闭预览',
      chooseFile: '请在文件资源管理器中选择要预览的文件。', fileDetails: '{size} · 修改于 {date}',
      clipped: '预览已截断。文件大小：{size}。', emptyFile: '没有可显示的文本。',
      chatPending: '正在打开 Oracle 对话…', chatFailed: 'Oracle 对话无法打开。请重试。',
      reconnect: '重新连接', newChat: '新对话',
      chatStale: 'Oracle 的后台服务版本低于此页面。请按 ⌘Q 完全退出 DeepSeek Harness，重新打开后再试。',
    };

    const styles = `
      .oracle-dsh { box-sizing:border-box; height:100%; min-height:0; display:flex; flex-direction:column;
        overflow:hidden; padding:28px clamp(20px,4vw,48px) 40px;
        color:var(--dsw-alias-label-primary); }
      html[data-platform='darwin'] .oracle-dsh { padding-top:calc(28px + var(--dsh-frame-top-clearance,0px)); }
      .oracle-dsh-body { container-type:inline-size; flex:1 1 auto; width:100%; min-height:0; max-width:960px; margin:0 auto;
        display:flex; flex-direction:column; gap:16px; }
      .oracle-dsh h1 { font-size:24px; margin:0; }
      .oracle-dsh h2 { font-size:16px; margin:0; }
      .oracle-dsh-sub { margin:6px 0 0; color:var(--dsw-alias-label-secondary); }
      .oracle-dsh-line { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
      .oracle-dsh-end { margin-inline-start:auto; }
      .oracle-dsh-tabs { display:flex; flex-wrap:wrap; gap:4px; border-bottom:1px solid var(--dsw-alias-border-l2); }
      .oracle-dsh-btn { appearance:none; border:1px solid var(--dsw-alias-border-l2); border-radius:8px;
        min-height:32px; padding:4px 10px; background:var(--dsw-alias-card-fill); color:inherit;
        font:inherit; cursor:pointer; }
      .oracle-dsh-btn:disabled { cursor:default; opacity:.58; }
      .oracle-dsh-btn:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px; }
      .oracle-dsh-tab { background:transparent; border-color:transparent; border-bottom-width:2px; border-radius:6px 6px 0 0; }
      .oracle-dsh-tab[aria-selected='true'] { border-bottom-color:var(--dsw-alias-state-business-primary); font-weight:600; }
      .oracle-dsh-pane[hidden] { display:none; }
      .oracle-dsh-pane { flex:1 1 auto; min-width:0; min-height:0; display:flex; flex-direction:column; gap:12px; }
      .oracle-dsh-body > header, .oracle-dsh-body > .oracle-dsh-tabs { flex:none; }
      .oracle-dsh-scroll { overflow:auto; padding-block-end:4px; }
      /* The embedded Conversation fills a definite-height box and scrolls itself. */
      .oracle-dsh-pane-chat { overflow:hidden; }
      .oracle-dsh-pane-files { overflow:hidden; }
      .oracle-dsh-chat-bar { flex:none; display:flex; align-items:center; justify-content:flex-end; gap:8px; }
      /* Mirrors the shipped embedded-chat wrapper: the Conversation shell expects
         a definite-height flex parent and owns its own scrolling. */
      .oracle-dsh-chat-host { display:flex; flex:1 1 auto; width:100%; min-width:0; min-height:0; }
      .oracle-dsh-muted { color:var(--dsw-alias-label-secondary); }
      .oracle-dsh-alert { border-inline-start:2px solid var(--dsw-alias-state-error-primary); padding-inline-start:10px; overflow-wrap:anywhere; }
      .oracle-dsh-card { border:1px solid var(--dsw-alias-border-l2); border-radius:12px; background:var(--dsw-alias-card-fill); padding:12px 14px; }
      .oracle-dsh-metrics { margin:0; display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr)); gap:8px; }
      .oracle-dsh-metrics dd { margin:5px 0 0; overflow-wrap:anywhere; }
      .oracle-dsh-path { margin:0; overflow-wrap:anywhere; }
      .oracle-dsh-charts { display:grid; gap:10px; grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr)); }
      .oracle-dsh-chart { display:grid; align-content:start; gap:8px; }
      .oracle-dsh-chart p { margin:0; }
      .oracle-dsh-chart-row { display:flex; gap:12px; justify-content:space-between; align-items:baseline; font-variant-numeric:tabular-nums; }
      .oracle-dsh-bar { display:block; height:8px; overflow:hidden; border-radius:100px; background:var(--dsw-alias-border-l2); }
      .oracle-dsh-bar span { display:block; height:100%; border-radius:inherit; box-shadow:inset 0 0 0 1px var(--dsw-alias-label-secondary); background:var(--dsw-alias-state-business-primary); }
      .oracle-dsh-bar[data-color='success'] span { background:var(--dsw-alias-state-success-primary); }
      .oracle-dsh-bar[data-color='warn'] span { background:var(--dsw-alias-state-warn-primary); }
      .oracle-dsh-bar[data-color='error'] span { background:var(--dsw-alias-state-error-primary); }
      .oracle-dsh-root-form { display:grid; gap:6px; }
      .oracle-dsh-root-input { flex:1 1 170px; min-width:0; padding:6px 8px; font:inherit; color:inherit;
        border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-card-fill); }
      .oracle-dsh-root-input:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:2px; }
      .oracle-dsh-explore { display:grid; align-items:stretch; gap:10px; flex:1 1 auto; min-height:0;
        grid-template-columns:minmax(185px, .65fr) minmax(0, 1.35fr); }
      .oracle-dsh-explore > section { display:flex; flex-direction:column; gap:8px; min-width:0; min-height:0; }
      .oracle-dsh-folder-scroll { overflow:auto; flex:1 1 auto; min-height:0; padding:2px 4px; }
      .oracle-dsh-branches { list-style:none; margin:0; padding-block:0; padding-inline:8px 0; border-inline-start:1px solid var(--dsw-alias-border-l2); }
      .oracle-dsh-deep-branch { padding-inline-start:2px; border-inline-start:0; }
      .oracle-dsh-tree-row { display:flex; align-items:center; gap:6px; width:100%; min-height:29px; padding:3px 4px; box-sizing:border-box;
        border:1px solid transparent; border-radius:5px; background:transparent; color:inherit; font:inherit; text-align:start; cursor:pointer; }
      .oracle-dsh-tree-row:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary); outline-offset:-2px; }
      .oracle-dsh-tree-row[aria-pressed='true'] { background:var(--dsw-alias-card-fill-hover); border-color:var(--dsw-alias-border-l2); font-weight:600; }
      .oracle-dsh-tree-row[data-hidden='true'] .oracle-dsh-tree-name { opacity:.72; }
      .oracle-dsh-tree-name { min-width:0; overflow-wrap:anywhere; white-space:pre-wrap; }
      .oracle-dsh-tree-glyph { display:inline-flex; flex:none; align-items:center; gap:3px; }
      .oracle-dsh-tree-chevron { inline-size:10px; }
      .oracle-dsh-tree-glyph[data-kind='directory'] { color:var(--dsw-alias-state-business-primary); }
      .oracle-dsh-tree-glyph[data-kind='file'] { color:var(--dsw-alias-label-secondary); }
      .oracle-dsh-tree-status { padding:4px; }
      .oracle-dsh-preview { flex:1 1 auto; min-height:0; overflow:auto; white-space:pre; tab-size:4; margin:0; padding:10px;
        border:1px solid var(--dsw-alias-border-l2); border-radius:8px; }
      @media (hover:hover) { .oracle-dsh-tree-row:hover { background:var(--dsw-alias-card-fill-hover); } }
      @container (max-width:520px) { .oracle-dsh-explore { grid-template-columns:minmax(0, 1fr); } .oracle-dsh-folder-scroll { max-height:32vh; } }
      @media (hover:hover) { .oracle-dsh-btn:not(:disabled):hover { background:var(--dsw-alias-card-fill-hover); } }
    `;

    function Icon() {
      return h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true },
        h('rect', { x: 3, y: 4, width: 18, height: 7, rx: 2 }),
        h('rect', { x: 3, y: 13, width: 18, height: 7, rx: 2 }),
        h('path', { d: 'M6.5 7.5H8m-1.5 9H8m2-9h7.5m-7.5 9h7.5', strokeLinecap: 'round' }));
    }

    const initialRead = { busy: false, value: null, error: null, loadedAt: null, key: null };
    const queryKey = (query = {}) => JSON.stringify(query);
    function responseError(key, detail) { return { key, detail }; }
    async function readJson(response) {
      if (!response.body) throw responseError('badReply');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = '', bytes = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > RESPONSE_LIMIT) throw responseError('badReply');
          text += decoder.decode(value, { stream: true });
        }
        try { return JSON.parse(text + decoder.decode()); }
        catch { throw responseError('badReply'); }
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }

    async function readSnapshot(snapshot, query, signal) {
      const params = new URLSearchParams({ snapshot });
      for (const [key, value] of Object.entries(query)) {
        if (typeof value === 'string') params.set(key, value);
      }
      const response = await fetch(`${READ_URL}?${params}`, {
        method: 'GET', credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
        cache: 'no-store', headers: HEADERS, signal,
      });
      if (response.status === 401 || response.status === 403) {
        void response.body?.cancel().catch(() => {});
        throw responseError('denied');
      }
      // An older Host streams NDJSON here; say so instead of waiting on it.
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
        void response.body?.cancel().catch(() => {});
        throw responseError('chatStale');
      }
      const body = await readJson(response);
      if (body?.ok === false) {
        const detail = typeof body.error === 'string' ? body.error : body.error?.message;
        throw responseError('readError', typeof detail === 'string' ? detail.slice(0, 300) : undefined);
      }
      if (!response.ok || body?.ok !== true || !body.value || typeof body.value !== 'object') {
        throw responseError('badReply');
      }
      const value = body.value;
      if (snapshot === 'list' || snapshot === 'preview') {
        // A missing field means an older Host generation is still running; a
        // different one means the reply belongs to another folder.
        if (typeof value.browseRoot !== 'string') throw responseError('rootStale');
        if (value.browseRoot !== query.root) throw responseError('rootMismatch');
      }
      if (snapshot === 'list' && (typeof value.path !== 'string' || !Array.isArray(value.entries))) {
        throw responseError('badReply');
      }
      if (snapshot === 'preview') {
        if (typeof value.path !== 'string' || typeof value.text !== 'string') throw responseError('badReply');
        return { ...value, text: value.text.slice(0, PREVIEW_LIMIT), truncated: value.truncated || value.text.length > PREVIEW_LIMIT };
      }
      return value;
    }

    // One in-flight request per resource. Ignore settlements from aborted or superseded requests.
    function useRead(snapshot) {
      const [state, set] = useState(initialRead);
      const current = useRef(null);
      const cancel = useCallback(() => { current.current?.abort(); current.current = null; }, []);
      const pause = useCallback(() => {
        cancel();
        set(prior => prior.busy ? { ...prior, busy: false } : prior);
      }, [cancel]);
      useEffect(() => cancel, [cancel]);
      const load = useCallback((query = {}, keep = false) => {
        cancel();
        const request = new AbortController();
        const key = queryKey(query);
        current.current = request;
        set(prior => ({ ...(keep ? prior : initialRead), busy: true, error: null }));
        void readSnapshot(snapshot, query, request.signal).then(value => {
          if (current.current !== request || request.signal.aborted) return;
          current.current = null;
          set({ busy: false, value, error: null, loadedAt: new Date(), key });
        }, error => {
          if (current.current !== request || request.signal.aborted) return;
          current.current = null;
          set(prior => ({ ...prior, busy: false, key, error: error?.key ? error : responseError('requestFailed') }));
        });
      }, [snapshot, cancel]);
      return { ...state, load, pause };
    }

    function button(label, onClick, props = {}) {
      return h('button', { type: 'button', className: 'oracle-dsh-btn', onClick, ...props }, label);
    }
    function feedback(t, state, refreshing = false) {
      return h(Fragment, null,
        state.busy && h('div', { role: 'status', className: 'oracle-dsh-muted' }, t(refreshing ? 'refreshing' : 'loading')),
        state.error && h('div', { role: 'alert', className: 'oracle-dsh-alert' },
          t(state.error.key), state.error.detail ? h('div', null, state.error.detail) : null));
    }
    function formatBytes(value, t, locale) {
      if (!Number.isFinite(value) || value < 0) return t('unavailable');
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
      let index = 0;
      while (value >= 1024 && index < units.length - 1) { value /= 1024; ++index; }
      return `${new Intl.NumberFormat(locale, { maximumFractionDigits: index ? 1 : 0 }).format(value)} ${units[index]}`;
    }
    function formatDate(value, t, locale) {
      if (typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Date)) return t('unavailable');
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? t('unavailable') : new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium', timeStyle: 'short',
      }).format(date);
    }

    function ChartBar({ ratio, color }) {
      return h('span', { className: 'oracle-dsh-bar', 'aria-hidden': true, 'data-color': color },
        h('span', { style: { width: `${Math.min(1, Math.max(0, ratio)) * 100}%` } }));
    }

    function CapacityChart({ title, data, t, locale }) {
      const { totalBytes, availableBytes } = data ?? {};
      const valid = Number.isFinite(totalBytes) && totalBytes > 0
        && Number.isFinite(availableBytes) && availableBytes >= 0 && availableBytes <= totalBytes;
      const used = valid ? (totalBytes - availableBytes) / totalBytes : 0;
      const color = used >= .9 ? 'error' : used >= .75 ? 'warn' : 'success';
      return h('section', { className: 'oracle-dsh-card oracle-dsh-chart' },
        h('h2', null, title),
        valid ? h(Fragment, null,
          h('p', { className: 'oracle-dsh-chart-row' },
            h('span', null, t('usage', { percent: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(used) })),
            color !== 'success' && h('span', null, t(color === 'error' ? 'usageCritical' : 'usageWarn'))),
          h(ChartBar, { ratio: used, color }),
          h('p', { className: 'oracle-dsh-muted' }, t('capacity', {
            total: formatBytes(totalBytes, t, locale), available: formatBytes(availableBytes, t, locale),
          }))) : h('p', { className: 'oracle-dsh-muted' }, t('unavailable')));
    }

    function CpuChart({ value, t, locale }) {
      const percent = value.cpuUsagePercent;
      const valid = Number.isFinite(percent) && percent >= 0 && percent <= 100;
      const ratio = valid ? percent / 100 : 0;
      return h('section', { className: 'oracle-dsh-card oracle-dsh-chart' },
        h('h2', null, t('cpuUsage')),
        valid ? h(Fragment, null,
          h('p', null, t('usage', { percent: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(ratio) })),
          h(ChartBar, { ratio, color: 'business' }),
          h('p', { className: 'oracle-dsh-muted' }, t('cpuSample')))
          : h('p', { className: 'oracle-dsh-muted' }, t('cpuUnavailable')));
    }

    function Overview({ t, locale, active }) {
      const overview = useRead('overview');
      useEffect(() => {
        if (!active) { overview.pause(); return; }
        // Re-entering can finish an interrupted initial load, not refresh a settled snapshot.
        if (overview.key === null) overview.load();
      }, [active, overview.key, overview.load, overview.pause]);
      const value = overview.value;
      const minutes = Number.isFinite(value?.uptimeSeconds) && value.uptimeSeconds >= 0 ? Math.floor(value.uptimeSeconds / 60) : null;
      const uptime = minutes === null ? null : t('duration', { days: Math.floor(minutes / 1440), hours: Math.floor(minutes / 60) % 24, minutes: minutes % 60 });
      const metrics = value ? [
        ['host', typeof value.hostname === 'string' && value.hostname],
        ['platform', typeof value.platform === 'string' && value.platform],
        ['uptime', uptime],
        ['cpu', Number.isFinite(value.cpuCount) ? new Intl.NumberFormat(locale).format(value.cpuCount) : null],
        ['scope', typeof value.scope === 'string' && value.scope],
      ] : [];
      return h(Fragment, null,
        h('div', { className: 'oracle-dsh-line' }, h('h2', null, t('overview')),
          overview.loadedAt && h('span', { className: 'oracle-dsh-muted' }, t('updated', { time: formatDate(overview.loadedAt, t, locale) })),
          button(t('refresh'), () => overview.load({}, true), { disabled: overview.busy, className: 'oracle-dsh-btn oracle-dsh-end' })),
        feedback(t, overview, !!value),
        value && h('div', { className: 'oracle-dsh-charts' },
          h(CpuChart, { value, t, locale }),
          h(CapacityChart, { title: t('memory'), data: value.memory, t, locale }),
          h(CapacityChart, { title: t('disk'), data: value.disk, t, locale })),
        metrics.length ? h('dl', { className: 'oracle-dsh-metrics' }, metrics.map(([name, content]) =>
          h('div', { className: 'oracle-dsh-card', key: name }, h('dt', { className: 'oracle-dsh-muted' }, t(name)), h('dd', null, content || t('unavailable'))))) : null);
    }

    function normalizeRoot(input) {
      const path = input.trim().replace(/\/+$/, '') || (input.trim() === '/' ? '/' : '');
      if (path === '/') return path;
      if (!path.startsWith('/') || new TextEncoder().encode(path).length > 2048) return null;
      return path.slice(1).split('/').every(validName) ? path : null;
    }

    function validName(name) {
      return typeof name === 'string' && name.length > 0 && name !== '.' && name !== '..'
        && !/[\\/\p{Cc}\p{Cf}\p{Cs}]/u.test(name);
    }

    function TreeGlyph({ directory, expanded }) {
      return h('span', { className: 'oracle-dsh-tree-glyph', 'aria-hidden': true, 'data-kind': directory ? 'directory' : 'file' },
        h('svg', { width: 10, height: 10, viewBox: '0 0 12 12', className: 'oracle-dsh-tree-chevron' },
          directory && h('path', { d: expanded ? 'M2 4l4 4 4-4' : 'M4 2l4 4-4 4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 })),
        h('svg', { width: 15, height: 15, viewBox: '0 0 18 18', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' },
          h('path', { d: directory ? 'M2 5h5l2 2h7v7H2z' : 'M4 2h6l4 4v10H4z M10 2v5h4' })));
    }

    const initialFolder = { entries: [], next: null, seen: [], pages: 0, busy: false, error: null, limited: false };
    function useFolders(root, active, isExpanded) {
      const [folders, setFolders] = useState(() => new Map());
      const controllers = useRef(new Map());
      const abortAll = useCallback(() => {
        for (const request of controllers.current.values()) request.abort();
        controllers.current.clear();
      }, []);
      useEffect(() => abortAll, [abortAll]);
      useEffect(() => {
        if (active) return;
        abortAll();
        setFolders(previous => {
          if (![...previous.values()].some(node => node.busy)) return previous;
          return new Map([...previous].map(([path, node]) => [path, node.busy ? { ...node, busy: false } : node]));
        });
      }, [active, abortAll]);
      function update(path, reduce) {
        setFolders(previous => {
          const next = new Map(previous);
          next.set(path, reduce(previous.get(path) ?? initialFolder));
          return next;
        });
      }
      function load(path, cursor = null) {
        if (!active || controllers.current.has(path)) return;
        if (controllers.current.size >= MAX_LIST_REQUESTS) {
          // A click never fans out; keep feedback local if several folders are opening.
          update(path, node => ({ ...node, error: responseError('requestBusy') }));
          return;
        }
        const request = new AbortController();
        controllers.current.set(path, request);
        update(path, node => ({ ...node, busy: true, error: null }));
        void readSnapshot('list', { root, path, cursor, limit: String(LIST_LIMIT) }, request.signal).then(value => {
          if (controllers.current.get(path) !== request || request.signal.aborted) return;
          controllers.current.delete(path);
          let follow;
          update(path, node => {
            const combined = new Map((cursor ? node.entries : []).map(entry => [entry.name, entry]));
            for (const entry of value.entries.slice(0, MAX_FOLDER_ENTRIES)) {
              if (validName(entry?.name) && (entry.type === 'file' || entry.type === 'directory')) combined.set(entry.name, entry);
            }
            const entries = [...combined.values()].slice(0, MAX_FOLDER_ENTRIES);
            const seen = cursor ? [...node.seen, cursor] : [];
            const pages = cursor ? node.pages + 1 : 1;
            const next = typeof value.nextCursor === 'string' && value.nextCursor.length <= 8192 && value.nextCursor.length > 0
              && !seen.includes(value.nextCursor) ? value.nextCursor : null;
            const limited = combined.size > MAX_FOLDER_ENTRIES
              || (!!next && (pages >= MAX_FOLDER_PAGES || entries.length >= MAX_FOLDER_ENTRIES));
            follow = limited || next === null ? null : next;
            return { entries, next: limited ? null : next, seen, pages, busy: false, error: null, limited };
          });
          // An open folder fills itself to the page ceiling; nothing to click.
          if (follow !== null && isExpanded(path)) queueMicrotask(() => load(path, follow));
        }, error => {
          if (controllers.current.get(path) !== request || request.signal.aborted) return;
          controllers.current.delete(path);
          update(path, node => ({ ...node, busy: false, error: error?.key ? error : responseError('requestFailed') }));
        });
      }
      return { folders, load };
    }

    const ROOT_PATH = '.';
    function FileWorkspace({ t, locale, active, root }) {
      const [expansion, setExpansion] = useState(() => new Map([[ROOT_PATH, true]]));
      const openFolders = useRef(expansion);
      const { folders, load } = useFolders(root, active, path => openFolders.current.get(path) === true);
      const [selected, setSelected] = useState(null);
      const [atFolderLimit, setAtFolderLimit] = useState(false);
      const preview = useRead('preview');
      const headings = useId();
      const heading = useRef(null);
      const opener = useRef(null);
      const rootNode = folders.get(ROOT_PATH);
      useEffect(() => {
        if (active && expansion.get(ROOT_PATH) && !rootNode?.pages && !rootNode?.error && !rootNode?.busy) load(ROOT_PATH);
      }, [active, expansion, rootNode]);
      const previewMatches = !!selected && preview.key === queryKey({ root, path: selected.path });
      const shownPreview = previewMatches ? preview.value : null;
      const previewStatus = { ...preview, error: previewMatches ? preview.error : null };
      useEffect(() => {
        if (!active) { preview.pause(); return; }
        if (selected && preview.key !== queryKey({ root, path: selected.path })) preview.load({ root, path: selected.path });
      }, [active, root, selected, preview.load, preview.pause]);
      useEffect(() => {
        if (selected && opener.current) heading.current?.focus();
      }, [selected]);

      function toggle(path) {
        const expanded = !expansion.get(path);
        if (!expansion.has(path) && expansion.size >= MAX_FOLDERS) { setAtFolderLimit(true); return; }
        setExpansion(known => {
          const next = new Map(known).set(path, expanded);
          openFolders.current = next;
          return next;
        });
        const folder = folders.get(path);
        if (expanded && !folder?.pages && !folder?.busy) load(path);
      }
      function select(path, entry, buttonElement) {
        opener.current = buttonElement;
        setSelected({ path, entry });
        if (selected?.path === path) preview.load({ root, path });
      }
      function close() {
        preview.pause();
        setSelected(null);
        if (opener.current?.isConnected && opener.current.offsetParent !== null) opener.current.focus();
        else document.getElementById(`${headings}-explorer`)?.focus();
      }
      function folderRow(path, name, depth = 0) {
        const expanded = expansion.get(path) === true;
        const node = folders.get(path) ?? initialFolder;
        const children = expanded && node.entries.map(entry => {
          const child = path === ROOT_PATH ? entry.name : `${path}/${entry.name}`;
          if (entry.type === 'directory') return folderRow(child, entry.name, depth + 1);
          return h('li', { key: child }, button(h(Fragment, null,
            h(TreeGlyph, { directory: false }), h('bdi', { className: 'oracle-dsh-tree-name' }, entry.name)),
          event => select(child, entry, event.currentTarget), {
            className: 'oracle-dsh-tree-row', 'aria-pressed': selected?.path === child, 'data-hidden': entry.name.startsWith('.'),
          }));
        });
        const rowId = `${headings}-folder-${encodeURIComponent(path)}`;
        function requestPage(cursor, buttonElement) {
          if (document.activeElement === buttonElement) document.getElementById(rowId)?.focus();
          load(path, cursor);
        }
        const row = button(h(Fragment, null, h(TreeGlyph, { directory: true, expanded }),
          h('bdi', { className: 'oracle-dsh-tree-name' }, name)), () => toggle(path),
        { className: 'oracle-dsh-tree-row', 'aria-expanded': expanded, id: rowId });
        return h('li', { key: path }, row, expanded && h('ul', {
          className: `oracle-dsh-branches${depth >= 8 ? ' oracle-dsh-deep-branch' : ''}`,
        }, children,
        node.error || node.busy || !node.pages || node.next || node.limited || !node.entries.length
          ? h('li', { className: 'oracle-dsh-tree-status' },
            // Appending another page is loading, not refreshing.
            feedback(t, node, false),
            !node.busy && !node.error && node.pages > 0 && !node.entries.length && h('span', { className: 'oracle-dsh-muted' }, t('empty')),
            !node.busy && (node.error || !node.pages) && button(t(node.error ? 'retry' : 'loadFolder'),
              event => requestPage(node.next, event.currentTarget), { 'aria-label': node.error ? t('retryFolder', { folder: name }) : undefined }),
            node.limited && h('p', { className: 'oracle-dsh-muted' }, t('pageLimit', { count: node.entries.length }))) : null));
      }
      const absoluteFile = selected ? `${root === '/' ? '' : root}/${selected.path}` : '';
      return h('div', { className: 'oracle-dsh-explore' },
        h('section', { className: 'oracle-dsh-card', 'aria-labelledby': `${headings}-explorer` },
          h('h2', { tabIndex: -1, id: `${headings}-explorer` }, t('explorer')),
          atFolderLimit && h('div', { role: 'status', className: 'oracle-dsh-muted' }, t('folderLimit')),
          h('div', { className: 'oracle-dsh-folder-scroll' },
            h('ul', { className: 'oracle-dsh-branches' }, folderRow(ROOT_PATH, root)))),
        h('section', { className: 'oracle-dsh-card', 'aria-labelledby': `${headings}-preview` },
          h('div', { className: 'oracle-dsh-line' }, h('h2', { id: `${headings}-preview`, tabIndex: -1, ref: heading }, t('preview')),
            selected && button(t('close'), close, { className: 'oracle-dsh-btn oracle-dsh-end' })),
          !selected ? h('p', { className: 'oracle-dsh-muted' }, `${t('chooseFile')} ${t('previewHelp')}`) : h(Fragment, null,
            h('p', { className: 'oracle-dsh-path oracle-dsh-muted' }, h('bdi', null, absoluteFile)),
            h('p', { className: 'oracle-dsh-path oracle-dsh-muted' }, t('fileDetails', {
              size: formatBytes(selected.entry.sizeBytes, t, locale), date: formatDate(selected.entry.modifiedAt, t, locale),
            })),
            feedback(t, previewStatus, !!shownPreview),
            previewStatus.error && button(t('retry'), () => preview.load({ root, path: selected.path })),
            shownPreview && h(Fragment, null,
              shownPreview.truncated && h('div', { role: 'status', className: 'oracle-dsh-muted' }, t('clipped', { size: formatBytes(shownPreview.sizeBytes, t, locale) })),
              shownPreview.text ? h('pre', { className: 'oracle-dsh-preview', tabIndex: 0, 'aria-label': t('preview') }, shownPreview.text) : t('emptyFile')))));
    }

    function Files({ t, locale, active }) {
      const [root, setRoot] = useState(DEFAULT_ROOT);
      const [draft, setDraft] = useState(DEFAULT_ROOT);
      const [invalid, setInvalid] = useState(false);
      const [revision, resetTree] = useState(0);
      const field = useId();
      function applyRoot(value) {
        const path = normalizeRoot(value);
        if (path === null) { setInvalid(true); return; }
        setInvalid(false);
        setDraft(path);
        if (path === root) resetTree(n => n + 1);
        else setRoot(path);
      }
      return h(Fragment, null,
        h('div', { className: 'oracle-dsh-line' }, h('h2', null, t('files')),
          button(t('resetTree'), () => resetTree(n => n + 1), { className: 'oracle-dsh-btn oracle-dsh-end' })),
        h('form', { className: 'oracle-dsh-root-form', onSubmit: event => { event.preventDefault(); applyRoot(draft); } },
          h('label', { htmlFor: field }, t('rootPath')),
          h('div', { className: 'oracle-dsh-line' },
            h('input', { id: field, className: 'oracle-dsh-root-input', type: 'text', value: draft, maxLength: 2048,
              'aria-invalid': invalid || undefined, 'aria-describedby': `${field}-help${invalid ? ` ${field}-invalid` : ''}`,
              autoComplete: 'off', autoCapitalize: 'off', spellCheck: false,
              onChange: event => { setDraft(event.target.value); setInvalid(false); } }),
            h('button', { type: 'submit', className: 'oracle-dsh-btn' }, t('openFolder')),
            button(t('homeFolder'), () => applyRoot(DEFAULT_ROOT))),
          h('span', { id: `${field}-help`, className: 'oracle-dsh-muted' }, t('rootHelp')),
          invalid && h('span', { id: `${field}-invalid`, role: 'alert', className: 'oracle-dsh-alert' }, t('rootInvalid'))),
        h(FileWorkspace, { key: `${root}:${revision}`, root, active, t, locale }));
    }

    // One request names the transcript; the answer is a small JSON object. No
    // stream is opened, so nothing has to be kept alive or reconnected.
    async function openChat(signal, wantsNew) {
      const response = await fetch(wantsNew ? `${CHAT_URL}?new=1` : CHAT_URL, {
        method: 'POST', credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
        cache: 'no-store', headers: HEADERS, signal,
      });
      if (response.status === 401 || response.status === 403) {
        void response.body?.cancel().catch(() => {});
        throw responseError('denied');
      }
      const body = await readJson(response);
      const valid = body && typeof body === 'object'
        && typeof body.sessionId === 'string' && body.sessionId.length > 0 && body.sessionId.length <= 256
        && !/\s/.test(body.sessionId);
      if (!response.ok || !valid) throw responseError('chatFailed');
      return { sessionId: body.sessionId, tools: body.tools };
    }

    function FixedChat({ renderSlot }) {
      return renderSlot('conversation.session', { view: 'chat' });
    }

    function OracleConversation({ renderFactorySlot }) {
      // The shell's blank hero expects workspace selection; this session is already bound.
      return renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false }, {
        slots: { views: FixedChat },
      });
    }

    function NativeChat({ t, sessionId, sessions, SessionProvider, renderSlot, onFailure }) {
      const [reference, setReference] = useState(null);
      useEffect(() => {
        const ownership = new AbortController();
        let acquired;
        try {
          acquired = sessions.retain(sessionId, { source: 'oraclePage', signal: ownership.signal });
          void acquired.ready.then(() => {
            if (!ownership.signal.aborted) setReference(acquired);
          }, () => { if (!ownership.signal.aborted) onFailure(); });
        } catch { onFailure(); }
        return () => { ownership.abort(); acquired?.release(); };
      }, [sessionId, sessions, onFailure]);
      if (!reference) return h('div', { role: 'status', className: 'oracle-dsh-muted' }, t('chatPending'));
      return h('div', { className: 'oracle-dsh-chat-host' },
        h(SessionProvider, { session: reference }, renderSlot(CHAT_SLOT, {})));
    }

    function renderChat({ t, sessions, onConnectionReset, SessionProvider, renderSlot }) {
      const [attempt, setAttempt] = useState(0);
      const [state, setState] = useState({});
      const request = useRef(null);
      const wantsNew = useRef(false);
      const previous = useRef(null);
      const retried = useRef(false);
      const startNew = useCallback(() => {
        wantsNew.current = true;
        retried.current = false;
        setState({});
        setAttempt(n => n + 1);
      }, []);
      const fail = useCallback((key = 'chatFailed') => {
        request.current?.abort();
        setState({ error: key });
      }, []);
      useEffect(() => {
        const control = new AbortController();
        request.current = control;
        const removeReset = onConnectionReset(() => fail());
        const deadline = setTimeout(() => fail(), 15000);
        const fresh = wantsNew.current;
        wantsNew.current = false;
        void openChat(control.signal, fresh).then(payload => {
          clearTimeout(deadline);
          if (control.signal.aborted) return;
          // An older Host ignores `new=1` and cannot advertise its tools.
          if (!Array.isArray(payload.tools) || (fresh && payload.sessionId === previous.current)) {
            fail('chatStale');
            return;
          }
          retried.current = false;
          previous.current = payload.sessionId;
          setState({ sessionId: payload.sessionId, tools: payload.tools });
        }, error => {
          clearTimeout(deadline);
          if (control.signal.aborted) return;
          // One silent retry covers a restarting app; after that, say so.
          if (!retried.current && error?.key !== 'denied' && error?.key !== 'chatStale') {
            retried.current = true;
            setTimeout(() => setAttempt(n => n + 1), 1500);
            return;
          }
          fail(error?.key);
        });
        return () => {
          clearTimeout(deadline);
          removeReset();
          control.abort();
          if (request.current === control) request.current = null;
        };
      }, [attempt, fail, onConnectionReset]);
      const toolbar = h('div', { className: 'oracle-dsh-chat-bar' },
        button(t('newChat'), startNew));
      let body;
      if (state.error) {
        body = h(Fragment, null,
          h('div', { role: 'alert', className: 'oracle-dsh-alert' }, t(state.error)),
          h('div', null, button(t('reconnect'), () => { retried.current = false; setState({}); setAttempt(n => n + 1); })));
      } else if (!state.sessionId) {
        body = h('div', { role: 'status', className: 'oracle-dsh-muted' }, t('chatPending'));
      } else {
        body = h(NativeChat, { t, key: state.sessionId, sessionId: state.sessionId, sessions, SessionProvider, renderSlot, onFailure: fail });
      }
      return h(Fragment, null, toolbar, body);
    }

    const tabs = ['overview', 'files', 'chat'];
    function OraclePage(props) {
      const { t } = props;
      const [tab, setTab] = useState('overview');
      // Visiting Chat once keeps it mounted: switching tabs must not tear down
      // the page lease while the assistant is still working.
      const [chatVisited, setChatVisited] = useState(false);
      useEffect(() => { if (tab === 'chat' && !chatVisited) setChatVisited(true); }, [tab, chatVisited]);
      const domId = useId();
      const tabRefs = useRef({});
      const locale = document.documentElement.lang || undefined;
      function onTabKey(event, key) {
        const index = tabs.indexOf(key);
        const target = ({ ArrowLeft: tabs[(index + tabs.length - 1) % tabs.length],
          ArrowRight: tabs[(index + 1) % tabs.length], Home: tabs[0], End: tabs[tabs.length - 1] })[event.key];
        if (!target) return;
        event.preventDefault();
        setTab(target);
        tabRefs.current[target]?.focus();
      }
      return h('div', { className: 'oracle-dsh' },
        h('style', null, styles),
        h('div', { className: 'oracle-dsh-body' },
          h('header', null, h('h1', null, t('title')), h('p', { className: 'oracle-dsh-sub' }, t('description'))),
          h('div', { className: 'oracle-dsh-tabs', role: 'tablist', 'aria-label': t('tabs') },
            tabs.map(key => button(t(key), () => setTab(key), {
              key, role: 'tab', id: `${domId}-tab-${key}`, 'aria-controls': `${domId}-pane-${key}`,
              'aria-selected': key === tab, tabIndex: key === tab ? 0 : -1,
              className: 'oracle-dsh-btn oracle-dsh-tab', ref: element => { tabRefs.current[key] = element; },
              onKeyDown: event => onTabKey(event, key),
            }))),
          tabs.map(key => h('div', {
            key, role: 'tabpanel', id: `${domId}-pane-${key}`, 'aria-labelledby': `${domId}-tab-${key}`,
            hidden: key !== tab,
            className: `oracle-dsh-pane ${key === 'chat' ? 'oracle-dsh-pane-chat' : key === 'files' ? 'oracle-dsh-pane-files' : 'oracle-dsh-scroll'}`,
          }, key === 'overview' ? h(Overview, { t, locale, active: tab === key })
            : key === 'files' ? h(Files, { t, locale, active: tab === key })
            : chatVisited ? h(renderChat, { ...props, active: tab === key }) : null))));
    }

    return {
      inject: ['slots', 'locale', 'sessions'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'oracle-dsh: dictionaries');
        const t = ctx.locale.bind(NS);
        const onConnectionReset = listener => ctx.on('connection/reset', listener);
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: ID, locale: NS,
          inject: () => ({ sessions: ctx.sessions, onConnectionReset }),
          children: { [CHAT_SLOT]: { kind: 'single', scope: 'session' } },
        }, OraclePage));
        ctx.slots.inject(CHAT_SLOT, () => ctx.slots.register({ name: CHAT_SLOT }, OracleConversation));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: ID, label: () => t('title'), locale: NS,
        }, Icon));
      },
    };
  },
});
