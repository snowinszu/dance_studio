/**
 * 课程管理渲染器（单页 + hash 路由）。
 *
 * 整体类比：这一个页面是教务处的操作台，靠地址栏 # 后面的门牌切柜台：
 *   #/classes       班级 + 花名册（默认）
 *   #/timetable     课程表（周视图）           —— #50 接入
 *   #/teacher-plan  上课时间计划表（月视图）    —— #52 接入
 *   #/teachers      老师字典
 *
 * 数据一律经 window.studioShell.course.*（preload 暴露的窄接口）向主进程要，
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
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
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

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/* ───────────────────────── 顶部标签页 ───────────────────────── */

const TABS = [
  { hash: '#/classes', label: '班级' },
  { hash: '#/timetable', label: '课程表' },
  { hash: '#/teacher-plan', label: '上课时间计划表' },
  { hash: '#/teachers', label: '老师' },
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

/* ───────────────────────── 模态 / 抽屉 ───────────────────────── */

function closeOverlays() {
  document.querySelectorAll('.modal-mask, .drawer-mask').forEach((n) => n.remove());
}

/** 打开一个模态，body 为内容节点数组；返回 { close }。模态可叠在抽屉之上，故只清其它模态。 */
function openModal(title, bodyNodes, actions) {
  document.querySelectorAll('.modal-mask').forEach((n) => n.remove());
  const modal = el(
    'div',
    { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
    el('h3', { text: title }),
    ...bodyNodes,
    actions ? el('div', { class: 'form-actions' }, ...actions) : null,
  );
  const mask = el(
    'div',
    {
      class: 'modal-mask',
      onclick: (e) => {
        if (e.target === mask) mask.remove();
      },
    },
    modal,
  );
  document.body.appendChild(mask);
  const first = modal.querySelector('input, select, textarea, button');
  if (first) first.focus();
  return { close: () => mask.remove(), modal };
}

/* ───────────────────────── 表单字段助手 ───────────────────────── */

/** 造一个带 label 的字段容器。返回 { wrap, input }。type 支持 text/number/date/select/textarea。 */
function field(label, { type = 'text', value = '', required = false, options = null, hint = null } = {}) {
  let input;
  if (type === 'select') {
    input = el('select', {});
    for (const o of options || []) {
      input.appendChild(el('option', { value: o.value, text: o.label, selected: o.value === value || undefined }));
    }
  } else if (type === 'textarea') {
    input = el('textarea', {});
    input.value = value ?? '';
  } else {
    input = el('input', { type });
    input.value = value ?? '';
  }
  const wrap = el(
    'div',
    { class: 'field' },
    el('label', {}, label, required ? el('span', { class: 'req', text: '*' }) : null),
    input,
    hint ? el('div', { class: 'field-hint', text: hint }) : null,
  );
  return { wrap, input };
}

/** 把 IpcError.fields 里的字段级错误画到对应 field 容器上。fieldMap: { key: wrapNode } */
function paintErrors(fieldMap, fields) {
  for (const w of Object.values(fieldMap)) {
    w.classList.remove('has-error');
    w.querySelector('.field-error')?.remove();
  }
  if (!fields) return;
  for (const [k, msg] of Object.entries(fields)) {
    const w = fieldMap[k];
    if (!w) continue;
    w.classList.add('has-error');
    w.appendChild(el('div', { class: 'field-error', text: msg }));
  }
}

/* ═════════════════════════ #/classes ═════════════════════════ */

const classState = { keyword: '', status: '', danceType: '', teacherId: '' };
let teacherCache = []; // 在职老师，供下拉

async function loadTeachers() {
  teacherCache = unwrap(await shell.course.teacherList()); // 默认只在职
}

async function renderClasses() {
  renderTabs('#/classes');
  view.replaceChildren(el('div', { class: 'empty', text: '加载中…' }));

  await loadTeachers();
  const query = {};
  if (classState.keyword) query.keyword = classState.keyword;
  if (classState.status) query.status = classState.status;
  if (classState.danceType) query.danceType = classState.danceType;
  if (classState.teacherId) query.teacherId = Number(classState.teacherId);
  const rows = unwrap(await shell.course.classList(query));

  // 舞种下拉：从当前结果收集（同库存分类做法）
  const danceTypes = [...new Set(rows.map((r) => r.danceType).filter(Boolean))].sort();

  const head = el(
    'div',
    { class: 'page-head' },
    el(
      'div',
      {},
      el('h1', { class: 'page-title', text: '班级' }),
      el('p', { class: 'page-sub', text: '维护班级档案与固定学员名单' }),
    ),
    el('button', { class: 'btn btn-primary', onclick: () => openClassForm(null) }, '＋ 新建班级'),
  );

  const kwInput = el('input', {
    class: 'toolbar-search',
    type: 'search',
    placeholder: '搜班名…',
    value: classState.keyword,
  });
  kwInput.addEventListener('input', () => {
    classState.keyword = kwInput.value.trim();
    debouncedReload();
  });

  const statusSel = el(
    'select',
    { class: 'toolbar-select', onchange: (e) => ((classState.status = e.target.value), renderClasses()) },
    el('option', { value: '', text: '全部状态' }),
    ...['在读', '停课', '结课'].map((s) =>
      el('option', { value: s, text: s, selected: s === classState.status || undefined }),
    ),
  );
  const danceSel = el(
    'select',
    { class: 'toolbar-select', onchange: (e) => ((classState.danceType = e.target.value), renderClasses()) },
    el('option', { value: '', text: '全部舞种' }),
    ...danceTypes.map((s) =>
      el('option', { value: s, text: s, selected: s === classState.danceType || undefined }),
    ),
  );
  const teacherSel = el(
    'select',
    { class: 'toolbar-select', onchange: (e) => ((classState.teacherId = e.target.value), renderClasses()) },
    el('option', { value: '', text: '全部主教' }),
    ...teacherCache.map((t) =>
      el('option', {
        value: String(t.id),
        text: t.name,
        selected: String(t.id) === classState.teacherId || undefined,
      }),
    ),
  );

  const toolbar = el(
    'div',
    { class: 'toolbar' },
    kwInput,
    statusSel,
    danceSel,
    teacherSel,
    el('span', { class: 'result-count', text: `共 ${rows.length} 个班` }),
  );

  let body;
  if (rows.length === 0) {
    body = el(
      'div',
      { class: 'empty' },
      el('strong', { text: '还没有班级' }),
      '点右上角「新建班级」，再给它排固定课、加学员。',
    );
  } else {
    body = el(
      'div',
      { class: 'card-grid' },
      ...rows.map((c) => classCard(c)),
    );
  }

  view.replaceChildren(head, toolbar, body);
}

function classCard(c) {
  const countCls = 'count-pill' + (c.overCapacity ? ' over' : '');
  const countText = c.capacity != null ? `在册 ${c.activeRosterCount}/${c.capacity}` : `在册 ${c.activeRosterCount}`;
  return el(
    'button',
    { class: 'entity-card', onclick: () => openClassDrawer(c.id) },
    el('div', { class: 'ec-name', text: c.name }),
    el(
      'div',
      { class: 'ec-meta' },
      [c.danceType, c.level].filter(Boolean).join(' · ') + (c.teacherName ? ` · ${c.teacherName}` : ''),
    ),
    el(
      'div',
      { class: 'ec-row' },
      el('span', { class: countCls, text: countText }),
      el('span', { class: 'status-tag', dataset: { status: c.status } }, el('span', { class: 'dot' }), c.status),
      c.room ? el('span', { class: 'ec-meta', text: `教室 ${c.room}` }) : null,
    ),
  );
}

let reloadTimer = null;
function debouncedReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(renderClasses, 250);
}

/* ───────────── 新建 / 编辑班级表单 ───────────── */

function openClassForm(existing) {
  const isEdit = !!existing;
  const f = {};
  f.name = field('班级名', { required: true, value: existing?.name });
  f.danceType = field('舞种', { required: true, value: existing?.danceType });
  f.level = field('级别', { value: existing?.level ?? '' });
  f.teacherId = field('主教', {
    type: 'select',
    value: existing?.teacherId != null ? String(existing.teacherId) : '',
    options: [{ value: '', label: '（暂不指定）' }, ...teacherCache.map((t) => ({ value: String(t.id), label: t.name }))],
  });
  f.room = field('教室', { value: existing?.room ?? '' });
  f.capacity = field('容量', { type: 'number', value: existing?.capacity ?? '', hint: '留空表示不限' });
  f.startDate = field('开班日期', { type: 'date', value: existing?.startDate ?? '' });
  f.endDate = field('结课日期', { type: 'date', value: existing?.endDate ?? '' });
  f.status = field('状态', {
    type: 'select',
    value: existing?.status ?? '在读',
    options: ['在读', '停课', '结课'].map((s) => ({ value: s, label: s })),
  });
  f.note = field('备注', { type: 'textarea', value: existing?.note ?? '' });

  const grid = el(
    'div',
    { class: 'field-grid' },
    f.name.wrap,
    f.danceType.wrap,
    f.level.wrap,
    f.teacherId.wrap,
    f.room.wrap,
    f.capacity.wrap,
    f.startDate.wrap,
    f.endDate.wrap,
    f.status.wrap,
  );
  const fieldMap = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.wrap]));

  const submit = el('button', { class: 'btn btn-primary' }, isEdit ? '保存' : '新建');
  const { close } = openModal(isEdit ? `编辑班级 · ${existing.name}` : '新建班级', [grid, f.note.wrap], [
    el('button', { class: 'btn', onclick: () => close() }, '取消'),
    submit,
  ]);

  submit.addEventListener('click', async () => {
    const input = {
      name: f.name.input.value.trim(),
      danceType: f.danceType.input.value.trim(),
      level: f.level.input.value.trim() || null,
      teacherId: f.teacherId.input.value ? Number(f.teacherId.input.value) : null,
      room: f.room.input.value.trim() || null,
      capacity: f.capacity.input.value === '' ? null : Number(f.capacity.input.value),
      startDate: f.startDate.input.value || null,
      endDate: f.endDate.input.value || null,
      status: f.status.input.value,
      note: f.note.input.value.trim() || null,
    };
    submit.disabled = true;
    try {
      if (isEdit) unwrap(await shell.course.classUpdate(existing.id, input));
      else unwrap(await shell.course.classCreate(input));
      close();
      toast(isEdit ? '已保存' : '班级已创建');
      renderClasses();
    } catch (e) {
      submit.disabled = false;
      if (e.code === 'VALIDATION_FAILED') paintErrors(fieldMap, e.fields);
      else toast(e.message);
    }
  });
}

