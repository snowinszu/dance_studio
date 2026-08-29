/**
 * 学员档案渲染器（单页 + hash 路由）。
 *
 * 整体类比：这一个页面就是一间「档案室」，靠地址栏 # 后面的门牌切换房间：
 *   #/list        档案架（列表）
 *   #/new         新建登记台
 * 数据一律通过 window.studioShell.*（preload 暴露的窄接口）向主进程要，
 * 本文件不碰任何 Node / 文件系统能力。
 *
 * 渲染层不参与 TypeScript 构建，所以这里是手写 ES module；数据的“权威校验”
 * 在主进程，页面里的即时提示只为体验。
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

/** 下划线 → 驼峰（birth_date → birthDate），与主进程 validation.toCamel 保持一致。 */
function toCamel(key) {
  return key.replace(/_([a-z])/g, (_m, c) => c.toUpperCase());
}

let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

/** 姓名首字符作头像占位。 */
function initial(name) {
  return (name || '').trim().charAt(0) || '?';
}

/** 统一处理 IpcResult 信封：ok 返回 data，否则抛带 fields 的错误。 */
function unwrap(res) {
  if (res && res.ok) return res.data;
  const err = (res && res.error) || { code: 'DB_ERROR', message: '未知错误' };
  const e = new Error(err.message || '操作失败');
  e.code = err.code;
  e.fields = err.fields || null;
  throw e;
}

/* ───────────────────────── 列表视图 ───────────────────────── */

const STATUS_OPTIONS = ['在读', '请假', '停课', '毕业', '流失'];

/** 列表页的筛选状态，跨 refreshList 调用保留（离开列表页不重置）。 */
const listState = { search: '', statuses: [], tagIds: [] };

/** 当前是否有任何筛选生效（用于区分两种空态）。 */
function hasActiveFilter() {
  return (
    listState.search.trim().length > 0 ||
    listState.statuses.length > 0 ||
    listState.tagIds.length > 0
  );
}

let searchDebounce = null;

async function renderList() {
  let tags = [];
  try {
    tags = unwrap(await shell.tags.list());
  } catch {
    tags = [];
  }
  // 清掉已被删除的标签 id
  const tagIdSet = new Set(tags.map((t) => t.id));
  listState.tagIds = listState.tagIds.filter((id) => tagIdSet.has(id));
  const search = el('input', {
    class: 'toolbar-search',
    type: 'search',
    placeholder: '搜索姓名或电话…',
    value: listState.search,
    'aria-label': '搜索学员',
  });
  search.addEventListener('input', () => {
    listState.search = search.value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => void refreshList(), 150);
  });

  const toggleChip = (arr, val, ev) => {
    const i = arr.indexOf(val);
    if (i >= 0) arr.splice(i, 1);
    else arr.push(val);
    ev.currentTarget.classList.toggle('on');
    ev.currentTarget.setAttribute('aria-pressed', i >= 0 ? 'false' : 'true');
    void refreshList();
  };

  const statusBar = el('div', { class: 'status-filter' },
    ...STATUS_OPTIONS.map((st) =>
      el('button', {
        class: 'chip-toggle' + (listState.statuses.includes(st) ? ' on' : ''),
        type: 'button',
        'aria-pressed': listState.statuses.includes(st) ? 'true' : 'false',
        onclick: (ev) => toggleChip(listState.statuses, st, ev),
      }, st),
    ),
  );

  const tagBar = tags.length
    ? el('div', { class: 'status-filter' },
        ...tags.map((t) =>
          el('button', {
            class: 'chip-toggle' + (listState.tagIds.includes(t.id) ? ' on' : ''),
            type: 'button',
            'aria-pressed': listState.tagIds.includes(t.id) ? 'true' : 'false',
            style: tagChipStyle(t.color),
            onclick: (ev) => toggleChip(listState.tagIds, t.id, ev),
          }, t.name),
        ),
      )
    : null;

  view.replaceChildren(
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', { class: 'page-title', text: '学员档案' }),
        el('p', { class: 'page-sub', id: 'list-count', text: '载入中…' }),
      ),
      el('div', { class: 'detail-actions' },
        el('button', { class: 'btn', type: 'button', onclick: (ev) => void exportCurrentList(ev.currentTarget) }, '导出'),
        el('button', { class: 'btn', type: 'button', onclick: () => { location.hash = '#/import'; } }, '导入'),
        el('button', { class: 'btn', type: 'button', onclick: () => { location.hash = '#/tags'; } }, '标签管理'),
        el('button', { class: 'btn', type: 'button', onclick: () => { location.hash = '#/fields'; } }, '字段管理'),
        el('button', {
          class: 'btn btn-primary',
          type: 'button',
          onclick: () => { location.hash = '#/new'; },
        }, '＋ 新建学员'),
      ),
    ),
    el('div', { class: 'toolbar' }, search, statusBar),
    tagBar ? el('div', { class: 'toolbar toolbar-tags' }, tagBar) : null,
    el('div', { class: 'list', id: 'list-body' }),
  );

  await refreshList();
}

