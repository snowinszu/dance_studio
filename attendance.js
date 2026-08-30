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

/* ───────────────────────── 确认模态 ───────────────────────── */

/**
 * 弹一个确认框，返回 Promise<boolean>。
 * 用于「余额不足 / 重复打卡」这类需要用户点头才强制的场景。
 */
function confirmModal({ title, body, confirmLabel = '确定', danger = false }) {
  return new Promise((resolve) => {
    const close = (val) => {
      mask.remove();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
    };
    const confirmBtn = el('button', {
      class: 'btn ' + (danger ? 'btn-primary' : 'btn-primary'),
      text: confirmLabel,
      onclick: () => close(true),
    });
    const mask = el(
      'div',
      {
        class: 'modal-mask',
        onclick: (e) => {
          if (e.target === mask) close(false);
        },
      },
      el(
        'div',
        { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        el('h3', { text: title }),
        ...(Array.isArray(body) ? body : [el('p', { text: body })]),
        el(
          'div',
          { class: 'form-actions' },
          el('button', { class: 'btn', text: '取消', onclick: () => close(false) }),
          confirmBtn,
        ),
      ),
    );
    document.body.appendChild(mask);
    document.addEventListener('keydown', onKey);
    confirmBtn.focus();
  });
}

/* ───────────────────────── 预警判断 ───────────────────────── */

const LOW_BALANCE_AT = 3;

/** 卡到期日已过（含今天之前）。 */
function cardExpired(cardExpireDate) {
  if (!cardExpireDate) return false;
  return String(cardExpireDate) < todayYmd();
}

/**
 * 给某学员打卡后的预警文案（数组，可能为空）。
 * balanceAfter 传「本次写入后的预计余额」；null 表示未知（不判低余额）。
 */
function warningsFor(candidate, balanceAfter) {
  const out = [];
  if (cardExpired(candidate.cardExpireDate)) {
    out.push(`会员卡已于 ${candidate.cardExpireDate} 到期，请提醒续费`);
  }
  if (balanceAfter != null && balanceAfter <= LOW_BALANCE_AT) {
    out.push(`${candidate.name} 打卡后剩 ${balanceAfter} 节，请提醒续费`);
  }
  return out;
}

function warnBanner(lines) {
  if (lines.length === 0) return null;
  return el(
    'div',
    { class: 'warn-banner' },
    el('span', { class: 'dot' }),
    el('span', { text: lines.join('；') }),
  );
}

/* ───────────────────────── 快速打卡（#/quick）───────────────────────── */

const EVENT_TYPES = ['出勤', '请假', '缺勤', '补课', '试听'];

const quickState = { keyword: '', picked: null, candidates: [], searching: false };
let quickSearchDebounce = null;

async function quickSearch() {
  const kw = quickState.keyword.trim();
  if (kw === '') {
    quickState.candidates = [];
    renderQuickInto(view);
    return;
  }
  quickState.searching = true;
  try {
    quickState.candidates = unwrap(await shell.attendance.rosterCandidates({ keyword: kw }));
  } catch (err) {
    toast(err.message);
    quickState.candidates = [];
  }
  quickState.searching = false;
  renderQuickInto(view);
}

function balPreview(candidate, type, lessons) {
  const base = candidate.remainingLessons == null ? 0 : Number(candidate.remainingLessons);
  if (type !== '出勤') return base;
  const n = Number(lessons) || 1;
  return base - n;
}

async function submitQuick({ force = false, allowDuplicate = false } = {}) {
  const p = quickState.picked;
  if (!p) return;
  const type = document.getElementById('q-type').value;
  const payload = {
    studentId: p.id,
    type,
    attendDate: document.getElementById('q-date').value || undefined,
    attendTime: document.getElementById('q-time').value || null,
    className: document.getElementById('q-class').value || null,
    teacher: document.getElementById('q-teacher').value || null,
    lessons: type === '出勤' ? Number(document.getElementById('q-lessons').value) || 1 : undefined,
    operator: document.getElementById('q-operator').value || null,
    note: document.getElementById('q-note').value || null,
    force,
    allowDuplicate,
  };
  try {
    const res = unwrap(await shell.attendance.quickCheckIn(payload));
    toast(`已记录 · ${p.name} 剩 ${res.remainingLessons} 节`);
    quickState.picked = null;
    quickState.keyword = '';
    quickState.candidates = [];
    listState.offset = 0;
    renderQuickInto(view);
  } catch (err) {
    if (err.code === 'INSUFFICIENT_LESSONS' && !force) {
      const ok = await confirmModal({
        title: '剩余课时不足',
        body: `${p.name} 当前剩余课时不足以扣这一笔。选择「仍然记录」将按欠课处理（余额记为负数）。`,
        confirmLabel: '仍然记录',
        danger: true,
      });
      if (ok) await submitQuick({ force: true, allowDuplicate });
      return;
    }
    if (err.code === 'DUPLICATE_ATTENDANCE' && !allowDuplicate) {
      const ok = await confirmModal({
        title: '疑似重复打卡',
        body: `${p.name} 在这一天的这节课已经有一条同类型记录了。仍要再记一条吗？`,
        confirmLabel: '仍然记录',
      });
      if (ok) await submitQuick({ force, allowDuplicate: true });
      return;
    }
    toast(err.message);
  }
}

function renderQuickInto(container) {
  const p = quickState.picked;

  const search = el('input', {
    class: 'toolbar-search',
    id: 'q-search',
    type: 'search',
    placeholder: '输入学员姓名或手机号',
    value: quickState.keyword,
    oninput: (e) => {
      quickState.keyword = e.target.value;
      quickState.picked = null;
      clearTimeout(quickSearchDebounce);
      quickSearchDebounce = setTimeout(quickSearch, 220);
    },
  });

  const candList = el(
    'div',
    { class: 'candidate-list' },
    ...(quickState.candidates.length === 0 && quickState.keyword.trim() !== '' && !quickState.searching
      ? [el('div', { class: 'field-hint', text: '没有匹配的学员' })]
      : quickState.candidates.map((c) => {
          const low = c.remainingLessons != null && Number(c.remainingLessons) <= LOW_BALANCE_AT;
          return el(
            'button',
            {
              class: 'candidate' + (p && p.id === c.id ? ' picked' : ''),
              type: 'button',
              onclick: () => {
                quickState.picked = c;
                renderQuickInto(container);
              },
            },
            el(
              'div',
              { class: 'c-main' },
              el('div', { class: 'c-name', text: c.name }),
              el('div', { class: 'c-sub', text: `${c.phone || '无手机号'} · ${c.status || ''}` }),
            ),
            el('span', {
              class: 'c-bal' + (low ? ' low' : ''),
              text: `剩 ${c.remainingLessons == null ? '—' : c.remainingLessons} 节`,
            }),
          );
        })),
  );

  container.replaceChildren(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', { class: 'page-title', text: '快速打卡' }),
        el('p', { class: 'page-sub', text: '搜一个学员，给他记一次考勤' }),
      ),
    ),
    el('div', { class: 'toolbar' }, search),
    candList,
  );

  if (!p) return;

  // 表单。类型切换不整段重渲染——只就地改「扣课时数」的可用性和预警条。
  const lessonsInput = el('input', {
    id: 'q-lessons',
    type: 'number',
    min: '1',
    step: '1',
    value: '1',
  });
  const lessonsHint = el('div', { class: 'field-hint', text: '私教课可填 2' });
  const bannerSlot = el('div');

  const refreshFor = (type) => {
    const isAttend = type === '出勤';
    lessonsInput.disabled = !isAttend;
    if (!isAttend) lessonsInput.value = '0';
    else if (lessonsInput.value === '0') lessonsInput.value = '1';
    lessonsHint.textContent = isAttend ? '私教课可填 2' : '非出勤不扣课时';
    const b = warnBanner(warningsFor(p, balPreview(p, type, Number(lessonsInput.value) || 1)));
    bannerSlot.replaceChildren(...(b ? [b] : []));
  };

  const typeSel = el(
    'select',
    {
      id: 'q-type',
      onchange: (e) => {
        quickState.formType = e.target.value;
        refreshFor(e.target.value);
      },
    },
    ...EVENT_TYPES.map((t) => el('option', { value: t, text: t })),
  );
  typeSel.value = quickState.formType || '出勤';
  lessonsInput.addEventListener('input', () => refreshFor(typeSel.value));

  const lessonsField = el(
    'div',
    { class: 'field' },
    el('label', { for: 'q-lessons', text: '扣课时数' }),
    lessonsInput,
    lessonsHint,
  );

  const form = el(
    'div',
    { class: 'form-group' },
    el('div', { class: 'group-title', text: `为「${p.name}」打卡` }),
    bannerSlot,
    el(
      'div',
      { class: 'field-grid' },
      el(
        'div',
        { class: 'field' },
        el('label', { for: 'q-date', text: '日期' }),
        el('input', { id: 'q-date', type: 'date', value: todayYmd() }),
      ),
      el(
        'div',
        { class: 'field' },
        el('label', { for: 'q-time', text: '时间' }),
        el('input', { id: 'q-time', type: 'time' }),
      ),
      el(
        'div',
        { class: 'field' },
        el('label', { for: 'q-type', text: '类型' }),
        typeSel,
      ),
      lessonsField,
      el(
        'div',
        { class: 'field' },
        el('label', { for: 'q-class', text: '课程名' }),
        el('input', { id: 'q-class', type: 'text', maxlength: '40', placeholder: '如：芭蕾基础' }),
      ),
      el(
        'div',
        { class: 'field' },
        el('label', { for: 'q-teacher', text: '老师' }),
        el('input', { id: 'q-teacher', type: 'text', maxlength: '20' }),
      ),
      el(
        'div',
        { class: 'field' },
        el('label', { for: 'q-operator', text: '经办人' }),
        el('input', { id: 'q-operator', type: 'text', maxlength: '20' }),
      ),
      el(
        'div',
        { class: 'field' },
        el('label', { for: 'q-note', text: '备注' }),
        el('input', { id: 'q-note', type: 'text', maxlength: '200' }),
      ),
    ),
    el(
      'div',
      { class: 'form-actions' },
      el('button', {
        class: 'btn',
        text: '取消',
        onclick: () => {
          quickState.picked = null;
          renderQuickInto(container);
        },
      }),
      el('button', { class: 'btn btn-primary', text: '确认打卡', onclick: () => submitQuick() }),
    ),
  );
  container.appendChild(form);
  refreshFor(typeSel.value);
}

