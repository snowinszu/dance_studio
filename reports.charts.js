/**
 * 数据报表的 SVG 图表工具函数（纯函数，无副作用）。
 *
 * 整体类比：一套「把数字画成条 / 线 / 格子」的模板机——喂进一组数值，吐出一段
 * <svg> 字符串。它不碰 document / window，也不发 IPC，所以既能在渲染层直接
 * `container.innerHTML = barChartSVG(...)` 用，也能在 node:test 里当普通模块
 * 导入、单测里面的几何换算。
 *
 * Electron 离线 + 项目无打包器，不能引任何图表库 / CDN，所以这里全部手写。
 * 图元统一用设计令牌上色（`var(--cc-8)` 为报表身份色），不出现裸 hex。
 *
 * 坐标系：SVG 左上为原点，y 向下增大。所有图表基线在底部（y = height），
 * 数值越大，条越高 / 点越靠上。
 */

/* ───────────────────────── 几何纯函数（可单测）───────────────────────── */

/**
 * 线性映射工厂：把定义域 [d0,d1] 上的值线性映射到值域 [r0,r1]。
 * 退化情形 d0 === d1（一组常数据）时恒返回 r0，避免除以 0 得 NaN。
 *
 * @returns {(v:number)=>number}
 */
export function scaleLinear(d0, d1, r0, r1) {
  if (d0 === d1) return () => r0;
  const k = (r1 - r0) / (d1 - d0);
  return (v) => r0 + (v - d0) * k;
}

/**
 * 把一个正数向上取整到「好看」的刻度：1 / 2 / 2.5 / 5 / 10 乘以 10 的整次幂。
 * 用来定 Y 轴上界，让柱 / 线不顶到框顶。
 *
 *   niceMax(7)  → 10      niceMax(23) → 25
 *   niceMax(0)  → 1       niceMax(-5) → 1   （非正数没有意义，兜底 1）
 */
export function niceMax(v) {
  if (!(v > 0)) return 1; // 含 NaN / 0 / 负数
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (step * mag >= v - 1e-9) return step * mag;
  }
  return 10 * mag; // 理论上不可达
}

/** 数字压成短字符串：整数原样，否则保留两位小数（去掉 fp 噪声）。 */
function n2(x) {
  return String(Number(x.toFixed(2)));
}

/**
 * 竖直柱状图的几何：把一组数值铺满 width×height，返回每根柱的矩形。
 * 空数组返回 []。所有值 ≤ 0 时柱高为 0（仍返回矩形，height:0）。
 *
 * @param {number[]} values
 * @param {number} width
 * @param {number} height
 * @param {number} [pad] 每个槽位左右留白，默认 4
 * @returns {{x:number,y:number,width:number,height:number}[]}
 */
export function barGeometry(values, width, height, pad = 4) {
  const n = values.length;
  if (n === 0) return [];
  const max = niceMax(Math.max(0, ...values));
  const slot = width / n;
  const barW = Math.max(0, slot - pad * 2);
  return values.map((v, i) => {
    const h = max > 0 ? Math.max(0, (v / max) * height) : 0;
    return { x: i * slot + pad, y: height - h, width: barW, height: h };
  });
}

/**
 * 折线图的顶点串：把一组数值横向等距铺开，纵向按 niceMax 归一后翻折。
 * 返回 SVG polyline 用的 "x,y x,y …" 字符串。空数组返回 ""；单点也能画。
 *
 * @param {number[]} values
 * @param {number} width
 * @param {number} height
 * @param {number} [pad] 左右留白，默认 0
 * @returns {string}
 */
export function linePoints(values, width, height, pad = 0) {
  const n = values.length;
  if (n === 0) return '';
  const innerW = width - pad * 2;
  const stepX = n > 1 ? innerW / (n - 1) : 0;
  const max = niceMax(Math.max(0, ...values));
  return values
    .map((v, i) => {
      const x = pad + i * stepX;
      const y = height - (max > 0 ? (v / max) * height : 0);
      return `${n2(x)},${n2(y)}`;
    })
    .join(' ');
}

/* ───────────────────────── SVG 构造器 ───────────────────────── */