/* ───────────── 班级详情抽屉 + 花名册 ───────────── */

async function openClassDrawer(classId) {
  closeOverlays();
  const mask = el('div', {
    class: 'drawer-mask',
    onclick: (e) => {
      if (e.target === mask) mask.remove();
    },
  });
  const panel = el('div', { class: 'drawer' }, el('div', { class: 'empty', text: '加载中…' }));
  mask.appendChild(panel);
  document.body.appendChild(mask);
  await refreshDrawer(panel, classId);
}

async function refreshDrawer(panel, classId) {
  let c, roster;
  try {
    c = unwrap(await shell.course.classGet(classId));
    roster = unwrap(await shell.course.rosterList(classId));
  } catch (e) {
    panel.replaceChildren(el('div', { class: 'empty', text: e.message }));
    return;
  }

  const meta = [c.danceType, c.level].filter(Boolean).join(' · ') + (c.teacherName ? ` · 主教 ${c.teacherName}` : '');
  const countText = c.capacity != null ? `在册 ${c.activeRosterCount}/${c.capacity}` : `在册 ${c.activeRosterCount}`;

  const rosterList = el(
    'div',
    { class: 'roster-list' },
    ...(roster.length
      ? roster.map((m) =>
          el(
            'div',
            { class: 'roster-item' },
            el(
              'div',
              { class: 'r-main' },
              el('div', { class: 'r-name', text: m.name }),
              el('div', {
                class: 'r-sub',
                text: `${m.phone} · 剩 ${m.remainingLessons ?? 0} 节 · 入班 ${m.joinedAt}`,
              }),
            ),
            el(
              'button',
              {
                class: 'btn btn-sm btn-danger',
                onclick: async () => {
                  try {
                    const r = unwrap(await shell.course.rosterRemove({ classId, studentId: m.studentId }));
                    toast(`已移出 · 在册 ${r.activeRosterCount}`);
                    refreshDrawer(panel, classId);
                    renderClasses();
                  } catch (e) {
                    toast(e.message);
                  }
                },
              },
              '移出',
            ),
          ),
        )
      : [el('div', { class: 'field-hint', text: '还没有学员，点下面「加入学员」。' })]),
  );

  panel.replaceChildren(
    el(
      'div',
      { class: 'drawer-head' },
      el('h3', { text: c.name }),
      el('button', { class: 'btn btn-sm btn-ghost', onclick: () => panel.closest('.drawer-mask').remove() }, '关闭'),
    ),
    el('p', { class: 'd-sub', text: meta }),
    el(
      'div',
      { class: 'ec-row' },
      el('span', { class: 'count-pill' + (c.overCapacity ? ' over' : ''), text: countText }),
      el('span', { class: 'status-tag', dataset: { status: c.status } }, el('span', { class: 'dot' }), c.status),
      c.room ? el('span', { class: 'ec-meta', text: `教室 ${c.room}` }) : null,
      c.startDate || c.endDate
        ? el('span', { class: 'ec-meta', text: `${c.startDate ?? '—'} ~ ${c.endDate ?? '—'}` })
        : null,
    ),
    el(
      'div',
      { class: 'form-actions', style: 'justify-content:flex-start;margin-top:14px' },
      el('button', { class: 'btn btn-sm', onclick: () => openClassForm(c) }, '编辑班级'),
      el(
        'button',
        {
          class: 'btn btn-sm btn-danger',
          onclick: async () => {
            if (!confirm(`确定删除「${c.name}」？花名册与排课记录会保留，但班级不再出现在列表。`)) return;
            try {
              unwrap(await shell.course.classDelete(classId));
              panel.closest('.drawer-mask').remove();
              toast('班级已删除');
              renderClasses();
            } catch (e) {
              toast(e.message);
            }
          },
        },
        '删除班级',
      ),
    ),
    el(
      'div',
      { class: 'drawer-section' },
      el('h4', { text: `花名册（${roster.length}）` }),
      rosterList,
      el('button', { class: 'btn btn-sm', style: 'margin-top:10px', onclick: () => openAddStudent(panel, classId) }, '＋ 加入学员'),
    ),
  );
}

