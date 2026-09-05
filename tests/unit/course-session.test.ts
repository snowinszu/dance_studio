/**
 * course.repo 的排课实例 + 按月生成集成测试：直接调 repo，对内存库。
 * 覆盖：generateMonth 条数正确 + 幂等 + 停课不复活 + 软删后重铺 + 结课班不生成 +
 * effective_from 裁剪；sessionUpdate 停课 / 改时间 / 换老师（schedule_id 不变）；
 * sessionCreate 手动加课 + DUPLICATE_SESSION；sessionsByMonth teacherId 过滤；改规则不追溯。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import * as repo from '../../src/domain/course.repo';
import { validateClass, validateSchedule, validateSessionCreate, validateTeacher } from '../../src/domain/course.validation';
import type { CourseClassInput } from '../../src/shared/types';

process.env['STUDIO_DB_PATH'] = ':memory:';
run(getDb());

function mkTeacher(name: string) {
  return repo.teacherCreate(validateTeacher({ name }).values);
}
function mkClass(input: Partial<CourseClassInput>) {
  const { values, errors } = validateClass(input as CourseClassInput);
  assert.deepEqual(errors, {});
  return repo.classCreate(values);
}
function mkSched(input: Parameters<typeof validateSchedule>[0]) {
  const { values, weekdayError, timeError, errors } = validateSchedule(input);
  assert.ok(!weekdayError && !timeError);
  assert.deepEqual(errors, {});
  return repo.scheduleCreate(values).schedule;
}

// 2026-09：周三是 2 / 9 / 16 / 23 / 30 —— 共 5 个
const Y = 2026;
const M = 9;

test('generateMonth：每周三规则对 2026-09 生成 5 条；重复调 created=0 且不改已存在实例', () => {
  const c = mkClass({ name: '周三生成班', danceType: '生成舞' });
  const s = mkSched({ classId: c.id, weekday: 3, startTime: '19:00', endTime: '20:00' });

  const r1 = repo.generateMonth(Y, M);
  assert.equal(r1.created, 5);

  const list1 = repo.sessionsByMonth({ teacherId: null, year: Y, month: M }).filter((x) => x.classId === c.id);
  assert.equal(list1.length, 5);
  assert.ok(list1.every((x) => x.origin === '计划' && x.scheduleId === s.id && x.status === '正常'));
  assert.deepEqual(
    list1.map((x) => x.sessionDate),
    ['2026-09-02', '2026-09-09', '2026-09-16', '2026-09-23', '2026-09-30'],
  );

  const r2 = repo.generateMonth(Y, M);
  assert.equal(r2.created, 0, '重复生成不新增');
});

test('人工「停课」后再 generateMonth 不复活；软删后 generateMonth 重铺一条新的', () => {
  const c = mkClass({ name: '停课复活班', danceType: '生成舞' });
  mkSched({ classId: c.id, weekday: 3, startTime: '10:00', endTime: '11:00' });
  repo.generateMonth(Y, M);
  let list = repo.sessionsByMonth({ teacherId: null, year: Y, month: M }).filter((x) => x.classId === c.id);
  assert.equal(list.length, 5);

  const first = list[0]!;
  repo.sessionUpdate({ id: first.id, action: '停课', startTime: null, endTime: null, teacherId: null, note: '国庆' });
  repo.generateMonth(Y, M);
  list = repo.sessionsByMonth({ teacherId: null, year: Y, month: M }).filter((x) => x.classId === c.id);
  assert.equal(list.length, 5, '停课实例仍在，未被复制');
  assert.equal(list.find((x) => x.id === first.id)?.status, '停课');

  // 软删一条 → 再生成会重铺一条新的（同日期，新 id）
  const second = list[1]!;
  repo.sessionSoftDelete(second.id);
  const r = repo.generateMonth(Y, M);
  assert.equal(r.created, 1, '软删的日期会重铺');
  list = repo.sessionsByMonth({ teacherId: null, year: Y, month: M }).filter((x) => x.classId === c.id);
  assert.equal(list.length, 5);
  assert.ok(!list.some((x) => x.id === second.id), '旧的软删实例不在结果里');
});

test('改时间 / 换老师：生效且 schedule_id 不变；换老师到不存在 id → TEACHER_NOT_FOUND', () => {
  const t1 = mkTeacher('原老师');
  const t2 = mkTeacher('代课老师');
  const c = mkClass({ name: '微调班', danceType: '生成舞', teacherId: t1.id });
  mkSched({ classId: c.id, weekday: 3, startTime: '15:00', endTime: '16:00' });
  repo.generateMonth(Y, M);
  const one = repo.sessionsByMonth({ teacherId: null, year: Y, month: M }).find((x) => x.classId === c.id)!;
  assert.equal(one.teacherId, t1.id);

  const rt = repo.sessionUpdate({ id: one.id, action: '改时间', startTime: '16:00', endTime: '17:30', teacherId: null, note: null });
  assert.equal(rt.session.startTime, '16:00');
  assert.equal(rt.session.endTime, '17:30');
  assert.equal(rt.session.scheduleId, one.scheduleId, 'schedule_id 不变');

  const rs = repo.sessionUpdate({ id: one.id, action: '换老师', startTime: null, endTime: null, teacherId: t2.id, note: null });
  assert.equal(rs.session.teacherId, t2.id);
  assert.equal(rs.session.teacherName, '代课老师');

  assert.throws(
    () => repo.sessionUpdate({ id: one.id, action: '换老师', startTime: null, endTime: null, teacherId: 99999, note: null }),
    (e: unknown) => (e as { code?: string }).code === 'TEACHER_NOT_FOUND',
  );
});

test('sessionCreate 手动加课 origin=手动 / schedule_id=NULL；同槽位重复 → DUPLICATE_SESSION', () => {
  const c = mkClass({ name: '手动加课班', danceType: '生成舞' });
  const { values } = validateSessionCreate({ classId: c.id, sessionDate: '2026-09-06', startTime: '14:00', endTime: '15:00' });
  const r = repo.sessionCreate(values);
  assert.equal(r.session.origin, '手动');
  assert.equal(r.session.scheduleId, null);
  assert.equal(r.session.status, '正常');

  assert.throws(
    () => repo.sessionCreate(values),
    (e: unknown) => (e as { code?: string }).code === 'DUPLICATE_SESSION',
  );
});

test('结课班不生成；effective_from 裁剪当月只从生效日起', () => {
  const c1 = mkClass({ name: '结课不生成班', danceType: '裁剪舞', status: '结课' });
  mkSched({ classId: c1.id, weekday: 3, startTime: '19:00', endTime: '20:00' });

  const c2 = mkClass({ name: '中途生效班', danceType: '裁剪舞' });
  mkSched({
    classId: c2.id,
    weekday: 3,
    startTime: '19:00',
    endTime: '20:00',
    effectiveFrom: '2026-09-16',
  });
  repo.generateMonth(Y, M);
  const all = repo.sessionsByMonth({ teacherId: null, year: Y, month: M });
  assert.equal(all.filter((x) => x.classId === c1.id).length, 0, '结课班不生成');
  const c2Rows = all.filter((x) => x.classId === c2.id).map((x) => x.sessionDate);
  assert.deepEqual(c2Rows, ['2026-09-16', '2026-09-23', '2026-09-30']);
});

test('sessionsByMonth teacherId 过滤：只返回该老师、排除 teacher_id 为 NULL 的实例', () => {
  const t = mkTeacher('过滤老师');
  const withT = mkClass({ name: '有老师班', danceType: '过滤舞', teacherId: t.id });
  const noT = mkClass({ name: '无老师班', danceType: '过滤舞' });
  mkSched({ classId: withT.id, weekday: 3, startTime: '09:00', endTime: '10:00' });
  mkSched({ classId: noT.id, weekday: 3, startTime: '09:00', endTime: '10:00' });
  repo.generateMonth(Y, M);

  const forT = repo.sessionsByMonth({ teacherId: t.id, year: Y, month: M });
  assert.ok(forT.length >= 5);
  assert.ok(forT.every((x) => x.teacherId === t.id));
  assert.ok(!forT.some((x) => x.classId === noT.id));
});

test('sessionsByDate：返回当天实例 + 在册人数；含停课实例（带标记）', () => {
  const c = mkClass({ name: '按日班', danceType: '按日舞', capacity: 5 });
  mkSched({ classId: c.id, weekday: 3, startTime: '19:00', endTime: '20:00' });
  repo.generateMonth(Y, M);
  const rows = repo.sessionsByDate('2026-09-02').filter((x) => x.classId === c.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, '正常');
  assert.equal(rows[0]?.className, '按日班');

  repo.sessionUpdate({ id: rows[0]!.id, action: '停课', startTime: null, endTime: null, teacherId: null, note: null });
  const rows2 = repo.sessionsByDate('2026-09-02').filter((x) => x.classId === c.id);
  assert.equal(rows2[0]?.status, '停课', '停课实例仍返回、带标记');
});

test('sessionsByDate：未调用 generateMonth 也能读带写补齐当日实例（批量点名下拉框场景）', () => {
  const c = mkClass({ name: '未展开班', danceType: '未展开舞' });
  mkSched({ classId: c.id, weekday: 3, startTime: '19:00', endTime: '20:00' });
  // 刻意不调用 generateMonth：模拟用户只在课程表新建了排课规则、从未打开过月视图
  const rows = repo.sessionsByDate('2026-09-02').filter((x) => x.classId === c.id);
  assert.equal(rows.length, 1, 'sessionsByDate 应自行补齐当月实例，而不是依赖调用方先跑 generateMonth');
  assert.equal(rows[0]?.className, '未展开班');
});

test('改周期规则不追溯已生成实例', () => {
  const c = mkClass({ name: '不追溯班', danceType: '不追溯舞' });
  const s = mkSched({ classId: c.id, weekday: 3, startTime: '19:00', endTime: '20:00' });
  repo.generateMonth(Y, M);
  const before = repo.sessionsByMonth({ teacherId: null, year: Y, month: M }).filter((x) => x.classId === c.id);
  assert.ok(before.every((x) => x.startTime === '19:00'));

  const { values } = validateSchedule({ classId: c.id, weekday: 3, startTime: '20:00', endTime: '21:00' });
  repo.scheduleUpdate(s.id, values);

  const after = repo.sessionsByMonth({ teacherId: null, year: Y, month: M }).filter((x) => x.classId === c.id);
  assert.ok(after.every((x) => x.startTime === '19:00'), '已生成实例仍是旧时间');
});

test('sessionUpdate / sessionSoftDelete 对不存在 id → SESSION_NOT_FOUND', () => {
  assert.throws(
    () => repo.sessionUpdate({ id: 999999, action: '停课', startTime: null, endTime: null, teacherId: null, note: null }),
    (e: unknown) => (e as { code?: string }).code === 'SESSION_NOT_FOUND',
  );
  assert.throws(
    () => repo.sessionSoftDelete(999999),
    (e: unknown) => (e as { code?: string }).code === 'SESSION_NOT_FOUND',
  );
});