/** 把当前筛选结果导出为 xlsx。 */
async function exportCurrentList(btn) {
  btn.disabled = true;
  try {
    const { filePath, count } = unwrap(await shell.io.exportStudents({
      search: listState.search.trim() || undefined,
      status: listState.statuses.length ? [...listState.statuses] : undefined,
      tagIds: listState.tagIds.length ? [...listState.tagIds] : undefined,
    }));
    toast(`已导出 ${count} 条到 ${filePath}`);
  } catch (e) {
    if (e.code === 'IO_CANCELLED') return; // 用户取消，静默
    toast(`导出失败：${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

/** 只刷新列表主体 + 计数，不动工具条（保住搜索框焦点）。 */
async function refreshList() {
  const body = document.getElementById('list-body');
  const countEl = document.getElementById('list-count');
  if (!body) return;

  let result;
  try {
    result = unwrap(await shell.students.list({
      search: listState.search.trim() || undefined,
      status: listState.statuses.length ? [...listState.statuses] : undefined,
      tagIds: listState.tagIds.length ? [...listState.tagIds] : undefined,
    }));
  } catch (e) {
    if (countEl) countEl.textContent = '';
    body.replaceChildren(
      el('div', { class: 'empty' },
        el('strong', { text: '数据加载失败' }),
        el('span', { text: e.message }),
      ),
    );
    return;
  }

  const { rows, total } = result;
  if (countEl) countEl.textContent = hasActiveFilter() ? `筛选到 ${total} 名` : `共 ${total} 名学员`;

  if (rows.length === 0) {
    body.replaceChildren(
      hasActiveFilter()
        ? el('div', { class: 'empty' },
            el('strong', { text: '没有符合筛选的学员' }),
            el('span', { text: '换个关键词或清掉状态筛选试试。' }),
          )
        : el('div', { class: 'empty' },
            el('strong', { text: '还没有学员' }),
            el('span', { text: '点击右上角「新建学员」录入第一份档案。' }),
          ),
    );
    return;
  }

  body.replaceChildren(
    ...rows.map((s) =>
      el('button', {
        class: 'student-row',
        type: 'button',
        dataset: { id: String(s.id) },
        onclick: () => { location.hash = `#/s/${s.id}`; },
      },
        el('div', { class: 'avatar', 'aria-hidden': 'true', text: initial(s.name) }),
        el('div', { class: 'row-main' },
          el('div', { class: 'row-name', text: s.name }),
          el('div', { class: 'row-phone', text: s.phonePrimary || '—' }),
        ),
        el('span', { class: 'status-pill', dataset: { status: s.status } },
          el('span', { class: 'status-dot', 'aria-hidden': 'true' }),
          s.status,
        ),
      ),
    ),
  );
}

/* ───────────────────────── 新建 / 编辑表单视图 ───────────────────────── */

/**
 * 按字段类型渲染一个录入控件。
 * @param initial 编辑态的当前值（新建态为 undefined）
 * @returns { wrap, read } —— wrap 挂进 DOM，read() 取控件当前值
 */
function renderField(f, initial, isEdit) {
  const id = `f_${f.key}`;
  const labelChildren = [f.label];
  if (f.required) labelChildren.push(el('span', { class: 'req', 'aria-hidden': 'true', text: '＊' }));
  if (f.sensitive) labelChildren.push(el('span', { class: 'sens', text: '敏感' }));

  const hasInitial = initial !== undefined && initial !== null && initial !== '';
  let control;
  let read;

  switch (f.type) {
    case 'textarea':
      control = el('textarea', { id });
      if (hasInitial) control.value = String(initial);
      read = () => control.value;
      break;
    case 'number':
    case 'money':
      control = el('input', { id, type: 'number', step: f.type === 'money' ? '0.01' : 'any' });
      if (hasInitial) control.value = String(initial);
      read = () => control.value;
      break;
    case 'date':
      control = el('input', { id, type: 'date' });
      if (hasInitial) control.value = String(initial);
      read = () => control.value;
      break;
    case 'phone':
      control = el('input', { id, type: 'tel', inputmode: 'numeric', maxlength: '11', placeholder: '11 位手机号' });
      if (hasInitial) control.value = String(initial);
      read = () => control.value;
      break;
    case 'select': {
      // 必填的 select（当前只有「学员状态」）不给空选项
      const known = new Set(f.options);
      const opts = [...f.options];
      // 编辑态：历史值已不在候选项内时，补一个「已停用」占位项，保留原值
      if (hasInitial && !known.has(String(initial))) opts.push(String(initial));
      control = el('select', { id },
        ...(f.required ? [] : [el('option', { value: '', text: '（未选择）' })]),
        ...opts.map((o) =>
          el('option', { value: o, text: known.has(o) ? o : `${o}（已停用）` }),
        ),
      );
      if (hasInitial) control.value = String(initial);
      else if (f.required && f.options.length > 0) control.value = f.options[0];
      read = () => control.value;
      break;
    }
    case 'multiselect': {
      const picked = new Set(Array.isArray(initial) ? initial.map(String) : []);
      const known = new Set(f.options);
      const values = [...f.options, ...[...picked].filter((v) => !known.has(v))];
      control = el('div', { class: 'checks', id },
        ...values.map((o) =>
          el('label', {},
            el('input', { type: 'checkbox', value: o, ...(picked.has(o) ? { checked: 'checked' } : {}) }),
            known.has(o) ? o : `${o}（已停用）`,
          ),
        ),
      );
      read = () => [...control.querySelectorAll('input:checked')].map((c) => c.value);
      break;
    }
    case 'boolean':
      control = el('div', { class: 'checks', id },
        el('label', {},
          el('input', { type: 'checkbox', ...(initial === true || initial === 'true' ? { checked: 'checked' } : {}) }),
          '是',
        ),
      );
      read = () => control.querySelector('input').checked;
      break;
    default: // text
      control = el('input', { id, type: 'text' });
      if (hasInitial) control.value = String(initial);
      read = () => control.value;
  }

  // 编辑态：必填字段但当前无值 → 提示「待补充」（不阻塞打开，仅保存时校验拦截）
  const pending =
    isEdit && f.required && (initial === undefined || initial === null || initial === '' ||
      (Array.isArray(initial) && initial.length === 0));

  const wrap = el('div', { class: 'field', dataset: { key: f.key } },
    el('label', { for: id }, ...labelChildren,
      pending ? el('span', { class: 'sens', text: '待补充' }) : null,
    ),
    control,
    el('div', { class: 'field-error', 'aria-live': 'polite' }),
  );

  return { wrap, read };
}

