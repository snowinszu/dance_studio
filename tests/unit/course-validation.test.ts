/**
 * course.validation 的单测：纯函数，不碰库。
 * 覆盖：老师 / 班级 / 花名册字段校验，日期助手，以及周期规则 / 排课实例校验的
 * INVALID_WEEKDAY / INVALID_TIME_RANGE 分流信号。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isRealYmd,
  overlaps,
  rangeOverlaps,
  todayYmd,
  validateClass,
  validateMonthQuery,
  validateRosterAdd,
  validateSchedule,
  validateSessionCreate,
  validateSessionUpdate,
  validateTeacher,
} from '../../src/domain/course.validation';

test('isRealYmd 拦非历法日期', () => {
  assert.equal(isRealYmd('2026-02-30'), false);
  assert.equal(isRealYmd('2026-13-01'), false);
  assert.equal(isRealYmd('2026-2-1'), false);
  assert.equal(isRealYmd('2024-02-29'), true);
  assert.equal(isRealYmd('2026-08-30'), true);
});

test('overlaps：半开区间，紧挨不算冲突', () => {
  assert.equal(overlaps('19:00', '20:00', '19:30', '20:30'), true);
  assert.equal(overlaps('19:00', '20:00', '20:00', '21:00'), false);
  assert.equal(overlaps('19:00', '20:00', '18:00', '19:00'), false);
});

test('rangeOverlaps：null 端不设限', () => {
  assert.equal(rangeOverlaps(null, null, null, null), true);
  assert.equal(rangeOverlaps('2026-01-01', '2026-06-30', '2026-07-01', null), false);
  assert.equal(rangeOverlaps('2026-01-01', '2026-06-30', '2026-06-30', null), true);
});

test('validateTeacher：新建缺姓名报错、状态非法报错、默认在职', () => {
  assert.ok(validateTeacher({ name: '' }).errors['name']);
  assert.ok(validateTeacher({ name: '甲', status: '休假' as never }).errors['status']);
  assert.equal(validateTeacher({ name: '甲' }).values.status, '在职');
  assert.ok(validateTeacher({ name: 'x'.repeat(21) }).errors['name']);
  // 编辑态省略字段 → undefined，无错
  const e = validateTeacher({ status: '离职' } as never, { isEdit: true });
  assert.deepEqual(e.errors, {});
  assert.equal(e.values.name, undefined);
  assert.equal(e.values.status, '离职');
});

test('validateClass：必填、容量、日期区间、状态', () => {
  assert.ok(validateClass({ name: '', danceType: '' }).errors['name']);
  assert.ok(validateClass({ name: 'A', danceType: '' }).errors['danceType']);
  assert.ok(validateClass({ name: 'A', danceType: '芭蕾', capacity: 0 }).errors['capacity']);
  assert.ok(validateClass({ name: 'A', danceType: '芭蕾', capacity: 2.5 }).errors['capacity']);
  assert.ok(
    validateClass({ name: 'A', danceType: '芭蕾', startDate: '2026-05-01', endDate: '2026-04-01' })
      .errors['endDate'],
  );
  assert.ok(validateClass({ name: 'A', danceType: '芭蕾', status: '暂停' as never }).errors['status']);

  const ok = validateClass({
    name: '芭蕾A',
    danceType: '芭蕾',
    level: '初级',
    capacity: 12,
    startDate: '2026-03-01',
    endDate: '2026-08-31',
  });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.values.capacity, 12);
  assert.equal(ok.values.status, '在读');
  assert.equal(ok.values.level, '初级');
});

test('validateRosterAdd：id 必填，joinedAt 默认今天', () => {
  assert.ok(validateRosterAdd({ classId: 0, studentId: 1 }).errors['classId']);
  assert.ok(validateRosterAdd({ classId: 1, studentId: -1 }).errors['studentId']);
  assert.equal(validateRosterAdd({ classId: 1, studentId: 2 }).values.joinedAt, todayYmd());
  assert.ok(
    validateRosterAdd({ classId: 1, studentId: 2, joinedAt: '2026-02-30' }).errors['joinedAt'],
  );
});

test('validateSchedule：weekday 越界 → weekdayError；时间倒置 → timeError', () => {
  const w = validateSchedule({ classId: 1, weekday: 7, startTime: '19:00', endTime: '20:00' });
  assert.ok(w.weekdayError);
  assert.equal(w.timeError, undefined);

  const t = validateSchedule({ classId: 1, weekday: 3, startTime: '20:00', endTime: '19:00' });
  assert.ok(t.timeError);
  assert.equal(t.weekdayError, undefined);

  const bad = validateSchedule({ classId: 1, weekday: 3, startTime: '9:00', endTime: '10:00' });
  assert.ok(bad.timeError, 'H:MM 非法');

  const ok = validateSchedule({ classId: 1, weekday: 0, startTime: '19:00', endTime: '20:30' });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.weekdayError, undefined);
  assert.equal(ok.timeError, undefined);
  assert.equal(ok.values.weekday, 0);
});

test('validateSessionCreate / validateSessionUpdate', () => {
  assert.ok(
    validateSessionCreate({ classId: 1, sessionDate: '2026-02-30', startTime: '19:00', endTime: '20:00' })
      .errors['sessionDate'],
  );
  assert.ok(
    validateSessionCreate({ classId: 1, sessionDate: '2026-09-02', startTime: '20:00', endTime: '19:00' })
      .timeError,
  );

  // 改时间但结束早于开始 → timeError
  const u = validateSessionUpdate({ id: 1, action: '改时间', startTime: '20:00', endTime: '19:30' });
  assert.ok(u.timeError);
  // 非法 action
  assert.ok(validateSessionUpdate({ id: 1, action: '取消' as never }).errors['action']);
  // 停课：无需时间
  const stop = validateSessionUpdate({ id: 1, action: '停课', note: '国庆放假' });
  assert.deepEqual(stop.errors, {});
  assert.equal(stop.timeError, undefined);
});

test('validateMonthQuery：month 1–12、year 2000–2100', () => {
  assert.ok(validateMonthQuery({ year: 2026, month: 13 }).error);
  assert.ok(validateMonthQuery({ year: 1999, month: 5 }).error);
  const ok = validateMonthQuery({ year: 2026, month: 9, teacherId: 3 });
  assert.equal(ok.error, undefined);
  assert.equal(ok.values.month, 9);
  assert.equal(ok.values.teacherId, 3);
});
