/**
 * 库存管理渲染器（单页 + hash 路由）。
 *
 * 整体类比：这一个页面是「仓库前台」，靠地址栏 # 后面的门牌切换柜台：
 *   #/items            物件台账（列表）
 *   #/items/new        新建物件            （#27 接入）
 *   #/items/:id        物件详情            （#27 接入）
 *   #/items/:id/edit   编辑物件            （#27 接入）
 *   #/allocate         分配给学员          （#28 接入）
 *   #/allocations      领用流水            （#29 接入）
 *
 * 数据一律经 window.studioShell.inventory.*（preload 暴露的窄接口）向主进程要，
 * 本文件不碰任何 Node / 文件系统能力。权威校验在主进程，页面里只做即时提示。
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
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
}

/** 物件名首字符作头像占位。 */
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

/* ───────────────────────── 物件列表视图 ───────────────────────── */

const listState = { search: '', category: '' };
let searchDebounce = null;

function hasActiveFilter() {
  return listState.search.trim() !== '' || listState.category !== '';
}

async function renderItems() {
  // 分类下拉的候选项：拉一份（几乎）全量，收集去重的非空分类。
  // 单机数百物件，一次多取可接受；分类是自由文本、无字典表，只能这样发现。
  let categories = [];
  try {
    const all = unwrap(await shell.inventory.listItems({ limit: 1000 }));
    categories = [...new Set(all.rows.map((r) => r.category).filter((c) => c && c.trim()))].sort(
      (a, b) => a.localeCompare(b, 'zh'),
    );
  } catch {
    categories = [];
  }
  // 当前选中的分类若已不存在（物件都删了 / 改名了），回退到「全部」
  if (listState.category && !categories.includes(listState.category)) listState.category = '';

  const search = el('input', {
    class: 'toolbar-search',
    type: 'search',
    placeholder: '搜索物件名…',
    value: listState.search,
    'aria-label': '搜索物件',
  });
  search.addEventListener('input', () => {
    listState.search = search.value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => void refreshItems(), 150);
  });

  const categorySelect = el(
    'select',
    { class: 'toolbar-select', 'aria-label': '按分类筛选' },
    el('option', { value: '' }, '全部分类'),
    ...categories.map((c) => el('option', { value: c, selected: c === listState.category || null }, c)),
  );
  categorySelect.addEventListener('change', () => {
    listState.category = categorySelect.value;
    void refreshItems();
  });

  view.replaceChildren(
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', { class: 'page-title', text: '库存管理' }),
        el('p', { class: 'page-sub', id: 'items-count', text: '载入中…' }),
      ),
      el('div', { class: 'detail-actions' },
        el('button', {
          class: 'btn btn-primary',
          type: 'button',
          onclick: () => { location.hash = '#/items/new'; },
        }, '＋ 新建物件'),
      ),
    ),
    el('div', { class: 'toolbar' }, search, categorySelect),
    el('div', { id: 'items-banner' }),
    el('div', { class: 'list', id: 'items-body' }),
  );

  await refreshItems();
}

