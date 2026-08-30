/**
 * 设置页渲染器。
 *
 * 整体类比：这一页是「工具间」——目前只放了一件工具：数据备份。它做两件事——
 * 把备份目录里已有的快照列出来给你看，以及点一下「立即备份」现场再拍一张快照。
 * 恢复不在这一页做（见「数据备份与恢复」文档），这里只负责「拍」和「看」。
 *
 * 数据一律通过 window.studioShell.backup.*（preload 暴露的窄接口）向主进程要。
 * 渲染层不参与 TypeScript 构建，所以这里是手写 ES module。
 */

const shell = window.studioShell;
const listRegion = document.getElementById('backup-list-region');
const btnBackupNow = document.getElementById('btn-backup-now');
const toastEl = document.getElementById('toast');

/* ───────────────────────── 小工具 ───────────────────────── */

/** 轻量 DOM 构造：el('div', { class:'x' }, child, '文本')。 */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2800);
}

/** 统一处理 IpcResult 信封：ok 返回 data，否则抛带 code 的错误。 */
function unwrap(res) {
  if (res && res.ok) return res.data;
  const err = (res && res.error) || { code: 'DB_ERROR', message: '未知错误' };
  const e = new Error(err.message || '操作失败');
  e.code = err.code;
  throw e;
}

/** 字节数 → 人类可读，如 `2.4 MB` / `812 KB`。 */
function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let val = n / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i += 1;
  }
  return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** ISO 时间串 → 本地可读 `YYYY-MM-DD HH:mm`。 */
function fmtTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '—';
  const p = (x) => String(x).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

/* ───────────────────────── 渲染 ───────────────────────── */

function showState(text, isError) {
  listRegion.replaceChildren(
    el('div', { class: isError ? 'state state-error' : 'state' }, text),
  );
}

function renderList(snapshots) {
  if (!snapshots.length) {
    showState('暂无备份记录', false);
    return;
  }

  const rows = snapshots.map((s) =>
    el(
      'tr',
      {},
      el('td', {}, fmtTime(s.createdAt)),
      el('td', { class: 'num' }, fmtBytes(s.bytes)),
      el(
        'td',
        {},
        el(
          'span',
          { class: 'badge ' + (s.kind === 'milestone' ? 'badge-milestone' : 'badge-daily') },
          s.kind === 'milestone' ? '迁移前' : '日常',
        ),
      ),
    ),
  );

  const table = el(
    'table',
    { class: 'data-table' },
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', {}, '备份时间'),
        el('th', { class: 'num' }, '大小'),
        el('th', {}, '类型'),
      ),
    ),
    el('tbody', {}, ...rows),
  );

  listRegion.replaceChildren(el('div', { class: 'table-scroll' }, table));
}

async function loadList() {
  try {
    const snapshots = unwrap(await shell.backup.list());
    renderList(snapshots);
  } catch (err) {
    showState(`备份列表加载失败：${err.message}`, true);
  }
}

async function backupNow() {
  btnBackupNow.disabled = true;
  const label = btnBackupNow.textContent;
  btnBackupNow.textContent = '备份中…';
  try {
    const meta = unwrap(await shell.backup.create());
    toast(`已备份到 ${meta.path}`);
    await loadList();
  } catch (err) {
    toast(`备份失败：${err.message}`);
  } finally {
    btnBackupNow.disabled = false;
    btnBackupNow.textContent = label;
  }
}

/* ───────────────────────── 启动 ───────────────────────── */

if (!shell || !shell.backup) {
  // preload 没跑起来 / 接口没暴露：给个明确错误态，别让页面看起来像在转圈
  showState('无法连接到应用后台，备份功能暂不可用。', true);
  btnBackupNow.disabled = true;
} else {
  btnBackupNow.addEventListener('click', () => {
    void backupNow();
  });
  void loadList();
}