function openAddStudent(panel, classId) {
  const search = el('input', { class: 'toolbar-search', type: 'search', placeholder: '按姓名或手机号搜学员…' });
  const listWrap = el('div', { class: 'candidate-list' });
  const { close } = openModal('加入学员', [search, listWrap]);

  let t = null;
  const run = async () => {
    const kw = search.value.trim();
    if (!kw) {
      listWrap.replaceChildren();
      return;
    }
    try {
      const rows = unwrap(await shell.attendance.rosterCandidates({ keyword: kw }));
      listWrap.replaceChildren(
        ...(rows.length
          ? rows.slice(0, 30).map((s) =>
              el(
                'button',
                {
                  class: 'candidate',
                  onclick: async () => {
                    try {
                      const r = unwrap(
                        await shell.course.rosterAdd({ classId, studentId: s.id }),
                      );
                      close();
                      toast(
                        r.overCapacity
                          ? `已加入，但已超容量（在册 ${r.activeRosterCount}）`
                          : `已加入 · 在册 ${r.activeRosterCount}`,
                      );
                      refreshDrawer(panel, classId);
                      renderClasses();
                    } catch (e) {
                      if (e.code === 'STUDENT_ALREADY_IN_CLASS') toast('该学员已在此班在册');
                      else toast(e.message);
                    }
                  },
                },
                el(
                  'div',
                  { class: 'c-main' },
                  el('div', { class: 'c-name', text: s.name }),
                  el('div', { class: 'c-sub', text: `${s.phone} · 剩 ${s.remainingLessons ?? 0} 节` }),
                ),
              ),
            )
          : [el('div', { class: 'field-hint', text: '没找到匹配的学员。' })]),
      );
    } catch (e) {
      listWrap.replaceChildren(el('div', { class: 'field-hint', text: e.message }));
    }
  };
  search.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(run, 220);
  });
}