/**
 * 渲染学员表单。
 * @param opts.mode 'new' | 'edit'
 * @param opts.student 编辑态传入当前档案（renderDetail 已取到）
 */
async function renderStudentForm(opts) {
  const isEdit = opts.mode === 'edit';
  const student = opts.student || null;

  view.replaceChildren(
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', { class: 'page-title', text: isEdit ? `编辑 · ${student ? student.name : ''}` : '新建学员' }),
        el('p', { class: 'page-sub', text: '带 ＊ 的为必填项' }),
      ),
    ),
    el('div', { id: 'form-body', text: '载入表单…' }),
  );

  let schema;
  try {
    schema = unwrap(await shell.fieldDefs.schema());
  } catch (e) {
    document.getElementById('form-body').textContent = `表单加载失败：${e.message}`;
    return;
  }

  /** 取某字段在编辑态下的初始值。 */
  const initialOf = (f) => {
    if (!isEdit || !student) return undefined;
    return f.origin === 'custom' ? (student.customFields || {})[f.key] : student[toCamel(f.key)];
  };

  const readers = new Map();
  const form = el('form', { id: 'student-form', novalidate: 'novalidate' });

  for (const group of schema.groups) {
    if (group.fields.length === 0) continue;
    const fieldset = el('fieldset', { class: 'form-group' }, el('legend', { text: group.label }));
    for (const f of group.fields) {
      const { wrap, read } = renderField(f, initialOf(f), isEdit);
      readers.set(f.key, { field: f, read });
      fieldset.appendChild(wrap);
    }
    form.appendChild(fieldset);
  }

  const cancelHash = isEdit && student ? `#/s/${student.id}` : '#/list';
  form.appendChild(
    el('div', { class: 'form-actions' },
      el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { location.hash = cancelHash; } }, '取消'),
      el('button', { class: 'btn btn-primary', type: 'submit' }, '保存'),
    ),
  );

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void submitForm(readers, form, { isEdit, id: student ? student.id : null });
  });

  document.getElementById('form-body').replaceChildren(form);
}

/** 清掉上一轮的字段级错误。 */
function clearErrors(form) {
  for (const fld of form.querySelectorAll('.field.has-error')) fld.classList.remove('has-error');
  for (const e of form.querySelectorAll('.field-error')) e.textContent = '';
}

/** 把 error.fields（key → 提示）画到对应字段下。 */
function showFieldErrors(form, fields) {
  let first = null;
  for (const [key, msg] of Object.entries(fields)) {
    const fld = form.querySelector(`.field[data-key="${CSS.escape(key)}"]`);
    if (!fld) continue;
    fld.classList.add('has-error');
    const slot = fld.querySelector('.field-error');
    if (slot) slot.textContent = msg;
    if (!first) first = fld;
  }
  if (first) first.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

async function submitForm(readers, form, ctx) {
  clearErrors(form);

  const input = { customFields: {} };
  for (const [key, { field, read }] of readers) {
    const val = read();
    if (field.origin === 'custom') {
      input.customFields[key] = val;
    } else {
      input[toCamel(key)] = val;
    }
  }

  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    const res = ctx.isEdit
      ? unwrap(await shell.students.update(ctx.id, input))
      : unwrap(await shell.students.create(input));
    toast('已保存');
    location.hash = `#/s/${res.id}`;
  } catch (e) {
    if (e.code === 'VALIDATION_FAILED' && e.fields) {
      showFieldErrors(form, e.fields);
      toast('请检查表单填写');
    } else if (e.code === 'NOT_FOUND') {
      toast('学员不存在，可能已被删除');
      location.hash = '#/list';
    } else {
      toast(`保存失败：${e.message}`);
    }
  } finally {
    submitBtn.disabled = false;
  }
}

/* ───────────────────────── 详情视图 ───────────────────────── */

/** 按当前日期算周岁：今年生日没到就减 1。 */
function ageFromBirthDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const now = new Date();
  let age = now.getFullYear() - y;
  const beforeBirthday =
    now.getMonth() + 1 < mo || (now.getMonth() + 1 === mo && now.getDate() < d);
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

/** 判断“空值”：null / undefined / 空串 / 空数组。 */
function isBlank(v) {
  return v == null || v === '' || (Array.isArray(v) && v.length === 0);
}

/** 某个取值是否已不在字段候选项内（选项被删过）。 */
function isStale(field, v) {
  return (
    (field.type === 'select' || field.type === 'multiselect') &&
    Array.isArray(field.options) &&
    field.options.length > 0 &&
    !field.options.includes(String(v))
  );
}