/** 转义要塞进 SVG 文本节点 / 属性的字符串。 */
function esc(s) {
  return String(s == null ? '' : s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/** 统一的 <svg> 开标签：viewBox + 等比缩放，宽高交给外层容器控制（响应式）。 */
function svgOpen(width, height, title) {
  return (
    `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" ` +
    `width="100%" role="img"${title ? ` aria-label="${esc(title)}"` : ' aria-hidden="true"'}>` +
    (title ? `<title>${esc(title)}</title>` : '')
  );
}

/**
 * 柱状图。data 为 [{ label, value }]；空 data 也返回合法 <svg>（只有基线）。
 * @param {{data?:{label?:string,value:number}[],width?:number,height?:number,pad?:number,title?:string}} opts
 */
export function barChartSVG(opts = {}) {
  const { data = [], width = 320, height = 120, pad = 4, title } = opts;
  const rects = barGeometry(
    data.map((d) => Number(d.value) || 0),
    width,
    height,
    pad,
  )
    .map(
      (r) =>
        `<rect x="${n2(r.x)}" y="${n2(r.y)}" width="${n2(r.width)}" height="${n2(r.height)}" ` +
        `rx="2" fill="var(--cc-8)"/>`,
    )
    .join('');
  return (
    svgOpen(width, height, title) +
    `<line x1="0" y1="${height}" x2="${width}" y2="${height}" stroke="var(--border)" stroke-width="1"/>` +
    rects +
    '</svg>'
  );
}

/**
 * 折线图。points 为 [{ label, value }]；空 / 单点也不抛。
 * @param {{points?:{label?:string,value:number}[],width?:number,height?:number,pad?:number,title?:string}} opts
 */
export function lineChartSVG(opts = {}) {
  const { points = [], width = 320, height = 120, pad = 4, title } = opts;
  const values = points.map((p) => Number(p.value) || 0);
  const pts = linePoints(values, width, height, pad);
  const poly = pts
    ? `<polyline points="${pts}" fill="none" stroke="var(--cc-8)" stroke-width="2" ` +
      `stroke-linejoin="round" stroke-linecap="round"/>`
    : '';
  // 单点时额外画一个圆点，否则 polyline 看不见
  const dot =
    values.length === 1
      ? `<circle cx="${n2(pad)}" cy="${n2(
          height - (niceMax(Math.max(0, ...values)) > 0 ? (values[0] / niceMax(Math.max(0, ...values))) * height : 0),
        )}" r="3" fill="var(--cc-8)"/>`
      : '';
  return (
    svgOpen(width, height, title) +
    `<line x1="0" y1="${height}" x2="${width}" y2="${height}" stroke="var(--border)" stroke-width="1"/>` +
    poly +
    dot +
    '</svg>'
  );
}

/**
 * 热力网格。matrix 为 number[][]（行 × 列）。空矩阵返回只有 <svg> 外壳、无格子。
 * 颜色用 var(--cc-8) 的透明度表达强弱：0 值近透明，最大值接近实心。
 *
 * @param {{matrix?:number[][],rowLabels?:string[],colLabels?:string[],width?:number,height?:number,gap?:number,title?:string}} opts
 */
export function heatmapSVG(opts = {}) {
  const { matrix = [], rowLabels = [], colLabels = [], width = 320, height = 160, gap = 2, title } =
    opts;
  const rows = matrix.length;
  const cols = rows > 0 ? Math.max(...matrix.map((r) => r.length)) : 0;
  if (rows === 0 || cols === 0) return svgOpen(width, height, title) + '</svg>';

  let max = 0;
  for (const row of matrix) for (const v of row) if (v > max) max = v;

  const cellW = width / cols;
  const cellH = height / rows;
  let cells = '';
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const v = Number(matrix[r][c]) || 0;
      const op = max > 0 && v > 0 ? 0.12 + 0.88 * (v / max) : 0.04;
      cells +=
        `<rect x="${n2(c * cellW)}" y="${n2(r * cellH)}" ` +
        `width="${n2(Math.max(0, cellW - gap))}" height="${n2(Math.max(0, cellH - gap))}" ` +
        `rx="2" fill="var(--cc-8)" fill-opacity="${n2(op)}"/>`;
    }
  }

  const colText = colLabels
    .slice(0, cols)
    .map(
      (t, c) =>
        `<text x="${n2(c * cellW + cellW / 2)}" y="10" text-anchor="middle" ` +
        `font-size="9" fill="var(--muted)">${esc(t)}</text>`,
    )
    .join('');
  const rowText = rowLabels
    .slice(0, rows)
    .map(
      (t, r) =>
        `<text x="2" y="${n2(r * cellH + cellH / 2 + 3)}" font-size="9" ` +
        `fill="var(--muted)">${esc(t)}</text>`,
    )
    .join('');

  return svgOpen(width, height, title) + cells + colText + rowText + '</svg>';
}