/* ═════════════════════════ #/teachers ═════════════════════════ */

async function renderTeachers() {
  renderTabs('#/teachers');
  view.replaceChildren(el('div', { class: 'empty', text: '加载中…' }));
  const rows = unwrap(await shell.course.teacherList({ includeInactive: true }));

  const head = el(
    'div',
    { class: 'page-head' },
    el(
      'div',
      {},
      el('h1', { class: 'page-title', text: '老师' }),
      el('p', { class: 'page-sub', text: '排课与代课引用的老师名册' }),
    ),
    el('button', { class: 'btn btn-primary', onclick: () => openTeacherForm(null) }, '＋ 新建老师'),
  );

  const body = rows.length
    ? el(
        'div',
        { class: 'card-grid' },
        ...rows.map((t) =>
          el(
            'div',
            { class: 'entity-card' + (t.status === '离职' ? ' off' : ''), style: 'cursor:default' },
            el('div', { class: 'ec-name', text: t.name }),
            el(
              'div',
              { class: 'ec-row' },
              el('span', { class: 'status-tag', dataset: { status: t.status } }, el('span', { class: 'dot' }), t.status),
            ),
            el(
              'div',
              { class: 'form-actions', style: 'justify-content:flex-start;margin-top:10px' },
              el('button', { class: 'btn btn-sm', onclick: () => openTeacherForm(t) }, '改名'),
              el(
                'button',
                {
                  class: 'btn btn-sm',
                  onclick: async () => {
                    try {
                      unwrap(
                        await shell.course.teacherUpdate(t.id, {
                          status: t.status === '在职' ? '离职' : '在职',
                        }),
                      );
                      toast(t.status === '在职' ? '已置为离职' : '已恢复在职');
                      renderTeachers();
                    } catch (e) {
                      toast(e.message);
                    }
                  },
                },
                t.status === '在职' ? '置为离职' : '恢复在职',
              ),
            ),
          ),
        ),
      )
    : el('div', { class: 'empty' }, el('strong', { text: '还没有老师' }), '先建老师，才能给班级指定主教。');

  view.replaceChildren(head, body);
}

