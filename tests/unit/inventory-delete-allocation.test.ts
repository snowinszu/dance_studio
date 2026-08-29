/**
 * 领用流水的筛选 + 删除回补：listAllocations 的 date/student/item 过滤，
 * 以及 deleteAllocation 的「删行 + 库存加回」事务（含物件已软删的情形）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import {
  createItem,
  getItem,
  allocate,
  listAllocations,
  deleteAllocation,
} from '../../src/domain/inventory.repo';
import { validateItem } from '../../src/domain/inventory.validation';

process.env['STUDIO_DB_PATH'] = ':memory:';
run(getDb());

const now = new Date().toISOString();
function seedStudent(name: string, phone: string): number {
  return Number(
    getDb()
      .prepare(
        `INSERT INTO students (name, phone_primary, status, dance_types, custom_fields, created_at, updated_at)
         VALUES (@name, @phone, '在读', '[]', '{}', @now, @now)`,
      )
      .run({ name, phone, now }).lastInsertRowid,
  );
}
function newItem(name: string, qty: number): number {
  return createItem(validateItem({ name, quantity: qty }).values).id;
}

const stuA = seedStudent('甲', '13800000001');
const stuB = seedStudent('乙', '13800000002');
const itemX = newItem('服装X', 50);
const itemY = newItem('道具Y', 50);

allocate({ itemId: itemX, studentId: stuA, quantity: 2, claimedAt: '2026-01-10', note: null });
allocate({ itemId: itemX, studentId: stuB, quantity: 3, claimedAt: '2026-02-15', note: null });
allocate({ itemId: itemY, studentId: stuA, quantity: 1, claimedAt: '2026-03-20', note: null });

test('listAllocations：无筛选返回全部，按日期倒序', () => {
  const r = listAllocations({});
  assert.equal(r.total, 3);
  assert.deepEqual(r.rows.map((x) => x.claimedAt), ['2026-03-20', '2026-02-15', '2026-01-10']);
  assert.equal(r.rows[0]?.studentName, '甲');
  assert.equal(r.rows[0]?.itemName, '道具Y');
});

test('listAllocations：日期区间闭合筛选', () => {
  const r = listAllocations({ dateFrom: '2026-02-01', dateTo: '2026-02-28' });
  assert.equal(r.total, 1);
  assert.equal(r.rows[0]?.claimedAt, '2026-02-15');
});

test('listAllocations：按 studentId / itemId 筛选', () => {
  assert.equal(listAllocations({ studentId: stuA }).total, 2);
  assert.equal(listAllocations({ itemId: itemX }).total, 2);
  assert.equal(listAllocations({ studentId: stuB, itemId: itemX }).total, 1);
});

test('deleteAllocation：删记录 + 把数量加回对应物件库存', () => {
  const before = getItem(itemX)!.quantity; // 50 - 2 - 3 = 45
  assert.equal(before, 45);
  const target = listAllocations({ itemId: itemX, studentId: stuB }).rows[0]!;
  const res = deleteAllocation(target.id);
  assert.equal(res.itemId, itemX);
  assert.equal(res.remaining, before + 3);
  assert.equal(getItem(itemX)!.quantity, before + 3);
  assert.equal(listAllocations({ itemId: itemX }).total, 1);
});

test('deleteAllocation：不存在的 id → NOT_FOUND', () => {
  assert.throws(
    () => deleteAllocation(999999),
    (e: unknown) => (e as { code?: string }).code === 'NOT_FOUND',
  );
});

test('deleteAllocation：物件已软删，仍成功且库存字段照常加回', () => {
  const it = newItem('会被删的物件', 10);
  allocate({ itemId: it, studentId: stuA, quantity: 4, claimedAt: '2026-04-01', note: null });
  assert.equal(getItem(it)!.quantity, 6);
  getDb().prepare(`UPDATE inventory_items SET deleted_at = @now WHERE id = @id`).run({ now, id: it });

  const rec = listAllocations({ itemId: it }).rows[0]!;
  const res = deleteAllocation(rec.id);
  assert.equal(res.remaining, 10);
  assert.equal(getItem(it)!.quantity, 10);
});
