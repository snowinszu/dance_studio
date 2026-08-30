/**
 * course.repo 的周期规则 + 冲突检测集成测试：直接调 repo，对内存库。
 * 覆盖：一班多规则、软删；checkScheduleConflicts 同老师 / 同教室 / 生效区间不相交 /
 * excludeScheduleId 不自撞 / 软删规则不参与；scheduleUpdate 不触碰 class_sessions。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import * as repo from '../../src/domain/course.repo';
import { validateClass, validateSchedule, validateTeacher } from '../../src/domain/course.validation';
import type { ClassScheduleInput, CourseClassInput, TeacherInput } from '../../src/shared/types';

process.env['STUDIO_DB_PATH'] = ':memory:';
run(getDb());

function mkTeacher(name: string) {
  const { values } = validateTeacher({ name } as TeacherInput);
  return repo.teacherCreate(values);
}
function mkClass(input: Partial<CourseClassInput>) {
  const { values, errors } = validateClass(input as CourseClassInput);
  assert.deepEqual(errors, {});
  return repo.classCreate(values);
}
function sched(input: ClassScheduleInput) {
  const { values, errors, weekdayError, timeError } = validateSchedule(input);
  assert.equal(weekdayError, undefined, weekdayError);
  assert.equal(timeError, undefined, timeError);
  assert.deepEqual(errors, {});
  return repo.scheduleCreate(values);
}

test('一个班可加多条规则；scheduleList 按 weekday, start_time 排序', () => {
  const c = mkClass({ name: '多时段班', danceType: '中国舞' });
  sched({ classId: c.id, weekday: 4, startTime: '19:00', endTime: '20:00' });
  sched({ classId: c.id, weekday: 2, startTime: '19:00', endTime: '20:00' });
  sched({ classId: c.id, weekday: 2, startTime: '10:00', endTime: '11:00' });
  const list = repo.scheduleList(c.id);
  assert.equal(list.length, 3);
  assert.deepEqual(
    list.map((s) => [s.weekday, s.startTime]),
    [
      [2, '10:00'],
      [2, '19:00'],
      [4, '19:00'],
    ],
  );
});

test('同一生效老师、同 weekday、时段重叠 → conflicts 含 kind:老师；规则仍落库', () => {
  const t = mkTeacher('冲突老师');
  const c1 = mkClass({ name: '冲突A', danceType: '爵士', teacherId: t.id });
  const c2 = mkClass({ name: '冲突B', danceType: '拉丁', teacherId: t.id });
  sched({ classId: c1.id, weekday: 3, startTime: '19:00', endTime: '20:00' });
  const r = sched({ classId: c2.id, weekday: 3, startTime: '19:30', endTime: '20:30' });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0]?.kind, '老师');
  assert.equal(r.conflicts[0]?.label, '冲突A');
  assert.equal(repo.scheduleList(c2.id).length, 1, '冲突不阻断，规则已落库');
});

test('同教室、时段重叠、不同老师 → conflicts 含 kind:教室', () => {
  const c1 = mkClass({ name: '教室A班', danceType: '街舞', room: '301' });
  const c2 = mkClass({ name: '教室B班', danceType: '芭蕾', room: '301' });
  sched({ classId: c1.id, weekday: 5, startTime: '18:00', endTime: '19:00' });
  const r = sched({ classId: c2.id, weekday: 5, startTime: '18:30', endTime: '19:30' });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0]?.kind, '教室');
});

test('紧挨（19:00-20:00 与 20:00-21:00）不算冲突', () => {
  const t = mkTeacher('紧挨老师');
  const c1 = mkClass({ name: '紧挨A', danceType: '现代舞', teacherId: t.id });
  const c2 = mkClass({ name: '紧挨B', danceType: '现代舞', teacherId: t.id });
  sched({ classId: c1.id, weekday: 1, startTime: '19:00', endTime: '20:00' });
  const r = sched({ classId: c2.id, weekday: 1, startTime: '20:00', endTime: '21:00' });
  assert.equal(r.conflicts.length, 0);
});

test('生效区间不相交 → 无冲突', () => {
  const t = mkTeacher('分期老师');
  const c1 = mkClass({ name: '上半年班', danceType: '中国舞', teacherId: t.id });
  const c2 = mkClass({ name: '下半年班', danceType: '中国舞', teacherId: t.id });
  sched({
    classId: c1.id,
    weekday: 6,
    startTime: '14:00',
    endTime: '15:00',
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-06-30',
  });
  const r = sched({
    classId: c2.id,
    weekday: 6,
    startTime: '14:00',
    endTime: '15:00',
    effectiveFrom: '2026-07-01',
    effectiveTo: '2026-12-31',
  });
  assert.equal(r.conflicts.length, 0);
});

test('scheduleUpdate 改自己不自撞（excludeScheduleId 生效）；软删规则不参与扫描', () => {
  const t = mkTeacher('改自己老师');
  const c = mkClass({ name: '改自己班', danceType: '爵士', teacherId: t.id });
  const a = sched({ classId: c.id, weekday: 0, startTime: '10:00', endTime: '11:00' });
  // 改这条规则本身，时段不变 → 不应把自己算成冲突
  const { values } = validateSchedule({ classId: c.id, weekday: 0, startTime: '10:00', endTime: '11:30' });
  const upd = repo.scheduleUpdate(a.schedule.id, values);
  assert.equal(upd.conflicts.length, 0);

  // 另加一条真冲突，再软删它 → 冲突消失
  const b = sched({ classId: c.id, weekday: 0, startTime: '10:15', endTime: '11:15' });
  const withDup = repo.scheduleUpdate(a.schedule.id, values);
  assert.equal(withDup.conflicts.length, 1, '软删前应能扫到 b');
  repo.scheduleSoftDelete(b.schedule.id);
  const afterDel = repo.scheduleUpdate(a.schedule.id, values);
  assert.equal(afterDel.conflicts.length, 0, '软删后 b 不再参与扫描');
});

test('scheduleCreate classId 不存在 → CLASS_NOT_FOUND；teacherId 不存在 → TEACHER_NOT_FOUND', () => {
  assert.throws(
    () => repo.scheduleCreate(validateSchedule({ classId: 99999, weekday: 1, startTime: '19:00', endTime: '20:00' }).values),
    (e: unknown) => (e as { code?: string }).code === 'CLASS_NOT_FOUND',
  );
  const c = mkClass({ name: '兜底班', danceType: '街舞' });
  assert.throws(
    () =>
      repo.scheduleCreate(
        validateSchedule({ classId: c.id, weekday: 1, startTime: '19:00', endTime: '20:00', teacherId: 88888 }).values,
      ),
    (e: unknown) => (e as { code?: string }).code === 'TEACHER_NOT_FOUND',
  );
});

test('scheduleUpdate / scheduleSoftDelete 对不存在 id → SCHEDULE_NOT_FOUND', () => {
  const { values } = validateSchedule({ classId: 1, weekday: 1, startTime: '19:00', endTime: '20:00' });
  assert.throws(
    () => repo.scheduleUpdate(77777, values),
    (e: unknown) => (e as { code?: string }).code === 'SCHEDULE_NOT_FOUND',
  );
  assert.throws(
    () => repo.scheduleSoftDelete(77777),
    (e: unknown) => (e as { code?: string }).code === 'SCHEDULE_NOT_FOUND',
  );
});
