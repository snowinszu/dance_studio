/**
 * 数据报表渲染器（单页 + hash 路由）。
 *
 * 整体类比：这一页是店铺的「电子公告栏」——它自己不产生数据，只是把考勤 / 课程 /
 * 学员 / 库存四个模块的库存数字重新「称重、排队、画趋势」，贴到一面墙上给老板看。
 * 顶上有一个「看哪段时间」的开关（本月 / 本年 / 自定义），拨一下，墙上所有数字重刷。
 *
 * 数据一律通过 window.studioShell.reports.*（preload 暴露的窄接口）向主进程要；
 * 报表是纯只读的，本模块不写任何库、不加数据库迁移。
 *
 * 渲染层不参与 TypeScript 构建，所以这里是手写 ES module。
 */

const shell = window.studioShell;
const view = document.getElementById('view');
const toastEl = document.getElementById('toast');

/* ───────────────────────── 小工具 ───────────────────────── */

/** 轻量 DOM 构造：el('div', { class:'x' }, child, '文本') */
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
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

/** 统一处理 IpcResult 信封：ok 返回 data，否则抛带 code 的错误。 */
function unwrap(res) {
  if (res && res.ok) return res.data;
  const err = (res && res.error) || { code: 'DB_ERROR', message: '未知错误' };
  const e = new Error(err.message || '操作失败');
  e.code = err.code;
  e.fields = err.fields || null;
  throw e;
}

/* ───────────────────────── 时间范围 ───────────────────────── */

/** 一个 Date → 本地时区的 'YYYY-MM-DD'（不用 toISOString，避免 UTC 偏移串日期）。 */
function ymdLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 页面时间范围状态。preset 决定 from/to 怎么算：
 *   month  当月 1 号 → 今天
 *   year   当年 1/1 → 今天
 *   custom 用 customFrom / customTo 两个输入框
 * 主进程只认算好的 { from, to } 日期串，不认 preset。
 */
const rangeState = { preset: 'month', customFrom: '', customTo: '' };

const PRESETS = [
  { key: 'month', label: '本月' },
  { key: 'year', label: '本年' },
  { key: 'custom', label: '自定义' },
];

/** 当前 preset 对应的 { from, to }；custom 缺输入时兜底为今天。 */
function currentRange() {
  const now = new Date();
  const today = ymdLocal(now);
  if (rangeState.preset === 'year') {
    return { from: `${now.getFullYear()}-01-01`, to: today };
  }
  if (rangeState.preset === 'custom') {
    return { from: rangeState.customFrom || today, to: rangeState.customTo || today };
  }
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return { from: `${now.getFullYear()}-${m}-01`, to: today };
}

/** custom 模式下起止是否非法（起 > 止）。 */
function customRangeInvalid() {
  return (
    rangeState.preset === 'custom' &&
    rangeState.customFrom &&
    rangeState.customTo &&
    rangeState.customFrom > rangeState.customTo
  );
}

/** 时间范围控件：三个 preset 胶囊 + 自定义时的两个日期输入。 */
function renderRangeControl() {
  const presets = el(
    'div',
    { class: 'range-presets', role: 'group', 'aria-label': '时间范围' },
    ...PRESETS.map((p) =>
      el(
        'button',
        {
          type: 'button',
          class: 'chip-toggle' + (rangeState.preset === p.key ? ' on' : ''),
          'aria-pressed': rangeState.preset === p.key ? 'true' : 'false',
          onclick: () => {
            if (rangeState.preset === p.key) return;
            rangeState.preset = p.key;
            render();
          },
        },
        p.label,
      ),
    ),
  );

  const children = [presets];

  if (rangeState.preset === 'custom') {
    const fromInput = el('input', {
      type: 'date',
      value: rangeState.customFrom,
      'aria-label': '起始日期',
      onchange: (e) => {
        rangeState.customFrom = e.target.value;
        render();
      },
    });
    const toInput = el('input', {
      type: 'date',
      value: rangeState.customTo,
      'aria-label': '结束日期',
      onchange: (e) => {
        rangeState.customTo = e.target.value;
        render();
      },
    });
    children.push(
      el('div', { class: 'range-custom' }, fromInput, el('span', { class: 'sep' }, '至'), toInput),
    );
  }

  const r = currentRange();
  children.push(
    el(
      'span',
      { class: 'range-note' },
      customRangeInvalid() ? '起始日期不能晚于结束日期' : `统计区间：${r.from} ~ ${r.to}`,
    ),
  );

  return el('div', { class: 'range-control' }, ...children);
}

/* ───────────────────────── 页面骨架 ───────────────────────── */

/**
 * 渲染整页骨架：页头 + 时间范围控件 + 数据区容器。
 * 各数据区（预警中心 / 概览 KPI / 考勤 / 课程 / 学员 / 库存）由后续 issue 往
 * #report-body 里填。本 issue 只落地骨架与时间范围控件。
 */
function render() {
  const body = el('div', { id: 'report-body' });

  view.replaceChildren(
    el(
      'div',
      { class: 'page-head' },
      el(
        'div',
        {},
        el('h1', { class: 'page-title' }, '数据报表'),
        el('p', { class: 'page-sub' }, '经营数据与业绩分析'),
      ),
    ),
    renderRangeControl(),
    body,
  );

  void load(body);
}

/**
 * 按当前时间范围拉取并渲染各数据区。
 * 本 issue 尚无数据接口，先放占位；概览 / 预警 / 各指标区在后续 issue 接入。
 */
async function load(body) {
  if (customRangeInvalid()) {
    body.replaceChildren(
      el('div', { class: 'empty' }, el('strong', {}, '请调整时间范围'), '起始日期不能晚于结束日期。'),
    );
    return;
  }

  body.replaceChildren(
    el(
      'div',
      { class: 'empty' },
      el('strong', {}, '数据区即将接入'),
      '预警中心、概览 KPI，以及考勤 / 课程 / 学员 / 库存四个指标区会陆续出现在这里。',
    ),
  );
}

/* ───────────────────────── 路由 ───────────────────────── */

function route() {
  // 目前只有一个视图；非 #/ 的地址统一归一到 #/
  if (location.hash && location.hash !== '#/' && location.hash !== '#') {
    location.hash = '#/';
    return;
  }
  render();
}

window.addEventListener('hashchange', route);
route();
