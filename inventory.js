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

/* ───────────────────────── 尚未接入的视图（占位） ─────────────────────────
   这些路由在后续 issue 里实现；先给一个简短占位，避免地址栏改动后白屏。 */

function renderStub(title) {
  view.replaceChildren(
    el('div', { class: 'page-head' },
      el('div', {},
        el('h1', { class: 'page-title', text: title }),
        el('p', { class: 'page-sub', text: '此功能即将上线。' }),
      ),
      el('button', {
        class: 'btn',
        type: 'button',
        onclick: () => { location.hash = '#/items'; },
      }, '返回物件列表'),
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
    if (head === 'allocate') return renderStub('分配物件');
    if (head === 'allocations') return renderStub('领用流水');
    if (head === 'items' && id === 'new') return renderStub('新建物件');
    if (head === 'items' && id && sub === 'edit') return renderStub('编辑物件');
    if (head === 'items' && id) return renderStub('物件详情');
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
