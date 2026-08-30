/**
 * 考勤指标 getAttendanceStats() 的口径单测。独立进程 / 独立 :memory: 库。
 *
 * 固定用 2025-01..03 这段历史区间做断言，避开和「今天」耦合；absenceTop 另用近几天的
 * 记录（落在该区间外，不干扰 ranking / 月度）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import { getAttendanceStats } from '../../src/domain/reports.repo';

process.env['STUDIO_DB_PATH'] = ':memory:';
run(getDb());

const db = getDb();
const NOW = new Date().toISOString();
const RANGE = { from: '2025-01-01', to: '2025-03-31' };

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function daysAgo(n: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return ymd(d);
}

let seq = 0;
function mkStudent(name: string): number {
  seq += 1;
  return Number(
    db
      .prepare(
        `INSERT INTO students (name, phone_primary, status, dance_types, custom_fields, created_at, updated_at)
         VALUES (@name, @phone, '在读', '[]', '{}', @now, @now)`,
      )
      .run({ name, phone: `137${String(1000000 + seq)}`, now: NOW }).lastInsertRowid,
  );
}
function mkClass(): number {
  return Number(
    db
      .prepare(
        `INSERT INTO classes (name, dance_type, created_at, updated_at)
         VALUES ('测试班', '中国舞', @now, @now)`,
      )
      .run({ now: NOW }).lastInsertRowid,
  );
}
function mkSession(classId: number, date: string, start: string, status = '正常'): void {
  db.prepare(
    `INSERT INTO class_sessions
       (class_id, session_date, start_time, end_time, status, origin, created_at, updated_at)
     VALUES (@cid, @d, @s, '23:59', @st, '手动', @now, @now)`,
  ).run({ cid: classId, d: date, s: start, st: status, now: NOW });
}
function mkAtt(
  studentId: number,
  o: {
    date: string;
    type: string;
    time?: string | null;
    teacher?: string | null;
    className?: string | null;
    deleted?: boolean;
  },
): void {
  db.prepare(
    `INSERT INTO attendance_records
       (student_id, attend_date, attend_time, type, teacher, class_name, lessons_delta,
        created_at, updated_at, deleted_at)
     VALUES (@sid, @d, @t, @type, @teacher, @cn, 0, @now, @now, @del)`,
  ).run({
    sid: studentId,
    d: o.date,
    t: o.time ?? null,
    type: o.type,
    teacher: o.teacher ?? null,
    cn: o.className ?? null,
    now: NOW,
    del: o.deleted ? NOW : null,
  });
}

/* ─────────────────────── 夹具 ─────────────────────── */

const cls = mkClass();
mkSession(cls, '2025-03-10', '09:00'); // 本月 + 本年
mkSession(cls, '2025-01-05', '09:00'); // 仅本年
mkSession(cls, '2025-03-11', '10:00', '停课'); // 不计
mkSession(cls, '2024-12-20', '09:00'); // 非本年

const SA = mkStudent('甲');
const SB = mkStudent('乙');
const SC = mkStudent('丙');

// SA：出勤 3 + 补课 1 + 缺勤 1 → attendCount 4 / attendOnly 3 / scheduled 4 / rate .75
mkAtt(SA, { date: '2025-01-10', type: '出勤', time: '09:30', teacher: '王老师', className: '中国舞' });
mkAtt(SA, { date: '2025-02-10', type: '出勤', time: null, teacher: '王老师', className: '中国舞' });
mkAtt(SA, { date: '2025-03-10', type: '出勤', teacher: null, className: null });
mkAtt(SA, { date: '2025-02-15', type: '补课', teacher: '李老师' });
mkAtt(SA, { date: '2025-03-20', type: '缺勤' });
mkAtt(SA, { date: '2025-03-25', type: '出勤', deleted: true }); // 软删 → 全程不计

// SB：请假 1 + 缺勤 1 → attendCount 0 / scheduled 2 / rate 0
mkAtt(SB, { date: '2025-01-12', type: '请假' });
mkAtt(SB, { date: '2025-01-13', type: '缺勤' });