function renderQuick() {
  renderTabs('#/quick');
  quickState.picked = null;
  quickState.formType = '出勤';
  renderQuickInto(view);
}

/* ───────────────────────── 批量点名（#/roster）───────────────────────── */

const rosterState = {
  danceType: '',
  keyword: '',
  candidates: [],
  danceTypeOptions: [],
  /** Map<studentId, { type, lessons }> */
  picks: new Map(),
  summary: null,
};
let rosterSearchDebounce = null;

async function rosterFetch({ withOptions } = {}) {
  const list = unwrap(
    await shell.attendance.rosterCandidates({
      danceType: rosterState.danceType || undefined,
      keyword: rosterState.keyword.trim() || undefined,
    }),
  );
  rosterState.candidates = list;
  if (withOptions) {
    const all = unwrap(await shell.attendance.rosterCandidates({}));
    rosterState.danceTypeOptions = [
      ...new Set(all.flatMap((c) => c.danceTypes || [])),
    ].sort((a, b) => a.localeCompare(b, 'zh'));
  }
}

function rosterCandidateRow(c) {
  const pick = rosterState.picks.get(c.id);
  const low = c.remainingLessons != null && Number(c.remainingLessons) <= LOW_BALANCE_AT;

  const check = el('input', {
    type: 'checkbox',
    checked: pick ? true : undefined,
    'aria-label': `勾选 ${c.name}`,
    onchange: (e) => {
      if (e.target.checked) rosterState.picks.set(c.id, { type: '出勤', lessons: 1 });
      else rosterState.picks.delete(c.id);
      paintRosterList();
    },
  });

  const left = el(
    'label',
    { class: 'candidate' + (pick ? ' picked' : ''), style: 'flex:1' },
    check,
    el(
      'div',
      { class: 'c-main' },
      el('div', { class: 'c-name', text: c.name }),
      el('div', {
        class: 'c-sub',
        text: `${c.phone || '无手机号'}${c.cardExpireDate ? ' · 卡到期 ' + c.cardExpireDate : ''}`,
      }),
    ),
    el('span', {
      class: 'c-bal' + (low ? ' low' : ''),
      text: `剩 ${c.remainingLessons == null ? '—' : c.remainingLessons} 节`,
    }),
  );

  if (!pick) return el('div', { class: 'roster-row', style: 'display:flex;gap:10px;align-items:center' }, left);

  const stateGroup = el(
    'div',
    { class: 'state-group' },
    ...EVENT_TYPES.map((t) =>
      el('button', {
        type: 'button',
        class: 'state-btn' + (pick.type === t ? ' on' : ''),
        text: t,
        onclick: () => {
          rosterState.picks.set(c.id, { type: t, lessons: pick.lessons });
          paintRosterList();
        },
      }),
    ),
  );

  const lessons = el('input', {
    type: 'number',
    min: '1',
    step: '1',
    value: String(pick.type === '出勤' ? pick.lessons : 0),
    disabled: pick.type !== '出勤' || undefined,
    style: 'width:64px;min-height:36px',
    'aria-label': `${c.name} 扣课时数`,
    onchange: (e) => {
      rosterState.picks.set(c.id, { type: pick.type, lessons: Number(e.target.value) || 1 });
    },
  });

  return el(
    'div',
    { class: 'roster-row', style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
    left,
    stateGroup,
    lessons,
  );
}

function paintRosterList() {
  const slot = document.getElementById('roster-list');
  if (!slot) return;
  const countPicked = rosterState.picks.size;
  slot.replaceChildren(
    el('div', { class: 'toolbar-label', text: `已勾选 ${countPicked} 人` }),
    ...(rosterState.candidates.length === 0
      ? [el('div', { class: 'field-hint', text: '没有匹配的学员' })]
      : rosterState.candidates.map(rosterCandidateRow)),
  );
}

async function submitRoster() {
  const entries = [];
  for (const c of rosterState.candidates) {
    const pick = rosterState.picks.get(c.id);
    if (!pick) continue;
    entries.push({
      studentId: c.id,
      type: pick.type,
      lessons: pick.type === '出勤' ? pick.lessons : undefined,
    });
  }
  // 也带上不在当前筛选结果里、但之前勾过的（理论上少见，稳妥起见）
  for (const [sid, pick] of rosterState.picks) {
    if (rosterState.candidates.some((c) => c.id === sid)) continue;
    entries.push({
      studentId: sid,
      type: pick.type,
      lessons: pick.type === '出勤' ? pick.lessons : undefined,
    });
  }
  if (entries.length === 0) {
    toast('请至少勾选一名学员');
    return;
  }

  const payload = {
    attendDate: document.getElementById('r-date').value || undefined,
    attendTime: document.getElementById('r-time').value || null,
    className: document.getElementById('r-class').value || null,
    teacher: document.getElementById('r-teacher').value || null,
    operator: document.getElementById('r-operator').value || null,
    entries,
  };
  try {
    const res = unwrap(await shell.attendance.batchCheckIn(payload));
    const nameOf = (sid) => {
      const c = rosterState.candidates.find((x) => x.id === sid);
      return c ? c.name : `#${sid}`;
    };
    rosterState.summary = {
      succeeded: res.succeeded,
      skipped: res.skipped,
      failures: res.rows.filter((r) => !r.ok).map((r) => `${nameOf(r.studentId)}：${r.reason}`),
    };
    rosterState.picks.clear();
    await rosterFetch({});
    renderRosterInto(view);
    toast(`点名完成 · 成功 ${res.succeeded}，跳过 ${res.skipped}`);
  } catch (err) {
    toast(err.message);
  }
}

function renderRosterInto(container) {
  const common = el(
    'div',
    { class: 'form-group' },
    el('div', { class: 'group-title', text: '这节课' }),
    el(
      'div',
      { class: 'field-grid' },
      el(
        'div',
        { class: 'field' },
        el('label', { for: 'r-date', text: '日期' }),
        el('input', { id: 'r-date', type: 'date', value: todayYmd() }),
      ),
      el(
        'div',
        { class: 'field' },
        el('label', { for: 'r-time', text: '时间' }),
        el('input', { id: 'r-time', type: 'time' }),
      ),
      el(
        'div',
        { class: 'field' },
        el('label', { for: 'r-class', text: '课程名' }),
        el('input', { id: 'r-class', type: 'text', maxlength: '40' }),
      ),
      el(
        'div',
        { class: 'field' },
        el('label', { for: 'r-teacher', text: '老师' }),
        el('input', { id: 'r-teacher', type: 'text', maxlength: '20' }),
      ),
      el(
        'div',
        { class: 'field' },
        el('label', { for: 'r-operator', text: '经办人' }),
        el('input', { id: 'r-operator', type: 'text', maxlength: '20' }),
      ),
    ),
  );

  const danceSel = el(
    'select',
    {
      class: 'toolbar-select',
      'aria-label': '舞种',
      onchange: async (e) => {
        rosterState.danceType = e.target.value;
        await rosterFetch({});
        paintRosterList();
      },
    },
    el('option', { value: '', text: '全部舞种' }),
    ...rosterState.danceTypeOptions.map((d) =>
      el('option', { value: d, text: d, selected: rosterState.danceType === d || undefined }),
    ),
  );
  const kw = el('input', {
    class: 'toolbar-search',
    type: 'search',
    placeholder: '姓名或手机号',
    value: rosterState.keyword,
    oninput: (e) => {
      rosterState.keyword = e.target.value;
      clearTimeout(rosterSearchDebounce);
      rosterSearchDebounce = setTimeout(async () => {
        await rosterFetch({});
        paintRosterList();
      }, 220);
    },
  });
  const allAttendBtn = el('button', {
    class: 'btn btn-sm',
    text: '全部设为出勤',
    onclick: () => {
      for (const c of rosterState.candidates) rosterState.picks.set(c.id, { type: '出勤', lessons: 1 });
      paintRosterList();
    },
  });

  const listSlot = el('div', { id: 'roster-list', class: 'candidate-list', style: 'max-height:none' });

  const summaryBox = rosterState.summary
    ? el(
        'div',
        { class: 'summary-box' },
        el('div', {
          class: 'sum-head',
          text: `上次点名：成功 ${rosterState.summary.succeeded}，跳过 ${rosterState.summary.skipped}`,
        }),
        rosterState.summary.failures.length > 0 &&
          el('ul', {}, ...rosterState.summary.failures.map((f) => el('li', { text: f }))),
      )
    : null;

  container.replaceChildren(
    ...[
      el(
        'div',
        { class: 'page-head' },
        el(
          'div',
          {},
          el('h1', { class: 'page-title', text: '批量点名' }),
          el('p', { class: 'page-sub', text: '填这节课的信息，对花名册逐个勾' }),
        ),
      ),
      summaryBox,
      common,
      el(
        'div',
        { class: 'toolbar' },
        el('span', { class: 'toolbar-label', text: '花名册' }),
        danceSel,
        kw,
        allAttendBtn,
      ),
      listSlot,
      el(
        'div',
        { class: 'form-actions' },
        el('button', { class: 'btn btn-primary', text: '提交点名', onclick: submitRoster }),
      ),
    ].filter(Boolean),
  );
  paintRosterList();
}

async function renderRoster() {
  renderTabs('#/roster');
  rosterState.picks.clear();
  rosterState.summary = null;
  rosterState.danceType = '';
  rosterState.keyword = '';
  view.replaceChildren(el('div', { class: 'empty', text: '加载中…' }));
  try {
    await rosterFetch({ withOptions: true });
    renderRosterInto(view);
  } catch (err) {
    toast(err.message);
    view.replaceChildren(el('div', { class: 'empty', text: '加载失败：' + err.message }));
  }
}

/* ───────────────────────── 路由 ───────────────────────── */

function route() {
  const hash = window.location.hash || '#/records';
  if (hash.startsWith('#/quick')) return renderQuick();
  if (hash.startsWith('#/roster')) return renderRoster();
  return renderRecords();
}

window.addEventListener('hashchange', route);
route();

// 供后续 issue / E2E 复用的极少量导出（挂到 window，避免打包器）
window.__attendance = { todayYmd, toast };
