/**
 * field-defs.repo 生命周期集成测试：create → archive → restore → reorder，
 * 以及 update 拒绝改 type、buildSchema 合并未归档自定义字段。
 * 用内存库现场建表。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env['STUDIO_DB_PATH'] = ':memory:';

import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import * as repo from '../../src/domain/field-defs.repo';
import { buildSchema } from '../../src/domain/validation';
import { AppError } from '../../src/shared/app-error';

run(getDb());

function customDescriptors() {
  return repo
    .list({ includeArchived: false })
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((d) => ({
      key: d.fieldKey,
      label: d.label,
      type: d.type,
      group: d.groupKey,
      options: d.options,
      required: d.required,
      sensitive: d.sensitive,
      origin: 'custom' as const,
      archived: false,
    }));
}

test('create：生成唯一 fieldKey，落到指定分组，选项持久化', () => {
  const a = repo.create({ label: 'Height', type: 'number', groupKey: 'basic' });
  assert.equal(a.fieldKey, 'height');
  assert.equal(a.archived, false);

  const b = repo.create({ label: '校区', type: 'select', groupKey: 'ops', options: ['东', '西'] });
  assert.match(b.fieldKey, /^field_[a-z0-9]+$/);
  assert.deepEqual(b.options, ['东', '西']);

  const c = repo.create({ label: 'Height', type: 'text', groupKey: 'basic' });
  assert.equal(c.fieldKey, 'height_2', 'label 冲突 → key 加后缀');
});

test('select 缺选项 → VALIDATION_FAILED', () => {
  assert.throws(
    () => repo.create({ label: '无选项', type: 'select', groupKey: 'ops', options: [] }),
    (e: unknown) => e instanceof AppError && e.code === 'VALIDATION_FAILED',
  );
});

test('buildSchema 合并未归档自定义字段到对应分组，归档后消失', () => {
  const before = buildSchema(customDescriptors());
  const basic = before.find((g) => g.key === 'basic')!;
  assert.ok(basic.fields.some((f) => f.key === 'height' && f.origin === 'custom'));

  const height = repo.list({ includeArchived: false }).find((d) => d.fieldKey === 'height')!;
  const archived = repo.archive(height.id);
  assert.equal(archived.archived, true);

  const after = buildSchema(customDescriptors());
  assert.ok(
    !after.find((g) => g.key === 'basic')!.fields.some((f) => f.key === 'height'),
    '归档后不应再出现在 schema',
  );

  // 恢复
  repo.restore(height.id);
  const restored = buildSchema(customDescriptors());
  assert.ok(restored.find((g) => g.key === 'basic')!.fields.some((f) => f.key === 'height'));
});

test('update：拒绝改 type，允许改 label / required / options / group', () => {
  const h = repo.list().find((d) => d.fieldKey === 'height')!;
  assert.throws(
    () => repo.update(h.id, { type: 'text' } as never),
    (e: unknown) => e instanceof AppError && e.code === 'FIELD_TYPE_IMMUTABLE',
  );

  const updated = repo.update(h.id, { label: '身高(cm)', required: true, groupKey: 'course' });
  assert.equal(updated.label, '身高(cm)');
  assert.equal(updated.required, true);
  assert.equal(updated.groupKey, 'course');
  assert.equal(updated.type, 'number', 'type 不变');
});

test('reorder：按给定 id 顺序重写 sort_order', () => {
  const all = repo.list({ includeArchived: true });
  const ids = all.map((d) => d.id).reverse();
  const after = repo.reorder(ids);
  const byId = new Map(after.map((d) => [d.id, d.sortOrder]));
  ids.forEach((id, i) => assert.equal(byId.get(id), i));
});

test('archive 不触碰任何学员数据（这里仅断言方法不抛、状态正确）', () => {
  const c = repo.create({ label: '临时字段', type: 'text', groupKey: 'ops' });
  const a = repo.archive(c.id);
  assert.equal(a.archived, true);
  assert.equal(repo.getById(c.id)!.label, '临时字段', '归档不改其它属性');
});