/** 把一个字段值渲染成 <dd> 内容。 */
function renderValue(field, value) {
  if (isBlank(value)) return el('dd', { class: 'is-empty', text: '—' });

  if (field.type === 'multiselect' || Array.isArray(value)) {
    const arr = Array.isArray(value) ? value : [value];
    return el('dd', {}, el('div', { class: 'chips' },
      ...arr.map((x) => el('span', { text: isStale(field, x) ? `${x}（已停用）` : String(x) })),
    ));
  }
  if (field.type === 'boolean') {
    return el('dd', { text: value === true || value === 'true' ? '是' : '否' });
  }
  if (field.key === 'birth_date') {
    const age = ageFromBirthDate(String(value));
    return el('dd', {},
      String(value),
      age != null ? el('span', { class: 'age-tag', text: `　·　年龄 ${age} 岁` }) : null,
    );
  }
  return el('dd', { text: isStale(field, value) ? `${value}（已停用）` : String(value) });
}

async function renderDetail(id) {
  view.replaceChildren(el('div', { text: '载入档案…' }));

  let student;
  let schema;
  let allTags;
  try {
    [student, schema, allTags] = await Promise.all([
      shell.students.get(id).then(unwrap),
      shell.fieldDefs.schema().then(unwrap),
      shell.tags.list().then(unwrap),
    ]);
  } catch (e) {
    view.replaceChildren(
      el('div', { class: 'empty' },
        el('strong', { text: e.code === 'NOT_FOUND' ? '找不到这名学员' : '加载失败' }),
        el('span', { text: e.message }),
        el('div', { style: 'margin-top:14px' },
          el('button', { class: 'btn', type: 'button', onclick: () => { location.hash = '#/list'; } }, '返回列表'),
        ),
      ),
    );
    return;
  }

  const head = el('div', { class: 'page-head' },
    el('div', {},
      el('h1', { class: 'page-title', text: student.name }),
      el('p', { class: 'page-sub', text: student.nickname ? `小名 ${student.nickname}` : `状态：${student.status}` }),
    ),
    el('div', { class: 'detail-actions' },
      el('button', { class: 'btn', type: 'button', onclick: () => { location.hash = `#/s/${id}/edit`; } }, '编辑'),
      el('button', {
        class: 'btn btn-ghost',
        type: 'button',
        onclick: () => void confirmDelete(student),
      }, '删除'),
    ),
  );

  const tagBar = el('div', { class: 'detail-tags' });
  renderTagBar(tagBar, id, student.tags || [], allTags);

  const groups = schema.groups
    .filter((g) => g.fields.length > 0)
    .map((g, idx) => {
      const body = el('dl', { class: 'detail-group-body' },
        ...g.fields.map((f) => {
          const value = f.origin === 'custom' ? student.customFields?.[f.key] : student[toCamel(f.key)];
          return el('div', { class: 'dl-row' }, el('dt', { text: f.label }), renderValue(f, value));
        }),
      );
      const section = el('section', { class: 'detail-group' + (idx === 0 ? ' open' : '') },
        el('button', { class: 'detail-group-head', type: 'button' },
          el('span', { text: g.label }),
          el('span', { class: 'chevron', 'aria-hidden': 'true', html: '▸' }),
        ),
        body,
      );
      // 窄屏手风琴：点标题切换本组展开（宽屏 CSS 强制展开、指针不响应）
      section.querySelector('.detail-group-head').addEventListener('click', () => {
        section.classList.toggle('open');
      });
      return section;
    });

  view.replaceChildren(head, tagBar, ...groups);
}

/** 颜色令牌 → 内联样式（chip 底色 + 文字色），无令牌时用中性色。 */
function tagChipStyle(color) {
  if (!color) return '';
  return `background: color-mix(in oklch, var(--${color}) 16%, var(--surface)); ` +
    `color: color-mix(in oklch, var(--${color}) 75%, black);`;
}

/** 在容器里渲染「学员标签条」：已打的标签 + 一个「添加」下拉，改动即写库。 */
function renderTagBar(container, studentId, current, allTags) {
  const currentIds = new Set(current.map((t) => t.id));

  const save = async (nextIds) => {
    try {
      const next = unwrap(await shell.tags.setForStudent(studentId, nextIds));
      renderTagBar(container, studentId, next, allTags);
    } catch (e) {
      toast(`标签更新失败：${e.message}`);
    }
  };

  const chips = current.map((t) =>
    el('span', { class: 'tag-chip removable', style: tagChipStyle(t.color) },
      t.name,
      el('button', {
        class: 'tag-x', type: 'button', 'aria-label': `移除标签 ${t.name}`,
        onclick: () => void save([...currentIds].filter((id) => id !== t.id)),
      }, '✕'),
    ),
  );

  const available = allTags.filter((t) => !currentIds.has(t.id));
  const adder = available.length
    ? (() => {
        const sel = el('select', { class: 'tag-add', 'aria-label': '添加标签' },
          el('option', { value: '', text: '＋ 添加标签' }),
          ...available.map((t) => el('option', { value: String(t.id), text: t.name })),
        );
        sel.addEventListener('change', () => {
          if (!sel.value) return;
          void save([...currentIds, Number(sel.value)]);
        });
        return sel;
      })()
    : null;

  const manage = el('button', {
    class: 'btn btn-ghost tag-manage', type: 'button',
    onclick: () => { location.hash = '#/tags'; },
  }, '管理标签');

  container.replaceChildren(
    ...(chips.length ? chips : [el('span', { class: 'tags-none', text: '未打标签' })]),
    adder,
    manage,
  );
}

