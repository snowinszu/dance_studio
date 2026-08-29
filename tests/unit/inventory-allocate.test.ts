/**
 * 分配扣减：validateAllocation 纯函数 + inventory.repo.allocate 事务集成。
 * 覆盖：正常扣减、库存不足被拒且库存不变、守卫更新的原子性、日期默认/校验。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import { createItem, getItem, allocate, listAllocations } from '../../src/domain/inventory.repo';
import {
  validateAllocation,
  validateItem,
  todayYmd,
} from '../../src/domain/inventory.validation';

process.env['STUDIO_DB_PATH'] = ':memory:';
run(getDb());

// 造一个学员（#28 还没有 students 的公开写接口，直接 SQL）
const now = new Date().toISOString();
const studentId = Number(
  getDb()
    .prepare(
      `INSERT INTO students (name, phone_primary, status, dance_types, custom_fields, created_at, updated_at)
       VALUES ('张三', '13800000000', '在读', '[]', '{}', @now, @now)`,
    )
    .run({ now }).lastInsertRowid,
);

function newItem(name: string, quantity: number) {
  const { values } = validateItem({ name, quantity });
  return createItem(values).id;
}

/* ----- validateAllocation ----- */

test('validateAllocation：合法输入无错误，日期缺省为今天', () => {
  const { values, errors } = validateAllocation(
    { itemId: 1, studentId: 2, quantity: 3 },
    { quantity: 10 },
  );
  assert.deepEqual(errors, {});
  assert.equal(values.quantity, 3);
  assert.equal(values.claimedAt, todayYmd());
});

test('validateAllocation：数量 < 1 / 非整数 / 超库存 报错', () => {
  assert.ok(validateAllocation({ itemId: 1, studentId: 1, quantity: 0 }, { quantity: 5 }).errors['quantity']);
  assert.ok(validateAllocation({ itemId: 1, studentId: 1, quantity: 2.5 }, { quantity: 5 }).errors['quantity']);
  const over = validateAllocation({ itemId: 1, studentId: 1, quantity: 6 }, { quantity: 5 }).errors['quantity'];
  assert.match(String(over), /仅剩 5/);
});

test('validateAllocation：日期非法历法 / 格式错 报错', () => {
  assert.ok(
    validateAllocation({ itemId: 1, studentId: 1, quantity: 1, claimedAt: '2026-02-30' }, { quantity: 9 })
      .errors['claimedAt'],
  );
  assert.ok(
    validateAllocation({ itemId: 1, studentId: 1, quantity: 1, claimedAt: '2026/02/03' }, { quantity: 9 })
      .errors['claimedAt'],
  );
  assert.equal(
    validateAllocation({ itemId: 1, studentId: 1, quantity: 1, claimedAt: '2026-02-28' }, { quantity: 9 })
      .errors['claimedAt'],
    undefined,
  );
});

test('validateAllocation：缺物件 / 缺学员 报错', () => {
  const e = validateAllocation({ quantity: 1 } as never, { quantity: 5 }).errors;
  assert.ok(e['itemId']);
  assert.ok(e['studentId']);
});

/* ----- repo.allocate 事务 ----- */

test('allocate：扣减库存 + 写一条流水，返回剩余', () => {
  const itemId = newItem('练功服', 10);
  const { values } = validateAllocation(
    { itemId, studentId, quantity: 3, claimedAt: '2026-03-01' },
    getItem(itemId)!,
  );
  const res = allocate(values);
  assert.equal(res.remaining, 7);
  assert.equal(getItem(itemId)!.quantity, 7);

  const flow = listAllocations({ itemId });
  assert.equal(flow.total, 1);
  assert.equal(flow.rows[0]?.quantity, 3);
  assert.equal(flow.rows[0]?.studentName, '张三');
  assert.equal(flow.rows[0]?.itemName, '练功服');
  assert.equal(flow.rows[0]?.claimedAt, '2026-03-01');
});

test('allocate：数量 > 库存 → INSUFFICIENT_STOCK，库存与流水都不变', () => {
  const itemId = newItem('把杆', 2);
  assert.throws(
    () => allocate({ itemId, studentId, quantity: 5, claimedAt: '2026-03-01', note: null }),
    (e: unknown) => (e as { code?: string }).code === 'INSUFFICIENT_STOCK',
  );
  assert.equal(getItem(itemId)!.quantity, 2, '库存不应变');
  assert.equal(listAllocations({ itemId }).total, 0, '不应写流水');
});

test('allocate：恰好扣到 0 是允许的', () => {
  const itemId = newItem('教材', 4);
  const res = allocate({ itemId, studentId, quantity: 4, claimedAt: '2026-03-02', note: null });
  assert.equal(res.remaining, 0);
  assert.equal(getItem(itemId)!.quantity, 0);
});

test('allocate：对已软删物件 → INSUFFICIENT_STOCK（守卫 WHERE deleted_at IS NULL）', () => {
  const itemId = newItem('临时', 5);
  getDb().prepare(`UPDATE inventory_items SET deleted_at = @now WHERE id = @id`).run({ now, id: itemId });
  assert.throws(
    () => allocate({ itemId, studentId, quantity: 1, claimedAt: '2026-03-02', note: null }),
    (e: unknown) => (e as { code?: string }).code === 'INSUFFICIENT_STOCK',
  );
});
