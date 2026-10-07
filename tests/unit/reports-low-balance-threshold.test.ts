/**
 * 课时余额预警阈值可调的集成单测：验证 settings.repo 的阈值变更会实时反映到
 * getOverview / getAlerts / getStudentStats 三处共用口径（而不是仍然硬编码 3）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import { getAlerts, getOverview, getStudentStats } from '../../src/domain/reports.repo';
import { setLowBalanceThreshold } from '../../src/domain/settings.repo';

process.env['STUDIO_DB_PATH'] = ':memory:';
run(getDb());

const db = getDb();
const NOW = new Date().toISOString();
const RANGE = { from: '2000-01-01', to: NOW.slice(0, 10) };

let seq = 0;
function mkStudent(remaining: number): void {
  seq += 1;
  db.prepare(
    `INSERT INTO students
       (name, phone_primary, status, dance_types, remaining_lessons, custom_fields,
        created_at, updated_at)
     VALUES (@name, @phone, '在读', '[]', @rem, '{}', @now, @now)`,
  ).run({ name: `阈值学员${seq}`, phone: `138${String(2000000 + seq)}`, rem: remaining, now: NOW });
}

// 剩余课时分别为 2 / 4 / 6，默认阈值 3 时只有「2」命中
mkStudent(2);
mkStudent(4);
mkStudent(6);

test('默认阈值 3：只命中剩余 2 的学员', () => {
  assert.equal(getOverview(RANGE).lowBalanceCount, 1);
  assert.deepEqual(getAlerts().lowBalance.map((r) => r.remainingLessons), [2]);
  assert.equal(getOverview(RANGE).lowBalanceThreshold, 3);
});

test('把阈值调到 5：命中 2 和 4，getOverview/getAlerts/getStudentStats 三处口径同步变化', () => {
  setLowBalanceThreshold(5);

  const ov = getOverview(RANGE);
  assert.equal(ov.lowBalanceCount, 2);
  assert.equal(ov.lowBalanceThreshold, 5);

  assert.deepEqual(
    getAlerts()
      .lowBalance.map((r) => r.remainingLessons)
      .sort((a, b) => a - b),
    [2, 4],
  );

  const stats = getStudentStats(RANGE);
  assert.equal(stats.lowBalanceThreshold, 5);
  assert.equal(stats.lowBalance.length, 2);
});

test('把阈值调到 0：谁都不命中', () => {
  setLowBalanceThreshold(0);
  assert.equal(getOverview(RANGE).lowBalanceCount, 0);
  assert.deepEqual(getAlerts().lowBalance, []);
});
