/**
 * 数据报表 SVG 图表工具的纯函数单测。
 *
 * reports.charts.js 是渲染层文件，不进主 tsc 构建；tsconfig.test.json 开了 allowJs
 * 并把它 include 进来，编到 dist-test/ 后这里当普通模块导入。只测「几何换算」和
 * 「不抛错 + 产出合法 SVG 外壳」，不测像素级视觉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scaleLinear,
  niceMax,
  barGeometry,
  linePoints,
  barChartSVG,
  lineChartSVG,
  heatmapSVG,
} from '../../reports.charts.js';

test('scaleLinear：常规线性映射', () => {
  const f = scaleLinear(0, 10, 0, 100);
  assert.equal(f(0), 0);
  assert.equal(f(5), 50);
  assert.equal(f(10), 100);
});

test('scaleLinear：定义域退化（d0 === d1）恒返回 r0', () => {
  const f = scaleLinear(5, 5, 2, 9);
  assert.equal(f(5), 2);
  assert.equal(f(999), 2);
  assert.equal(f(-3), 2);
});

test('niceMax：向上取整到 1/2/2.5/5/10 × 10^n', () => {
  assert.equal(niceMax(7), 10);
  assert.equal(niceMax(23), 25);
  assert.equal(niceMax(4), 5);
  assert.equal(niceMax(10), 10);
  assert.equal(niceMax(100), 100);
  assert.equal(niceMax(250), 250);
});

test('niceMax：非正数兜底为 1', () => {
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(-5), 1);
  assert.equal(niceMax(Number.NaN), 1);
});

test('barGeometry：已知输入 → 精确矩形', () => {
  const g = barGeometry([0, 10], 100, 50, 5);
  assert.deepEqual(g, [
    { x: 5, y: 50, width: 40, height: 0 },
    { x: 55, y: 0, width: 40, height: 50 },
  ]);
});

test('barGeometry：空数组 → []；全 0 → 每根柱高为 0', () => {
  assert.deepEqual(barGeometry([], 100, 50), []);
  const g = barGeometry([0, 0], 100, 50, 5);
  assert.equal(g.length, 2);
  for (const r of g) assert.equal(r.height, 0);
});

test('linePoints：已知输入 → 精确 points 串', () => {
  assert.equal(linePoints([0, 5, 10], 100, 40, 0), '0,40 50,20 100,0');
});

test('linePoints：空数组 → 空串；单点也能画', () => {
  assert.equal(linePoints([], 100, 40, 0), '');
  assert.equal(linePoints([7], 100, 40, 0), '0,12');
});

test('barChartSVG：返回带 viewBox 的合法 <svg>；空数据不抛', () => {
  const svg = barChartSVG({ data: [{ label: '一月', value: 3 }], title: '出勤' });
  assert.ok(svg.startsWith('<svg'));
  assert.match(svg, /viewBox="0 0 320 120"/);
  assert.match(svg, /<rect /);
  assert.doesNotThrow(() => barChartSVG());
  assert.ok(barChartSVG({ data: [] }).startsWith('<svg'));
});

test('lineChartSVG：空 / 单点 / 多点都不抛且是合法 <svg>', () => {
  assert.ok(lineChartSVG().startsWith('<svg'));
  assert.doesNotThrow(() => lineChartSVG({ points: [] }));
  const one = lineChartSVG({ points: [{ value: 5 }] });
  assert.match(one, /<circle /);
  const many = lineChartSVG({ points: [{ value: 1 }, { value: 4 }, { value: 2 }] });
  assert.match(many, /<polyline points="/);
});

test('heatmapSVG：空矩阵返回只有外壳的 <svg>，不抛', () => {
  assert.doesNotThrow(() => heatmapSVG());
  const empty = heatmapSVG({ matrix: [] });
  assert.ok(empty.startsWith('<svg'));
  assert.ok(!empty.includes('<rect'));
});

test('heatmapSVG：非空矩阵按行列铺格子', () => {
  const svg = heatmapSVG({
    matrix: [
      [0, 2],
      [1, 4],
    ],
    rowLabels: ['周日', '周一'],
    colLabels: ['上午', '下午'],
    title: '时段热力',
  });
  assert.ok(svg.startsWith('<svg'));
  assert.equal((svg.match(/<rect /g) || []).length, 4);
  assert.match(svg, /<title>时段热力<\/title>/);
});