/** 只刷新列表主体 + 计数 + 低库存条，不动工具条（保住搜索框焦点）。 */
async function refreshItems() {
  const body = document.getElementById('items-body');
  const countEl = document.getElementById('items-count');
  const bannerEl = document.getElementById('items-banner');
  if (!body) return;

  let result;
  try {
    result = unwrap(await shell.inventory.listItems({
      search: listState.search.trim() || undefined,
      category: listState.category || undefined,
    }));
  } catch (e) {
    if (countEl) countEl.textContent = '';
    if (bannerEl) bannerEl.replaceChildren();
    body.replaceChildren(
      el('div', { class: 'empty' },
        el('strong', { text: '数据加载失败' }),
        el('span', { text: e.message }),
      ),
    );
    return;
  }

  const { rows, total, lowStockCount } = result;

  if (countEl) {
    countEl.textContent = hasActiveFilter() ? `筛选到 ${total} 种物件` : `共 ${total} 种物件`;
  }

  if (bannerEl) {
    bannerEl.replaceChildren(
      lowStockCount > 0
        ? el('div', { class: 'lowstock-banner', role: 'status' },
            el('span', { class: 'dot', 'aria-hidden': 'true' }),
            `${lowStockCount} 个物件库存偏低`,
          )
        : el('span'),
    );
  }

  if (rows.length === 0) {
    body.replaceChildren(
      hasActiveFilter()
        ? el('div', { class: 'empty' },
            el('strong', { text: '没有符合筛选的物件' }),
            el('span', { text: '换个关键词或清掉分类筛选试试。' }),
          )
        : el('div', { class: 'empty' },
            el('strong', { text: '还没有物件' }),
            el('span', { text: '点击右上角「新建物件」录入第一件物资。' }),
          ),
    );
    return;
  }

  body.replaceChildren(
    ...rows.map((it) => {
      const low = it.quantity <= it.lowStockThreshold;
      const meta = [it.category, it.unit].filter((x) => x && String(x).trim()).join(' · ');
      return el('button', {
        class: 'student-row',
        type: 'button',
        dataset: { id: String(it.id) },
        onclick: () => { location.hash = `#/items/${it.id}`; },
      },
        el('div', { class: 'avatar', 'aria-hidden': 'true', text: initial(it.name) }),
        el('div', { class: 'row-main' },
          el('div', { class: 'row-name', text: it.name }),
          meta ? el('div', { class: 'row-meta', text: meta }) : null,
        ),
        low ? el('span', { class: 'low-badge' },
          el('span', { class: 'dot', 'aria-hidden': 'true',
            style: 'width:6px;height:6px;border-radius:999px;background:currentColor' }),
          '库存偏低',
        ) : null,
        el('span', { class: 'row-qty', text: `剩 ${it.quantity} ${it.unit || '件'}` }),
      );
    }),
  );
}

/* ───────────────────────── 新建 / 编辑物件表单 ───────────────────────── */

/** 表单字段定义：key 与主进程校验 errors 的 key 一一对应。 */
const ITEM_FIELDS = [
  { key: 'name', label: '物件名', required: true, type: 'text', placeholder: '如：练功服（女·S）' },
  { key: 'category', label: '分类', type: 'text', placeholder: '如：服装 / 器材 / 教材（可留空）' },
  { key: 'unit', label: '单位', type: 'text', placeholder: '件' },
  { key: 'quantity', label: '库存数量', type: 'number', min: 0, step: 1 },
  { key: 'lowStockThreshold', label: '预警阈值', type: 'number', min: 0, step: 1,
    hint: '库存低于等于此值时，列表标「库存偏低」' },
  { key: 'note', label: '备注', type: 'textarea' },
];

function itemFieldControl(f, initialValue) {
  const common = { id: `f-${f.key}`, name: f.key };
  if (f.type === 'textarea') {
    return el('textarea', { ...common, rows: 3, text: initialValue == null ? '' : String(initialValue) });
  }
  const inp = el('input', {
    ...common,
    type: f.type === 'number' ? 'number' : 'text',
    value: initialValue == null ? '' : String(initialValue),
    placeholder: f.placeholder || null,
  });
  if (f.type === 'number') {
    if (f.min != null) inp.min = String(f.min);
    if (f.step != null) inp.step = String(f.step);
    inp.inputMode = 'numeric';
  }
  return inp;
}

async function renderItemForm(opts) {
  const isEdit = opts.mode === 'edit';
  const item = opts.item || null;

  const form = el('form', { id: 'item-form', novalidate: 'novalidate' });
  const fieldset = el('fieldset', { class: 'form-group' },
    el('legend', { text: isEdit ? '编辑物件' : '新建物件' }),
  );

  for (const f of ITEM_FIELDS) {
    const initial = isEdit && item ? item[f.key] : undefined;
    const control = itemFieldControl(f, initial);
    fieldset.appendChild(
      el('div', { class: 'field', dataset: { key: f.key } },
        el('label', { for: `f-${f.key}` }, f.label, f.required ? el('span', { class: 'req', text: '＊' }) : null),
        control,
        f.hint ? el('div', { class: 'field-hint', text: f.hint }) : null,
        el('div', { class: 'field-error' }),
      ),
    );
  }

  form.appendChild(fieldset);
  const cancelHash = isEdit && item ? `#/items/${item.id}` : '#/items';
  form.appendChild(
    el('div', { class: 'form-actions' },
      el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { location.hash = cancelHash; } }, '取消'),
      el('button', { class: 'btn btn-primary', type: 'submit' }, '保存'),
    ),
  );

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void submitItemForm(form, { isEdit, id: item ? item.id : null });
  });

  view.replaceChildren(
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', { class: 'page-title', text: isEdit && item ? `编辑 · ${item.name}` : '新建物件' }),
        el('p', { class: 'page-sub', text: '带 ＊ 的为必填项' }),
      ),
    ),
    form,
  );
}

