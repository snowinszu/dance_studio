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
        el('button', { class: 'btn', type: 'button', onclick: (ev) => void exportItemsXlsx(ev.currentTarget) }, '导出台账'),
        el('button', { class: 'btn', type: 'button', onclick: () => { location.hash = '#/import'; } }, '导入台账'),
        el('button', { class: 'btn', type: 'button', onclick: () => { location.hash = '#/allocations'; } }, '领用流水'),
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

/** 把当前筛选到的物件台账导出为 xlsx。 */
async function exportItemsXlsx(btn) {
  btn.disabled = true;
  try {
    const { filePath, count } = unwrap(await shell.inventory.exportItems({
      search: listState.search.trim() || undefined,
      category: listState.category || undefined,
    }));
    toast(`已导出 ${count} 种物件到 ${filePath}`);
  } catch (e) {
    if (e.code === 'IO_CANCELLED') return; // 用户取消，静默
    toast(`导出失败：${e.message}`);
  } finally {
    btn.disabled = false;
  }
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

/**
 * 关键字搜索选学员的选择器：搜索框（防抖 220ms + 中文输入法 compositionend 处理，
 * 同 attendance.js 的花名册搜索）+ 候选卡片列表；选中后收起成一条「已选」摘要，
 * 点「更换」再展开搜索。用一个隐藏 input 兜住 studentId，让外层表单原有的
 * `form.elements.studentId.value` 读取方式不用跟着改。
 *
 * 替换掉原来「一次拉 2000 个学员塞进 &lt;select&gt;」的做法——学员一多，下拉就没法用了。
 */
function studentPicker() {
  const state = { keyword: '', picked: null, candidates: [], searching: false };
  let deb = null;
  const idInput = el('input', { type: 'hidden', name: 'studentId', value: '' });
  const body = el('div', { class: 'student-picker' });

  const doSearch = async () => {
    const kw = state.keyword.trim();
    if (!kw) {
      state.candidates = [];
      paint();
      return;
    }
    state.searching = true;
    try {
      state.candidates = unwrap(await shell.students.list({ search: kw, limit: 20 })).rows;
    } catch (err) {
      toast(err.message);
      state.candidates = [];
    }
    state.searching = false;
    paint();
  };

  function paint() {
    if (state.picked) {
      const p = state.picked;
      idInput.value = String(p.id);
      body.replaceChildren(
        el('div', { class: 'candidate picked picked-static' },
          el('div', { class: 'c-main' },
            el('div', { class: 'c-name', text: p.name }),
            el('div', { class: 'c-sub', text: `${p.phonePrimary || '无手机号'} · ${p.status}` }),
          ),
          el('button', {
            type: 'button',
            class: 'btn btn-ghost btn-sm',
            onclick: () => {
              state.picked = null;
              state.keyword = '';
              state.candidates = [];
              paint();
            },
          }, '更换'),
        ),
      );
      return;
    }

    idInput.value = '';
    const search = el('input', {
      id: 'f-studentId',
      class: 'toolbar-search',
      type: 'search',
      placeholder: '按姓名或手机号搜索学员',
      value: state.keyword,
      oninput: (e) => {
        state.keyword = e.target.value;
        // 中文等输入法组字期间跳过防抖重渲染，避免把带着组字状态的输入框整个换掉
        // （否则永远打不出汉字）；等 compositionend 组字完成再触发搜索。
        if (e.isComposing) return;
        clearTimeout(deb);
        deb = setTimeout(doSearch, 220);
      },
      oncompositionend: (e) => {
        state.keyword = e.target.value;
        clearTimeout(deb);
        deb = setTimeout(doSearch, 220);
      },
    });
    const list = el(
      'div',
      { class: 'candidate-list' },
      ...(state.candidates.length === 0 && state.keyword.trim() && !state.searching
        ? [el('div', { class: 'field-hint', text: '没有匹配的学员' })]
        : state.candidates.map((c) =>
            el(
              'button',
              {
                type: 'button',
                class: 'candidate',
                onclick: () => {
                  state.picked = c;
                  paint();
                },
              },
              el('div', { class: 'c-main' },
                el('div', { class: 'c-name', text: c.name }),
                el('div', { class: 'c-sub', text: `${c.phonePrimary || '无手机号'} · ${c.status}` }),
              ),
            ),
          )),
    );
    body.replaceChildren(search, list);
  }

  paint();
  return el('div', {}, body, idInput);
}

async function renderAllocateForm(preItemId) {
  view.replaceChildren(el('div', { text: '载入…' }));

  let items = [];
  let hasStudents = true;
  try {
    const [itemRows, studentTotal] = await Promise.all([
      shell.inventory.listItems({ limit: 1000 }).then((r) => unwrap(r).rows),
      shell.students.list({ limit: 1 }).then((r) => unwrap(r).total),
    ]);
    items = itemRows;
    hasStudents = studentTotal > 0;
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

  if (sellable.length === 0 || !hasStudents) {
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
      field('studentId', '学员', studentPicker()),
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

/* ───────────────────────── 领用流水 ───────────────────────── */

const allocState = { dateFrom: '', dateTo: '', studentId: '', itemId: '', limit: 100 };

function allocQuery() {
  return {
    dateFrom: allocState.dateFrom || undefined,
    dateTo: allocState.dateTo || undefined,
    studentId: allocState.studentId ? Number(allocState.studentId) : undefined,
    itemId: allocState.itemId ? Number(allocState.itemId) : undefined,
    limit: allocState.limit,
  };
}

async function renderAllocations() {
  view.replaceChildren(el('div', { text: '载入…' }));

  // 从一份较大的流水里收集去重的「学员」「物件」作筛选下拉（含已软删物件）
  let all = [];
  try {
    all = unwrap(await shell.inventory.allocations({ limit: 2000 })).rows;
  } catch (e) {
    view.replaceChildren(
      el('div', { class: 'empty' }, el('strong', { text: '加载失败' }), el('span', { text: e.message })),
    );
    return;
  }
  const uniqBy = (arr, idKey, labelKey) => {
    const m = new Map();
    for (const r of arr) if (!m.has(r[idKey])) m.set(r[idKey], r[labelKey]);
    return [...m.entries()].map(([id, label]) => ({ id, label }));
  };
  const studentOpts = uniqBy(all, 'studentId', 'studentName');
  const itemOpts = uniqBy(all, 'itemId', 'itemName');

  const dFrom = el('input', { type: 'date', class: 'toolbar-select', 'aria-label': '起始日期', value: allocState.dateFrom });
  const dTo = el('input', { type: 'date', class: 'toolbar-select', 'aria-label': '截止日期', value: allocState.dateTo });
  dFrom.addEventListener('change', () => { allocState.dateFrom = dFrom.value; allocState.limit = 100; void refreshAllocations(); });
  dTo.addEventListener('change', () => { allocState.dateTo = dTo.value; allocState.limit = 100; void refreshAllocations(); });

  const stuSel = el('select', { class: 'toolbar-select', 'aria-label': '按学员筛选' },
    el('option', { value: '' }, '全部学员'),
    ...studentOpts.map((o) => el('option', { value: String(o.id), selected: String(o.id) === allocState.studentId || null }, o.label)),
  );
  stuSel.addEventListener('change', () => { allocState.studentId = stuSel.value; allocState.limit = 100; void refreshAllocations(); });

  const itmSel = el('select', { class: 'toolbar-select', 'aria-label': '按物件筛选' },
    el('option', { value: '' }, '全部物件'),
    ...itemOpts.map((o) => el('option', { value: String(o.id), selected: String(o.id) === allocState.itemId || null }, o.label)),
  );
  itmSel.addEventListener('change', () => { allocState.itemId = itmSel.value; allocState.limit = 100; void refreshAllocations(); });

  view.replaceChildren(
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', { class: 'page-title', text: '领用流水' }),
        el('p', { class: 'page-sub', id: 'alloc-count', text: '载入中…' }),
      ),
      el('div', { class: 'detail-actions' },
        el('button', { class: 'btn', type: 'button', onclick: (ev) => void exportAllocationsXlsx(ev.currentTarget) }, '导出流水'),
        el('button', { class: 'btn', type: 'button', onclick: () => { location.hash = '#/allocate'; } }, '＋ 分配'),
        el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { location.hash = '#/items'; } }, '返回列表'),
      ),
    ),
    el('div', { class: 'toolbar' },
      el('span', { class: 'row-meta', text: '日期' }), dFrom, el('span', { class: 'row-meta', text: '至' }), dTo,
      stuSel, itmSel,
    ),
    el('div', { class: 'list', id: 'alloc-body' }),
  );

  await refreshAllocations();
}

