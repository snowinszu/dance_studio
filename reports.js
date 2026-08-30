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

import { lineChartSVG, heatmapSVG } from './reports.charts.js';

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

/* ───────────────────────── 通用区块 / 卡片 ───────────────────────── */

/** 一个可折叠的报表分区：<details class="report-section">。 */
function section(title, open, ...children) {
  return el(
    'details',
    { class: 'report-section', open: open ? '' : null },
    el(
      'summary',
      {},
      el('span', {}, title),
      el(
        'svg',
        { class: 'sec-chevron', viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
        el('polyline', { points: '9 18 15 12 9 6' }),
      ),
    ),
    el('div', { class: 'section-body' }, ...children),
  );
}

/** 一张 KPI 卡片。warn=true 时数值转成预警色（--cc-1）。 */
function kpiCard(label, value, warn) {
  return el(
    'div',
    { class: 'kpi-card' + (warn ? ' is-warn' : '') },
    el('div', { class: 'kpi-label' }, label),
    el('div', { class: 'kpi-value' }, String(value)),
  );
}

/** 小标题。 */
function subHead(text) {
  return el('div', { class: 'sub-head' }, text);
}

/**
 * 水平分布条列表：[{ label, value }] → 按最大值归一化的进度条。
 * 超过 limit 行给「还有 N 项」。空数组显示占位。
 */
function distList(items, limit = 12) {
  if (!items.length) return el('div', { class: 'sec-empty' }, '暂无数据');
  const max = Math.max(1, ...items.map((i) => i.value));
  const rows = items.slice(0, limit).map((it) =>
    el(
      'div',
      { class: 'dist-row' },
      el('span', { class: 'd-label', title: it.label }, it.label),
      el(
        'div',
        { class: 'd-track' },
        el('div', { class: 'd-fill', style: `width:${Math.round((it.value / max) * 100)}%` }),
      ),
      el('span', { class: 'd-value' }, String(it.value)),
    ),
  );
  if (items.length > limit) {
    rows.push(el('div', { class: 'a-more' }, `……还有 ${items.length - limit} 项`));
  }
  return el('div', { class: 'dist-list' }, ...rows);
}

/** 简单两列表格：表头 [左, 右]，行 [左值, 右值(数字右对齐)]。 */
function twoColTable(headLeft, headRight, rows) {
  if (!rows.length) return el('div', { class: 'sec-empty' }, '暂无数据');
  return el(
    'div',
    { class: 'table-scroll' },
    el(
      'table',
      { class: 'data-table' },
      el(
        'thead',
        {},
        el('tr', {}, el('th', {}, headLeft), el('th', { class: 'num' }, headRight)),
      ),
      el(
        'tbody',
        {},
        ...rows.map(([l, r]) =>
          el('tr', {}, el('td', {}, l), el('td', { class: 'num' }, String(r))),
        ),
      ),
    ),
  );
}

/* ───────────────────────── 预警中心 ───────────────────────── */

/** 一组预警：标题 + 计数徽标 + 明细清单（每组最多渲染 50 行，超出给「还有 N 条」）。 */
function alertGroup(title, items, renderRow) {
  const n = items.length;
  const shown = items.slice(0, 50);
  const rows =
    n === 0
      ? [el('li', { class: 'a-none' }, '暂无')]
      : shown.map((it) => el('li', {}, renderRow(it)));
  if (n > shown.length) {
    rows.push(el('li', { class: 'a-more' }, `……还有 ${n - shown.length} 条`));
  }
  return el(
    'div',
    { class: 'alert-group' },
    el(
      'div',
      { class: 'alert-group-head' },
      el('span', {}, title),
      el('span', { class: 'alert-count' + (n === 0 ? ' is-zero' : '') }, String(n)),
    ),
    el('ul', { class: 'alert-list' }, ...rows),
  );
}

function renderAlerts(alerts) {
  const grid = el(
    'div',
    { class: 'alert-grid' },
    alertGroup(
      '低库存',
      alerts.lowStock,
      (it) => `${it.name} · 剩 ${it.quantity}（阈值 ${it.threshold}）`,
    ),
    alertGroup(
      '课时余额不足',
      alerts.lowBalance,
      (it) => `${it.name} · 剩 ${it.remainingLessons} 课时`,
    ),
    alertGroup(
      '沉睡学员（近 60 天无出勤）',
      alerts.dormant,
      (it) => `${it.name} · ${it.lastAttendDate ? '最近出勤 ' + it.lastAttendDate : '无出勤记录'}`,
    ),
    alertGroup(
      '空课（近 30 天 0 到课）',
      alerts.emptySessions,
      (it) => `${it.className} · ${it.sessionDate} ${it.startTime}`,
    ),
  );
  return section('预警中心', true, grid);
}

/* ───────────────────────── 概览 KPI 区 ───────────────────────── */

function renderOverview(ov) {
  const grid = el(
    'div',
    { class: 'kpi-grid' },
    kpiCard('在读学员', ov.activeStudents),
    kpiCard('本区间出勤人次', ov.checkInsInRange),
    kpiCard('本区间课节数', ov.sessionsInRange),
    kpiCard('近 30 天新增学员', ov.newStudentsLast30d),
    kpiCard('课时余额预警', ov.lowBalanceCount, ov.lowBalanceCount > 0),
    kpiCard('低库存预警', ov.lowStockCount, ov.lowStockCount > 0),
  );
  return section('概览', true, grid);
}

/* ───────────────────────── 考勤指标区 ───────────────────────── */

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
/** 12 个 2 小时桶 + 「未知」 */
const BUCKET_LABELS = Array.from({ length: 12 }, (_, i) => `${i * 2}–${i * 2 + 2}`).concat('未知');

/** hourHeatmap 的稀疏行 → 7×13 稠密矩阵（列 0..11=时段桶，列 12=未知时段）。 */
function buildHeatmapMatrix(cells) {
  const m = Array.from({ length: 7 }, () => new Array(13).fill(0));
  for (const c of cells) {
    if (c.weekday < 0 || c.weekday > 6) continue;
    const col = c.bucket === -1 ? 12 : c.bucket >= 0 && c.bucket <= 11 ? c.bucket : -1;
    if (col < 0) continue;
    m[c.weekday][col] += c.count;
  }
  return m;
}

/** 出勤排名的当前排序键，在同一次页面停留内保留。 */
let rankSort = 'count'; // 'count' | 'rate'

function sortedRanking(ranking) {
  const arr = ranking.slice();
  if (rankSort === 'rate') {
    arr.sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.attendCount - a.attendCount);
  } else {
    arr.sort((a, b) => b.attendCount - a.attendCount || (b.rate ?? -1) - (a.rate ?? -1));
  }
  return arr;
}