function clearItemErrors(form) {
  for (const fld of form.querySelectorAll('.field.has-error')) fld.classList.remove('has-error');
  for (const slot of form.querySelectorAll('.field .field-error')) slot.textContent = '';
}

function showItemErrors(form, fields) {
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

/** 读一个表单控件的值：数字框空 → undefined（编辑时表示「不改」），否则 Number()。 */
function readItemField(form, f) {
  const node = form.elements[f.key];
  const raw = (node && node.value != null ? node.value : '').trim();
  if (f.type === 'number') return raw === '' ? undefined : Number(raw);
  return raw;
}

async function submitItemForm(form, ctx) {
  clearItemErrors(form);
  const input = {};
  for (const f of ITEM_FIELDS) input[f.key] = readItemField(form, f);

  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const res = ctx.isEdit
      ? unwrap(await shell.inventory.updateItem(ctx.id, input))
      : unwrap(await shell.inventory.createItem(input));
    toast('已保存');
    location.hash = `#/items/${res.id}`;
  } catch (e) {
    if (e.code === 'VALIDATION_FAILED' && e.fields) {
      showItemErrors(form, e.fields);
      toast('请检查表单填写');
    } else if (e.code === 'ITEM_NAME_CONFLICT') {
      showItemErrors(form, { name: '物件已存在' });
      toast('物件名重复');
    } else if (e.code === 'NOT_FOUND') {
      toast('物件不存在，可能已被删除');
      location.hash = '#/items';
    } else {
      toast(`保存失败：${e.message}`);
    }
  } finally {
    btn.disabled = false;
  }
}

/* ───────────────────────── 物件详情 ───────────────────────── */

function dlRow(label, value, isEmpty) {
  return el('div', { class: 'dl-row' },
    el('dt', { text: label }),
    el('dd', { class: isEmpty ? 'is-empty' : null, text: isEmpty ? '—' : String(value) }),
  );
}

async function renderItemDetail(id) {
  view.replaceChildren(el('div', { text: '载入物件…' }));

  let item;
  let allocations = [];
  try {
    item = unwrap(await shell.inventory.getItem(id));
  } catch (e) {
    view.replaceChildren(
      el('div', { class: 'empty' },
        el('strong', { text: e.code === 'NOT_FOUND' ? '找不到这件物件' : '加载失败' }),
        el('span', { text: e.message }),
        el('div', { style: 'margin-top:14px' },
          el('button', { class: 'btn', type: 'button', onclick: () => { location.hash = '#/items'; } }, '返回列表'),
        ),
      ),
    );
    return;
  }
  try {
    allocations = unwrap(await shell.inventory.allocations({ itemId: id, limit: 200 })).rows;
  } catch {
    allocations = [];
  }

  const low = item.quantity <= item.lowStockThreshold;
  const deleted = item.deletedAt != null;

  const head = el('div', { class: 'page-head' },
    el('div', {},
      el('h1', { class: 'page-title', text: item.name }),
      el('p', { class: 'page-sub', text: deleted ? '此物件已删除（仅历史可见）' : `当前库存 ${item.quantity} ${item.unit}` }),
    ),
    el('div', { class: 'detail-actions' },
      !deleted && item.quantity > 0 && el('button', { class: 'btn btn-primary', type: 'button', onclick: () => { location.hash = `#/allocate/${id}`; } }, '分配'),
      !deleted && el('button', { class: 'btn', type: 'button', onclick: () => { location.hash = `#/items/${id}/edit`; } }, '编辑'),
      !deleted && el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => void confirmDeleteItem(item) }, '删除'),
      el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { location.hash = '#/items'; } }, '返回列表'),
    ),
  );

  const info = el('section', { class: 'detail-group open' },
    el('div', { class: 'detail-group-head' }, el('span', { text: '物件信息' })),
    el('dl', { class: 'detail-group-body' },
      dlRow('物件名', item.name, false),
      dlRow('分类', item.category, !item.category),
      dlRow('单位', item.unit, false),
      el('div', { class: 'dl-row' },
        el('dt', { text: '当前库存' }),
        el('dd', {},
          `${item.quantity} ${item.unit}`,
          low ? el('span', { class: 'low-badge', style: 'margin-left:8px' }, '库存偏低') : null,
        ),
      ),
      dlRow('预警阈值', item.lowStockThreshold, false),
      dlRow('备注', item.note, !item.note),
    ),
  );

  const historyRows = allocations.length
    ? allocations.map((a) =>
        el('div', { class: 'student-row', style: 'cursor:default' },
          el('div', { class: 'row-main' },
            el('div', { class: 'row-name', text: a.studentName }),
            el('div', { class: 'row-meta', text: `${a.claimedAt}${a.note ? ' · ' + a.note : ''}` }),
          ),
          el('span', { class: 'row-qty', text: `领 ${a.quantity} ${item.unit}` }),
        ),
      )
    : [el('div', { class: 'empty' }, el('strong', { text: '暂无领用记录' }))];

  const history = el('section', { class: 'detail-group open' },
    el('div', { class: 'detail-group-head' }, el('span', { text: `领用历史（${allocations.length}）` })),
    el('div', { class: 'detail-group-body', style: 'grid-template-columns:1fr; gap:8px' }, ...historyRows),
  );

  view.replaceChildren(head, info, history);
}

