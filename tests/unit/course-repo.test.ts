/**
 * course.repo 的老师 / 班级 / 花名册集成测试：直接调 repo，对内存库。
 * 覆盖：老师增改软删（软删后 JOIN 仍带名）、班级增改软删（软删班不进列表）、
 * classList 筛选与 activeRosterCount / overCapacity、rosterAdd 重复 / 超容量 / 离班再入班、rosterRemove。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import * as repo from '../../src/domain/course.repo';
import {
  todayYmd,
  validateClass,
  validateSchedule,
  type TeacherValues,
  validateTeacher,
} from '../../src/domain/course.validation';
import type { CourseClassInput, TeacherInput } from '../../src/shared/types';

process.env['STUDIO_DB_PATH'] = ':memory:';
run(getDb());

/** 花名册 repo 收的是校验后的值（joinedAt/leftAt 必填），测试里补上今天。 */
function addRoster(classId: number, studentId: number) {
  return repo.rosterAdd({ classId, studentId, joinedAt: todayYmd() });
}
function removeRoster(classId: number, studentId: number) {
  return repo.rosterRemove({ classId, studentId, leftAt: todayYmd() });
}

let seq = 0;
/** 插一个学员，返回 id。名字 / 手机号自增避免碰撞。 */
function seedStudent(remaining: number | null = null): number {
  seq += 1;
  const info = getDb()
    .prepare(
      `INSERT INTO students (name, phone_primary, remaining_lessons, created_at, updated_at)
       VALUES (@name, @phone, @rem, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    )
    .run({ name: `学员${seq}`, phone: `1380000${String(1000 + seq)}`, rem: remaining });
  return Number(info.lastInsertRowid);
}

function mkTeacher(input: Partial<TeacherInput>, isEdit = false): TeacherValues {
  const { values, errors } = validateTeacher(input as TeacherInput, { isEdit });
  assert.deepEqual(errors, {}, '测试种子不该有校验错误');
  return values;
}
function mkClass(input: Partial<CourseClassInput>) {
  const { values, errors } = validateClass(input as CourseClassInput);
  assert.deepEqual(errors, {}, '测试种子不该有校验错误');
  return values;
}

/* ───────────────────────── 老师 ───────────────────────── */

test('老师 create → list（默认只在职）→ update 改名改状态 → 软删后 list 消失但 JOIN 仍带名', () => {
  const zhang = repo.teacherCreate(mkTeacher({ name: '张老师' }));
  assert.equal(zhang.status, '在职');

  repo.teacherCreate(mkTeacher({ name: '李老师', status: '离职' }));
  const active = repo.teacherList();
  assert.ok(active.some((t) => t.name === '张老师'));
  assert.ok(!active.some((t) => t.name === '李老师'), '默认不返回离职老师');
  assert.ok(repo.teacherList({ includeInactive: true }).some((t) => t.name === '李老师'));

  const renamed = repo.teacherUpdate(zhang.id, mkTeacher({ name: '张三老师' }, true));
  assert.equal(renamed.name, '张三老师');
  const off = repo.teacherUpdate(zhang.id, mkTeacher({ status: '离职' }, true));
  assert.equal(off.name, '张三老师', 'update 省略 name 应保持原值');
  assert.equal(off.status, '离职');

  // 软删老师后：其名下班级 JOIN 仍带出老师名
  const cls = repo.classCreate(mkClass({ name: '张老师的班', danceType: '中国舞', teacherId: zhang.id }));
  repo.teacherSoftDelete(zhang.id);
  assert.ok(!repo.teacherList({ includeInactive: true }).some((t) => t.id === zhang.id));
  assert.equal(repo.classGet(cls.id).teacherName, '张三老师', '软删老师后班级仍带出其姓名');
});

test('teacherUpdate / teacherSoftDelete 对不存在 id → TEACHER_NOT_FOUND', () => {
  assert.throws(
    () => repo.teacherUpdate(99999, mkTeacher({ name: 'x' }, true)),
    (e: unknown) => (e as { code?: string }).code === 'TEACHER_NOT_FOUND',
  );
  assert.throws(
    () => repo.teacherSoftDelete(99999),
    (e: unknown) => (e as { code?: string }).code === 'TEACHER_NOT_FOUND',
  );
});

/* ───────────────────────── 班级 ───────────────────────── */

test('班级 create → update → 软删：软删班不进 classList，classGet 仍报错', () => {
  const c = repo.classCreate(mkClass({ name: '芭蕾初级A', danceType: '芭蕾', level: '初级', capacity: 10 }));
  assert.equal(c.status, '在读');
  assert.equal(c.danceType, '芭蕾');

  const u = repo.classUpdate(c.id, mkClass({ name: '芭蕾初级A', danceType: '芭蕾', level: '中级', capacity: 12, status: '停课' }));
  assert.equal(u.level, '中级');
  assert.equal(u.status, '停课');

  repo.classSoftDelete(c.id);
  assert.ok(!repo.classList().some((x) => x.id === c.id), '软删班不进列表');
  assert.throws(
    () => repo.classGet(c.id),
    (e: unknown) => (e as { code?: string }).code === 'CLASS_NOT_FOUND',
  );
});

test('classCreate teacherId 不存在 → TEACHER_NOT_FOUND', () => {
  assert.throws(
    () => repo.classCreate(mkClass({ name: '无主班', danceType: '街舞', teacherId: 88888 })),
    (e: unknown) => (e as { code?: string }).code === 'TEACHER_NOT_FOUND',
  );
});

test('classList 按 status / danceType / teacherId / keyword 筛选', () => {
  const t = repo.teacherCreate(mkTeacher({ name: '筛选老师' }));
  repo.classCreate(mkClass({ name: '筛选-爵士周末', danceType: '爵士', teacherId: t.id, status: '在读' }));
  repo.classCreate(mkClass({ name: '筛选-爵士结课', danceType: '爵士', status: '结课' }));
  repo.classCreate(mkClass({ name: '筛选-拉丁', danceType: '拉丁', status: '在读' }));

  assert.equal(repo.classList({ danceType: '爵士' }).length >= 2, true);
  assert.equal(repo.classList({ status: '结课', keyword: '筛选' }).length, 1);
  assert.equal(repo.classList({ teacherId: t.id }).length, 1);
  assert.equal(repo.classList({ keyword: '拉丁' }).length, 1);
});

/* ───────────────────────── 花名册 ───────────────────────── */

test('rosterAdd / rosterList / rosterRemove：计数、超容量标记、离班再入班', () => {
  const c = repo.classCreate(mkClass({ name: '容量2的班', danceType: '中国舞', capacity: 2 }));
  const s1 = seedStudent(10);
  const s2 = seedStudent(0);
  const s3 = seedStudent(null);

  const r1 = addRoster(c.id, s1);
  assert.equal(r1.activeRosterCount, 1);
  assert.equal(r1.overCapacity, false);

  addRoster(c.id, s2);
  const r3 = addRoster(c.id, s3);
  assert.equal(r3.activeRosterCount, 3);
  assert.equal(r3.overCapacity, true, '超容量应成功且标记 overCapacity');

  const list = repo.rosterList(c.id);
  assert.equal(list.length, 3);
  assert.equal(list[0]?.remainingLessons, 10);

  // 重复加入 → STUDENT_ALREADY_IN_CLASS
  assert.throws(
    () => addRoster(c.id, s1),
    (e: unknown) => (e as { code?: string }).code === 'STUDENT_ALREADY_IN_CLASS',
  );

  // 移出 s3 → 计数回 2、不再超容量
  const rr = removeRoster(c.id, s3);
  assert.equal(rr.activeRosterCount, 2);
  assert.equal(rr.overCapacity, false);
  assert.equal(repo.rosterList(c.id).length, 2);

  // 移出不在册的 → NOT_FOUND
  assert.throws(
    () => removeRoster(c.id, s3),
    (e: unknown) => (e as { code?: string }).code === 'NOT_FOUND',
  );

  // 离班后可再次加入
  assert.doesNotThrow(() => addRoster(c.id, s3));
  assert.equal(repo.rosterList(c.id).length, 3);
});

test('classList 每行带 activeRosterCount / overCapacity', () => {
  const c = repo.classCreate(mkClass({ name: '计数班', danceType: '现代舞', capacity: 1 }));
  addRoster(c.id, seedStudent());
  addRoster(c.id, seedStudent());
  const row = repo.classList({ keyword: '计数班' })[0];
  assert.ok(row);
  assert.equal(row.activeRosterCount, 2);
  assert.equal(row.overCapacity, true);
});

test('rosterAdd 学员不存在 → NOT_FOUND；班不存在 → CLASS_NOT_FOUND', () => {
  const c = repo.classCreate(mkClass({ name: '空班', danceType: '爵士' }));
  assert.throws(
    () => addRoster(c.id, 777777),
    (e: unknown) => (e as { code?: string }).code === 'NOT_FOUND',
  );
  assert.throws(
    () => addRoster(777777, seedStudent()),
    (e: unknown) => (e as { code?: string }).code === 'CLASS_NOT_FOUND',
  );
});

test('weeklyTimetable：JOIN 出班名 / 生效老师 / 在册人数；结课班与软删班不出现；按 weekday,start_time 排', () => {
  const sched = (classId: number, weekday: number, s: string, e: string) => {
    const { values } = validateSchedule({ classId, weekday, startTime: s, endTime: e });
    repo.scheduleCreate(values);
  };
  const t = repo.teacherCreate(mkTeacher({ name: '周表老师' }));
  const c1 = repo.classCreate(mkClass({ name: '周表在读', danceType: '周表舞', teacherId: t.id }));
  const c2 = repo.classCreate(mkClass({ name: '周表结课', danceType: '周表舞', status: '结课' }));
  const c3 = repo.classCreate(mkClass({ name: '周表软删', danceType: '周表舞' }));
  addRoster(c1.id, seedStudent());
  addRoster(c1.id, seedStudent());
  sched(c1.id, 5, '19:00', '20:00');
  sched(c1.id, 2, '10:00', '11:00');
  sched(c2.id, 3, '19:00', '20:00');
  sched(c3.id, 4, '19:00', '20:00');
  repo.classSoftDelete(c3.id);

  const rows = repo.weeklyTimetable({ danceType: '周表舞' });
  assert.equal(rows.length, 2, '只留在读班 c1 的两条规则');
  assert.deepEqual(rows.map((r) => [r.weekday, r.startTime]), [[2, '10:00'], [5, '19:00']]);
  assert.equal(rows[0]?.className, '周表在读');
  assert.equal(rows[0]?.teacherName, '周表老师');
  assert.equal(rows[0]?.activeRosterCount, 2);

  assert.equal(repo.weeklyTimetable({ danceType: '周表舞', teacherId: t.id }).length, 2);
  assert.equal(repo.weeklyTimetable({ danceType: '周表舞', teacherId: 999999 }).length, 0);
});