/* ───────────────────────── 导入向导视图 ───────────────────────── */

async function renderImport() {
  view.replaceChildren(
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', { class: 'page-title', text: '批量导入' }),
        el('p', { class: 'page-sub', text: '从 Excel 导入学员；一律按新建处理，不按手机号去重' }),
      ),
      el('button', { class: 'btn', type: 'button', onclick: () => { location.hash = '#/list'; } }, '返回列表'),
    ),
    el('div', { id: 'imp-body' }),
  );

  let schema;
  try {
    schema = unwrap(await shell.fieldDefs.schema());
  } catch (e) {
    document.getElementById('imp-body').textContent = `加载失败：${e.message}`;
    return;
  }
  const fields = schema.groups.flatMap((g) => g.fields); // 预设 + 未归档自定义
  const body = document.getElementById('imp-body');

  const step1 = el('div', { class: 'form-group' },
    el('div', { class: 'group-title', text: '第 1 步：准备文件' }),
    el('p', { class: 'page-sub', text: '没有模板？先下载一个，按表头填好再回来选文件。' }),
    el('div', { class: 'form-actions', style: 'justify-content:flex-start' },
      el('button', {
        class: 'btn', type: 'button',
        onclick: async (ev) => {
          const btn = ev.currentTarget; // async 里 ev.currentTarget 会变 null，先抓住
          btn.disabled = true;
          try {
            const { filePath } = unwrap(await shell.io.downloadTemplate());
            toast(`模板已保存到 ${filePath}`);
          } catch (e) { if (e.code !== 'IO_CANCELLED') toast(`下载失败：${e.message}`); }
          finally { btn.disabled = false; }
        },
      }, '下载模板'),
      el('button', {
        class: 'btn btn-primary', type: 'button',
        onclick: async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          try {
            const preview = unwrap(await shell.io.pickImportFile());
            renderMapping(preview);
          } catch (e) { if (e.code !== 'IO_CANCELLED') toast(`读取失败：${e.message}`); }
          finally { btn.disabled = false; }
        },
      }, '选择文件…'),
    ),
  );
  body.replaceChildren(step1);

  function renderMapping(preview) {
    const { filePath, headers, sample } = preview;
    const selects = new Map(); // fieldKey -> <select>

    const rows = fields.map((f) => {
      const sel = el('select', {},
        el('option', { value: '', text: '（不导入）' }),
        ...headers.filter((h) => h).map((h) => el('option', { value: h, text: h })),
      );
      // 表头与字段显示名完全一致时自动选中
      if (headers.includes(f.label)) sel.value = f.label;
      sel.addEventListener('change', updateStartBtn);
      selects.set(f.key, sel);
      return el('tr', { dataset: { key: f.key } },
        el('td', {}, f.label, (f.key === 'name' || f.key === 'phone_primary')
          ? el('span', { class: 'req', text: ' ＊' }) : null),
        el('td', {}, sel),
      );
    });

    const startBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '开始导入');
    function currentMapping() {
      const m = {};
      for (const [key, sel] of selects) if (sel.value) m[key] = sel.value;
      return m;
    }
    function updateStartBtn() {
      const m = currentMapping();
      startBtn.disabled = !(m['name'] && m['phone_primary']);
    }
    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      try {
        const report = unwrap(await shell.io.importStudents({ filePath, mapping: currentMapping() }));
        renderReport(report);
      } catch (e) {
        toast(`导入失败：${e.message}`);
        startBtn.disabled = false;
      }
    });

    const sampleNote = sample.length
      ? el('p', { class: 'page-sub', text: `示例首行：${sample[0].filter(Boolean).slice(0, 6).join(' | ')}` })
      : null;

    body.replaceChildren(
      el('div', { class: 'form-group' },
        el('div', { class: 'group-title', text: '第 2 步：列映射' }),
        el('p', { class: 'page-sub', text: `文件：${filePath}` }),
        sampleNote,
        el('table', { class: 'map-table' },
          el('thead', {}, el('tr', {}, el('th', {}, '档案字段'), el('th', {}, '表格列'))),
          el('tbody', {}, ...rows),
        ),
        el('div', { class: 'form-actions' }, startBtn),
      ),
    );
    updateStartBtn();
  }

  function renderReport(report) {
    body.replaceChildren(
      el('div', { class: 'form-group' },
        el('div', { class: 'group-title', text: '导入完成' }),
        el('p', {}, `成功 ${report.created} 行，失败 ${report.failed} 行。`),
        report.failures.length
          ? el('div', { class: 'fa-list' },
              ...report.failures.map((f) =>
                el('div', { class: 'fa-item' }, el('div', { class: 'fa-meta', text: `第 ${f.row} 行：${f.reason}` })),
              ),
            )
          : null,
        el('div', { class: 'form-actions' },
          el('button', { class: 'btn btn-primary', type: 'button', onclick: () => { location.hash = '#/list'; } }, '完成'),
        ),
      ),
    );
  }
}

/* ───────────────────────── 标签管理视图 ───────────────────────── */

const TAG_COLORS = ['cc-1', 'cc-2', 'cc-3', 'cc-4', 'cc-5', 'cc-6'];

