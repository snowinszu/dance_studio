/**
 * inventory.repo 的物件 CRUD 集成测试：直接调 repo，对内存库。
 * 覆盖：create/get/update/softDelete 全链路、重名冲突、软删后可见性、
 * updateItem 省略 quantity 保持原值。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import {
  createItem,
  getItem,
  updateItem,
  softDeleteItem,
  listItems,
} from '../../src/domain/inventory.repo';
import { validateItem } from '../../src/domain/inventory.validation';

process.env['STUDIO_DB_PATH'] = ':memory:';
run(getDb());

/** 走一遍校验再入库，贴近真实调用路径。 */
function make(input: Parameters<typeof validateItem>[0], isEdit = false) {
  const { values, errors } = validateItem(input, { isEdit });
  assert.deepEqual(errors, {}, '测试种子不该有校验错误');
  return values;
}

test('create → get：字段落库正确', () => {
  const { id } = createItem(make({ name: '把杆', category: '器材', unit: '根', quantity: 6, lowStockThreshold: 2 }));
  const it = getItem(id);
  assert.ok(it);
  assert.equal(it.name, '把杆');
  assert.equal(it.category, '器材');
  assert.equal(it.unit, '根');
  assert.equal(it.quantity, 6);
  assert.equal(it.lowStockThreshold, 2);
  assert.equal(it.deletedAt, null);
});

test('重名（未软删）→ ITEM_NAME_CONFLICT', () => {
  createItem(make({ name: '瑜伽垫' }));
  assert.throws(() => createItem(make({ name: '瑜伽垫' })), (e: unknown) => {
    return e instanceof Error && (e as { code?: string }).code === 'ITEM_NAME_CONFLICT';
  });
});

test('updateItem 改名撞已有 → 冲突；改回自身名 → 放行', () => {
  const a = createItem(make({ name: '道具扇' }));
  createItem(make({ name: '道具伞' }));
  assert.throws(
    () => updateItem(a.id, make({ name: '道具伞' }, true)),
    (e: unknown) => (e as { code?: string }).code === 'ITEM_NAME_CONFLICT',
  );
  // 改成自身原名不算冲突
  assert.doesNotThrow(() => updateItem(a.id, make({ name: '道具扇' }, true)));
});

test('updateItem 省略 quantity → 保持原值；给出 → 覆盖', () => {
  const { id } = createItem(make({ name: '钢琴谱', quantity: 10 }));
  // 只改分类，不带 quantity
  updateItem(id, make({ name: '钢琴谱', category: '教材' }, true));
  assert.equal(getItem(id)!.quantity, 10, '省略 quantity 应保持原值');
  assert.equal(getItem(id)!.category, '教材');
  // 显式改库存
  updateItem(id, make({ name: '钢琴谱', category: '教材', quantity: 3 }, true));
  assert.equal(getItem(id)!.quantity, 3);
});

test('softDeleteItem：从 listItems 消失，但 getItem 仍能取到', () => {
  const { id } = createItem(make({ name: '临时道具' }));
  softDeleteItem(id);
  const listed = listItems({ search: '临时道具' });
  assert.equal(listed.total, 0);
  const it = getItem(id);
  assert.ok(it, 'getItem 对已软删物件仍返回');
  assert.notEqual(it.deletedAt, null);
});

test('softDeleteItem 后同名可再新建（软删物件不占用名字）', () => {
  const { id } = createItem(make({ name: '一次性物件' }));
  softDeleteItem(id);
  assert.doesNotThrow(() => createItem(make({ name: '一次性物件' })));
});

test('对不存在 / 已软删 id 调 update / softDelete → NOT_FOUND', () => {
  assert.throws(
    () => updateItem(99999, make({ name: 'x' }, true)),
    (e: unknown) => (e as { code?: string }).code === 'NOT_FOUND',
  );
  const { id } = createItem(make({ name: '删两次' }));
  softDeleteItem(id);
  assert.throws(
    () => softDeleteItem(id),
    (e: unknown) => (e as { code?: string }).code === 'NOT_FOUND',
  );
});
