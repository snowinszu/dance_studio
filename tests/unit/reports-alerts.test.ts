/**
 * 预警中心 getAlerts() 的口径单测。
 *
 * 每个 .test.ts 文件在独立进程里跑，各自一个 :memory: 库——所以这里的夹具不会
 * 和 reports-repo.test.ts（概览）互相污染。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import { getAlerts } from '../../src/domain/reports.repo';

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
/** 今天 ± n 天（本地），n 为正 = 过去。 */
function dayOffset(n: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return ymd(d);
}

let seq = 0;
function mkStudent(opts: {
  name?: string;
  status?: string;
  remaining?: number | null;
  deleted?: boolean;
}): number {
  seq += 1;
  return Number(
    db
      .prepare(
        `INSERT INTO students
           (name, phone_primary, status, dance_types, remaining_lessons, custom_fields,
            created_at, updated_at, deleted_at)
         VALUES (@name, @phone, @status, '[]', @rem, '{}', @now, @now, @del)`,
      )
      .run({
        name: opts.name ?? `学员${seq}`,
        phone: `137${String(1000000 + seq)}`,
        status: opts.status ?? '在读',
        rem: opts.remaining === undefined ? null : opts.remaining,
        now: NOW,
        del: opts.deleted ? NOW : null,
      }).lastInsertRowid,
  );
}
function mkItem(name: string, quantity: number, threshold: number, deleted = false): void {
  db.prepare(
    `INSERT INTO inventory_items
       (name, unit, quantity, low_stock_threshold, created_at, updated_at, deleted_at)
     VALUES (@name, '件', @q, @t, @now, @now, @del)`,
  ).run({ name, q: quantity, t: threshold, now: NOW, del: deleted ? NOW : null });
}
function mkClass(): number {
  return Number(
    db
      .prepare(
        `INSERT INTO classes (name, dance_type, created_at, updated_at)
         VALUES ('少儿中国舞', '中国舞', @now, @now)`,
      )
      .run({ now: NOW }).lastInsertRowid,
  );
}
function mkSession(
  classId: number,
  opts: { date: string; start: string; status?: string },
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO class_sessions
           (class_id, session_date, start_time, end_time, status, origin, created_at, updated_at)
         VALUES (@cid, @date, @start, '23:59', @status, '手动', @now, @now)`,
      )
      .run({
        cid: classId,
        date: opts.date,
        start: opts.start,
        status: opts.status ?? '正常',
        now: NOW,
      }).lastInsertRowid,
  );
}
function mkAttendance(
  studentId: number,
  opts: { date: string; type: string; sessionId?: number | null },
): void {
  db.prepare(
    `INSERT INTO attendance_records
       (student_id, session_id, attend_date, type, lessons_delta, created_at, updated_at)
     VALUES (@sid, @session, @date, @type, 0, @now, @now)`,
  ).run({
    sid: studentId,
    session: opts.sessionId ?? null,
    date: opts.date,
    type: opts.type,
    now: NOW,
  });
}

/* ─────────────────────── 夹具 ─────────────────────── */

// lowStock：命中 2（含恰好等于阈值），排除充足与软删
mkItem('把杆布套', 2, 5);
mkItem('练功袜', 5, 5);
mkItem('地垫', 10, 3);
mkItem('旧海报', 0, 0, true);

// lowBalance：命中 2（含恰好 3），排除 4 / 软删 / 非在读
mkStudent({ name: '余额1', remaining: 1 });
mkStudent({ name: '余额3', remaining: 3 });
mkStudent({ name: '余额4', remaining: 4 });
mkStudent({ name: '余额软删', remaining: 2, deleted: true });
mkStudent({ name: '余额毕业', status: '毕业', remaining: 0 });

// dormant：D3/D4/D5 命中
const d1 = mkStudent({ name: 'D1_59天前有出勤' });
mkAttendance(d1, { date: dayOffset(59), type: '出勤' });
const d2 = mkStudent({ name: 'D2_恰好60天前有出勤' });
mkAttendance(d2, { date: dayOffset(60), type: '出勤' });
const d3 = mkStudent({ name: 'D3_61天前有出勤' });
mkAttendance(d3, { date: dayOffset(61), type: '出勤' });
mkStudent({ name: 'D4_从无记录' });
const d5 = mkStudent({ name: 'D5_只有请假' });
mkAttendance(d5, { date: dayOffset(1), type: '请假' });
mkStudent({ name: 'D6_软删', deleted: true });
mkStudent({ name: 'D7_毕业', status: '毕业' });

// emptySessions：E1/E5 命中
const cls = mkClass();
const stForSess = mkStudent({ name: '点名用' });
mkSession(cls, { date: dayOffset(5), start: '09:00' }); // E1：空课，命中
const e2 = mkSession(cls, { date: dayOffset(5), start: '11:00' });
mkAttendance(stForSess, { date: dayOffset(5), type: '出勤', sessionId: e2 });
mkSession(cls, { date: dayOffset(5), start: '13:00', status: '停课' });
mkSession(cls, { date: dayOffset(40), start: '09:00' });
const e5 = mkSession(cls, { date: dayOffset(1), start: '15:00' });
mkAttendance(stForSess, { date: dayOffset(1), type: '请假', sessionId: e5 });
mkSession(cls, { date: dayOffset(-1), start: '09:00' }); // 明天：未发生

/* ─────────────────────── 断言 ─────────────────────── */

test('getAlerts.lowStock：命中低库存（含等于阈值），最紧缺在前', () => {
  const { lowStock } = getAlerts();
  assert.deepEqual(
    lowStock.map((r) => r.name),
    ['把杆布套', '练功袜'],
  );
  assert.deepEqual(lowStock[0], { id: lowStock[0]!.id, name: '把杆布套', quantity: 2, threshold: 5 });
});

test('getAlerts.lowBalance：命中 <=3（含 3），排除 4 / 软删 / 非在读', () => {
  const names = getAlerts().lowBalance.map((r) => r.name);
  assert.deepEqual(names, ['余额1', '余额3']);
});

test('getAlerts.dormant：近 60 天无「出勤」；第 60 天当天算未沉睡；请假不算出勤', () => {
  const dormant = getAlerts().dormant;
  const names = new Set(dormant.map((r) => r.name));
  // 61 天前有出勤 / 从无记录 / 只有请假 → 沉睡
  assert.ok(names.has('D3_61天前有出勤'));
  assert.ok(names.has('D4_从无记录'));
  assert.ok(names.has('D5_只有请假'));
  // 59 天前、恰好 60 天前有出勤 → 不沉睡（>= cutoff60）
  assert.ok(!names.has('D1_59天前有出勤'));
  assert.ok(!names.has('D2_恰好60天前有出勤'));
  // 软删 / 非在读不计
  assert.ok(!names.has('D6_软删'));
  assert.ok(!names.has('D7_毕业'));

  assert.equal(dormant.find((r) => r.name === 'D3_61天前有出勤')!.lastAttendDate, dayOffset(61));
  assert.equal(dormant.find((r) => r.name === 'D4_从无记录')!.lastAttendDate, null);
  assert.equal(dormant.find((r) => r.name === 'D5_只有请假')!.lastAttendDate, null);

  // 排序：lastAttendDate 为空的整体排在有值的前面
  const firstWithDate = dormant.findIndex((r) => r.lastAttendDate !== null);
  const lastWithoutDate = dormant.map((r) => r.lastAttendDate).lastIndexOf(null);
  assert.ok(firstWithDate === -1 || firstWithDate > lastWithoutDate);
});

test('getAlerts.emptySessions：近 30 天内、已发生、正常、0 出勤/补课；请假不算到课', () => {
  const empty = getAlerts().emptySessions;
  assert.deepEqual(
    empty.map((r) => ({ date: r.sessionDate, start: r.startTime })),
    [
      { date: dayOffset(1), start: '15:00' },
      { date: dayOffset(5), start: '09:00' },
    ],
  );
  assert.equal(empty[0]!.className, '少儿中国舞');
});