/** 把当前筛选到的领用流水导出为 xlsx。 */
async function exportAllocationsXlsx(btn) {
  btn.disabled = true;
  try {
    const { filePath, count } = unwrap(await shell.inventory.exportAllocations(allocQuery()));
    toast(`已导出 ${count} 条到 ${filePath}`);
  } catch (e) {
    if (e.code === 'IO_CANCELLED') return;
    toast(`导出失败：${e.message}`);
  } finally {
    btn.disabled = false;
  }
}

async function refreshAllocations() {
  const body = document.getElementById('alloc-body');
  const countEl = document.getElementById('alloc-count');
  if (!body) return;

  let result;
  try {
    result = unwrap(await shell.inventory.allocations(allocQuery()));
  } catch (e) {
    if (countEl) countEl.textContent = '';
    body.replaceChildren(el('div', { class: 'empty' }, el('strong', { text: '加载失败' }), el('span', { text: e.message })));
    return;
  }

  const { rows, total } = result;
  const filtered = allocState.dateFrom || allocState.dateTo || allocState.studentId || allocState.itemId;
  if (countEl) countEl.textContent = filtered ? `筛选到 ${total} 条` : `共 ${total} 条领用记录`;

  if (rows.length === 0) {
    body.replaceChildren(
      el('div', { class: 'empty' },
        el('strong', { text: filtered ? '没有符合筛选的记录' : '还没有领用记录' }),
        el('span', { text: filtered ? '换个条件试试。' : '在物件详情点「分配」发放第一件物资。' }),
      ),
    );
    return;
  }

  const rowEls = rows.map((a) =>
    el('div', { class: 'student-row', style: 'cursor:default' },
      el('div', { class: 'row-main' },
        el('div', { class: 'row-name', text: `${a.studentName} · ${a.itemName}` }),
        el('div', { class: 'row-meta', text: `${a.claimedAt}${a.studentPhone ? ' · ' + a.studentPhone : ''}${a.note ? ' · ' + a.note : ''}` }),
      ),
      el('span', { class: 'row-qty', text: `领 ${a.quantity}` }),
      el('button', {
        class: 'btn btn-ghost',
        type: 'button',
        style: 'min-height:36px;padding:0 10px',
        onclick: () => void confirmDeleteAllocation(a),
      }, '删除'),
    ),
  );
  if (total > rows.length) {
    rowEls.push(
      el('button', {
        class: 'btn',
        type: 'button',
        style: 'align-self:center;margin-top:6px',
        onclick: () => { allocState.limit += 100; void refreshAllocations(); },
      }, `加载更多（还有 ${total - rows.length} 条）`),
    );
  }
  body.replaceChildren(...rowEls);
}

