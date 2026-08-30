/**
 * 考勤管理渲染器（单页 + hash 路由）。
 *
 * 整体类比：这一个页面是「前台考勤台」，靠地址栏 # 后面的门牌切换柜台：
 *   #/records   考勤流水（列表，默认）
 *   #/quick     快速打卡（单个学员）         —— #38 接入
 *   #/roster    批量点名（对花名册）          —— #39 接入
 *
 * 数据一律经 window.studioShell.attendance.*（preload 暴露的窄接口）向主进程要，
 * 本文件不碰任何 Node / 文件系统能力。权威校验在主进程，页面里只做即时提示。
 */

const shell = window.studioShell;
const view = document.getElementById('view');
const toastEl = document.getElementById('toast');
const navTabsEl = document.getElementById('nav-tabs');

/* ───────────────────────── 小工具 ───────────────────────── */

/** 轻量 DOM 构造：el('div', { class:'x', onclick:fn }, child, '文本') */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
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
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

/** 统一处理 IpcResult 信封：ok 返回 data，否则抛带 code / fields 的错误。 */
function unwrap(res) {
  if (res && res.ok) return res.data;
  const err = (res && res.error) || { code: 'DB_ERROR', message: '未知错误' };
  const e = new Error(err.message || '操作失败');
  e.code = err.code;
  e.fields = err.fields || null;
  throw e;
}

/** 本地今天 YYYY-MM-DD。 */
function todayYmd() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ───────────────────────── 顶部标签页 ───────────────────────── */

// 后续 issue 往这里加 { hash:'#/quick', label:'快速打卡' } / { hash:'#/roster', label:'批量点名' }
const TABS = [
  { hash: '#/records', label: '考勤流水' },
  { hash: '#/quick', label: '快速打卡' },
  { hash: '#/roster', label: '批量点名' },
];

function renderTabs(activeHash) {
  navTabsEl.replaceChildren(
    ...TABS.map((t) =>
      el('a', {
        class: 'nav-tab' + (t.hash === activeHash ? ' on' : ''),
        href: t.hash,
        role: 'tab',
        text: t.label,
      }),
    ),
  );
}

/* ───────────────────────── 考勤流水列表 ───────────────────────── */

const TYPE_OPTIONS = ['出勤', '请假', '缺勤', '补课', '试听', '调整'];
const PAGE_SIZE = 50;

const listState = { dateFrom: '', dateTo: '', keyword: '', type: '', offset: 0 };
let listRows = [];
let listTotal = 0;
let keywordDebounce = null;

function currentQuery() {
  return {
    dateFrom: listState.dateFrom || undefined,
    dateTo: listState.dateTo || undefined,
    keyword: listState.keyword.trim() || undefined,
    type: listState.type || undefined,
    limit: PAGE_SIZE,
    offset: listState.offset,
  };
}

async function fetchList({ append } = {}) {
  const data = unwrap(await shell.attendance.list(currentQuery()));
  listTotal = data.total;
  listRows = append ? listRows.concat(data.rows) : data.rows;
}

function deltaCell(delta) {
  if (delta === 0) return el('span', { class: 'cell-delta', text: '0' });
  const sign = delta < 0 ? 'minus' : 'plus';
  const txt = delta > 0 ? `+${delta}` : String(delta);
  return el('span', { class: `cell-delta ${sign}`, text: txt });
}

function recordRow(r) {
  return el(
    'tr',
    { dataset: { id: String(r.id) } },
    el('td', { text: r.attendDate }),
    el('td', { text: r.attendTime || '—' }),
    el(
      'td',
      {},
      el('div', { class: 'cell-student', text: r.studentName || `#${r.studentId}` }),
      el('div', { class: 'cell-phone', text: r.studentPhone || '' }),
    ),
    el('td', { text: r.className || '—' }),
    el('td', { text: r.teacher || '—' }),
    el(
      'td',
      {},
      el('span', { class: 'type-pill', dataset: { type: r.type } }, el('span', { class: 'dot' }), r.type),
    ),
    el('td', {}, deltaCell(r.lessonsDelta)),
    el('td', { text: r.operator || '—' }),
    el('td', { class: 'cell-note', text: r.reason || r.note || '' }),
  );
}

function hasActiveFilter() {
  return (
    listState.dateFrom !== '' ||
    listState.dateTo !== '' ||
    listState.keyword.trim() !== '' ||
    listState.type !== ''
  );
}

