/**
 * listRecords / listRosterCandidates 的筛选、排序、分页、软删排除。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import { listRecords, listRosterCandidates } from '../../src/domain/attendance.repo';

process.env['STUDIO_DB_PATH'] = ':memory:';
run(getDb());

const now = new Date().toISOString();

function mkStudent(name: string, phone: string, danceTypes = '[]', remaining = 100): number {
  return Number(
    getDb()
      .prepare(
        `INSERT INTO students
           (name, phone_primary, status, dance_types, remaining_lessons, custom_fields, created_at, updated_at)
         VALUES (@name, @phone, '在读', @dt, @rem, '{}', @now, @now)`,
      )
      .run({ name, phone, dt: danceTypes, rem: remaining, now }).lastInsertRowid,
  );
}

/** 直接插一行考勤流水（绕过 createRecord，方便造各种日期 / 已撤销）。 */
function mkRecord(opts: {
  studentId: number;
  date: string;
  type?: string;
  cls?: string | null;
  deleted?: boolean;
}): number {
  const id = Number(
    getDb()
      .prepare(
        `INSERT INTO attendance_records
           (student_id, attend_date, type, class_name, lessons_delta, deleted_at, created_at, updated_at)
         VALUES (@sid, @date, @type, @cls, 0, @del, @now, @now)`,
      )
      .run({
        sid: opts.studentId,
        date: opts.date,
        type: opts.type ?? '出勤',
        cls: opts.cls ?? '班A',
        del: opts.deleted ? now : null,
        now,
      }).lastInsertRowid,
  );
  return id;
}

const alice = mkStudent('Alice', '13900000001', '["街舞","爵士"]');
const bob = mkStudent('Bob', '13900000002', '["拉丁"]');

mkRecord({ studentId: alice, date: '2026-01-10', type: '出勤' });
mkRecord({ studentId: alice, date: '2026-02-15', type: '请假' });
mkRecord({ studentId: alice, date: '2026-03-20', type: '出勤' });
mkRecord({ studentId: bob, date: '2026-02-15', type: '缺勤' });
mkRecord({ studentId: bob, date: '2026-02-16', type: '出勤', deleted: true });

test('日期区间：含端点', () => {
  const r = listRecords({ dateFrom: '2026-02-15', dateTo: '2026-02-15' });
  assert.equal(r.total, 2); // alice 请假 + bob 缺勤（bob 的已撤销那条是 02-16，不在区间也已排除）
});

test('keyword 命中姓名', () => {
  const r = listRecords({ keyword: 'Alice' });
  assert.equal(r.total, 3);
  assert.ok(r.rows.every((x) => x.studentName === 'Alice'));
});

test('keyword 命中手机号', () => {
  const r = listRecords({ keyword: '13900000002' });
  assert.equal(r.total, 1);
  assert.equal(r.rows[0]?.studentName, 'Bob');
});

test('type 精确筛选', () => {
  assert.equal(listRecords({ type: '出勤' }).total, 2); // alice x2；bob 那条出勤已撤销
  assert.equal(listRecords({ type: '缺勤' }).total, 1);
});

test('已撤销记录默认不出现', () => {
  const all = listRecords({});
  assert.equal(all.total, 4);
  assert.ok(all.rows.every((x) => x.deletedAt === null));
});

test('排序：attend_date 倒序', () => {
  const rows = listRecords({ keyword: 'Alice' }).rows;
  assert.deepEqual(
    rows.map((r) => r.attendDate),
    ['2026-03-20', '2026-02-15', '2026-01-10'],
  );
});

test('分页：total 是过滤后的总数，rows 只有一页', () => {
  const r = listRecords({ limit: 2, offset: 0 });
  assert.equal(r.total, 4);
  assert.equal(r.rows.length, 2);
  const p2 = listRecords({ limit: 2, offset: 2 });
  assert.equal(p2.rows.length, 2);
});

test('listRosterCandidates：舞种包含匹配，且带回解析后的 danceTypes 数组', () => {
  const jazz = listRosterCandidates({ danceType: '爵士' });
  assert.equal(jazz.length, 1);
  assert.equal(jazz[0]?.name, 'Alice');
  assert.deepEqual(jazz[0]?.danceTypes, ['街舞', '爵士']);
  const latin = listRosterCandidates({ danceType: '拉丁' });
  assert.equal(latin[0]?.name, 'Bob');
  assert.deepEqual(latin[0]?.danceTypes, ['拉丁']);
});

test('listRosterCandidates：keyword + 软删排除', () => {
  assert.equal(listRosterCandidates({ keyword: 'Bob' }).length, 1);
  getDb()
    .prepare(`UPDATE students SET deleted_at = @now WHERE id = @id`)
    .run({ now, id: bob });
  assert.equal(listRosterCandidates({ keyword: 'Bob' }).length, 0);
});