// SC：补课 1 + 调整 1 → attendCount 1 / attendOnly 0 / scheduled 0 / rate null
mkAtt(SC, { date: '2025-02-01', type: '补课', teacher: null, className: null });
mkAtt(SC, { date: '2025-02-02', type: '调整' });

// absenceTop（近 30 天，落在断言区间外）
mkAtt(SA, { date: daysAgo(3), type: '缺勤' });
mkAtt(SA, { date: daysAgo(4), type: '缺勤' });
mkAtt(SB, { date: daysAgo(5), type: '请假' });

/* ─────────────────────── 断言 ─────────────────────── */

test('getAttendanceStats：课节数由 to 推（本月 1 / 本年 2）', () => {
  const s = getAttendanceStats(RANGE);
  assert.equal(s.sessionsThisMonth, 1);
  assert.equal(s.sessionsThisYear, 2);
});

test('getAttendanceStats：ranking 的三个计数与 rate（scheduled=0 → null）', () => {
  const s = getAttendanceStats(RANGE);
  const byId = new Map(s.ranking.map((r) => [r.studentId, r]));
  const a = byId.get(SA)!;
  const b = byId.get(SB)!;
  const c = byId.get(SC)!;
  assert.deepEqual(
    { attendCount: a.attendCount, attendOnly: a.attendOnly, scheduled: a.scheduled, rate: a.rate },
    { attendCount: 4, attendOnly: 3, scheduled: 4, rate: 0.75 },
  );
  assert.equal(b.attendCount, 0);
  assert.equal(b.rate, 0);
  assert.deepEqual(
    { attendCount: c.attendCount, attendOnly: c.attendOnly, scheduled: c.scheduled, rate: c.rate },
    { attendCount: 1, attendOnly: 0, scheduled: 0, rate: null },
  );
  // 默认按 attendCount 降序
  assert.deepEqual(s.ranking.map((r) => r.studentId), [SA, SC, SB]);
});

test('getAttendanceStats：monthlyCheckIns 补齐每个自然月，缺月为 0', () => {
  const s = getAttendanceStats(RANGE);
  assert.deepEqual(s.monthlyCheckIns, [
    { month: '2025-01', count: 1 },
    { month: '2025-02', count: 3 },
    { month: '2025-03', count: 1 },
  ]);
});

test('getAttendanceStats：hourHeatmap 有空时段桶(-1)与整除桶', () => {
  const s = getAttendanceStats(RANGE);
  assert.ok(s.hourHeatmap.some((c) => c.bucket === -1)); // 02-10 出勤无 attend_time
  assert.ok(s.hourHeatmap.some((c) => c.bucket === 4)); // 01-10 出勤 09:30 → 9/2=4
  assert.ok(s.hourHeatmap.every((c) => c.weekday >= 0 && c.weekday <= 6));
});

test('getAttendanceStats：byTeacher / byDanceType 计出勤+补课，空值归「未记录」', () => {
  const s = getAttendanceStats(RANGE);
  const t = Object.fromEntries(s.byTeacher.map((x) => [x.teacher, x.checkIns]));
  assert.equal(t['王老师'], 2);
  assert.equal(t['李老师'], 1);
  assert.equal(t['未记录'], 2); // SA 03-10（null）+ SC 02-01（null）
  const d = Object.fromEntries(s.byDanceType.map((x) => [x.danceType, x.checkIns]));
  assert.equal(d['中国舞'], 2);
  assert.equal(d['未记录'], 3);
});

test('getAttendanceStats：absenceTop 取近 30 天缺勤+请假，最多在前', () => {
  const s = getAttendanceStats(RANGE);
  assert.equal(s.absenceTop[0]!.studentId, SA);
  assert.equal(s.absenceTop[0]!.absentPlusLeave, 2);
  assert.ok(s.absenceTop.some((r) => r.studentId === SB && r.absentPlusLeave === 1));
});
