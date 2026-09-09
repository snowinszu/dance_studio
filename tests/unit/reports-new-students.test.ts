/**
 * getNewStudents 的口径单测：与 getOverview 的 newStudentsLast30d 用同一个
 * cutoff（今天-30 天，含当天），只是多返回姓名和入学日期。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import { getNewStudents } from '../../src/domain/reports.repo';

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

let seq = 0;
function mkStudent(opts: { enrollDate?: string | null; deleted?: boolean }): number {
  seq += 1;
  return Number(
    db
      .prepare(
        `INSERT INTO students
           (name, phone_primary, status, dance_types, remaining_lessons, enroll_date,
            custom_fields, created_at, updated_at, deleted_at)
         VALUES (@name, @phone, '在读', '[]', NULL, @enroll, '{}', @now, @now, @del)`,
      )
      .run({
        name: `新生${seq}`,
        phone: `138${String(2000000 + seq)}`,
        enroll: opts.enrollDate ?? null,
        now: NOW,
        del: opts.deleted ? NOW : null,
      }).lastInsertRowid,
  );
}

const idToday = mkStudent({ enrollDate: daysAgo(0) });
const id30 = mkStudent({ enrollDate: daysAgo(30) }); // 恰好 30 天 → 计入（闭区间）
mkStudent({ enrollDate: daysAgo(31) }); // 31 天前 → 不计入
mkStudent({ enrollDate: null }); // 未填入学日期 → 不计入
mkStudent({ enrollDate: daysAgo(0), deleted: true }); // 软删 → 不计入

test('getNewStudents：边界日期与软删/空日期口径正确，按入学日期降序', () => {
  const list = getNewStudents();
  assert.deepEqual(list, [
    { id: idToday, name: '新生1', enrollDate: daysAgo(0) },
    { id: id30, name: '新生2', enrollDate: daysAgo(30) },
  ]);
});
