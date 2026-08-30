/**
 * 考勤校验层纯函数单测：deltaFor / validateQuickCheckIn / validateBatchCheckIn / validateAdjustment。
 * 不碰数据库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deltaFor,
  todayYmd,
  validateAdjustment,
  validateBatchCheckIn,
  validateQuickCheckIn,
} from '../../src/domain/attendance.validation';

test('deltaFor：出勤缺省扣 1，私教填 2 扣 2，非正整数报错', () => {
  assert.deepEqual(deltaFor('出勤', undefined), { delta: -1 });
  assert.deepEqual(deltaFor('出勤', 2), { delta: -2 });
  assert.deepEqual(deltaFor('出勤', ''), { delta: -1 });
  assert.ok('error' in deltaFor('出勤', 0));
  assert.ok('error' in deltaFor('出勤', 1.5));
  assert.ok('error' in deltaFor('出勤', -1));
});

test('deltaFor：请假 / 缺勤 / 补课 / 试听 一律 0，不看 lessons', () => {
  for (const t of ['请假', '缺勤', '补课', '试听'] as const) {
    assert.deepEqual(deltaFor(t, 3), { delta: 0 });
  }
});

test('validateQuickCheckIn：最小合法输入无错误，日期缺省为今天，出勤 delta = -1', () => {
  const { values, errors } = validateQuickCheckIn({ studentId: 1, type: '出勤' });
  assert.deepEqual(errors, {});
  assert.equal(values.attendDate, todayYmd());
  assert.equal(values.lessonsDelta, -1);
  assert.equal(values.type, '出勤');
  assert.equal(values.sessionId, null);
});

test('validateQuickCheckIn：类型非法 / 日期非历法 / 时间格式错 / 课程超长 各自报错', () => {
  assert.ok(
    validateQuickCheckIn({ studentId: 1, type: '调整' as never }).errors['type'],
  );
  assert.ok(
    validateQuickCheckIn({ studentId: 1, type: '出勤', attendDate: '2026-02-30' }).errors[
      'attendDate'
    ],
  );
  assert.ok(
    validateQuickCheckIn({ studentId: 1, type: '出勤', attendTime: '25:00' }).errors[
      'attendTime'
    ],
  );
  assert.ok(
    validateQuickCheckIn({ studentId: 1, type: '出勤', className: 'x'.repeat(41) }).errors[
      'className'
    ],
  );
});

test('validateQuickCheckIn：缺学员报错', () => {
  assert.ok(validateQuickCheckIn({ type: '出勤' } as never).errors['studentId']);
});

test('validateBatchCheckIn：entries 为空报错；某条类型非法 → entries.N.type 报错', () => {
  assert.ok(validateBatchCheckIn({ entries: [] }).errors['entries']);
  const r = validateBatchCheckIn({
    className: '爵士',
    entries: [
      { studentId: 1, type: '出勤' },
      { studentId: 2, type: '调整' as never },
    ],
  });
  assert.ok(r.errors['entries.1.type']);
});

test('validateBatchCheckIn：合法输入 → 每条共享公共字段，出勤 delta = -1', () => {
  const { values, errors } = validateBatchCheckIn({
    attendDate: '2026-03-01',
    className: '街舞',
    teacher: '王老师',
    operator: '前台A',
    entries: [
      { studentId: 1, type: '出勤' },
      { studentId: 2, type: '请假' },
      { studentId: 3, type: '出勤', lessons: 2 },
    ],
  });
  assert.deepEqual(errors, {});
  assert.equal(values.length, 3);
  assert.ok(values.every((v) => v.attendDate === '2026-03-01' && v.className === '街舞'));
  assert.equal(values[0]?.lessonsDelta, -1);
  assert.equal(values[1]?.lessonsDelta, 0);
  assert.equal(values[2]?.lessonsDelta, -2);
});

test('validateAdjustment：delta 为 0 / 非整数 → deltaError；缺原因 → errors.reason', () => {
  assert.ok(validateAdjustment({ studentId: 1, delta: 0, reason: 'x' }).deltaError);
  assert.ok(validateAdjustment({ studentId: 1, delta: 2.5, reason: 'x' }).deltaError);
  assert.ok(validateAdjustment({ studentId: 1, delta: 5, reason: '' }).errors['reason']);
});

test('validateAdjustment：合法 → type=调整，lessonsDelta 原样带符号，allowDuplicate=true', () => {
  const { values, errors, deltaError } = validateAdjustment({
    studentId: 1,
    delta: -3,
    reason: '手误多扣',
  });
  assert.deepEqual(errors, {});
  assert.equal(deltaError, undefined);
  assert.equal(values.type, '调整');
  assert.equal(values.lessonsDelta, -3);
  assert.equal(values.allowDuplicate, true);
  assert.equal(values.reason, '手误多扣');
});
