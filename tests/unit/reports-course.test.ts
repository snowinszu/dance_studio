/**
 * 课程指标 getCourseStats() 的口径单测。独立进程 / 独立 :memory: 库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import { getCourseStats } from '../../src/domain/reports.repo';

process.env['STUDIO_DB_PATH'] = ':memory:';
run(getDb());

const db = getDb();
const NOW = new Date().toISOString();
const RANGE = { from: '2025-01-01', to: '2025-12-31' };

let seq = 0;
function mkTeacher(name: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO teachers (name, status, created_at, updated_at) VALUES (@n, '在职', @now, @now)`,
      )
      .run({ n: name, now: NOW }).lastInsertRowid,
  );
}
function mkClass(name: string, capacity: number | null, status = '在读'): number {
  return Number(
    db
      .prepare(
        `INSERT INTO classes (name, dance_type, capacity, status, created_at, updated_at)
         VALUES (@n, '中国舞', @cap, @st, @now, @now)`,
      )
      .run({ n: name, cap: capacity, st: status, now: NOW }).lastInsertRowid,
  );
}
function mkRoster(classId: number, left: boolean): void {
  seq += 1;
  const sid = Number(
    db
      .prepare(
        `INSERT INTO students (name, phone_primary, status, dance_types, custom_fields, created_at, updated_at)
         VALUES (@n, @p, '在读', '[]', '{}', @now, @now)`,
      )
      .run({ n: `学员${seq}`, p: `137${String(2000000 + seq)}`, now: NOW }).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO class_students (class_id, student_id, joined_at, left_at, created_at, updated_at)
     VALUES (@cid, @sid, '2025-01-01', @left, @now, @now)`,
  ).run({ cid: classId, sid, left: left ? '2025-06-01' : null, now: NOW });
}
function mkSession(
  classId: number,
  o: {
    date: string;
    start: string;
    end: string;
    teacherId?: number | null;
    status?: string;
    deleted?: boolean;
  },
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO class_sessions
           (class_id, session_date, start_time, end_time, teacher_id, status, origin,
            created_at, updated_at, deleted_at)
         VALUES (@cid, @d, @s, @e, @tid, @st, '手动', @now, @now, @del)`,
      )
      .run({
        cid: classId,
        d: o.date,
        s: o.start,
        e: o.end,
        tid: o.teacherId ?? null,
        st: o.status ?? '正常',
        now: NOW,
        del: o.deleted ? NOW : null,
      }).lastInsertRowid,
  );
}
function linkAttendance(sessionId: number, classId: number): void {
  const sid = Number(
    db
      .prepare(
        `INSERT INTO students (name, phone_primary, status, dance_types, custom_fields, created_at, updated_at)
         VALUES ('点名学员', '13799999999', '在读', '[]', '{}', @now, @now)`,
      )
      .run({ now: NOW }).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO attendance_records
       (student_id, session_id, attend_date, type, lessons_delta, created_at, updated_at)
     VALUES (@sid, @sess, '2025-03-01', '出勤', 0, @now, @now)`,
  ).run({ sid, sess: sessionId, now: NOW });
  void classId;
}

/* ─────────────────────── 夹具 ─────────────────────── */

const T1 = mkTeacher('张老师');
const T2 = mkTeacher('陈老师');

const C1 = mkClass('启蒙班', 6);
const C2 = mkClass('进阶班', null);
mkClass('结课班', 10, '结课'); // 不进 classFillRate
const C4 = mkClass('零容量班', 0);

mkRoster(C1, false);
mkRoster(C1, false);
mkRoster(C1, false);
mkRoster(C1, true); // 已离班 → 不计 enrolled
mkRoster(C2, false);
mkRoster(C2, false);
mkRoster(C4, false);

const S1 = mkSession(C1, { date: '2025-03-01', start: '09:30', end: '11:00', teacherId: T1 }); // 90
mkSession(C1, { date: '2025-03-08', start: '10:00', end: '11:30', teacherId: T1 }); // 90
mkSession(C2, { date: '2025-03-02', start: '14:00', end: '15:00', teacherId: T2 }); // 60
mkSession(C1, { date: '2025-03-15', start: '09:00', end: '10:00', teacherId: null }); // 60 → 未指定
mkSession(C1, { date: '2025-03-22', start: '09:00', end: '10:00', teacherId: T1, status: '停课' });
mkSession(C1, { date: '2025-03-29', start: '09:00', end: '10:00', teacherId: T1, deleted: true });
mkSession(C1, { date: '2024-12-01', start: '09:00', end: '10:00', teacherId: T1 }); // 区间外

linkAttendance(S1, C1); // S1 有到课 → 不算空课

/* ─────────────────────── 断言 ─────────────────────── */

test('getCourseStats.teacherLoad：时长按 HH:MM 换算求和；停课/软删/区间外不计；未指定归组', () => {
  const load = getCourseStats(RANGE).teacherLoad;
  const m = new Map(load.map((r) => [r.teacherName, r]));
  assert.deepEqual(
    { c: m.get('张老师')!.sessionCount, min: m.get('张老师')!.minutes },
    { c: 2, min: 180 },
  );
  assert.deepEqual(
    { c: m.get('陈老师')!.sessionCount, min: m.get('陈老师')!.minutes },
    { c: 1, min: 60 },
  );
  assert.deepEqual(
    { c: m.get('未指定')!.sessionCount, min: m.get('未指定')!.minutes },
    { c: 1, min: 60 },
  );
  assert.equal(load[0]!.teacherName, '张老师'); // 按时长降序，最高在前
});

test('getCourseStats.cancelRate：停课占比；分母为 0 → null', () => {
  const cr = getCourseStats(RANGE).cancelRate;
  assert.deepEqual(cr, { normal: 4, cancelled: 1, rate: 0.2 });
  const none = getCourseStats({ from: '2020-01-01', to: '2020-12-31' }).cancelRate;
  assert.deepEqual(none, { normal: 0, cancelled: 0, rate: null });
});

test('getCourseStats.classFillRate：在册人数 ÷ capacity；capacity 缺失或 <=0 → null；结课班排除', () => {
  const fill = getCourseStats(RANGE).classFillRate;
  const m = new Map(fill.map((r) => [r.className, r]));
  assert.equal(m.has('结课班'), false);
  assert.deepEqual(
    { e: m.get('启蒙班')!.enrolled, cap: m.get('启蒙班')!.capacity, rate: m.get('启蒙班')!.rate },
    { e: 3, cap: 6, rate: 0.5 },
  );
  assert.deepEqual(
    { e: m.get('进阶班')!.enrolled, cap: m.get('进阶班')!.capacity, rate: m.get('进阶班')!.rate },
    { e: 2, cap: null, rate: null },
  );
  assert.equal(m.get('零容量班')!.rate, null); // capacity = 0
});

test('getCourseStats.emptySessions：区间内、正常、0 到课；有到课 / 停课的不算', () => {
  const empty = getCourseStats(RANGE).emptySessions;
  const dates = empty.map((r) => r.sessionDate);
  assert.deepEqual(dates, ['2025-03-15', '2025-03-08', '2025-03-02']); // 按日期倒序
  assert.ok(!empty.some((r) => r.sessionDate === '2025-03-01')); // S1 有到课
});