function openTeacherForm(existing) {
  const isEdit = !!existing;
  const nameF = field('姓名', { required: true, value: existing?.name });
  const fieldMap = { name: nameF.wrap };
  const submit = el('button', { class: 'btn btn-primary' }, isEdit ? '保存' : '新建');
  const { close } = openModal(isEdit ? '改名' : '新建老师', [nameF.wrap], [
    el('button', { class: 'btn', onclick: () => close() }, '取消'),
    submit,
  ]);
  submit.addEventListener('click', async () => {
    submit.disabled = true;
    try {
      const payload = { name: nameF.input.value.trim() };
      if (isEdit) unwrap(await shell.course.teacherUpdate(existing.id, payload));
      else unwrap(await shell.course.teacherCreate(payload));
      close();
      toast(isEdit ? '已保存' : '老师已创建');
      renderTeachers();
    } catch (e) {
      submit.disabled = false;
      if (e.code === 'VALIDATION_FAILED') paintErrors(fieldMap, e.fields);
      else toast(e.message);
    }
  });
}

/* ═════════════════════════ #/timetable（学生向课程表 · 周视图） ═════════════════════════ */

const ttState = { danceType: '', teacherId: '' };

async function renderTimetable() {
  renderTabs('#/timetable');
  view.replaceChildren(el('div', { class: 'empty', text: '加载中…' }));
  await loadTeachers();

  const query = {};
  if (ttState.danceType) query.danceType = ttState.danceType;
  if (ttState.teacherId) query.teacherId = Number(ttState.teacherId);
  const rows = unwrap(await shell.course.weeklyTimetable(query));

  const danceTypes = [...new Set(rows.map((r) => r.danceType).filter(Boolean))].sort();
  const todayW = new Date().getDay();

  const head = el(
    'div',
    { class: 'page-head' },
    el(
      'div',
      {},
      el('h1', { class: 'page-title', text: '课程表' }),
      el('p', { class: 'page-sub', text: '每周固定课 · 点一节看班级与花名册' }),
    ),
  );

  const danceSel = el(
    'select',
    { class: 'toolbar-select', onchange: (e) => ((ttState.danceType = e.target.value), renderTimetable()) },
    el('option', { value: '', text: '全部舞种' }),
    ...danceTypes.map((s) => el('option', { value: s, text: s, selected: s === ttState.danceType || undefined })),
  );
  const teacherSel = el(
    'select',
    { class: 'toolbar-select', onchange: (e) => ((ttState.teacherId = e.target.value), renderTimetable()) },
    el('option', { value: '', text: '全部老师' }),
    ...teacherCache.map((t) =>
      el('option', { value: String(t.id), text: t.name, selected: String(t.id) === ttState.teacherId || undefined }),
    ),
  );
  const toolbar = el(
    'div',
    { class: 'toolbar' },
    danceSel,
    teacherSel,
    el('span', { class: 'result-count', text: `共 ${rows.length} 节固定课` }),
  );

  if (rows.length === 0) {
    view.replaceChildren(
      head,
      toolbar,
      el(
        'div',
        { class: 'empty' },
        el('strong', { text: '还没有排固定课' }),
        '去「班级」里挑一个班，给它加「每周几 + 时间」的周期规则。',
      ),
    );
    return;
  }

  const dayRows = (w) => rows.filter((r) => r.weekday === w);

  // 桌面 7 列网格
  const grid = el(
    'div',
    { class: 'tt-grid' },
    ...WEEKDAY_LABELS.map((label, w) =>
      el(
        'div',
        { class: 'tt-col' + (w === todayW ? ' today' : '') },
        el('div', { class: 'tt-day', text: label }),
        ...dayRows(w).map((r) => ttSlot(r)),
      ),
    ),
  );

  // 移动端竖列表：今天置顶
  const order = [todayW, ...WEEKDAY_LABELS.map((_, i) => i).filter((i) => i !== todayW)];
  const list = el(
    'div',
    { class: 'day-list' },
    ...order
      .filter((w) => dayRows(w).length > 0)
      .map((w) =>
        el(
          'div',
          { class: 'day-block' + (w === todayW ? ' today' : '') },
          el('div', { class: 'db-head', text: WEEKDAY_LABELS[w] + (w === todayW ? ' · 今天' : '') }),
          ...dayRows(w).map((r) => ttSlot(r)),
        ),
      ),
  );

  view.replaceChildren(head, toolbar, grid, list);
}

