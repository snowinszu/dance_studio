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
const btnBackupTo = document.getElementById('btn-backup-to');
const btnOpenDir = document.getElementById('btn-open-dir');
const btnRestoreFile = document.getElementById('btn-restore-file');
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

/** 快照类型 → 徽章 class / 文案。 */
function badgeClass(kind) {
  if (kind === 'milestone') return 'badge-milestone';
  if (kind === 'pre-restore') return 'badge-prerestore';
  return 'badge-daily';
}
function badgeLabel(kind) {
  if (kind === 'milestone') return '迁移前';
  if (kind === 'pre-restore') return '恢复前';
  return '日常';
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
        el('span', { class: 'badge ' + badgeClass(s.kind) }, badgeLabel(s.kind)),
      ),
      el(
        'td',
        { class: 'op' },
        el(
          'button',
          {
            class: 'row-btn',
            type: 'button',
            onclick: () => void doRestore(() => shell.backup.restoreFromList(s.name)),
          },
          '恢复',
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
        el('th', { class: 'op' }, '操作'),
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

/** 备份类操作的公共外壳：按钮进行中态 + 统一的成功/失败处理。 */
async function runBackupAction(btn, busyText, action) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyText;
  try {
    await action();
  } catch (err) {
    // 用户在目录选择框点了取消：这是正常操作，不当作错误弹提示
    if (err.code !== 'IO_CANCELLED') toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function backupNow() {
  return runBackupAction(btnBackupNow, '备份中…', async () => {
    const meta = unwrap(await shell.backup.create());
    toast(`已备份到 ${meta.path}`);
    await loadList();
  });
}

function backupToFolder() {
  return runBackupAction(btnBackupTo, '备份中…', async () => {
    const { copiedTo } = unwrap(await shell.backup.createToFolder());
    toast(`已另存到 ${copiedTo}`);
    await loadList();
  });
}

function openDir() {
  return runBackupAction(btnOpenDir, '打开中…', async () => {
    unwrap(await shell.backup.reveal());
  });
}

/**
 * 恢复：确认在主进程弹原生框；用户确认后应用会重启，下面的 Promise 通常不会 resolve。
 * 触发期间禁用整页所有按钮并给出提示；只有取消 / 出错才把按钮放开。
 */
async function doRestore(trigger) {
  const allBtns = [
    btnBackupNow,
    btnBackupTo,
    btnOpenDir,
    btnRestoreFile,
    ...document.querySelectorAll('.row-btn'),
  ];
  for (const b of allBtns) b.disabled = true;
  toast('正在准备恢复，确认后应用会重启…');
  try {
    unwrap(await trigger());
    toast('正在重启…'); // 走到这说明进程还没退，稍等即重启
  } catch (err) {
    if (err.code !== 'IO_CANCELLED') toast(`恢复失败：${err.message}`);
    for (const b of allBtns) b.disabled = false;
  }
}

/* ───────────────────────── 启动 ───────────────────────── */

if (!shell || !shell.backup) {
  // preload 没跑起来 / 接口没暴露：给个明确错误态，别让页面看起来像在转圈
  showState('无法连接到应用后台，备份功能暂不可用。', true);
  for (const b of [btnBackupNow, btnBackupTo, btnOpenDir, btnRestoreFile]) b.disabled = true;
} else {
  btnBackupNow.addEventListener('click', () => void backupNow());
  btnBackupTo.addEventListener('click', () => void backupToFolder());
  btnOpenDir.addEventListener('click', () => void openDir());
  btnRestoreFile.addEventListener('click', () => void doRestore(() => shell.backup.restoreFromFile()));
  void loadList();
}
