/**
 * 手动调整课时：validateAdjustment 的 deltaError + repo.adjustLessons 的余额效果与守卫。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import { adjustLessons } from '../../src/domain/attendance.repo';
import { validateAdjustment } from '../../src/domain/attendance.validation';

process.env['STUDIO_DB_PATH'] = ':memory:';
run(getDb());

let seq = 0;
function mkStudent(remaining: number): number {
  seq += 1;
  const now = new Date().toISOString();
  return Number(
    getDb()
      .prepare(
        `INSERT INTO students
           (name, phone_primary, status, dance_types, remaining_lessons, custom_fields, created_at, updated_at)
         VALUES (@name, @phone, '在读', '[]', @rem, '{}', @now, @now)`,
      )
      .run({ name: `学员${seq}`, phone: `137${String(2000000 + seq)}`, rem: remaining, now })
      .lastInsertRowid,
  );
}
function balanceOf(id: number): number {
  return (
    getDb().prepare(`SELECT remaining_lessons AS r FROM students WHERE id = ?`).get(id) as {
      r: number;
    }
  ).r;
}

test('validateAdjustment：delta 为 0 / 非整数 → deltaError（register 据此抛 INVALID_ADJUSTMENT）', () => {
  assert.ok(validateAdjustment({ studentId: 1, delta: 0, reason: 'x' }).deltaError);
  assert.ok(validateAdjustment({ studentId: 1, delta: 1.2, reason: 'x' }).deltaError);
  assert.equal(validateAdjustment({ studentId: 1, delta: -4, reason: 'x' }).deltaError, undefined);
});

test('adjustLessons：+10 使余额 +10，写一条 type=调整 流水', () => {
  const s = mkStudent(2);
  const { values } = validateAdjustment({ studentId: s, delta: 10, reason: '活动补偿' });
  const res = adjustLessons(values);
  assert.equal(res.remainingLessons, 12);
  assert.equal(balanceOf(s), 12);
  const row = getDb()
    .prepare(
      `SELECT type, lessons_delta AS d, reason FROM attendance_records WHERE student_id = ?`,
    )
    .get(s) as { type: string; d: number; reason: string };
  assert.equal(row.type, '调整');
  assert.equal(row.d, 10);
  assert.equal(row.reason, '活动补偿');
});

test('adjustLessons：-5 且余额 3 未 force → INSUFFICIENT_LESSONS；force 后余额 -2', () => {
  const s = mkStudent(3);
  const mk = (force?: boolean) =>
    validateAdjustment({ studentId: s, delta: -5, reason: '手误', force }).values;
  assert.throws(
    () => adjustLessons(mk()),
    (e: unknown) => (e as { code?: string }).code === 'INSUFFICIENT_LESSONS',
  );
  assert.equal(balanceOf(s), 3);
  const res = adjustLessons(mk(true));
  assert.equal(res.remainingLessons, -2);
});

test('adjustLessons：两次一模一样的调整都能写（调整类型跳过重复检测）', () => {
  const s = mkStudent(0);
  const { values } = validateAdjustment({ studentId: s, delta: 4, reason: '赠课' });
  adjustLessons(values);
  adjustLessons({ ...values });
  assert.equal(balanceOf(s), 8);
});