async function confirmDeleteItem(item) {
  const yes = window.confirm(
    `确定要删除物件「${item.name}」吗？\n\n删除后不在列表显示，但已有的领用记录与导出仍可见（数据保留在库中）。`,
  );
  if (!yes) return;
  try {
    unwrap(await shell.inventory.deleteItem(item.id));
    toast('已删除');
    location.hash = '#/items';
  } catch (e) {
    toast(e.code === 'NOT_FOUND' ? '该物件已被删除' : `删除失败：${e.message}`);
    location.hash = '#/items';
  }
}

/* ───────────────────────── 分配物件给学员 ───────────────────────── */

/** 本地今天，YYYY-MM-DD（date input 的 value 格式）。 */
function todayInput() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function renderAllocateForm(preItemId) {
  view.replaceChildren(el('div', { text: '载入…' }));

  let items = [];
  let students = [];
  try {
    [items, students] = await Promise.all([
      shell.inventory.listItems({ limit: 1000 }).then((r) => unwrap(r).rows),
      shell.students.list({ limit: 2000 }).then((r) => unwrap(r).rows),
    ]);
  } catch (e) {
    view.replaceChildren(
      el('div', { class: 'empty' }, el('strong', { text: '加载失败' }), el('span', { text: e.message })),
    );
    return;
  }

  const sellable = items.filter((it) => it.deletedAt == null && it.quantity > 0);

  const head = el('div', { class: 'page-head' },
    el('div', {},
      el('h1', { class: 'page-title', text: '分配物件' }),
      el('p', { class: 'page-sub', text: '给学员发放物件，库存自动扣减' }),
    ),
    el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { location.hash = '#/items'; } }, '返回列表'),
  );

  if (sellable.length === 0 || students.length === 0) {
    view.replaceChildren(head,
      el('div', { class: 'empty' },
        el('strong', { text: sellable.length === 0 ? '没有可分配的物件' : '还没有学员' }),
        el('span', {
          text: sellable.length === 0
            ? '所有物件库存都为 0，请先补货或新建物件。'
            : '请先到「学员档案」录入学员。',
        }),
      ),
    );
    return;
  }

  const itemSel = el('select', { id: 'f-itemId', name: 'itemId' },
    el('option', { value: '' }, '请选择物件'),
    ...sellable.map((it) =>
      el('option', {
        value: String(it.id),
        selected: preItemId && Number(preItemId) === it.id ? 'selected' : null,
      }, `${it.name}（剩 ${it.quantity} ${it.unit}）`),
    ),
  );
  const studentSel = el('select', { id: 'f-studentId', name: 'studentId' },
    el('option', { value: '' }, '请选择学员'),
    ...students.map((s) =>
      el('option', { value: String(s.id) }, `${s.name}${s.phonePrimary ? ' · ' + s.phonePrimary : ''}`),
    ),
  );
  const qtyInp = el('input', { id: 'f-quantity', name: 'quantity', type: 'number', min: '1', step: '1', value: '1', inputmode: 'numeric' });
  const dateInp = el('input', { id: 'f-claimedAt', name: 'claimedAt', type: 'date', value: todayInput() });
  const noteInp = el('textarea', { id: 'f-note', name: 'note', rows: 2 });

  const field = (key, label, control, hint) =>
    el('div', { class: 'field', dataset: { key } },
      el('label', { for: `f-${key}` }, label),
      control,
      hint ? el('div', { class: 'field-hint', text: hint }) : null,
      el('div', { class: 'field-error' }),
    );

  const form = el('form', { id: 'allocate-form', novalidate: 'novalidate' },
    el('fieldset', { class: 'form-group' },
      el('legend', { text: '领用登记' }),
      field('itemId', '物件', itemSel),
      field('studentId', '学员', studentSel),
      field('quantity', '领取数量', qtyInp),
      field('claimedAt', '领取日期', dateInp),
      field('note', '备注', noteInp),
    ),
    el('div', { class: 'form-actions' },
      el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { location.hash = '#/items'; } }, '取消'),
      el('button', { class: 'btn btn-primary', type: 'submit' }, '确认分配'),
    ),
  );

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void submitAllocate(form);
  });

  view.replaceChildren(head, form);
}

