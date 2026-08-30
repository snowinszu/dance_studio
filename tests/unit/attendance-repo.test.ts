/**
 * 考勤 repo 事务集成：createRecord（扣课时 / 余额守卫 / force / 重复检测 / 学员守卫）
 * 与 batchCreate（每条独立事务、单条失败不回滚）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import { batchCreate, createRecord, listRecords } from '../../src/domain/attendance.repo';
import type { RecordValues } from '../../src/domain/attendance.validation';

process.env['STUDIO_DB_PATH'] = ':memory:';
run(getDb());

let seq = 0;
/** 造一个学员，返回 id。remaining 传 null 表示不设课时。 */
function mkStudent(remaining: number | null, danceTypes = '[]'): number {
  seq += 1;
  const now = new Date().toISOString();
  return Number(
    getDb()
      .prepare(
        `INSERT INTO students
           (name, phone_primary, status, dance_types, remaining_lessons, custom_fields, created_at, updated_at)
         VALUES (@name, @phone, '在读', @dt, @rem, '{}', @now, @now)`,
      )
      .run({
        name: `学员${seq}`,
        phone: `1380000${String(1000 + seq)}`,
        dt: danceTypes,
        rem: remaining,
        now,
      }).lastInsertRowid,
  );
}

function balanceOf(studentId: number): number | null {
  const row = getDb()
    .prepare(`SELECT remaining_lessons AS r FROM students WHERE id = ?`)
    .get(studentId) as { r: number | null };
  return row.r;
}

function countRows(studentId: number): number {
  return (
    getDb()
      .prepare(`SELECT COUNT(*) AS n FROM attendance_records WHERE student_id = ?`)
      .get(studentId) as { n: number }
  ).n;
}

function rv(over: Partial<RecordValues> & { studentId: number }): RecordValues {
  return {
    studentId: over.studentId,
    type: over.type ?? '出勤',
    attendDate: over.attendDate ?? '2026-03-01',
    attendTime: over.attendTime ?? null,
    className: over.className ?? '街舞初级',
    teacher: over.teacher ?? null,
    lessonsDelta: over.lessonsDelta ?? -1,
    reason: over.reason ?? null,
    operator: over.operator ?? null,
    note: over.note ?? null,
    sessionId: null,
    force: over.force ?? false,
    allowDuplicate: over.allowDuplicate ?? false,
  };
}

test('出勤扣 1：余额 2 → 1，流水写一行', () => {
  const s = mkStudent(2);
  const res = createRecord(rv({ studentId: s }));
  assert.equal(res.remainingLessons, 1);
  assert.equal(balanceOf(s), 1);
  assert.equal(countRows(s), 1);
});

test('私教出勤扣 2：余额 2 → 0', () => {
  const s = mkStudent(2);
  const res = createRecord(rv({ studentId: s, lessonsDelta: -2 }));
  assert.equal(res.remainingLessons, 0);
});

test('请假 / 缺勤 不动余额', () => {
  const s = mkStudent(5);
  createRecord(rv({ studentId: s, type: '请假', lessonsDelta: 0 }));
  createRecord(rv({ studentId: s, type: '缺勤', lessonsDelta: 0, className: '爵士' }));
  assert.equal(balanceOf(s), 5);
  assert.equal(countRows(s), 2);
});

test('余额不足且未强制 → INSUFFICIENT_LESSONS，余额与流水都不变', () => {
  const s = mkStudent(0);
  assert.throws(
    () => createRecord(rv({ studentId: s })),
    (e: unknown) => (e as { code?: string }).code === 'INSUFFICIENT_LESSONS',
  );
  assert.equal(balanceOf(s), 0);
  assert.equal(countRows(s), 0);
});

test('remaining_lessons 为 NULL 视作 0：出勤非强制被拦', () => {
  const s = mkStudent(null);
  assert.throws(
    () => createRecord(rv({ studentId: s })),
    (e: unknown) => (e as { code?: string }).code === 'INSUFFICIENT_LESSONS',
  );
});

