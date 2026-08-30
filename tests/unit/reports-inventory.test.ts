/**
 * 库存指标 getInventoryStats() 的口径单测。独立进程 / 独立 :memory: 库。
 * 重点：staleItems 的 90 天边界与「从未领用」、monthlyAllocations 补齐、totals 合计。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import { getInventoryStats } from '../../src/domain/reports.repo';

process.env['STUDIO_DB_PATH'] = ':memory:';
run(getDb());

const db = getDb();
const NOW = new Date().toISOString();
const RANGE = { from: '2025-01-01', to: '2025-03-31' };

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function daysAgo(n: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return ymd(d);
}

let seq = 0;
function mkItem(name: string, quantity: number, threshold: number, deleted = false): number {
  return Number(
    db
      .prepare(
        `INSERT INTO inventory_items
           (name, unit, quantity, low_stock_threshold, created_at, updated_at, deleted_at)
         VALUES (@n, '件', @q, @t, @now, @now, @del)`,
      )
      .run({ n: name, q: quantity, t: threshold, now: NOW, del: deleted ? NOW : null })
      .lastInsertRowid,
  );
}
function mkStudent(name: string): number {
  seq += 1;
  return Number(
    db
      .prepare(
        `INSERT INTO students (name, phone_primary, status, dance_types, custom_fields, created_at, updated_at)
         VALUES (@n, @p, '在读', '[]', '{}', @now, @now)`,
      )
      .run({ n: name, p: `137${String(4000000 + seq)}`, now: NOW }).lastInsertRowid,
  );
}
function mkAlloc(itemId: number, studentId: number, quantity: number, claimedAt: string): void {
  db.prepare(
    `INSERT INTO item_allocations (item_id, student_id, quantity, claimed_at, created_at)
     VALUES (@i, @s, @q, @d, @now)`,
  ).run({ i: itemId, s: studentId, q: quantity, d: claimedAt, now: NOW });
}

/* ─────────────────────── 夹具 ─────────────────────── */

const I1 = mkItem('A把杆', 5, 2); // 有旧领用、无近 90 天领用 → 呆滞
const I2 = mkItem('B袜子', 0, 3); // 0 <= 3 → 低库存；q=0 → 不呆滞
mkItem('C垫子', 10, 1); // 近 10 天有领用 → 不呆滞
const I5 = mkItem('E道具', 4, 0); // 从未领用 → 呆滞，lastClaimedAt=null
const I6 = mkItem('F镜子', 3, 0); // 恰好 90 天前有领用 → 不呆滞
mkItem('D旧物', 8, 0, true); // 软删 → 全程排除
void I2;
void I6;

const SA = mkStudent('甲');
const SB = mkStudent('乙');

mkAlloc(I1, SA, 2, '2025-02-10');
mkAlloc(I1, SB, 3, '2025-02-20');
const C = db.prepare(`SELECT id FROM inventory_items WHERE name='C垫子'`).get() as { id: number };
mkAlloc(C.id, SA, 1, daysAgo(10));
const F = db.prepare(`SELECT id FROM inventory_items WHERE name='F镜子'`).get() as { id: number };
mkAlloc(F.id, SB, 1, daysAgo(90)); // 边界：>= cutoff90 → 不呆滞

/* ─────────────────────── 断言 ─────────────────────── */

test('getInventoryStats.totals：未软删物件的品类数与件数合计', () => {
  const t = getInventoryStats(RANGE).totals;
  assert.deepEqual(t, { itemKinds: 5, totalQuantity: 5 + 0 + 10 + 4 + 3 });
});

test('getInventoryStats.lowStock：库存 <= 阈值（软删排除）', () => {
  const names = getInventoryStats(RANGE).lowStock.map((r) => r.name);
  assert.deepEqual(names, ['B袜子']);
});

test('getInventoryStats.monthlyAllocations：按月补齐；无领用区间全 0', () => {
  assert.deepEqual(getInventoryStats(RANGE).monthlyAllocations, [
    { month: '2025-01', quantity: 0 },
    { month: '2025-02', quantity: 5 },
    { month: '2025-03', quantity: 0 },
  ]);
  assert.deepEqual(getInventoryStats({ from: '2019-01-01', to: '2019-02-28' }).monthlyAllocations, [
    { month: '2019-01', quantity: 0 },
    { month: '2019-02', quantity: 0 },
  ]);
});

test('getInventoryStats.topItems / topStudents：区间内按件数前 N', () => {
  const s = getInventoryStats(RANGE);
  assert.deepEqual(s.topItems, [{ itemId: I1, name: 'A把杆', quantity: 5 }]);
  assert.deepEqual(
    s.topStudents.map((r) => ({ id: r.studentId, q: r.quantity })),
    [
      { id: SB, q: 3 },
      { id: SA, q: 2 },
    ],
  );
});

test('getInventoryStats.staleItems：在库>0 且近 90 天无领用；从未领用排最前；边界(第90天)不呆滞', () => {
  const stale = getInventoryStats(RANGE).staleItems;
  const names = stale.map((r) => r.name);
  assert.ok(names.includes('E道具'));
  assert.ok(names.includes('A把杆'));
  assert.ok(!names.includes('C垫子')); // 近 10 天有领用
  assert.ok(!names.includes('F镜子')); // 恰好 90 天前有领用
  assert.ok(!names.includes('B袜子')); // 库存 0
  assert.equal(stale.find((r) => r.name === 'E道具')!.lastClaimedAt, null);
  assert.equal(stale.find((r) => r.name === 'A把杆')!.lastClaimedAt, '2025-02-20');
  assert.equal(stale[0]!.name, 'E道具'); // 从未领用（null）排最前
  void I5;
});
