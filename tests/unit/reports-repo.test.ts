/**
 * 数据报表只读聚合的口径单测。
 *
 * 每个函数一个 describe。用 :memory: 库跑真实迁移后塞已知夹具，断言口径与边界
 * （软删不计、区间边界闭、恰好等于阈值算命中、跨年归属）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import { getOverview } from '../../src/domain/reports.repo';

process.env['STUDIO_DB_PATH'] = ':memory:';
run(getDb());

const db = getDb();
const NOW = new Date().toISOString();

/** 本地 'YYYY-MM-DD'，与 reports.repo 内部算 cutoff 的方式一致。 */
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
const TODAY = ymd(new Date());
const THIS_YEAR = new Date().getFullYear();

let seq = 0;
function mkStudent(opts: {
  status?: string;
  remaining?: number | null;
  enrollDate?: string | null;
  deleted?: boolean;
}): number {
  seq += 1;
  return Number(
    db
      .prepare(
        `INSERT INTO students
           (name, phone_primary, status, dance_types, remaining_lessons, enroll_date,
            custom_fields, created_at, updated_at, deleted_at)
         VALUES (@name, @phone, @status, '[]', @rem, @enroll, '{}', @now, @now, @del)`,
      )
      .run({
        name: `学员${seq}`,
        phone: `137${String(1000000 + seq)}`,
        status: opts.status ?? '在读',
        rem: opts.remaining === undefined ? null : opts.remaining,
        enroll: opts.enrollDate ?? null,
        now: NOW,
        del: opts.deleted ? NOW : null,
      }).lastInsertRowid,
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

function mkSession(
  classId: number,
  opts: { date: string; start?: string; status?: string; deleted?: boolean },
): void {
  // 同班同日同开始时间的未软删课节有部分唯一索引，夹具里错开 start_time。
  db.prepare(
    `INSERT INTO class_sessions
       (class_id, session_date, start_time, end_time, status, origin, created_at, updated_at, deleted_at)
     VALUES (@cid, @date, @start, '23:59', @status, '手动', @now, @now, @del)`,
  ).run({
    cid: classId,
    date: opts.date,
    start: opts.start ?? '09:00',
    status: opts.status ?? '正常',
    now: NOW,
    del: opts.deleted ? NOW : null,
  });
}

function mkAttendance(studentId: number, opts: {
  date: string;
  type: string;
  sessionId?: number | null;
  deleted?: boolean;
}): void {
  db.prepare(
    `INSERT INTO attendance_records
       (student_id, session_id, attend_date, type, lessons_delta, created_at, updated_at, deleted_at)
     VALUES (@sid, @session, @date, @type, 0, @now, @now, @del)`,
  ).run({
    sid: studentId,
    session: opts.sessionId ?? null,
    date: opts.date,
    type: opts.type,
    now: NOW,
    del: opts.deleted ? NOW : null,
  });
}

function mkItem(opts: { quantity: number; threshold: number; deleted?: boolean }): void {
  seq += 1;
  db.prepare(
    `INSERT INTO inventory_items
       (name, unit, quantity, low_stock_threshold, created_at, updated_at, deleted_at)
     VALUES (@name, '件', @qty, @th, @now, @now, @del)`,
  ).run({
    name: `物件${seq}`,
    qty: opts.quantity,
    th: opts.threshold,
    now: NOW,
    del: opts.deleted ? NOW : null,
  });
}

/* ─────────────────────── 夹具 ─────────────────────── */

const s1 = mkStudent({ status: '在读', remaining: 10 });
mkStudent({ status: '在读', remaining: 3 }); // 恰好等于阈值 → 计入 lowBalance
mkStudent({ status: '在读', remaining: null }); // 未设课时 → 不计入 lowBalance
mkStudent({ status: '毕业', remaining: 1 }); // 非在读 → 不计 active / lowBalance
mkStudent({ status: '在读', remaining: 2, deleted: true }); // 软删 → 不计 active
mkStudent({ status: '在读', enrollDate: daysAgo(30) }); // 恰好 30 天 → 计入 new30
mkStudent({ status: '在读', enrollDate: daysAgo(31) }); // 31 天前 → 不计 new30
// active 在读非软删：s1 + rem3 + remNull + enroll30 + enroll31 = 5

const cls = mkClass();
mkSession(cls, { date: TODAY, start: '09:00' }); // 正常 + 在区间 → 计入
mkSession(cls, { date: TODAY, start: '11:00', status: '停课' }); // 停课 → 不计
mkSession(cls, { date: TODAY, start: '13:00', deleted: true }); // 软删 → 不计
mkSession(cls, { date: '1999-06-01', start: '09:00' }); // 区间外 → 不计

mkAttendance(s1, { date: TODAY, type: '出勤', sessionId: null }); // 计 checkIn；当年 + 无课节 → 计 unlinked
mkAttendance(s1, { date: TODAY, type: '补课', sessionId: 1 }); // 计 checkIn；有课节 → 不计 unlinked
mkAttendance(s1, { date: TODAY, type: '请假' }); // 类型不符 → 不计
mkAttendance(s1, { date: TODAY, type: '出勤', deleted: true }); // 已撤销 → 不计
mkAttendance(s1, { date: '1999-01-01', type: '出勤' }); // 区间外 + 非当年 → 都不计

mkItem({ quantity: 0, threshold: 0 }); // 0 <= 0 → 低库存
mkItem({ quantity: 5, threshold: 10 }); // 5 <= 10 → 低库存
mkItem({ quantity: 20, threshold: 5 }); // 充足 → 不计
mkItem({ quantity: 0, threshold: 0, deleted: true }); // 软删 → 不计

/* ─────────────────────── 断言 ─────────────────────── */

test('getOverview：六项 KPI + unlinkedCheckInsThisYear 口径正确', () => {
  const ov = getOverview({ from: '2000-01-01', to: TODAY });
  assert.deepEqual(ov, {
    activeStudents: 5,
    checkInsInRange: 2,
    sessionsInRange: 1,
    newStudentsLast30d: 1,
    lowBalanceCount: 1,
    lowStockCount: 2,
    unlinkedCheckInsThisYear: 1,
  });
});

test('getOverview：区间收窄到未来 → 区间相关项归 0，存量项不变', () => {
  const future = `${THIS_YEAR + 1}-01-01`;
  const ov = getOverview({ from: future, to: `${THIS_YEAR + 1}-12-31` });
  assert.equal(ov.checkInsInRange, 0);
  assert.equal(ov.sessionsInRange, 0);
  // 存量项（不受 range 影响）
  assert.equal(ov.activeStudents, 5);
  assert.equal(ov.lowBalanceCount, 1);
  assert.equal(ov.lowStockCount, 2);
  // unlinked 取 to 的年份 → 明年没有记录
  assert.equal(ov.unlinkedCheckInsThisYear, 0);
});
