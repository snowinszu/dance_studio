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

/** 与 course.js 的 WEEKDAY_LABELS 对齐：下标即 Date.getDay()（0=周日）。 */
const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 'YYYY-MM-DD' → '周x MM-DD'，本地时区解析，避免 UTC 偏移把日期读错一天。 */
function weekdayMmdd(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const p = (n) => String(n).padStart(2, '0');
  return `${WEEKDAY_LABELS[dt.getDay()]} ${p(m)}-${p(d)}`;
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
  const ops = el(
    'td',
    {},
    el(
      'div',
      { class: 'row-ops' },
      r.type !== '调整' &&
        el('button', {
          class: 'btn btn-sm',
          text: '更正',
          onclick: () => openCorrectModal(r),
        }),
      el('button', {
        class: 'btn btn-sm',
        text: '撤销',
        onclick: () => voidRecordFlow(r),
      }),
    ),
  );
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
    ops,
  );
}

/**
 * 「调整课时」模态：搜学员 → 填带符号增减数 + 必填原因 → 写一条 type='调整' 流水。
 */
function openAdjustModal() {
  const state = { keyword: '', picked: null, candidates: [], searching: false };
  let deb = null;

  const body = el('div');

  const doSearch = async () => {
    const kw = state.keyword.trim();
    if (!kw) {
      state.candidates = [];
      paint();
      return;
    }
    state.searching = true;
    try {
      state.candidates = unwrap(await shell.attendance.rosterCandidates({ keyword: kw }));
    } catch (err) {
      toast(err.message);
      state.candidates = [];
    }
    state.searching = false;
    paint();
  };

  const submit = async (force) => {
    const p = state.picked;
    if (!p) {
      toast('请先选择学员');
      return;
    }
    const payload = {
      studentId: p.id,
      delta: Number(document.getElementById('adj-delta').value),
      reason: document.getElementById('adj-reason').value,
      attendDate: document.getElementById('adj-date').value || undefined,
      operator: document.getElementById('adj-operator').value || null,
      note: document.getElementById('adj-note').value || null,
      force,
    };
    try {
      const res = unwrap(await shell.attendance.adjustLessons(payload));
      toast(`已调整 · ${p.name} 剩 ${res.remainingLessons} 节`);
      mask.remove();
      listState.offset = 0;
      await reloadList();
    } catch (err) {
      if (err.code === 'INSUFFICIENT_LESSONS' && !force) {
        const ok = await confirmModal({
          title: '课时会变负',
          body: '这次减扣会让该学员剩余课时低于 0。仍要保存吗？',
          confirmLabel: '仍然保存',
          danger: true,
        });
        if (ok) await submit(true);
        return;
      }
      toast(err.message); // INVALID_ADJUSTMENT / VALIDATION_FAILED 等
    }
  };

  function paint() {
    const search = el('input', {
      class: 'toolbar-search',
      type: 'search',
      placeholder: '学员姓名或手机号',
      value: state.keyword,
      oninput: (e) => {
        state.keyword = e.target.value;
        state.picked = null;
        // 中文等输入法组字期间跳过防抖重渲染，避免把带着组字状态的输入框整个换掉
        // （否则永远打不出汉字）；等 compositionend 组字完成再触发搜索。
        if (e.isComposing) return;
        clearTimeout(deb);
        deb = setTimeout(doSearch, 220);
      },
      oncompositionend: (e) => {
        state.keyword = e.target.value;
        state.picked = null;
        clearTimeout(deb);
        deb = setTimeout(doSearch, 220);
      },
    });
    const cands = el(
      'div',
      { class: 'candidate-list' },
      ...(state.candidates.length === 0 && state.keyword.trim() && !state.searching
        ? [el('div', { class: 'field-hint', text: '没有匹配的学员' })]
        : state.candidates.map((c) =>
            el(
              'button',
              {
                type: 'button',
                class: 'candidate' + (state.picked && state.picked.id === c.id ? ' picked' : ''),
                onclick: () => {
                  state.picked = c;
                  paint();
                },
              },
              el(
                'div',
                { class: 'c-main' },
                el('div', { class: 'c-name', text: c.name }),
                el('div', { class: 'c-sub', text: c.phone || '无手机号' }),
              ),
              el('span', {
                class: 'c-bal',
                text: `剩 ${c.remainingLessons == null ? '—' : c.remainingLessons} 节`,
              }),
            ),
          )),
    );

    const children = [el('div', { class: 'toolbar' }, search), cands];

    if (state.picked) {
      const field = (label, node, req) =>
        el(
          'div',
          { class: 'field' },
          el('label', {}, label, req ? el('span', { class: 'req', text: '*' }) : null),
          node,
        );
      children.push(
        el(
          'div',
          { class: 'field-grid' },
          field('增减课时', el('input', { id: 'adj-delta', type: 'number', step: '1', placeholder: '正数加 / 负数减' }), true),
          field('原因', el('input', { id: 'adj-reason', type: 'text', maxlength: '200' }), true),
          field('日期', el('input', { id: 'adj-date', type: 'date', value: todayYmd() })),
          field('经办人', el('input', { id: 'adj-operator', type: 'text', maxlength: '20' })),
          field('备注', el('input', { id: 'adj-note', type: 'text', maxlength: '200' })),
        ),
        el(
          'div',
          { class: 'form-actions' },
          el('button', { class: 'btn', text: '取消', onclick: () => mask.remove() }),
          el('button', {
            class: 'btn btn-primary',
            text: `为「${state.picked.name}」调整`,
            onclick: () => submit(false),
          }),
        ),
      );
    }
    body.replaceChildren(...children.filter(Boolean));
  }

  const mask = el(
    'div',
    { class: 'modal-mask', onclick: (e) => e.target === mask && mask.remove() },
    el(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      el('h3', { text: '手动调整课时' }),
      body,
    ),
  );
  paint();
  document.body.appendChild(mask);
}