async function renderTagAdmin() {
  view.replaceChildren(
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', { class: 'page-title', text: '标签管理' }),
        el('p', { class: 'page-sub', text: '标签可用于给学员自由分类，并在列表页筛选' }),
      ),
      el('button', { class: 'btn', type: 'button', onclick: () => { location.hash = '#/list'; } }, '返回列表'),
    ),
    el('div', { id: 'tag-body', text: '载入中…' }),
  );

  let tags;
  try {
    tags = unwrap(await shell.tags.list());
  } catch (e) {
    document.getElementById('tag-body').textContent = `加载失败：${e.message}`;
    return;
  }

  const colorPicker = (selected, onPick) =>
    el('div', { class: 'color-picker' },
      ...TAG_COLORS.map((c) =>
        el('button', {
          class: 'color-dot' + (c === selected ? ' on' : ''),
          type: 'button',
          style: `background: var(--${c})`,
          'aria-label': `颜色 ${c}`,
          onclick: (ev) => {
            ev.currentTarget.parentElement.querySelectorAll('.color-dot').forEach((d) => d.classList.remove('on'));
            ev.currentTarget.classList.add('on');
            onPick(c);
          },
        }),
      ),
    );

  // 现有标签
  const listCard = el('div', { class: 'form-group' },
    el('div', { class: 'group-title', text: `标签（${tags.length}）` }),
    tags.length === 0
      ? el('p', { class: 'page-sub', text: '还没有标签。用下面的表单加一个。' })
      : el('div', { class: 'fa-list' },
          ...tags.map((t) => {
            let pendingColor = t.color;
            const nameInput = el('input', { type: 'text', maxlength: '20', value: t.name });
            const row = el('div', { class: 'fa-item' },
              el('div', { class: 'fa-row' },
                el('span', { class: 'tag-chip', style: tagChipStyle(t.color), text: t.name }),
                el('div', { class: 'fa-grow' },
                  nameInput,
                  colorPicker(t.color, (c) => { pendingColor = c; }),
                ),
                el('div', { class: 'fa-ops' },
                  el('button', {
                    class: 'btn btn-ghost', type: 'button',
                    onclick: async () => {
                      try {
                        unwrap(await shell.tags.update(t.id, { name: nameInput.value, color: pendingColor }));
                        toast('已保存');
                        await renderTagAdmin();
                      } catch (e) {
                        toast(e.code === 'TAG_NAME_CONFLICT' ? '标签已存在' : `保存失败：${e.message}`);
                      }
                    },
                  }, '保存'),
                  el('button', {
                    class: 'btn btn-ghost', type: 'button',
                    onclick: async () => {
                      if (!window.confirm(`删除标签「${t.name}」？\n\n所有学员身上的这个标签也会一并移除。`)) return;
                      try {
                        unwrap(await shell.tags.remove(t.id));
                        // 若正被列表筛选，摘掉它
                        const i = listState.tagIds.indexOf(t.id);
                        if (i >= 0) listState.tagIds.splice(i, 1);
                        toast('已删除');
                        await renderTagAdmin();
                      } catch (e) {
                        toast(`删除失败：${e.message}`);
                      }
                    },
                  }, '删除'),
                ),
              ),
            );
            return row;
          }),
        ),
  );

  // 新增标签
  let newColor = TAG_COLORS[0];
  const newName = el('input', { id: 'tag-name', type: 'text', maxlength: '20' });
  const addForm = el('form', { class: 'form-group', novalidate: 'novalidate' },
    el('div', { class: 'group-title', text: '新增标签' }),
    el('div', { class: 'field' }, el('label', { for: 'tag-name' }, '名称'), newName, el('div', { class: 'field-error' })),
    el('div', { class: 'field' }, el('label', {}, '颜色'), colorPicker(newColor, (c) => { newColor = c; })),
    el('div', { class: 'form-actions' }, el('button', { class: 'btn btn-primary', type: 'submit' }, '添加')),
  );
  addForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      unwrap(await shell.tags.create({ name: newName.value, color: newColor }));
      toast('已添加标签');
      await renderTagAdmin();
    } catch (e) {
      toast(e.code === 'TAG_NAME_CONFLICT' ? '标签已存在' : `添加失败：${e.message}`);
    }
  });

  document.getElementById('tag-body').replaceChildren(listCard, addForm);
}

/* ───────────────────────── 字段管理视图 ───────────────────────── */

const FIELD_TYPE_LABELS = [
  ['text', '单行文本'],
  ['textarea', '多行文本'],
  ['number', '数字'],
  ['date', '日期'],
  ['select', '单选'],
  ['multiselect', '多选'],
  ['boolean', '是否'],
  ['phone', '电话'],
  ['money', '金额'],
];
const GROUP_LABELS = [
  ['basic', '基本信息'],
  ['contact', '联系方式'],
  ['course', '课程与会员'],
  ['health', '健康与安全'],
  ['ops', '运营'],
];
const typeLabel = (t) => (FIELD_TYPE_LABELS.find(([k]) => k === t) || [t, t])[1];
const groupLabel = (g) => (GROUP_LABELS.find(([k]) => k === g) || [g, g])[1];

