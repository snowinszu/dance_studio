/**
 * inventory.repo.listItems 的查询构造单测：搜索 / 分类筛选 / 低库存 / LIKE 转义 / 分页 / lowStockCount。
 * 内存库现场建表灌数据，跑完即弃。#27 之前还没有 createItem，直接用 SQL 插种子。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import { listItems } from '../../src/domain/inventory.repo';

process.env['STUDIO_DB_PATH'] = ':memory:';
run(getDb());

function seed(
  name: string,
  opts: {
    category?: string | null;
    unit?: string;
    quantity?: number;
    threshold?: number;
    deleted?: boolean;
  } = {},
): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO inventory_items
         (name, category, unit, quantity, low_stock_threshold, note, created_at, updated_at, deleted_at)
       VALUES (@name, @category, @unit, @quantity, @threshold, NULL, @now, @now, @deleted_at)`,
    )
    .run({
      name,
      category: opts.category ?? null,
      unit: opts.unit ?? '件',
      quantity: opts.quantity ?? 0,
      threshold: opts.threshold ?? 0,
      now,
      deleted_at: opts.deleted ? now : null,
    });
}

seed('练功服 S', { category: '服装', quantity: 20, threshold: 5 });
seed('练功服 M', { category: '服装', quantity: 3, threshold: 5 }); // 低库存
seed('把杆', { category: '器材', quantity: 8, threshold: 2 });
seed('教材_基础', { category: '教材', quantity: 0, threshold: 0 }); // 0 <= 0 → 低库存；名字含下划线验证转义
seed('折扇50%款', { category: '道具', quantity: 100, threshold: 10 }); // 名字含百分号
seed('旧道具', { category: '道具', quantity: 1, threshold: 5, deleted: true }); // 已软删，任何查询都不该出现

test('无条件：只返回未软删物件，total 与行数一致', () => {
  const r = listItems({});
  assert.equal(r.total, 5);
  assert.equal(r.rows.length, 5);
  assert.ok(!r.rows.some((x) => x.name === '旧道具'));
});

test('lowStockCount 独立统计，不受 search / category 影响', () => {
  // 低库存：练功服 M(3<=5) 和 教材_基础(0<=0) → 2
  assert.equal(listItems({}).lowStockCount, 2);
  assert.equal(listItems({ search: '把杆' }).lowStockCount, 2);
  assert.equal(listItems({ category: '器材' }).lowStockCount, 2);
});

test('search 命中物件名子串', () => {
  const r = listItems({ search: '练功服' });
  assert.equal(r.total, 2);
  assert.deepEqual(r.rows.map((x) => x.name).sort(), ['练功服 M', '练功服 S']);
});

test('search 对下划线转义：不当作通配符', () => {
  // '教材_基础' 里的 _ 若未转义，'教材_' 会匹配 '教材X'；这里应精确命中含字面下划线的那条
  const r = listItems({ search: '教材_' });
  assert.equal(r.total, 1);
  assert.equal(r.rows[0]?.name, '教材_基础');
});

test('search 对百分号转义', () => {
  const r = listItems({ search: '50%' });
  assert.equal(r.total, 1);
  assert.equal(r.rows[0]?.name, '折扇50%款');
});

test('category 精确筛选', () => {
  const r = listItems({ category: '服装' });
  assert.equal(r.total, 2);
  assert.ok(r.rows.every((x) => x.category === '服装'));
});

test('lowStockOnly 只留低于等于阈值的', () => {
  const r = listItems({ lowStockOnly: true });
  assert.deepEqual(r.rows.map((x) => x.name).sort(), ['教材_基础', '练功服 M']);
  assert.equal(r.total, 2);
});

test('search + category 组合', () => {
  const r = listItems({ search: '练功服', category: '服装' });
  assert.equal(r.total, 2);
  const r2 = listItems({ search: '练功服', category: '器材' });
  assert.equal(r2.total, 0);
});

test('分页：total 是过滤后总数，rows 只有一页', () => {
  const r = listItems({ limit: 2, offset: 0 });
  assert.equal(r.total, 5);
  assert.equal(r.rows.length, 2);
  const r2 = listItems({ limit: 2, offset: 4 });
  assert.equal(r2.rows.length, 1);
});

test('按物件名不区分大小写排序', () => {
  const names = listItems({}).rows.map((x) => x.name);
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(names, sorted);
});

test('列名映射为驼峰：lowStockThreshold / createdAt 等', () => {
  const it = listItems({ search: '把杆' }).rows[0];
  assert.ok(it);
  assert.equal(it.lowStockThreshold, 2);
  assert.equal(typeof it.createdAt, 'string');
  assert.equal(it.deletedAt, null);
});
