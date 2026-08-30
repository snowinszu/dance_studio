/**
 * 首页概况 getHomeSummary() 的口径单测。独立进程 / 独立 :memory: 库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import { getHomeSummary } from '../../src/domain/reports.repo';

process.env['STUDIO_DB_PATH'] = ':memory:';
run(getDb());

const db = getDb();
const NOW = new Date().toISOString();

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
const YESTERDAY = daysAgo(1);

let seq = 0;
function mkStudent(o: { status?: string; enroll?: string | null; deleted?: boolean }): number {
  seq += 1;
  return Number(
    db
      .prepare(
        `INSERT INTO students
           (name, phone_primary, status, dance_types, enroll_date, custom_fields, created_at, updated_at, deleted_at)
         VALUES (@n, @p, @st, '[]', @e, '{}', @now, @now, @del)`,
      )
      .run({
        n: `学员${seq}`,
        p: `137${String(1000000 + seq)}`,
        st: o.status ?? '在读',
        e: o.enroll ?? null,
        now: NOW,
        del: o.deleted ? NOW : null,
      }).lastInsertRowid,
  );
}
function mkClass(): number {
  return Number(
    db
      .prepare(`INSERT INTO classes (name, dance_type, created_at, updated_at) VALUES ('班', '中国舞', @now, @now)`)
      .run({ now: NOW }).lastInsertRowid,
  );
}
function mkSession(
  classId: number,
  o: { date: string; start: string; room?: string | null; status?: string; deleted?: boolean },
): void {
  db.prepare(
    `INSERT INTO class_sessions
       (class_id, session_date, start_time, end_time, room, status, origin, created_at, updated_at, deleted_at)
     VALUES (@c, @d, @s, '23:59', @r, @st, '手动', @now, @now, @del)`,
  ).run({
    c: classId,
    d: o.date,
    s: o.start,
    r: o.room === undefined ? null : o.room,
    st: o.status ?? '正常',
    now: NOW,
    del: o.deleted ? NOW : null,
  });
}
/** 复用同一个学员，避免出勤夹具影响 activeStudents 计数。 */
let attStudentId = 0;
function mkAtt(o: { date: string; type: string; deleted?: boolean }): void {
  if (!attStudentId) attStudentId = mkStudent({});
  db.prepare(
    `INSERT INTO attendance_records
       (student_id, attend_date, type, lessons_delta, created_at, updated_at, deleted_at)
     VALUES (@sid, @d, @t, 0, @now, @now, @del)`,
  ).run({ sid: attStudentId, d: o.date, t: o.type, now: NOW, del: o.deleted ? NOW : null });
}
function mkItem(quantity: number, threshold: number, deleted = false): void {
  seq += 1;
  db.prepare(
    `INSERT INTO inventory_items
       (name, unit, quantity, low_stock_threshold, created_at, updated_at, deleted_at)
     VALUES (@n, '件', @q, @t, @now, @now, @del)`,
  ).run({ n: `物${seq}`, q: quantity, t: threshold, now: NOW, del: deleted ? NOW : null });
}

/* ─────────────────────── 夹具 ─────────────────────── */

// 学员：在读非软删 3；enroll 恰好 30 天前 1、31 天前 0、无 enroll 0
mkStudent({ status: '在读', enroll: daysAgo(30) });
mkStudent({ status: '在读', enroll: daysAgo(31) });
mkStudent({ status: '在读', enroll: null });
mkStudent({ status: '在读', deleted: true });
mkStudent({ status: '毕业', enroll: daysAgo(40) });
// mkAtt 复用一个学员（下面首次调用时创建）→ activeStudents = 3 显式 + 1 复用 = 4

// 今日考勤：出勤 ×3、缺勤 ×1、请假 ×1、补课 ×1；+ 软删出勤 ×1、昨天出勤 ×1
mkAtt({ date: TODAY, type: '出勤' });
mkAtt({ date: TODAY, type: '出勤' });
mkAtt({ date: TODAY, type: '出勤' });
mkAtt({ date: TODAY, type: '缺勤' });
mkAtt({ date: TODAY, type: '请假' });
mkAtt({ date: TODAY, type: '补课' });
mkAtt({ date: TODAY, type: '出勤', deleted: true });
mkAtt({ date: YESTERDAY, type: '出勤' });

const cls = mkClass();
mkSession(cls, { date: TODAY, start: '09:00', room: 'A101' });
mkSession(cls, { date: TODAY, start: '10:00', room: 'A101' }); // 同房间 → 去重
mkSession(cls, { date: TODAY, start: '11:00', room: 'B202' });
mkSession(cls, { date: TODAY, start: '12:00', room: null });
mkSession(cls, { date: TODAY, start: '13:00', room: '   ' });
mkSession(cls, { date: TODAY, start: '14:00', room: 'C303', status: '停课' });
mkSession(cls, { date: TODAY, start: '15:00', room: 'D404', deleted: true });
mkSession(cls, { date: YESTERDAY, start: '09:00', room: 'E505' });

mkItem(5, 2);
mkItem(0, 0); // 0 <= 0 → 低库存
mkItem(3, 5); // 3 <= 5 → 低库存
mkItem(1, 0, true); // 软删 → 全排除

/* ─────────────────────── 断言 ─────────────────────── */

test('getHomeSummary：学员相关字段', () => {
  const h = getHomeSummary();
  // 显式在读 3 + mkAtt 复用的 1 个 = 4（软删 1、毕业 1 不计）
  assert.equal(h.activeStudents, 4);
  // enroll_date 恰为 30 天前算命中；31 天前 / 40 天前 / 无 enroll 不算；不看 status
  assert.equal(h.newStudentsLast30d, 1);
});

test('getHomeSummary：今日出勤人次与出勤率', () => {
  const h = getHomeSummary();
  assert.equal(h.todayCheckIns, 4); // 出勤 3 + 补课 1（软删、昨天不计）
  assert.equal(h.todayAttendanceRate, 3 / 5); // 出勤 3 /(出勤 3 + 缺勤 1 + 请假 1)
});

test('getHomeSummary：今日课节数与在用教室数', () => {
  const h = getHomeSummary();
  assert.equal(h.todaySessions, 5); // 正常未软删今日：A101×2 + B202 + null + 空白
  assert.equal(h.todayRoomsInUse, 2); // 去重非空：A101、B202
});

test('getHomeSummary：库存字段（软删排除）', () => {
  const h = getHomeSummary();
  assert.equal(h.itemKinds, 3);
  assert.equal(h.totalQuantity, 5 + 0 + 3);
  assert.equal(h.lowStockCount, 2);
});

test('getHomeSummary：无排课的日子出勤率为 null；空库合计为 0', () => {
  db.exec('DELETE FROM attendance_records; DELETE FROM class_sessions');
  db.prepare(`UPDATE inventory_items SET deleted_at = @now`).run({ now: NOW });
  const h = getHomeSummary();
  assert.equal(h.todayAttendanceRate, null);
  assert.equal(h.todayCheckIns, 0);
  assert.equal(h.todaySessions, 0);
  assert.equal(h.todayRoomsInUse, 0);
  assert.deepEqual(
    { kinds: h.itemKinds, qty: h.totalQuantity, low: h.lowStockCount },
    { kinds: 0, qty: 0, low: 0 },
  );
});
