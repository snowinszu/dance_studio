/**
 * 预设字段真源 vs. 实际库结构的一致性单测。
 *
 * 目的：preset-fields.ts 里每个预设字段的 key，都必须对应 students 表的一个真实列。
 * 一旦有人加了预设字段却忘了写迁移（或反之），这个测试立刻红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { run } from '../../src/db/migrations';
import {
  GROUPS,
  PRESET_FIELDS,
  PRESET_COLUMN_NAMES,
  STUDENT_STATUSES,
  DEFAULT_STUDENT_STATUS,
} from '../../src/shared/preset-fields';

/** students 表迁移后实际拥有的列名。 */
function studentColumns(): Set<string> {
  const db = new Database(':memory:');
  try {
    run(db);
    const cols = db.prepare(`PRAGMA table_info(students)`).all() as { name: string }[];
    return new Set(cols.map((c) => c.name));
  } finally {
    db.close();
  }
}

test('每个预设字段的 key 都是 students 表的真实列', () => {
  const cols = studentColumns();
  for (const key of PRESET_COLUMN_NAMES) {
    assert.ok(cols.has(key), `预设字段 "${key}" 在 students 表里没有对应列`);
  }
});

test('已移除的证件字段：预设里没有、迁移后 students 表也没有对应列', () => {
  const cols = studentColumns();
  for (const gone of ['id_card_type', 'id_card_no']) {
    assert.ok(!PRESET_COLUMN_NAMES.includes(gone), `预设不应再含 ${gone}`);
    assert.ok(!cols.has(gone), `students 表不应再有列 ${gone}`);
  }
});

test('新增的「班级」字段：预设里有、迁移后 students 表有对应列，归属课程与会员组', () => {
  const cols = studentColumns();
  assert.ok(PRESET_COLUMN_NAMES.includes('class_name'));
  assert.ok(cols.has('class_name'));
  const f = PRESET_FIELDS.find((x) => x.key === 'class_name');
  assert.ok(f);
  assert.equal(f.group, 'course');
  assert.equal(f.type, 'text');
});

test('预设字段 key 无重复', () => {
  assert.equal(new Set(PRESET_COLUMN_NAMES).size, PRESET_COLUMN_NAMES.length);
});

test('每个预设字段都归属于某个已声明的分组', () => {
  const groupKeys = new Set(GROUPS.map((g) => g.key));
  for (const f of PRESET_FIELDS) {
    assert.ok(groupKeys.has(f.group), `字段 "${f.key}" 的分组 "${f.group}" 未在 GROUPS 声明`);
  }
});

test('select / multiselect 类型的预设字段必须带非空 options', () => {
  for (const f of PRESET_FIELDS) {
    if (f.type === 'select' || f.type === 'multiselect') {
      assert.ok(f.options && f.options.length > 0, `字段 "${f.key}" 缺 options`);
    }
  }
});

test('status 字段的 options 与 STUDENT_STATUSES 一致，默认值取第一个', () => {
  const statusField = PRESET_FIELDS.find((f) => f.key === 'status');
  assert.ok(statusField);
  assert.deepEqual([...(statusField.options ?? [])], [...STUDENT_STATUSES]);
  assert.equal(DEFAULT_STUDENT_STATUS, STUDENT_STATUSES[0]);
});

test('GROUPS 的 order 从 1 起、连续且升序', () => {
  const orders = GROUPS.map((g) => g.order);
  assert.deepEqual(
    orders,
    orders.map((_, i) => i + 1),
  );
});
