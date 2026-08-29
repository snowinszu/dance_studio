/**
 * inventory.validation.validateItem 单测：字段格式 / 长度上限 / quantity 的
 * 「新建缺省 0、编辑省略保持原值」语义。纯函数，无需数据库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateItem } from '../../src/domain/inventory.validation';

test('最小合法输入：只有 name，其余归一化为缺省', () => {
  const { values, errors } = validateItem({ name: '  练功服  ' });
  assert.deepEqual(errors, {});
  assert.equal(values.name, '练功服'); // trim
  assert.equal(values.category, null);
  assert.equal(values.unit, '件');
  assert.equal(values.quantity, 0); // 新建缺省
  assert.equal(values.lowStockThreshold, 0);
  assert.equal(values.note, null);
});

test('name 必填 / 超 40 字报错', () => {
  assert.equal(validateItem({ name: '   ' }).errors['name'], '请填写物件名');
  assert.ok(validateItem({ name: 'x'.repeat(41) }).errors['name']);
  assert.equal(validateItem({ name: 'x'.repeat(40) }).errors['name'], undefined);
});

test('quantity：非整数 / 负数报错，合法整数通过', () => {
  assert.ok(validateItem({ name: 'a', quantity: -1 }).errors['quantity']);
  assert.ok(validateItem({ name: 'a', quantity: 1.5 }).errors['quantity']);
  assert.equal(validateItem({ name: 'a', quantity: 0 }).errors['quantity'], undefined);
  assert.equal(validateItem({ name: 'a', quantity: 25 }).values.quantity, 25);
});

test('quantity 接受数字字符串（渲染层可能传字符串）', () => {
  const { values, errors } = validateItem({ name: 'a', quantity: '12' as unknown as number });
  assert.deepEqual(errors, {});
  assert.equal(values.quantity, 12);
});

test('编辑态：quantity 省略 → values.quantity 为 undefined（仓库层保持原值）', () => {
  const { values } = validateItem({ name: 'a' }, { isEdit: true });
  assert.equal(values.quantity, undefined);
});

test('新建态：quantity 省略 → 0', () => {
  assert.equal(validateItem({ name: 'a' }, { isEdit: false }).values.quantity, 0);
});

test('lowStockThreshold：负数 / 非整数报错', () => {
  assert.ok(validateItem({ name: 'a', lowStockThreshold: -3 }).errors['lowStockThreshold']);
  assert.ok(validateItem({ name: 'a', lowStockThreshold: 2.2 }).errors['lowStockThreshold']);
  assert.equal(validateItem({ name: 'a', lowStockThreshold: 5 }).values.lowStockThreshold, 5);
});

test('category / unit / note 长度上限', () => {
  assert.ok(validateItem({ name: 'a', category: 'c'.repeat(41) }).errors['category']);
  assert.ok(validateItem({ name: 'a', unit: 'u'.repeat(11) }).errors['unit']);
  assert.ok(validateItem({ name: 'a', note: 'n'.repeat(201) }).errors['note']);
});

test('category / note 空白 → null；unit 空白 → 件', () => {
  const { values } = validateItem({ name: 'a', category: '  ', unit: '  ', note: '  ' });
  assert.equal(values.category, null);
  assert.equal(values.unit, '件');
  assert.equal(values.note, null);
});