async function voidRecordFlow(r) {
  const ok = await confirmModal({
    title: '撤销这条考勤',
    body: `将撤销 ${r.studentName || '#' + r.studentId} 在 ${r.attendDate} 的「${r.type}」记录，并把课时按原样回补。`,
    confirmLabel: '撤销',
  });
  if (!ok) return;
  try {
    unwrap(await shell.attendance.voidRecord(r.id));
    toast('已撤销，课时已回补');
    listState.offset = 0;
    await reloadList();
  } catch (err) {
    toast(err.message);
  }
}

function openCorrectModal(r) {
  const isAttendInit = r.type === '出勤';
  const dateInput = el('input', { type: 'date', value: r.attendDate });
  const timeInput = el('input', { type: 'time', value: r.attendTime || '' });
  const classInput = el('input', { type: 'text', maxlength: '40', value: r.className || '' });
  const teacherInput = el('input', { type: 'text', maxlength: '20', value: r.teacher || '' });
  const operatorInput = el('input', { type: 'text', maxlength: '20', value: r.operator || '' });
  const noteInput = el('input', { type: 'text', maxlength: '200', value: r.note || '' });
  const lessonsInput = el('input', {
    type: 'number',
    min: '1',
    step: '1',
    value: String(isAttendInit ? Math.abs(r.lessonsDelta) || 1 : 1),
    disabled: !isAttendInit || undefined,
  });
  const typeSel = el(
    'select',
    {
      onchange: (e) => {
        lessonsInput.disabled = e.target.value !== '出勤';
        if (e.target.value !== '出勤') lessonsInput.value = '1';
      },
    },
    ...EVENT_TYPES.map((t) => el('option', { value: t, text: t, selected: r.type === t || undefined })),
  );

  const field = (label, node) =>
    el('div', { class: 'field' }, el('label', { text: label }), node);

  const submit = async (force) => {
    const type = typeSel.value;
    const payload = {
      id: r.id,
      type,
      attendDate: dateInput.value || undefined,
      attendTime: timeInput.value || null,
      className: classInput.value || null,
      teacher: teacherInput.value || null,
      lessons: type === '出勤' ? Number(lessonsInput.value) || 1 : undefined,
      operator: operatorInput.value || null,
      note: noteInput.value || null,
      force,
    };
    try {
      unwrap(await shell.attendance.correct(payload));
      toast('已更正');
      mask.remove();
      listState.offset = 0;
      await reloadList();
    } catch (err) {
      if (err.code === 'INSUFFICIENT_LESSONS' && !force) {
        const ok = await confirmModal({
          title: '课时会变负',
          body: '这次更正会让该学员剩余课时低于 0。仍要保存吗？',
          confirmLabel: '仍然保存',
          danger: true,
        });
        if (ok) await submit(true);
        return;
      }
      toast(err.message);
    }
  };

  const mask = el(
    'div',
    { class: 'modal-mask', onclick: (e) => e.target === mask && mask.remove() },
    el(
      'div',
      { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
      el('h3', { text: `更正 · ${r.studentName || '#' + r.studentId}` }),
      el(
        'div',
        { class: 'field-grid' },
        field('日期', dateInput),
        field('时间', timeInput),
        field('类型', typeSel),
        field('扣课时数', lessonsInput),
        field('课程名', classInput),
        field('老师', teacherInput),
        field('经办人', operatorInput),
        field('备注', noteInput),
      ),
      el(
        'div',
        { class: 'form-actions' },
        el('button', { class: 'btn', text: '取消', onclick: () => mask.remove() }),
        el('button', { class: 'btn btn-primary', text: '保存更正', onclick: () => submit(false) }),
      ),
    ),
  );
  document.body.appendChild(mask);
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
      // 中文等输入法组字期间跳过防抖重渲染，避免把带着组字状态的输入框整个换掉
      // （否则永远打不出汉字）；等 compositionend 组字完成再触发。
      if (e.isComposing) return;
      clearTimeout(keywordDebounce);
      keywordDebounce = setTimeout(reloadList, 240);
    },
    oncompositionend: (e) => {
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
      el(
        'div',
        { style: 'display:flex;gap:10px' },
        el('button', { class: 'btn', text: '调整课时', onclick: () => openAdjustModal() }),
        el('button', { class: 'btn', text: '导出', onclick: () => exportRecordsFlow() }),
        el('button', {
          class: 'btn',
          text: '导入',
          onclick: () => {
            window.location.hash = '#/import';
          },
        }),
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
        ...['日期', '时间', '学员', '课程', '老师', '类型', '课时增减', '经办人', '备注', '操作'].map(
          (h) => el('th', { text: h }),
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

async function exportRecordsFlow() {
  try {
    const res = unwrap(
      await shell.attendance.export({
        dateFrom: listState.dateFrom || undefined,
        dateTo: listState.dateTo || undefined,
        keyword: listState.keyword.trim() || undefined,
        type: listState.type || undefined,
      }),
    );
    toast(`已导出 ${res.detail} 条明细 · ${res.summary} 行汇总`);
  } catch (err) {
    if (err.code === 'IO_CANCELLED') return;
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
      // 中文等输入法组字期间（拼音候选还没敲定）也会不断触发 input：这时如果照常
      // 防抖后整页重渲染，会把这个输入框本身连着组字状态一起换掉，导致永远打不出
      // 汉字。isComposing 为真时只更新状态、不排搜索，等 compositionend 组字完成
      // 再触发，避免中途炸掉输入法。
      if (e.isComposing) return;
      clearTimeout(quickSearchDebounce);
      quickSearchDebounce = setTimeout(quickSearch, 220);
    },
    oncompositionend: (e) => {
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
  /** 「选择课节」关联的 class_sessions.id；null = 未关联，走学员库筛选 */
  sessionId: null,
  /** 当前日期所在整周（周一到周日）可选的课节（course.sessionsByWeek） */
  sessionOptions: [],
  /** 不关联课节时，按班级筛花名册；null = 不筛班级。与舞种筛选互斥（选一个清另一个）。 */
  classId: null,
  /** 「班级」下拉的候选项（course.classList） */
  classOptions: [],
};
let rosterSearchDebounce = null;

/** 拉全部班级填「班级」筛选下拉。course 模块未上线时静默失败即可。 */
async function loadRosterClassOptions() {
  if (!shell.course || typeof shell.course.classList !== 'function') {
    rosterState.classOptions = [];
    return;
  }
  try {
    const list = unwrap(await shell.course.classList({}));
    rosterState.classOptions = list
      .map((c) => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  } catch {
    rosterState.classOptions = [];
  }
}

/**
 * 不关联课节时刷新候选名单：选了班级 → 用该班在册花名册（course.rosterList），
 * 关键字在客户端再筛一遍；没选班级 → 走原来的舞种 / 关键字学员库筛选。
 */
async function refreshRosterCandidates() {
  if (rosterState.classId && shell.course && typeof shell.course.rosterList === 'function') {
    try {
      const roster = unwrap(await shell.course.rosterList(rosterState.classId));
      let list = roster.map((m) => ({
        id: m.studentId,
        name: m.name,
        phone: m.phone,
        remainingLessons: m.remainingLessons,
        cardExpireDate: m.cardExpireDate,
        danceTypes: [],
      }));
      const kw = rosterState.keyword.trim();
      if (kw) {
        const low = kw.toLowerCase();
        list = list.filter((c) => c.name.toLowerCase().includes(low) || (c.phone || '').includes(kw));
      }
      rosterState.candidates = list;
    } catch (err) {
      toast(err.message);
      rosterState.candidates = [];
    }
    return;
  }
  await rosterFetch({});
}

/** 拉「日期所在整周」的课节列表填「选择课节」下拉，方便补前几天的点名。course 模块未上线时静默失败即可。 */
async function loadRosterSessions(date) {
  if (!date || !shell.course || typeof shell.course.sessionsByWeek !== 'function') {
    rosterState.sessionOptions = [];
    return;
  }
  try {
    rosterState.sessionOptions = unwrap(await shell.course.sessionsByWeek({ date }));
  } catch {
    rosterState.sessionOptions = [];
  }
}

/**
 * 选中一节课：带出公共字段（含日期——课节可能不在当前 #r-date 显示的这天）+ 用该班
 * 在册花名册替换候选名单。不预先勾选任何人——请假 / 缺勤的学员容易被连带误记出勤，
 * 由老师逐个勾选更保险；要整班出勤用「全部设为出勤」一键代劳。
 */
async function applyRosterSession(opt) {
  rosterState.sessionId = opt.id;
  const setVal = (id, v) => {
    const n = document.getElementById(id);
    if (n) n.value = v ?? '';
  };
  setVal('r-date', opt.sessionDate);
  setVal('r-time', opt.startTime);
  setVal('r-class', opt.className);
  setVal('r-teacher', opt.teacherName || '');

  const roster = unwrap(await shell.course.rosterList(opt.classId));
  rosterState.candidates = roster.map((m) => ({
    id: m.studentId,
    name: m.name,
    phone: m.phone,
    remainingLessons: m.remainingLessons,
    cardExpireDate: m.cardExpireDate,
    danceTypes: [],
  }));
  rosterState.picks = new Map();
  paintRosterList();
}

/** 取消课节关联，回到「按班级 / 舞种 / 关键字筛花名册」。 */
async function clearRosterSession() {
  rosterState.sessionId = null;
  rosterState.picks.clear();
  await refreshRosterCandidates();
  paintRosterList();
}

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
    sessionId: rosterState.sessionId || undefined,
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

/**
 * 「选择课节」下拉的 <option> 列表：第一项为「不关联」，其余来自 rosterState.sessionOptions
 * ——覆盖 #r-date 所在整周（周一到周日），每项带上日期方便补前几天的点名。
 */
function sessionOptionEls() {
  return [
    el('option', { value: '', text: '不关联课节（手动填这节课信息）' }),
    ...rosterState.sessionOptions.map((s) =>
      el('option', {
        value: String(s.id),
        text:
          `${weekdayMmdd(s.sessionDate)} ${s.startTime}–${s.endTime} ${s.className}` +
          (s.teacherName ? ` · ${s.teacherName}` : '') +
          (s.status === '停课' ? ' · 已停课' : ''),
        selected: rosterState.sessionId === s.id || undefined,
        disabled: s.status === '停课' || undefined,
      }),
    ),
  ];
}

function renderRosterInto(container) {
  const sessionSel = el(
    'select',
    {
      id: 'r-session',
      style: 'width:100%;min-height:44px',
      'aria-label': '选择课节',
      onchange: async (e) => {
        const id = Number(e.target.value);
        if (!id) {
          await clearRosterSession();
          return;
        }
        const opt = rosterState.sessionOptions.find((s) => s.id === id);
        if (opt) await applyRosterSession(opt);
      },
    },
    ...sessionOptionEls(),
  );

  const common = el(
    'div',
    { class: 'form-group' },
    el('div', { class: 'group-title', text: '这节课' }),
    el(
      'div',
      { class: 'field' },
      el('label', { for: 'r-session', text: '选择课节（从课程表带出日期 / 班级 / 老师 / 花名册）' }),
      sessionSel,
    ),
    el(
      'div',
      { class: 'field-grid' },
      el(
        'div',
        { class: 'field' },
        el('label', { for: 'r-date', text: '日期' }),
        el('input', {
          id: 'r-date',
          type: 'date',
          value: todayYmd(),
          onchange: async (e) => {
            await loadRosterSessions(e.target.value);
            const sel = document.getElementById('r-session');
            if (sel) sel.replaceChildren(...sessionOptionEls());
          },
        }),
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

  const classSel = el(
    'select',
    {
      id: 'r-class-filter',
      class: 'toolbar-select',
      'aria-label': '班级',
      onchange: async (e) => {
        const v = e.target.value;
        rosterState.classId = v ? Number(v) : null;
        rosterState.sessionId = null; // 改用花名册筛选 → 脱离课节关联
        const ss = document.getElementById('r-session');
        if (ss) ss.value = '';
        if (rosterState.classId) {
          // 按班级筛和按舞种筛是两套互斥的候选来源，选了班级就清掉舞种，避免两边打架
          rosterState.danceType = '';
          const ds = document.getElementById('r-dance-filter');
          if (ds) ds.value = '';
        }
        await refreshRosterCandidates();
        paintRosterList();
      },
    },
    el('option', { value: '', text: '全部班级' }),
    ...rosterState.classOptions.map((c) =>
      el('option', {
        value: String(c.id),
        text: c.name,
        selected: rosterState.classId === c.id || undefined,
      }),
    ),
  );
  const danceSel = el(
    'select',
    {
      id: 'r-dance-filter',
      class: 'toolbar-select',
      'aria-label': '舞种',
      onchange: async (e) => {
        rosterState.danceType = e.target.value;
        rosterState.sessionId = null; // 改用学员库筛选 → 脱离课节关联
        const ss = document.getElementById('r-session');
        if (ss) ss.value = '';
        if (rosterState.danceType) {
          rosterState.classId = null;
          const cs = document.getElementById('r-class-filter');
          if (cs) cs.value = '';
        }
        await refreshRosterCandidates();
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
      rosterState.sessionId = null; // 改用学员库筛选 → 脱离课节关联
      const ss = document.getElementById('r-session');
      if (ss) ss.value = '';
      clearTimeout(rosterSearchDebounce);
      rosterSearchDebounce = setTimeout(async () => {
        await refreshRosterCandidates();
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
        classSel,
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
  rosterState.sessionId = null;
  rosterState.classId = null;
  view.replaceChildren(el('div', { class: 'empty', text: '加载中…' }));
  try {
    await rosterFetch({ withOptions: true });
    await loadRosterClassOptions();
    await loadRosterSessions(todayYmd());
    renderRosterInto(view);
  } catch (err) {
    toast(err.message);
    view.replaceChildren(el('div', { class: 'empty', text: '加载失败：' + err.message }));
  }
}

/* ───────────────────────── 导入历史考勤（#/import）───────────────────────── */

const IMPORT_FIELDS = [
  { key: 'studentName', label: '学员姓名', required: true },
  { key: 'phone', label: '手机号', required: true },
  { key: 'date', label: '日期', required: true },
  { key: 'type', label: '类型', required: true },
  { key: 'time', label: '时间' },
  { key: 'className', label: '课程' },
  { key: 'teacher', label: '老师' },
  { key: 'lessons', label: '课时增减' },
  { key: 'operator', label: '经办人' },
  { key: 'note', label: '备注' },
];

function renderImport() {
  renderTabs('');
  view.replaceChildren(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', { class: 'page-title', text: '导入历史考勤' }),
        el('p', {
          class: 'page-sub',
          text: '按「姓名 + 手机号」匹配学员；每一行都会真实扣 / 加课时（补录默认允许欠课记负）',
        }),
      ),
      el('button', {
        class: 'btn btn-ghost',
        text: '返回流水',
        onclick: () => {
          window.location.hash = '#/records';
        },
      }),
    ),
    el('div', { id: 'imp-body' }),
  );
  const body = document.getElementById('imp-body');

  const step1 = el(
    'div',
    { class: 'form-group' },
    el('div', { class: 'group-title', text: '第 1 步：准备文件' }),
    el('p', { class: 'page-sub', text: '没有模板？先下载一个，按表头填好再回来选文件。' }),
    el(
      'div',
      { class: 'form-actions', style: 'justify-content:flex-start' },
      el('button', {
        class: 'btn',
        text: '下载模板',
        onclick: async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          try {
            const { filePath } = unwrap(await shell.attendance.downloadTemplate());
            toast(`模板已保存到 ${filePath}`);
          } catch (e) {
            if (e.code !== 'IO_CANCELLED') toast(`下载失败：${e.message}`);
          } finally {
            btn.disabled = false;
          }
        },
      }),
      el('button', {
        class: 'btn btn-primary',
        text: '选择文件…',
        onclick: async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          try {
            const preview = unwrap(await shell.attendance.pickImportFile());
            renderMapping(preview);
          } catch (e) {
            if (e.code !== 'IO_CANCELLED') toast(`读取失败：${e.message}`);
            btn.disabled = false;
          }
        },
      }),
    ),
  );
  body.replaceChildren(step1);

  function renderMapping({ filePath, headers, sample }) {
    const opts = headers.filter((h) => h);
    const selects = new Map();

    const rows = IMPORT_FIELDS.map((f) => {
      const sel = el(
        'select',
        {},
        el('option', { value: '', text: '（不导入）' }),
        ...opts.map((h) => el('option', { value: h, text: h })),
      );
      if (headers.includes(f.label)) sel.value = f.label;
      sel.addEventListener('change', updateStartBtn);
      selects.set(f.key, sel);
      return el(
        'tr',
        {},
        el('td', {}, f.label, f.required ? el('span', { class: 'req', text: ' ＊' }) : null),
        el('td', {}, sel),
      );
    });

    const startBtn = el('button', { class: 'btn btn-primary', text: '开始导入' });
    const currentMapping = () => {
      const m = {};
      for (const [key, sel] of selects) if (sel.value) m[key] = sel.value;
      return m;
    };
    function updateStartBtn() {
      const m = currentMapping();
      startBtn.disabled = !(m.studentName && m.phone && m.date && m.type);
    }
    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      try {
        const report = unwrap(
          await shell.attendance.import({ filePath, mapping: currentMapping() }),
        );
        renderReport(report);
      } catch (e) {
        toast(`导入失败：${e.message}`);
        startBtn.disabled = false;
      }
    });

    const sampleNote = sample.length
      ? el('p', {
          class: 'page-sub',
          text: `示例首行：${sample[0].filter(Boolean).slice(0, 6).join(' | ')}`,
        })
      : null;

    body.replaceChildren(
      el(
        'div',
        { class: 'form-group' },
        el('div', { class: 'group-title', text: '第 2 步：列映射' }),
        el('p', { class: 'page-sub', text: `文件：${filePath}` }),
        sampleNote,
        el(
          'table',
          { class: 'map-table' },
          el('thead', {}, el('tr', {}, el('th', { text: '模板字段' }), el('th', { text: '表格列' }))),
          el('tbody', {}, ...rows),
        ),
        el('div', { class: 'form-actions' }, startBtn),
      ),
    );
    updateStartBtn();
  }

  function renderReport(report) {
    body.replaceChildren(
      el(
        'div',
        { class: 'form-group' },
        el('div', { class: 'group-title', text: '导入完成' }),
        el('p', {
          text: `成功 ${report.succeeded} 行，跳过 ${report.skipped} 行（疑似重复），失败 ${report.failed} 行。`,
        }),
        report.negativeBalance > 0
          ? el(
              'div',
              { class: 'warn-banner' },
              el('span', { class: 'dot' }),
              el('span', {
                text: `其中 ${report.negativeBalance} 行使对应学员课时变为负数`,
              }),
            )
          : null,
        report.failures.length > 0
          ? el(
              'ul',
              {},
              ...report.failures.map((f) => el('li', { text: `第 ${f.row} 行：${f.reason}` })),
            )
          : null,
        el(
          'div',
          { class: 'form-actions' },
          el('button', {
            class: 'btn btn-primary',
            text: '完成',
            onclick: () => {
              window.location.hash = '#/records';
            },
          }),
        ),
      ),
    );
  }
}

/* ───────────────────────── 路由 ───────────────────────── */

function route() {
  const hash = window.location.hash || '#/records';
  if (hash.startsWith('#/quick')) return renderQuick();
  if (hash.startsWith('#/roster')) return renderRoster();
  if (hash.startsWith('#/import')) return renderImport();
  return renderRecords();
}

window.addEventListener('hashchange', route);
route();

// 供后续 issue / E2E 复用的极少量导出（挂到 window，避免打包器）
window.__attendance = { todayYmd, toast };