function ttSlot(r) {
  return el(
    'button',
    { class: 'tt-slot', onclick: () => openScheduleDetail(r) },
    el('div', { class: 's-time', text: `${r.startTime}–${r.endTime}` }),
    el('div', { class: 's-name', text: r.className }),
    el('div', {
      class: 's-sub',
      text: [r.teacherName, r.room && `教室 ${r.room}`, `在册 ${r.activeRosterCount}`].filter(Boolean).join(' · '),
    }),
  );
}

async function openScheduleDetail(entry) {
  const rosterWrap = el('div', { class: 'roster-list' }, el('div', { class: 'field-hint', text: '加载花名册…' }));
  const { modal } = openModal(`${entry.className} · ${WEEKDAY_LABELS[entry.weekday]} ${entry.startTime}–${entry.endTime}`, [
    el(
      'p',
      {},
      [entry.danceType, entry.level].filter(Boolean).join(' · ') +
        (entry.teacherName ? ` · ${entry.teacherName}` : '') +
        (entry.room ? ` · 教室 ${entry.room}` : ''),
    ),
    rosterWrap,
    el(
      'div',
      { class: 'form-actions', style: 'justify-content:flex-start' },
      el('button', { class: 'btn btn-sm', onclick: () => openScheduleForm(entry.classId, entry) }, '编辑规则'),
      el('button', { class: 'btn btn-sm', onclick: () => openScheduleForm(entry.classId, null) }, '新增规则'),
      el(
        'button',
        {
          class: 'btn btn-sm btn-danger',
          onclick: async () => {
            if (!confirm('删除这条周期规则？已生成的排课实例不受影响。')) return;
            try {
              unwrap(await shell.course.scheduleDelete(entry.scheduleId));
              closeOverlays();
              toast('规则已删除');
              renderTimetable();
            } catch (e) {
              toast(e.message);
            }
          },
        },
        '删除规则',
      ),
    ),
  ]);
  try {
    const roster = unwrap(await shell.course.rosterList(entry.classId));
    rosterWrap.replaceChildren(
      ...(roster.length
        ? roster.map((m) =>
            el(
              'div',
              { class: 'roster-item' },
              el(
                'div',
                { class: 'r-main' },
                el('div', { class: 'r-name', text: m.name }),
                el('div', { class: 'r-sub', text: `${m.phone} · 剩 ${m.remainingLessons ?? 0} 节` }),
              ),
            ),
          )
        : [el('div', { class: 'field-hint', text: '这个班还没有学员。' })]),
    );
  } catch (e) {
    rosterWrap.replaceChildren(el('div', { class: 'field-hint', text: e.message }));
  }
  void modal;
}