async function confirmDeleteAllocation(a) {
  const yes = window.confirm(
    `确定删除这条领用记录吗？\n\n${a.studentName} 于 ${a.claimedAt} 领「${a.itemName}」${a.quantity} 件。\n删除将把 ${a.quantity} 件加回库存。`,
  );
  if (!yes) return;
  try {
    const { remaining } = unwrap(await shell.inventory.deleteAllocation(a.id));
    toast(`已删除，「${a.itemName}」库存回补到 ${remaining}`);
    await refreshAllocations();
  } catch (e) {
    toast(e.code === 'NOT_FOUND' ? '该记录已被删除' : `删除失败：${e.message}`);
    await refreshAllocations();
  }
}

/* ───────────────────────── 导入物件台账 ───────────────────────── */

const IMPORT_FIELDS = [
  { key: 'name', label: '物件名', required: true },
  { key: 'quantity', label: '入库数量', required: true },
  { key: 'category', label: '分类' },
  { key: 'unit', label: '单位' },
  { key: 'lowStockThreshold', label: '预警阈值' },
  { key: 'note', label: '备注' },
];

async function renderImport() {
  view.replaceChildren(
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', { class: 'page-title', text: '导入物件台账' }),
        el('p', { class: 'page-sub', text: '物件名匹配已有物件则累加入库数量，否则新建；不导入领用流水' }),
      ),
      el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { location.hash = '#/items'; } }, '返回列表'),
    ),
    el('div', { id: 'imp-body' }),
  );
  const body = document.getElementById('imp-body');

  const step1 = el('div', { class: 'form-group' },
    el('div', { class: 'group-title', text: '第 1 步：准备文件' }),
    el('p', { class: 'page-sub', text: '没有模板？先下载一个，按表头填好再回来选文件。' }),
    el('div', { class: 'form-actions', style: 'justify-content:flex-start' },
      el('button', {
        class: 'btn', type: 'button',
        onclick: async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          try {
            const { filePath } = unwrap(await shell.inventory.downloadTemplate());
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
            const preview = unwrap(await shell.inventory.pickImportFile());
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
    const opts = headers.filter((h) => h);
    const selects = new Map();

    const rows = IMPORT_FIELDS.map((f) => {
      const sel = el('select', {},
        el('option', { value: '' }, '（不导入）'),
        ...opts.map((h) => el('option', { value: h }, h)),
      );
      if (headers.includes(f.label)) sel.value = f.label; // 表头与字段名一致则自动选中
      sel.addEventListener('change', updateStartBtn);
      selects.set(f.key, sel);
      return el('tr', { dataset: { key: f.key } },
        el('td', {}, f.label, f.required ? el('span', { class: 'req', text: ' ＊' }) : null),
        el('td', {}, sel),
      );
    });

    const startBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '开始导入');
    const currentMapping = () => {
      const m = {};
      for (const [key, sel] of selects) if (sel.value) m[key] = sel.value;
      return m;
    };
    function updateStartBtn() {
      const m = currentMapping();
      startBtn.disabled = !(m['name'] && m['quantity']);
    }
    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      try {
        const report = unwrap(await shell.inventory.importItems({ filePath, mapping: currentMapping() }));
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
          el('thead', {}, el('tr', {}, el('th', {}, '模板字段'), el('th', {}, '表格列'))),
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
        el('p', {}, `新建 ${report.created} 个，更新 ${report.updated} 个，失败 ${report.failed} 行。`),
        report.failures.length
          ? el('div', { class: 'fa-list' },
              ...report.failures.map((f) =>
                el('div', { class: 'fa-item' }, el('div', { class: 'fa-meta', text: `第 ${f.row} 行：${f.reason}` })),
              ),
            )
          : null,
        el('div', { class: 'form-actions' },
          el('button', { class: 'btn btn-primary', type: 'button', onclick: () => { location.hash = '#/items'; } }, '完成'),
        ),
      ),
    );
  }
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
    if (head === 'allocations') return await renderAllocations();
    if (head === 'import') return await renderImport();
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
