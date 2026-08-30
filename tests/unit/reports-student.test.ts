/**
 * 学员指标 getStudentStats() 的口径单测。独立进程 / 独立 :memory: 库。
 * 重点：json_each 展开多舞种、json_valid 跳过脏 dance_types（不抛）、空值归类、月份补齐。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import { getStudentStats } from '../../src/domain/reports.repo';

process.env['STUDIO_DB_PATH'] = ':memory:';
run(getDb());

const db = getDb();
const NOW = new Date().toISOString();
const RANGE = { from: '2025-01-01', to: '2025-04-30' };

let seq = 0;
function mkStudent(o: {
  danceTypes?: string;
  level?: string | null;
  status?: string;
  enroll?: string | null;
  referrer?: string | null;
  remaining?: number | null;
  deleted?: boolean;
}): number {
  seq += 1;
  return Number(
    db
      .prepare(
        `INSERT INTO students
           (name, phone_primary, status, dance_types, current_level, enroll_date, referrer,
            remaining_lessons, custom_fields, created_at, updated_at, deleted_at)
         VALUES (@name, @phone, @status, @dt, @lvl, @enroll, @ref, @rem, '{}', @now, @now, @del)`,
      )
      .run({
        name: `学员${seq}`,
        phone: `137${String(3000000 + seq)}`,
        status: o.status ?? '在读',
        dt: o.danceTypes ?? '[]',
        lvl: o.level === undefined ? null : o.level,
        enroll: o.enroll ?? null,
        ref: o.referrer ?? null,
        rem: o.remaining === undefined ? null : o.remaining,
        now: NOW,
        del: o.deleted ? NOW : null,
      }).lastInsertRowid,
  );
}

/* ─────────────────────── 夹具 ─────────────────────── */

mkStudent({ danceTypes: '["中国舞","爵士舞"]', level: '一级', enroll: '2025-02-10', referrer: '王妈妈' });
mkStudent({ danceTypes: '["中国舞"]', level: null, enroll: '2025-02-20', referrer: '王妈妈' });
mkStudent({ danceTypes: '[]', level: '   ', status: '请假', enroll: '2025-03-05', referrer: null });
mkStudent({ danceTypes: 'not-json', level: null, enroll: null, referrer: '' }); // json_valid=false → 跳过
mkStudent({ danceTypes: '["芭蕾"]', deleted: true }); // 软删 → 全程排除
const st6 = mkStudent({ danceTypes: '[]', remaining: 2 }); // lowBalance

/* ─────────────────────── 断言 ─────────────────────── */

test('getStudentStats.danceTypeDist：多舞种各计一次；脏 dance_types 被 json_valid 跳过（不抛）', () => {
  const dist = getStudentStats(RANGE).danceTypeDist;
  assert.deepEqual(dist, [
    { danceType: '中国舞', count: 2 },
    { danceType: '爵士舞', count: 1 },
  ]);
});

test('getStudentStats.statusDist：按状态计数，排除软删', () => {
  const dist = getStudentStats(RANGE).statusDist;
  assert.deepEqual(dist, [
    { status: '在读', count: 4 },
    { status: '请假', count: 1 },
  ]);
});

test('getStudentStats.levelDist：空 / 纯空白 current_level 归「未分级」', () => {
  const m = Object.fromEntries(getStudentStats(RANGE).levelDist.map((r) => [r.level, r.count]));
  assert.equal(m['一级'], 1);
  assert.equal(m['未分级'], 4); // 2 个 null + 1 个空白 + st6 null
});

test('getStudentStats.monthlyNew：按 enroll_date 月份补齐区间内每个月', () => {
  assert.deepEqual(getStudentStats(RANGE).monthlyNew, [
    { month: '2025-01', count: 0 },
    { month: '2025-02', count: 2 },
    { month: '2025-03', count: 1 },
    { month: '2025-04', count: 0 },
  ]);
});

test('getStudentStats.referrerTop：空 / 空串 referrer 不计', () => {
  assert.deepEqual(getStudentStats(RANGE).referrerTop, [{ referrer: '王妈妈', count: 2 }]);
});

test('getStudentStats：lowBalance / dormant 复用预警口径', () => {
  const s = getStudentStats(RANGE);
  assert.deepEqual(
    s.lowBalance.map((r) => ({ id: r.id, rem: r.remainingLessons })),
    [{ id: st6, rem: 2 }],
  );
  // 4 个在读学员都没有出勤记录 → 全部沉睡
  assert.equal(s.dormant.length, 4);
});