/** 把排名表渲染进 mount 容器；点表头切换排序键后就地重渲染，不重新拉数。 */
function renderRankingTable(ranking, mount) {
  const th = (key, label) =>
    el(
      'th',
      {
        class: 'sortable num' + (rankSort === key ? ' on' : ''),
        onclick: () => {
          rankSort = key;
          renderRankingTable(ranking, mount);
        },
      },
      label + (rankSort === key ? ' ↓' : ''),
    );

  const body = sortedRanking(ranking)
    .slice(0, 100)
    .map((r, i) =>
      el(
        'tr',
        {},
        el('td', {}, `${i + 1}. ${r.name}`),
        el('td', { class: 'num' }, String(r.attendCount)),
        el('td', { class: 'num' }, r.rate == null ? '—' : `${Math.round(r.rate * 100)}%`),
      ),
    );

  mount.replaceChildren(
    ranking.length === 0
      ? el('div', { class: 'sec-empty' }, '暂无数据')
      : el(
          'table',
          { class: 'data-table' },
          el(
            'thead',
            {},
            el('tr', {}, el('th', {}, '学员'), th('count', '出勤次数'), th('rate', '出勤率')),
          ),
          el('tbody', {}, ...body),
        ),
  );
}

function renderAttendance(stats) {
  const rankMount = el('div', { class: 'table-scroll' });
  renderRankingTable(stats.ranking, rankMount);

  const heatMatrix = buildHeatmapMatrix(stats.hourHeatmap);

  return section(
    '考勤指标',
    true,
    subHead('课节数'),
    el(
      'div',
      { class: 'stat-pair' },
      el('div', { class: 'stat' }, el('b', {}, String(stats.sessionsThisMonth)), el('span', {}, '本月')),
      el('div', { class: 'stat' }, el('b', {}, String(stats.sessionsThisYear)), el('span', {}, '本年')),
    ),

    subHead('月度出勤人次'),
    el('div', {
      class: 'chart',
      html: lineChartSVG({
        points: stats.monthlyCheckIns.map((m) => ({ label: m.month, value: m.count })),
        width: 600,
        height: 160,
        title: '月度出勤人次趋势',
      }),
    }),
    el(
      'div',
      { class: 'chart-xlabels' },
      ...stats.monthlyCheckIns.map((m) => el('span', {}, `${m.month.slice(2)}·${m.count}`)),
    ),

    subHead('出勤排名'),
    rankMount,

    subHead('近 30 天缺勤 / 请假 TOP'),
    twoColTable(
      '学员',
      '缺勤 + 请假',
      stats.absenceTop.map((r, i) => [`${i + 1}. ${r.name}`, r.absentPlusLeave]),
    ),

    subHead('按老师（出勤人次）'),
    distList(stats.byTeacher.map((t) => ({ label: t.teacher, value: t.checkIns }))),

    subHead('按课程（出勤人次）'),
    distList(stats.byDanceType.map((t) => ({ label: t.danceType, value: t.checkIns }))),

    subHead('上课时段热力（星期 × 2 小时）'),
    el('div', {
      class: 'chart',
      html: heatmapSVG({
        matrix: heatMatrix,
        rowLabels: WEEKDAY_LABELS,
        colLabels: BUCKET_LABELS,
        width: 640,
        height: 200,
        title: '上课时段热力',
      }),
    }),
  );
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
 * 预警中心、考勤 / 课程 / 学员 / 库存四个指标区在后续 issue 往下追加。
 *
 * body 是本次 render() 新建的容器节点：范围快速切换时，旧请求回来只会写到已脱离
 * 文档的旧 body 上，不会盖掉新结果——闭包捕获天然隔离了竞态。
 */
async function load(body) {
  if (customRangeInvalid()) {
    body.replaceChildren(
      el('div', { class: 'empty' }, el('strong', {}, '请调整时间范围'), '起始日期不能晚于结束日期。'),
    );
    return;
  }

  body.replaceChildren(el('div', { class: 'sec-empty' }, '加载中…'));

  const range = currentRange();
  const sections = [];

  // 预警中心（第一屏）——窗口固定，不跟随时间范围
  try {
    const alerts = unwrap(await shell.reports.alerts());
    sections.push(renderAlerts(alerts));
  } catch (e) {
    sections.push(sectionError('预警中心', e));
  }

  // 概览 KPI——跟随时间范围
  try {
    const overview = unwrap(await shell.reports.overview(range));
    sections.push(renderOverview(overview));
  } catch (e) {
    sections.push(sectionError('概览', e));
  }

  // 考勤指标区
  try {
    const att = unwrap(await shell.reports.attendanceStats(range));
    sections.push(renderAttendance(att));
  } catch (e) {
    sections.push(sectionError('考勤指标', e));
  }

  body.replaceChildren(...sections);
}

/** 某个数据区加载失败时的降级占位——不影响其它区。 */
function sectionError(title, e) {
  return section(
    title,
    true,
    el('div', { class: 'empty' }, el('strong', {}, '这一区加载失败'), (e && e.message) || '请稍后重试'),
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