async function submitAllocate(form) {
  clearItemErrors(form);
  const g = (k) => (form.elements[k] && form.elements[k].value != null ? form.elements[k].value : '').trim();
  const input = {
    itemId: g('itemId') === '' ? undefined : Number(g('itemId')),
    studentId: g('studentId') === '' ? undefined : Number(g('studentId')),
    quantity: g('quantity') === '' ? undefined : Number(g('quantity')),
    claimedAt: g('claimedAt'),
    note: g('note'),
  };

  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const { itemId } = input;
    const { remaining } = unwrap(await shell.inventory.allocate(input));
    toast(`已分配，该物件剩 ${remaining}`);
    location.hash = `#/items/${itemId}`;
  } catch (e) {
    if ((e.code === 'VALIDATION_FAILED' || e.code === 'INSUFFICIENT_STOCK') && e.fields) {
      showItemErrors(form, e.fields);
      toast(e.code === 'INSUFFICIENT_STOCK' ? '库存不足' : '请检查表单填写');
    } else if (e.code === 'INSUFFICIENT_STOCK') {
      showItemErrors(form, { quantity: '库存不足' });
      toast('库存不足');
    } else if (e.code === 'NOT_FOUND') {
      toast('物件不存在，可能已被删除');
      location.hash = '#/items';
    } else {
      toast(`分配失败：${e.message}`);
    }
  } finally {
    btn.disabled = false;
  }
}

/* ───────────────────────── 尚未接入的视图（占位） ─────────────────────────
   #/allocations（#29）在后续 issue 里实现。 */

function renderStub(title) {
  view.replaceChildren(
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', { class: 'page-title', text: title }),
        el('p', { class: 'page-sub', text: '此功能即将上线。' }),
      ),
      el('button', { class: 'btn', type: 'button', onclick: () => { location.hash = '#/items'; } }, '返回物件列表'),
    ),
    el('div', { class: 'empty' },
      el('strong', { text: '开发中' }),
      el('span', { text: '返回「库存管理 → 物件列表」继续。' }),
    ),
  );
}

/* ───────────────────────── 路由 ───────────────────────── */

function parseRoute() {
  const raw = (location.hash || '#/items').replace(/^#/, '');
  const parts = raw.split('/').filter(Boolean); // ['items','12','edit'] / ['allocate']
  return { head: parts[0] || 'items', id: parts[1] || null, sub: parts[2] || null };
}

async function route() {
  const { head, id, sub } = parseRoute();
  try {
    if (head === 'allocate') return await renderAllocateForm(id);
    if (head === 'allocations') return renderStub('领用流水');
    if (head === 'items' && id === 'new') return await renderItemForm({ mode: 'new' });
    if (head === 'items' && id && sub === 'edit') {
      const item = unwrap(await shell.inventory.getItem(Number(id)));
      return await renderItemForm({ mode: 'edit', item });
    }
    if (head === 'items' && id) return await renderItemDetail(Number(id));
    return await renderItems();
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