function renderListInto(container) {
  const dateFrom = el('input', {
    class: 'toolbar-date',
    type: 'date',
    value: listState.dateFrom,
    'aria-label': '起始日期',
    onchange: (e) => {
      listState.dateFrom = e.target.value;
      listState.offset = 0;
      reloadList();
    },
  });
  const dateTo = el('input', {
    class: 'toolbar-date',
    type: 'date',
    value: listState.dateTo,
    'aria-label': '结束日期',
    onchange: (e) => {
      listState.dateTo = e.target.value;
      listState.offset = 0;
      reloadList();
    },
  });
  const search = el('input', {
    class: 'toolbar-search',
    type: 'search',
    placeholder: '按学员姓名或手机号筛选',
    value: listState.keyword,
    oninput: (e) => {
      listState.keyword = e.target.value;
      listState.offset = 0;
      clearTimeout(keywordDebounce);
      keywordDebounce = setTimeout(reloadList, 240);
    },
  });
  const typeSel = el(
    'select',
    {
      class: 'toolbar-select',
      'aria-label': '类型',
      onchange: (e) => {
        listState.type = e.target.value;
        listState.offset = 0;
        reloadList();
      },
    },
    el('option', { value: '', text: '全部类型' }),
    ...TYPE_OPTIONS.map((t) =>
      el('option', { value: t, text: t, selected: listState.type === t || undefined }),
    ),
  );

  const count = el('span', { class: 'result-count', text: `共 ${listTotal} 条` });

  const toolbar = el(
    'div',
    { class: 'toolbar' },
    el('span', { class: 'toolbar-label', text: '日期' }),
    dateFrom,
    el('span', { class: 'toolbar-label', text: '至' }),
    dateTo,
    search,
    typeSel,
    count,
  );

  container.replaceChildren(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', { class: 'page-title', text: '考勤流水' }),
        el('p', { class: 'page-sub', text: '每一次打卡 / 请假 / 缺勤 / 课时调整都在这里留痕' }),
      ),
    ),
    toolbar,
  );

  if (listRows.length === 0) {
    container.appendChild(
      el(
        'div',
        { class: 'empty' },
        el('strong', { text: hasActiveFilter() ? '没有匹配的记录' : '还没有考勤记录' }),
        hasActiveFilter() ? '换个筛选条件试试' : '去「快速打卡」或「批量点名」开始记录考勤',
      ),
    );
    return;
  }

  const body = el('tbody', {}, ...listRows.map(recordRow));
  const table = el(
    'table',
    { class: 'records' },
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        ...['日期', '时间', '学员', '课程', '老师', '类型', '课时增减', '经办人', '备注'].map((h) =>
          el('th', { text: h }),
        ),
      ),
    ),
    body,
  );
  container.appendChild(el('div', { class: 'table-wrap' }, table));

  if (listRows.length < listTotal) {
    container.appendChild(
      el(
        'div',
        { class: 'load-more' },
        el('button', {
          class: 'btn btn-sm',
          text: `加载更多（已显示 ${listRows.length} / ${listTotal}）`,
          onclick: async () => {
            listState.offset += PAGE_SIZE;
            try {
              await fetchList({ append: true });
              renderListInto(container);
            } catch (err) {
              toast(err.message);
            }
          },
        }),
      ),
    );
  }
}

async function reloadList() {
  try {
    await fetchList({});
    renderListInto(view);
  } catch (err) {
    toast(err.message);
  }
}

async function renderRecords() {
  renderTabs('#/records');
  view.replaceChildren(el('div', { class: 'empty', text: '加载中…' }));
  await reloadList();
}

/* ───────────────────────── 占位视图（后续 issue 替换）───────────────────────── */

function renderComingSoon(hash, label) {
  renderTabs(hash);
  view.replaceChildren(
    el(
      'div',
      { class: 'empty' },
      el('strong', { text: `${label}即将上线` }),
      '该视图将在后续版本接入。',
    ),
  );
}

/* ───────────────────────── 路由 ───────────────────────── */

function route() {
  const hash = window.location.hash || '#/records';
  if (hash.startsWith('#/quick')) return renderComingSoon('#/quick', '快速打卡');
  if (hash.startsWith('#/roster')) return renderComingSoon('#/roster', '批量点名');
  return renderRecords();
}

window.addEventListener('hashchange', route);
route();

// 供后续 issue / E2E 复用的极少量导出（挂到 window，避免打包器）
window.__attendance = { todayYmd, toast };