function openScheduleForm(classId, existing) {
  const isEdit = !!existing;
  const f = {};
  f.weekday = field('星期', {
    type: 'select',
    value: existing ? String(existing.weekday) : String(new Date().getDay()),
    options: WEEKDAY_LABELS.map((label, w) => ({ value: String(w), label })),
  });
  f.startTime = field('开始', { type: 'time', value: existing?.startTime ?? '19:00' });
  f.endTime = field('结束', { type: 'time', value: existing?.endTime ?? '20:00' });
  f.teacherId = field('老师', {
    type: 'select',
    value: existing?.teacherId != null ? String(existing.teacherId) : '',
    options: [
      { value: '', label: '（跟随班主教）' },
      ...teacherCache.map((t) => ({ value: String(t.id), label: t.name })),
    ],
  });
  f.room = field('教室', { value: existing?.room ?? '', hint: '留空则跟随班级教室' });
  const fieldMap = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.wrap]));

  const banner = el('div', {});
  const submit = el('button', { class: 'btn btn-primary' }, isEdit ? '保存' : '新增');
  const { close } = openModal(isEdit ? '编辑周期规则' : '新增周期规则', [
    el('div', { class: 'field-grid' }, f.weekday.wrap, f.startTime.wrap, f.endTime.wrap, f.teacherId.wrap),
    f.room.wrap,
    banner,
  ], [el('button', { class: 'btn', onclick: () => close() }, '取消'), submit]);

  submit.addEventListener('click', async () => {
    const input = {
      classId,
      weekday: Number(f.weekday.input.value),
      startTime: f.startTime.input.value,
      endTime: f.endTime.input.value,
      teacherId: f.teacherId.input.value ? Number(f.teacherId.input.value) : null,
      room: f.room.input.value.trim() || null,
    };
    submit.disabled = true;
    banner.replaceChildren();
    try {
      const res = isEdit
        ? unwrap(await shell.course.scheduleUpdate(existing.scheduleId, input))
        : unwrap(await shell.course.scheduleCreate(input));
      if (res.conflicts && res.conflicts.length) {
        // 冲突非阻断：规则已保存，仅提示
        banner.replaceChildren(
          el(
            'div',
            { class: 'warn-banner' },
            el('span', { class: 'dot' }),
            `已保存，但与 ${res.conflicts
              .map((c) => `${c.label}（${c.kind}冲突 ${c.startTime}–${c.endTime}）`)
              .join('、')} 时段重叠`,
          ),
        );
        submit.textContent = '知道了';
        submit.disabled = false;
        submit.onclick = () => {
          close();
          renderTimetable();
        };
        return;
      }
      close();
      toast(isEdit ? '规则已保存' : '规则已新增');
      renderTimetable();
    } catch (e) {
      submit.disabled = false;
      if (e.code === 'VALIDATION_FAILED') paintErrors(fieldMap, e.fields);
      else if (e.code === 'INVALID_WEEKDAY') paintErrors(fieldMap, { weekday: e.message });
      else if (e.code === 'INVALID_TIME_RANGE') paintErrors(fieldMap, { endTime: e.message });
      else toast(e.message);
    }
  });
}

/* ═════════════════════════ 占位视图（#52 替换） ═════════════════════════ */

function renderTeacherPlanPlaceholder() {
  renderTabs('#/teacher-plan');
  view.replaceChildren(
    el(
      'div',
      { class: 'empty' },
      el('strong', { text: '上课时间计划表' }),
      '老师按月的排课视图将在后续版本接入。',
    ),
  );
}

/* ───────────────────────── 路由 ───────────────────────── */

function route() {
  closeOverlays();
  const hash = location.hash || '#/classes';
  const run = (fn) =>
    Promise.resolve()
      .then(fn)
      .catch((e) => {
        console.error(e);
        view.replaceChildren(el('div', { class: 'empty', text: `出错了：${e.message}` }));
      });

  if (hash.startsWith('#/teachers')) run(renderTeachers);
  else if (hash.startsWith('#/timetable')) run(renderTimetable);
  else if (hash.startsWith('#/teacher-plan')) run(renderTeacherPlanPlaceholder);
  else run(renderClasses);
}

window.addEventListener('hashchange', route);
route();
