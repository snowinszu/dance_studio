/**
 * tags.repo 集成测试：CRUD、重名冲突、setForStudent 全量重写、
 * 删除标签级联清理 student_tags、list 按 tagIds 筛选学员。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env['STUDIO_DB_PATH'] = ':memory:';

import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import * as tags from '../../src/domain/tags.repo';
import * as students from '../../src/domain/students.repo';
import { AppError } from '../../src/shared/app-error';

run(getDb());

const mkStudent = (name: string): number =>
  students.create({ name, phonePrimary: '13800000000', customFields: {} } as never).id;

test('create / 重名冲突（不区分大小写）', () => {
  const t = tags.create({ name: '参赛苗子', color: 'cc-1' });
  assert.equal(t.name, '参赛苗子');
  assert.equal(t.color, 'cc-1');
  assert.throws(
    () => tags.create({ name: '参赛苗子' }),
    (e: unknown) => e instanceof AppError && e.code === 'TAG_NAME_CONFLICT',
  );
});

test('update 改名 / 改色，重名仍冲突', () => {
  const a = tags.create({ name: '甲' });
  const b = tags.create({ name: '乙' });
  const up = tags.update(a.id, { name: '甲组', color: 'cc-3' });
  assert.equal(up.name, '甲组');
  assert.equal(up.color, 'cc-3');
  assert.throws(
    () => tags.update(b.id, { name: '甲组' }),
    (e: unknown) => e instanceof AppError && e.code === 'TAG_NAME_CONFLICT',
  );
});

test('setForStudent：全量重写，返回结果与 forStudent 一致', () => {
  const sid = mkStudent('打标签的学生');
  const t1 = tags.create({ name: 'T1' });
  const t2 = tags.create({ name: 'T2' });
  const t3 = tags.create({ name: 'T3' });

  let cur = tags.setForStudent(sid, [t1.id, t2.id]);
  assert.deepEqual(cur.map((t) => t.name).sort(), ['T1', 'T2']);

  cur = tags.setForStudent(sid, [t2.id, t3.id]); // 去掉 T1、加 T3
  assert.deepEqual(cur.map((t) => t.name).sort(), ['T2', 'T3']);
  assert.deepEqual(tags.forStudent(sid).map((t) => t.name).sort(), ['T2', 'T3']);

  cur = tags.setForStudent(sid, []); // 清空
  assert.deepEqual(cur, []);
});

test('list 按 tagIds 筛选：任一命中', () => {
  const s1 = mkStudent('学生A');
  const s2 = mkStudent('学生B');
  const s3 = mkStudent('学生C');
  const red = tags.create({ name: '红' });
  const blue = tags.create({ name: '蓝' });
  tags.setForStudent(s1, [red.id]);
  tags.setForStudent(s2, [blue.id]);
  tags.setForStudent(s3, [red.id, blue.id]);

  const byRed = students.list({ tagIds: [red.id] });
  assert.deepEqual(byRed.rows.map((r) => r.name).sort(), ['学生A', '学生C']);

  const byEither = students.list({ tagIds: [red.id, blue.id] });
  assert.deepEqual(byEither.rows.map((r) => r.name).sort(), ['学生A', '学生B', '学生C']);
});

test('删除标签 → student_tags 级联清理', () => {
  const sid = mkStudent('学生D');
  const gone = tags.create({ name: '待删标签' });
  tags.setForStudent(sid, [gone.id]);
  assert.equal(tags.forStudent(sid).length, 1);

  tags.remove(gone.id);

  assert.equal(tags.forStudent(sid).length, 0, '关联应被级联删除');
  const rows = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM student_tags WHERE tag_id = ?`)
    .get(gone.id) as { n: number };
  assert.equal(rows.n, 0);
});

test('get 会 hydrate 学员标签', () => {
  const sid = mkStudent('学生E');
  const x = tags.create({ name: '标签X' });
  tags.setForStudent(sid, [x.id]);
  const s = students.get(sid)!;
  assert.deepEqual(s.tags.map((t) => t.name), ['标签X']);
});