test('force：余额 0 也能记，余额落成 -1', () => {
  const s = mkStudent(0);
  const res = createRecord(rv({ studentId: s, force: true }));
  assert.equal(res.remainingLessons, -1);
  assert.equal(balanceOf(s), -1);
});

test('重复检测：同 学员+日期+课程+类型 第二次 → DUPLICATE_ATTENDANCE', () => {
  const s = mkStudent(10);
  createRecord(rv({ studentId: s }));
  assert.throws(
    () => createRecord(rv({ studentId: s })),
    (e: unknown) => (e as { code?: string }).code === 'DUPLICATE_ATTENDANCE',
  );
  assert.equal(countRows(s), 1);
});

test('allowDuplicate 放行重复', () => {
  const s = mkStudent(10);
  createRecord(rv({ studentId: s }));
  createRecord(rv({ studentId: s, allowDuplicate: true }));
  assert.equal(countRows(s), 2);
  assert.equal(balanceOf(s), 8);
});

test('同日同课不同类型不算重复：先请假再出勤都能记', () => {
  const s = mkStudent(10);
  createRecord(rv({ studentId: s, type: '请假', lessonsDelta: 0 }));
  createRecord(rv({ studentId: s, type: '出勤', lessonsDelta: -1 }));
  assert.equal(countRows(s), 2);
});

test('调整类型跳过重复检测：两条一模一样的调整都能记', () => {
  const s = mkStudent(0);
  createRecord(rv({ studentId: s, type: '调整', lessonsDelta: 5, className: null, reason: 'a' }));
  createRecord(rv({ studentId: s, type: '调整', lessonsDelta: 5, className: null, reason: 'a' }));
  assert.equal(balanceOf(s), 10);
});

test('学员不存在 / 已软删 → NOT_FOUND', () => {
  assert.throws(
    () => createRecord(rv({ studentId: 999999 })),
    (e: unknown) => (e as { code?: string }).code === 'NOT_FOUND',
  );
  const s = mkStudent(5);
  getDb()
    .prepare(`UPDATE students SET deleted_at = @now WHERE id = @id`)
    .run({ now: new Date().toISOString(), id: s });
  assert.throws(
    () => createRecord(rv({ studentId: s })),
    (e: unknown) => (e as { code?: string }).code === 'NOT_FOUND',
  );
});

test('batchCreate：中间一条余额不足 → 其余照常写入，不回滚', () => {
  const a = mkStudent(2);
  const b = mkStudent(0); // 会失败
  const c = mkStudent(2);
  const result = batchCreate([
    rv({ studentId: a, className: '合班' }),
    rv({ studentId: b, className: '合班' }),
    rv({ studentId: c, className: '合班' }),
  ]);
  assert.equal(result.succeeded, 2);
  assert.equal(result.skipped, 1);
  assert.equal(result.rows[1]?.ok, false);
  assert.equal(result.rows[1]?.errorCode, 'INSUFFICIENT_LESSONS');
  assert.equal(balanceOf(a), 1);
  assert.equal(balanceOf(b), 0, '失败条目的学员余额不变');
  assert.equal(balanceOf(c), 1);
});

test('listRecords：JOIN 出学员姓名/手机号，事务后返回值与库一致', () => {
  const s = mkStudent(3, '["拉丁"]');
  createRecord(rv({ studentId: s, className: '拉丁提高', attendDate: '2026-04-10' }));
  const { rows, total } = listRecords({ keyword: '学员', dateFrom: '2026-04-01' });
  assert.ok(total >= 1);
  const mine = rows.find((r) => r.studentId === s);
  assert.ok(mine);
  assert.equal(mine?.className, '拉丁提高');
  assert.ok(mine?.studentName?.startsWith('学员'));
  assert.equal(mine?.lessonsDelta, -1);
});
