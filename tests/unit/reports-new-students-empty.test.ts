/**
 * getNewStudents 的空列表边界：库里一个学员都没有（或都不满足条件）时返回 []。
 * 单独一个文件是因为 node:test 按文件分进程跑，这样能保证是真正的空库，
 * 不受 reports-new-students.test.ts 里那份边界夹具影响。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import { getNewStudents } from '../../src/domain/reports.repo';

process.env['STUDIO_DB_PATH'] = ':memory:';
run(getDb());

test('getNewStudents：空库 → 空数组', () => {
  assert.deepEqual(getNewStudents(), []);
});
