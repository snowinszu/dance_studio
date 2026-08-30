/**
 * 撤销（voidRecord）与更正（correctRecord）的事务行为。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import { correctRecord, createRecord, voidRecord } from '../../src/domain/attendance.repo';
import type { CorrectionValues, RecordValues } from '../../src/domain/attendance.validation';

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
      .run({ name: `学员${seq}`, phone: `139${String(1000000 + seq)}`, rem: remaining, now })
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
function isVoided(id: number): boolean {
  return (
    (getDb().prepare(`SELECT deleted_at AS d FROM attendance_records WHERE id = ?`).get(id) as {
      d: string | null;
    }).d != null
  );
}

function rv(over: Partial<RecordValues> & { studentId: number }): RecordValues {
  return {
    studentId: over.studentId,
    type: over.type ?? '出勤',
    attendDate: over.attendDate ?? '2026-03-01',
    attendTime: null,
    className: over.className ?? '班A',
    teacher: null,
    lessonsDelta: over.lessonsDelta ?? -1,
    reason: over.reason ?? null,
    operator: null,
    note: null,
    sessionId: null,
    force: over.force ?? false,
    allowDuplicate: over.allowDuplicate ?? false,
  };
}
function cv(over: Partial<CorrectionValues> & { id: number }): CorrectionValues {
  return {
    id: over.id,
    type: over.type ?? '出勤',
    attendDate: over.attendDate ?? '2026-03-01',
    attendTime: null,
    className: over.className ?? '班A',
    teacher: null,
    lessonsDelta: over.lessonsDelta ?? -1,
    operator: null,
    note: null,
    force: over.force ?? false,
  };
}

test('撤销出勤：课时回补，行标记已撤销，返回 studentId', () => {
  const s = mkStudent(5);
  const { id } = createRecord(rv({ studentId: s }));
  assert.equal(balanceOf(s), 4);
  const res = voidRecord(id);
  assert.equal(res.studentId, s);
  assert.equal(res.remainingLessons, 5);
  assert.equal(balanceOf(s), 5);
  assert.ok(isVoided(id));
});

test('二次撤销幂等：不再回补', () => {
  const s = mkStudent(5);
  const { id } = createRecord(rv({ studentId: s }));
  voidRecord(id);
  voidRecord(id);
  assert.equal(balanceOf(s), 5);
});

test('撤销不存在的记录 → ATTENDANCE_NOT_FOUND', () => {
  assert.throws(
    () => voidRecord(999999),
    (e: unknown) => (e as { code?: string }).code === 'ATTENDANCE_NOT_FOUND',
  );
});

test('撤销请假（delta 0）：余额不变', () => {
  const s = mkStudent(5);
  const { id } = createRecord(rv({ studentId: s, type: '请假', lessonsDelta: 0 }));
  voidRecord(id);
  assert.equal(balanceOf(s), 5);
});

test('更正 出勤-1 → 出勤-2：差额 -1，余额再 -1', () => {
  const s = mkStudent(5);
  const { id } = createRecord(rv({ studentId: s }));
  assert.equal(balanceOf(s), 4);
  const res = correctRecord(cv({ id, type: '出勤', lessonsDelta: -2 }));
  assert.equal(res.remainingLessons, 3);
  assert.equal(balanceOf(s), 3);
});

test('更正 出勤-1 → 请假0：差额 +1，余额回补', () => {
  const s = mkStudent(5);
  const { id } = createRecord(rv({ studentId: s }));
  correctRecord(cv({ id, type: '请假', lessonsDelta: 0 }));
  assert.equal(balanceOf(s), 5);
  const row = getDb()
    .prepare(`SELECT type, lessons_delta AS d FROM attendance_records WHERE id = ?`)
    .get(id) as { type: string; d: number };
  assert.equal(row.type, '请假');
  assert.equal(row.d, 0);
});

test('更正差额致负且未 force → INSUFFICIENT_LESSONS；force 放行', () => {
  const s = mkStudent(1);
  const { id } = createRecord(rv({ studentId: s })); // 余额 0
  assert.throws(
    () => correctRecord(cv({ id, type: '出勤', lessonsDelta: -3 })),
    (e: unknown) => (e as { code?: string }).code === 'INSUFFICIENT_LESSONS',
  );
  const res = correctRecord(cv({ id, type: '出勤', lessonsDelta: -3, force: true }));
  assert.equal(res.remainingLessons, -2);
});

test('更正已撤销的记录 → ATTENDANCE_NOT_FOUND', () => {
  const s = mkStudent(5);
  const { id } = createRecord(rv({ studentId: s }));
  voidRecord(id);
  assert.throws(
    () => correctRecord(cv({ id })),
    (e: unknown) => (e as { code?: string }).code === 'ATTENDANCE_NOT_FOUND',
  );
});

test('更正「调整」类型记录 → BAD_REQUEST', () => {
  const s = mkStudent(5);
  const { id } = createRecord(
    rv({ studentId: s, type: '调整', lessonsDelta: 3, className: null, reason: 'x' }),
  );
  assert.throws(
    () => correctRecord(cv({ id })),
    (e: unknown) => (e as { code?: string }).code === 'BAD_REQUEST',
  );
});