async function renderFieldAdmin() {
  view.replaceChildren(
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', { class: 'page-title', text: '字段管理' }),
        el('p', { class: 'page-sub', text: '预设字段不可改；自定义字段的值存入每位学员的档案' }),
      ),
      el('button', { class: 'btn', type: 'button', onclick: () => { location.hash = '#/list'; } }, '返回列表'),
    ),
    el('div', { id: 'fa-body', text: '载入中…' }),
  );

  let defs;
  try {
    defs = unwrap(await shell.fieldDefs.list({ includeArchived: true }));
  } catch (e) {
    document.getElementById('fa-body').textContent = `加载失败：${e.message}`;
    return;
  }

  const active = defs.filter((d) => !d.archived).sort((a, b) => a.sortOrder - b.sortOrder);
  const archived = defs.filter((d) => d.archived);

  /** 保存当前 DOM 里 .fa-item 的顺序到后端。 */
  async function persistOrder(container) {
    const ids = [...container.querySelectorAll('.fa-item')].map((n) => Number(n.dataset.id));
    try {
      unwrap(await shell.fieldDefs.reorder(ids));
      toast('顺序已保存');
    } catch (e) {
      toast(`排序失败：${e.message}`);
      await renderFieldAdmin();
    }
  }

  /** 渲染一行「查看态」的自定义字段。 */
  function activeItem(d) {
    const item = el('div', { class: 'fa-item', draggable: 'true', dataset: { id: String(d.id) } },
      el('div', { class: 'fa-row' },
        el('span', { class: 'fa-drag', 'aria-hidden': 'true', text: '⠿' }),
        el('div', { class: 'fa-grow' },
          el('div', {},
            el('span', { class: 'fa-name', text: d.label }),
            d.required ? el('span', { class: 'req', text: ' ＊' }) : null,
          ),
          el('div', { class: 'fa-meta', text: `${typeLabel(d.type)} · ${groupLabel(d.groupKey)} · ${d.fieldKey}` }),
          d.options && d.options.length
            ? el('div', { class: 'fa-meta', text: `选项：${d.options.join('、')}` })
            : null,
        ),
        el('div', { class: 'fa-ops' },
          el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => item.replaceWith(editItem(d)) }, '编辑'),
          el('button', {
            class: 'btn btn-ghost',
            type: 'button',
            onclick: async () => {
              if (!window.confirm(`归档字段「${d.label}」？\n\n归档后新档案不再显示此字段，已填写的历史数据会保留。`)) return;
              try { unwrap(await shell.fieldDefs.archive(d.id)); toast('已归档'); await renderFieldAdmin(); }
              catch (e) { toast(`归档失败：${e.message}`); }
            },
          }, '归档'),
        ),
      ),
    );

    // 拖拽排序
    item.addEventListener('dragstart', (ev) => {
      item.classList.add('dragging');
      ev.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      void persistOrder(item.parentElement);
    });
    item.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      const list = item.parentElement;
      const dragging = list.querySelector('.fa-item.dragging');
      if (!dragging || dragging === item) return;
      const rect = item.getBoundingClientRect();
      const after = ev.clientY > rect.top + rect.height / 2;
      list.insertBefore(dragging, after ? item.nextSibling : item);
    });

    return item;
  }

  /** 渲染一行「编辑态」的自定义字段。 */
  function editItem(d) {
    const isChoice = d.type === 'select' || d.type === 'multiselect';
    const eLabel = el('input', { type: 'text', maxlength: '40', value: d.label });
    const eGroup = el('select', {}, ...GROUP_LABELS.map(([v, t]) =>
      el('option', { value: v, text: t, ...(v === d.groupKey ? { selected: 'selected' } : {}) }),
    ));
    const eReq = el('input', { type: 'checkbox', ...(d.required ? { checked: 'checked' } : {}) });
    const eOpts = el('textarea', {}, (d.options || []).join('\n'));

    const box = el('div', { class: 'fa-item editing', dataset: { id: String(d.id) } },
      el('div', { class: 'field' }, el('label', {}, '显示名称'), eLabel, el('div', { class: 'field-error' })),
      el('div', { class: 'field' }, el('label', {}, `类型（不可改）`),
        el('input', { type: 'text', value: typeLabel(d.type), disabled: 'disabled' })),
      el('div', { class: 'field' }, el('label', {}, '所属分组'), eGroup, el('div', { class: 'field-error' })),
      el('div', { class: 'field' }, el('label', { class: 'checks' }, eReq, ' 必填')),
      isChoice
        ? el('div', { class: 'field' }, el('label', {}, '选项（每行一个）'), eOpts, el('div', { class: 'field-error' }))
        : null,
      el('div', { class: 'form-actions' },
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => box.replaceWith(activeItem(d)) }, '取消'),
        el('button', {
          class: 'btn btn-primary',
          type: 'button',
          onclick: async () => {
            const patch = { label: eLabel.value, groupKey: eGroup.value, required: eReq.checked };
            if (isChoice) patch.options = eOpts.value.split('\n').map((s) => s.trim()).filter(Boolean);
            try {
              unwrap(await shell.fieldDefs.update(d.id, patch));
              toast('已保存');
              await renderFieldAdmin();
            } catch (e) {
              if (e.code === 'VALIDATION_FAILED' && e.fields) showFieldErrors(box, e.fields);
              else toast(`保存失败：${e.message}`);
            }
          },
        }, '保存'),
      ),
    );
    return box;
  }

  const listCard = el('div', { class: 'form-group' },
    el('div', { class: 'group-title', text: `自定义字段（${active.length}）` }),
    active.length === 0
      ? el('p', { class: 'page-sub', text: '还没有自定义字段。用下面的表单加一个。' })
      : el('div', { class: 'fa-list' }, ...active.map(activeItem)),
    archived.length > 0
      ? el('div', { class: 'fa-archived' },
          el('div', { class: 'group-title', text: `已归档（${archived.length}）` }),
          ...archived.map((d) =>
            el('div', { class: 'fa-item archived', dataset: { id: String(d.id) } },
              el('div', { class: 'fa-row' },
                el('div', { class: 'fa-grow' },
                  el('span', { class: 'fa-name', text: d.label }),
                  el('div', { class: 'fa-meta', text: `${typeLabel(d.type)} · ${groupLabel(d.groupKey)} · ${d.fieldKey}` }),
                ),
                el('button', {
                  class: 'btn btn-ghost',
                  type: 'button',
                  onclick: async () => {
                    try { unwrap(await shell.fieldDefs.restore(d.id)); toast('已恢复'); await renderFieldAdmin(); }
                    catch (e) { toast(`恢复失败：${e.message}`); }
                  },
                }, '恢复'),
              ),
            ),
          ),
        )
      : null,
  );

  // —— 新增字段表单 ——
  const fLabel = el('input', { id: 'fa-label', type: 'text', maxlength: '40' });
  const fType = el('select', { id: 'fa-type' },
    ...FIELD_TYPE_LABELS.map(([v, t]) => el('option', { value: v, text: t })),
  );
  const fGroup = el('select', { id: 'fa-group' },
    ...GROUP_LABELS.map(([v, t]) => el('option', { value: v, text: t })),
  );
  const fRequired = el('input', { id: 'fa-required', type: 'checkbox' });
  const fOptions = el('textarea', { id: 'fa-options', placeholder: '每行一个选项' });
  const optionsField = el('div', { class: 'field', dataset: { key: 'options' }, hidden: 'hidden' },
    el('label', { for: 'fa-options' }, '选项（单选 / 多选用）'),
    fOptions,
    el('div', { class: 'field-error' }),
  );

  const syncOptionsVisibility = () => {
    optionsField.hidden = !(fType.value === 'select' || fType.value === 'multiselect');
  };
  fType.addEventListener('change', syncOptionsVisibility);
  syncOptionsVisibility();

  const mkField = (key, labelText, control) =>
    el('div', { class: 'field', dataset: { key } },
      el('label', { for: control.id }, labelText),
      control,
      el('div', { class: 'field-error' }),
    );

  const addForm = el('form', { class: 'form-group', id: 'fa-form', novalidate: 'novalidate' },
    el('div', { class: 'group-title', text: '新增字段' }),
    mkField('label', '显示名称', fLabel),
    mkField('type', '类型', fType),
    mkField('groupKey', '所属分组', fGroup),
    el('div', { class: 'field', dataset: { key: 'required' } },
      el('label', { class: 'checks' }, fRequired, ' 必填'),
    ),
    optionsField,
    el('div', { class: 'form-actions' },
      el('button', { class: 'btn btn-primary', type: 'submit' }, '添加字段'),
    ),
  );

  addForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    clearErrors(addForm);
    const type = fType.value;
    const payload = {
      label: fLabel.value,
      type,
      groupKey: fGroup.value,
      required: fRequired.checked,
    };
    if (type === 'select' || type === 'multiselect') {
      payload.options = fOptions.value.split('\n').map((s) => s.trim()).filter(Boolean);
    }
    const btn = addForm.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      unwrap(await shell.fieldDefs.create(payload));
      toast('已添加字段');
      await renderFieldAdmin();
    } catch (e) {
      if (e.code === 'VALIDATION_FAILED' && e.fields) showFieldErrors(addForm, e.fields);
      else toast(`添加失败：${e.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('fa-body').replaceChildren(listCard, addForm);
}

/** 删除前二次确认，确认后走软删除并回列表。 */
async function confirmDelete(student) {
  const yes = window.confirm(
    `确定要删除学员「${student.name}」吗？\n\n删除后将不在列表显示（数据仍保留在库中）。`,
  );
  if (!yes) return;
  try {
    unwrap(await shell.students.softDelete(student.id));
    toast('已删除');
    location.hash = '#/list';
  } catch (e) {
    toast(e.code === 'NOT_FOUND' ? '该学员已被删除' : `删除失败：${e.message}`);
    if (e.code === 'NOT_FOUND') location.hash = '#/list';
  }
}

/* ───────────────────────── 路由 ───────────────────────── */

function parseRoute() {
  const raw = (location.hash || '#/list').replace(/^#/, '');
  const parts = raw.split('/').filter(Boolean); // ['s','12','edit'] / ['new'] / ['list']
  return { head: parts[0] || 'list', id: parts[1] || null, sub: parts[2] || null };
}

async function route() {
  const { head, id, sub } = parseRoute();
  try {
    if (head === 'fields') return await renderFieldAdmin();
    if (head === 'tags') return await renderTagAdmin();
    if (head === 'import') return await renderImport();
    if (head === 'new') return await renderStudentForm({ mode: 'new' });
    if (head === 's' && id) {
      if (sub === 'edit') {
        const student = unwrap(await shell.students.get(Number(id)));
        return await renderStudentForm({ mode: 'edit', student });
      }
      return await renderDetail(Number(id));
    }
    return await renderList();
  } catch (e) {
    view.replaceChildren(
      el('div', { class: 'empty' },
        el('strong', { text: '页面出错了' }),
        el('span', { text: e.message }),
      ),
    );
  }
}

window.addEventListener('hashchange', () => { void route(); });
void route();
