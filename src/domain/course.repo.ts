/**
 * 课程管理的数据读写（仓库层）。
 *
 * 整体类比：教务处的几本册子——老师名册（teachers）、班级档案（classes）、
 * 每个班的花名册（class_students）、周期课表（class_schedules）、按月排出来的
 * 上课日程（class_sessions）。本文件按操作把这些册子的读写封起来。
 *
 * 「课程表」读周期规则、「上课时间计划表」读排课实例；两个视图共用这一份数据。
 * 显示用的班名 / 老师名一律 JOIN 现取，不在流水里快照——班改名后历史跟着变，可接受。
 *
 * 所有 SQL 走预编译语句 + 命名参数，绝不把用户输入拼进语句。软删一律只写 deleted_at。
 */
import { getDb } from '../db/connection';
import { AppError } from '../shared/app-error';
import type {
  ClassSchedule,
  CourseClass,
  CourseClassListItem,
  CourseClassListQuery,
  RosterMember,
  RosterMutationResult,
  ScheduleConflict,
  Teacher,
  WeeklyTimetableEntry,
  WeeklyTimetableQuery,
} from '../shared/types';
import type {
  ClassValues,
  RosterAddValues,
  RosterRemoveValues,
  ScheduleValues,
  TeacherValues,
} from './course.validation';
import { overlaps, rangeOverlaps } from './course.validation';

function nowIso(): string {
  return new Date().toISOString();
}

/** LIKE 通配符转义：% _ \ 前面加反斜杠，配合 SQL 里的 ESCAPE '\'。 */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/* ═══════════════════════════ 老师 ═══════════════════════════ */

const TEACHER_COLUMNS = `
  id,
  name,
  status,
  created_at AS createdAt,
  updated_at AS updatedAt,
  deleted_at AS deletedAt
`;

/** 老师列表。默认只返回未软删的在职老师；includeInactive 时连离职的一起给（仍排除软删）。 */
export function teacherList(opts: { includeInactive?: boolean } = {}): Teacher[] {
  const where = ['deleted_at IS NULL'];
  if (opts.includeInactive !== true) where.push(`status = '在职'`);
  return getDb()
    .prepare(
      `SELECT ${TEACHER_COLUMNS} FROM teachers
        WHERE ${where.join(' AND ')}
        ORDER BY name COLLATE NOCASE`,
    )
    .all() as Teacher[];
}

/** 读一位老师（含已软删，供内部校验用）。 */
function getTeacherRow(id: number): Teacher | undefined {
  return getDb()
    .prepare(`SELECT ${TEACHER_COLUMNS} FROM teachers WHERE id = ?`)
    .get(id) as Teacher | undefined;
}

/** 断言老师存在（含已软删——代课可以指派到刚离职的老师）；不存在抛 TEACHER_NOT_FOUND。 */
export function assertTeacherExists(id: number): void {
  if (!getTeacherRow(id)) {
    throw new AppError('TEACHER_NOT_FOUND', '老师不存在，可能已被删除');
  }
}

export function teacherCreate(values: TeacherValues): Teacher {
  const ts = nowIso();
  const info = getDb()
    .prepare(
      `INSERT INTO teachers (name, status, created_at, updated_at)
       VALUES (@name, @status, @ts, @ts)`,
    )
    .run({ name: values.name, status: values.status ?? '在职', ts });
  return getTeacherRow(Number(info.lastInsertRowid))!;
}

/** 改名 / 改状态。省略的字段保持原值。id 不存在或已软删 → TEACHER_NOT_FOUND。 */
export function teacherUpdate(id: number, values: TeacherValues): Teacher {
  const db = getDb();
  const current = db.prepare(`SELECT id FROM teachers WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!current) throw new AppError('TEACHER_NOT_FOUND', '老师不存在，可能已被删除');

  const sets: string[] = ['updated_at = @ts'];
  const params: Record<string, string | number> = { id, ts: nowIso() };
  if (values.name !== undefined) {
    sets.push('name = @name');
    params['name'] = values.name;
  }
  if (values.status !== undefined) {
    sets.push('status = @status');
    params['status'] = values.status;
  }
  db.prepare(`UPDATE teachers SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getTeacherRow(id)!;
}

/** 软删一位老师。名下班级 / 规则 / 课节的 teacher_id 不动。 */
export function teacherSoftDelete(id: number): { id: number } {
  const db = getDb();
  const current = db.prepare(`SELECT id FROM teachers WHERE id = ? AND deleted_at IS NULL`).get(id);
  if (!current) throw new AppError('TEACHER_NOT_FOUND', '老师不存在，可能已被删除');
  const ts = nowIso();
  db.prepare(`UPDATE teachers SET deleted_at = @ts, updated_at = @ts WHERE id = @id`).run({ ts, id });
  return { id };
}

/* ═══════════════════════════ 班级 ═══════════════════════════ */

/** SELECT 一个班（JOIN 主教姓名），可选带在册人数。id 不存在返回 undefined。 */
function selectClass(id: number): CourseClass | undefined {
  return getDb()
    .prepare(
      `SELECT c.id, c.name, c.dance_type AS danceType, c.level,
              c.teacher_id AS teacherId, t.name AS teacherName,
              c.room, c.capacity, c.start_date AS startDate, c.end_date AS endDate,
              c.status, c.note,
              c.created_at AS createdAt, c.updated_at AS updatedAt, c.deleted_at AS deletedAt
         FROM classes c
         LEFT JOIN teachers t ON t.id = c.teacher_id
        WHERE c.id = ?`,
    )
    .get(id) as CourseClass | undefined;
}

/** 某班当前在册人数（left_at IS NULL）。 */
function activeRosterCount(classId: number): number {
  return (
    getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM class_students WHERE class_id = ? AND left_at IS NULL`,
      )
      .get(classId) as { n: number }
  ).n;
}

function withCount(c: CourseClass): CourseClassListItem {
  const count = activeRosterCount(c.id);
  return {
    ...c,
    activeRosterCount: count,
    overCapacity: c.capacity != null && count > c.capacity,
  };
}

/** 断言班级存在且未软删；不存在抛 CLASS_NOT_FOUND。返回该班（不带计数）。 */
function assertClassExists(id: number): CourseClass {
  const c = selectClass(id);
  if (!c || c.deletedAt != null) {
    throw new AppError('CLASS_NOT_FOUND', '班级不存在，可能已被删除');
  }
  return c;
}

export function classCreate(values: ClassValues): CourseClass {
  if (values.teacherId != null) assertTeacherExists(values.teacherId);
  const ts = nowIso();
  const info = getDb()
    .prepare(
      `INSERT INTO classes
         (name, dance_type, level, teacher_id, room, capacity, start_date, end_date,
          status, note, created_at, updated_at)
       VALUES
         (@name, @danceType, @level, @teacherId, @room, @capacity, @startDate, @endDate,
          @status, @note, @ts, @ts)`,
    )
    .run({ ...values, ts });
  return selectClass(Number(info.lastInsertRowid))!;
}

/** 覆盖式更新一个班。id 不存在或已软删 → CLASS_NOT_FOUND；teacherId 给出不存在 → TEACHER_NOT_FOUND。 */
export function classUpdate(id: number, values: ClassValues): CourseClass {
  assertClassExists(id);
  if (values.teacherId != null) assertTeacherExists(values.teacherId);
  getDb()
    .prepare(
      `UPDATE classes SET
         name = @name, dance_type = @danceType, level = @level, teacher_id = @teacherId,
         room = @room, capacity = @capacity, start_date = @startDate, end_date = @endDate,
         status = @status, note = @note, updated_at = @ts
       WHERE id = @id`,
    )
    .run({ ...values, id, ts: nowIso() });
  return selectClass(id)!;
}

/** 软删一个班。不动其花名册 / 规则 / 排课实例。 */
export function classSoftDelete(id: number): { id: number } {
  assertClassExists(id);
  const ts = nowIso();
  getDb()
    .prepare(`UPDATE classes SET deleted_at = @ts, updated_at = @ts WHERE id = @id`)
    .run({ ts, id });
  return { id };
}

/** 班级详情：带在册人数与超容量标记。 */
export function classGet(id: number): CourseClassListItem {
  return withCount(assertClassExists(id));
}

/** 班级列表：默认排除软删；可按状态 / 舞种 / 主教 / 班名关键字筛选。每行带在册人数与超容量。 */
export function classList(query: CourseClassListQuery = {}): CourseClassListItem[] {
  const where = ['c.deleted_at IS NULL'];
  const params: Record<string, string | number> = {};

  if (query.status) {
    where.push('c.status = @status');
    params['status'] = query.status;
  }
  const dance = (query.danceType ?? '').trim();
  if (dance) {
    where.push('c.dance_type = @dance');
    params['dance'] = dance;
  }
  if (Number.isInteger(query.teacherId)) {
    where.push('c.teacher_id = @tid');
    params['tid'] = query.teacherId as number;
  }
  const kw = (query.keyword ?? '').trim();
  if (kw) {
    where.push(`c.name LIKE @kw ESCAPE '\\'`);
    params['kw'] = `%${escapeLike(kw)}%`;
  }

  const rows = getDb()
    .prepare(
      `SELECT c.id, c.name, c.dance_type AS danceType, c.level,
              c.teacher_id AS teacherId, t.name AS teacherName,
              c.room, c.capacity, c.start_date AS startDate, c.end_date AS endDate,
              c.status, c.note,
              c.created_at AS createdAt, c.updated_at AS updatedAt, c.deleted_at AS deletedAt,
              (SELECT COUNT(*) FROM class_students cs
                WHERE cs.class_id = c.id AND cs.left_at IS NULL) AS activeRosterCount
         FROM classes c
         LEFT JOIN teachers t ON t.id = c.teacher_id
        WHERE ${where.join(' AND ')}
        ORDER BY c.name COLLATE NOCASE`,
    )
    .all(params) as (CourseClass & { activeRosterCount: number })[];

  return rows.map((r) => ({
    ...r,
    overCapacity: r.capacity != null && r.activeRosterCount > r.capacity,
  }));
}

/* ═══════════════════════════ 花名册 ═══════════════════════════ */

/** 某班在册学员（left_at IS NULL），JOIN students 带出姓名 / 手机号 / 剩余课时。 */
export function rosterList(classId: number): RosterMember[] {
  assertClassExists(classId);
  return getDb()
    .prepare(
      `SELECT cs.student_id       AS studentId,
              s.name              AS name,
              s.phone_primary     AS phone,
              s.remaining_lessons AS remainingLessons,
              s.card_expire_date  AS cardExpireDate,
              cs.joined_at        AS joinedAt
         FROM class_students cs
         JOIN students s ON s.id = cs.student_id
        WHERE cs.class_id = ? AND cs.left_at IS NULL
        ORDER BY cs.joined_at, s.name COLLATE NOCASE`,
    )
    .all(classId) as RosterMember[];
}

function rosterResult(classId: number, cls: CourseClass): RosterMutationResult {
  const count = activeRosterCount(classId);
  return {
    classId,
    activeRosterCount: count,
    overCapacity: cls.capacity != null && count > cls.capacity,
  };
}

/**
 * 把学员加入某班。
 * - 班 / 学员不存在（或已软删）→ CLASS_NOT_FOUND / NOT_FOUND
 * - 该学员在该班已有在册记录 → STUDENT_ALREADY_IN_CLASS
 * - 超容量**不报错**：照常加入，返回值里 overCapacity=true
 */
export function rosterAdd(values: RosterAddValues): RosterMutationResult {
  const db = getDb();
  const cls = db.transaction((): CourseClass => {
    const c = assertClassExists(values.classId);
    const stu = db
      .prepare(`SELECT id FROM students WHERE id = ? AND deleted_at IS NULL`)
      .get(values.studentId);
    if (!stu) throw new AppError('NOT_FOUND', '学员不存在，可能已被删除');

    const dup = db
      .prepare(
        `SELECT 1 FROM class_students
          WHERE class_id = @classId AND student_id = @studentId AND left_at IS NULL LIMIT 1`,
      )
      .get({ classId: values.classId, studentId: values.studentId });
    if (dup) throw new AppError('STUDENT_ALREADY_IN_CLASS', '该学员已在此班在册');

    const ts = nowIso();
    db.prepare(
      `INSERT INTO class_students (class_id, student_id, joined_at, created_at, updated_at)
       VALUES (@classId, @studentId, @joinedAt, @ts, @ts)`,
    ).run({ classId: values.classId, studentId: values.studentId, joinedAt: values.joinedAt, ts });
    return c;
  })();

  return rosterResult(values.classId, cls);
}

/** 把学员移出某班：置 left_at（不物理删）。无在册记录 → NOT_FOUND。 */
export function rosterRemove(values: RosterRemoveValues): RosterMutationResult {
  const db = getDb();
  const cls = assertClassExists(values.classId);
  const upd = db
    .prepare(
      `UPDATE class_students SET left_at = @leftAt, updated_at = @ts
        WHERE class_id = @classId AND student_id = @studentId AND left_at IS NULL`,
    )
    .run({
      leftAt: values.leftAt,
      ts: nowIso(),
      classId: values.classId,
      studentId: values.studentId,
    });
  if (upd.changes === 0) throw new AppError('NOT_FOUND', '该学员不在此班在册');
  return rosterResult(values.classId, cls);
}

/* ═══════════════════════════ 周期规则 ═══════════════════════════ */

/** SELECT 列 → ClassSchedule 的映射，带生效老师 / 教室（COALESCE 覆盖值与班默认值）。 */
const SCHEDULE_SELECT = `
  SELECT sch.id, sch.class_id AS classId, sch.weekday,
         sch.start_time AS startTime, sch.end_time AS endTime,
         sch.teacher_id AS teacherId, sch.room,
         sch.effective_from AS effectiveFrom, sch.effective_to AS effectiveTo,
         COALESCE(sch.teacher_id, c.teacher_id)              AS effectiveTeacherId,
         t.name                                              AS effectiveTeacherName,
         COALESCE(NULLIF(sch.room, ''), c.room)              AS effectiveRoom,
         sch.created_at AS createdAt, sch.updated_at AS updatedAt, sch.deleted_at AS deletedAt
    FROM class_schedules sch
    JOIN classes c ON c.id = sch.class_id
    LEFT JOIN teachers t ON t.id = COALESCE(sch.teacher_id, c.teacher_id)
`;

function getScheduleRow(id: number): ClassSchedule | undefined {
  return getDb().prepare(`${SCHEDULE_SELECT} WHERE sch.id = ?`).get(id) as ClassSchedule | undefined;
}

/** 某班的未软删周期规则，按 weekday, start_time 排。 */
export function scheduleList(classId: number): ClassSchedule[] {
  assertClassExists(classId);
  return getDb()
    .prepare(
      `${SCHEDULE_SELECT} WHERE sch.class_id = ? AND sch.deleted_at IS NULL
        ORDER BY sch.weekday, sch.start_time`,
    )
    .all(classId) as ClassSchedule[];
}

/**
 * 扫描所有未软删周期规则，找与候选规则冲突的：
 * 同 weekday + 时段重叠 + 生效区间相交 + （生效老师相同 → kind:'老师' | 生效教室相同且非空 → kind:'教室'）。
 * 非阻断——调用方把结果放进返回值即可。
 */
export function checkScheduleConflicts(candidate: {
  excludeScheduleId?: number;
  weekday: number;
  startTime: string;
  endTime: string;
  effectiveTeacherId: number | null;
  effectiveRoom: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}): ScheduleConflict[] {
  const rows = getDb()
    .prepare(
      `SELECT sch.id, sch.weekday, sch.start_time AS startTime, sch.end_time AS endTime,
              sch.effective_from AS effectiveFrom, sch.effective_to AS effectiveTo,
              COALESCE(sch.teacher_id, c.teacher_id)         AS effTeacherId,
              COALESCE(NULLIF(sch.room, ''), c.room)          AS effRoom,
              c.name AS className
         FROM class_schedules sch
         JOIN classes c ON c.id = sch.class_id
        WHERE sch.deleted_at IS NULL AND c.deleted_at IS NULL AND sch.weekday = @weekday`,
    )
    .all({ weekday: candidate.weekday }) as {
    id: number;
    startTime: string;
    endTime: string;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    effTeacherId: number | null;
    effRoom: string | null;
    className: string;
  }[];

  const out: ScheduleConflict[] = [];
  const room = (candidate.effectiveRoom ?? '').trim();
  for (const r of rows) {
    if (candidate.excludeScheduleId != null && r.id === candidate.excludeScheduleId) continue;
    if (!overlaps(candidate.startTime, candidate.endTime, r.startTime, r.endTime)) continue;
    if (
      !rangeOverlaps(candidate.effectiveFrom, candidate.effectiveTo, r.effectiveFrom, r.effectiveTo)
    ) {
      continue;
    }
    const sameTeacher =
      candidate.effectiveTeacherId != null && r.effTeacherId === candidate.effectiveTeacherId;
    const sameRoom = room.length > 0 && (r.effRoom ?? '').trim() === room;
    if (sameTeacher) {
      out.push({
        kind: '老师',
        refType: '规则',
        refId: r.id,
        label: r.className,
        weekdayOrDate: String(candidate.weekday),
        startTime: r.startTime,
        endTime: r.endTime,
      });
    } else if (sameRoom) {
      out.push({
        kind: '教室',
        refType: '规则',
        refId: r.id,
        label: r.className,
        weekdayOrDate: String(candidate.weekday),
        startTime: r.startTime,
        endTime: r.endTime,
      });
    }
  }
  return out;
}

/** 一条规则的「生效老师 / 教室 / 生效区间」（用于冲突扫描）。 */
function effectiveOf(s: ClassSchedule): {
  effectiveTeacherId: number | null;
  effectiveRoom: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
} {
  return {
    effectiveTeacherId: s.effectiveTeacherId,
    effectiveRoom: s.effectiveRoom,
    effectiveFrom: s.effectiveFrom,
    effectiveTo: s.effectiveTo,
  };
}

export function scheduleCreate(values: ScheduleValues): {
  schedule: ClassSchedule;
  conflicts: ScheduleConflict[];
} {
  assertClassExists(values.classId);
  if (values.teacherId != null) assertTeacherExists(values.teacherId);
  const ts = nowIso();
  const info = getDb()
    .prepare(
      `INSERT INTO class_schedules
         (class_id, weekday, start_time, end_time, teacher_id, room,
          effective_from, effective_to, created_at, updated_at)
       VALUES
         (@classId, @weekday, @startTime, @endTime, @teacherId, @room,
          @effectiveFrom, @effectiveTo, @ts, @ts)`,
    )
    .run({ ...values, ts });
  const schedule = getScheduleRow(Number(info.lastInsertRowid))!;
  const conflicts = checkScheduleConflicts({
    excludeScheduleId: schedule.id,
    weekday: schedule.weekday,
    startTime: schedule.startTime,
    endTime: schedule.endTime,
    ...effectiveOf(schedule),
  });
  return { schedule, conflicts };
}

export function scheduleUpdate(
  id: number,
  values: ScheduleValues,
): { schedule: ClassSchedule; conflicts: ScheduleConflict[] } {
  const db = getDb();
  const cur = db
    .prepare(`SELECT id FROM class_schedules WHERE id = ? AND deleted_at IS NULL`)
    .get(id);
  if (!cur) throw new AppError('SCHEDULE_NOT_FOUND', '该周期规则不存在');
  if (values.teacherId != null) assertTeacherExists(values.teacherId);
  db.prepare(
    `UPDATE class_schedules SET
       weekday = @weekday, start_time = @startTime, end_time = @endTime,
       teacher_id = @teacherId, room = @room,
       effective_from = @effectiveFrom, effective_to = @effectiveTo, updated_at = @ts
     WHERE id = @id`,
  ).run({ ...values, id, ts: nowIso() });
  const schedule = getScheduleRow(id)!;
  const conflicts = checkScheduleConflicts({
    excludeScheduleId: id,
    weekday: schedule.weekday,
    startTime: schedule.startTime,
    endTime: schedule.endTime,
    ...effectiveOf(schedule),
  });
  return { schedule, conflicts };
}

/** 软删一条规则。不追溯已生成的排课实例。 */
export function scheduleSoftDelete(id: number): { id: number } {
  const db = getDb();
  const cur = db
    .prepare(`SELECT id FROM class_schedules WHERE id = ? AND deleted_at IS NULL`)
    .get(id);
  if (!cur) throw new AppError('SCHEDULE_NOT_FOUND', '该周期规则不存在');
  const ts = nowIso();
  db.prepare(`UPDATE class_schedules SET deleted_at = @ts, updated_at = @ts WHERE id = @id`).run({
    ts,
    id,
  });
  return { id };
}

/**
 * 「课程表」周视图：所有未软删班（status != 结课）的未软删周期规则，JOIN 出班名 /
 * 舞种 / 级别 / 生效老师姓名 / 生效教室 / 在册人数。按 weekday, start_time, 班名 排序。
 */
export function weeklyTimetable(query: WeeklyTimetableQuery = {}): WeeklyTimetableEntry[] {
  const where = ["sch.deleted_at IS NULL", "c.deleted_at IS NULL", "c.status != '结课'"];
  const params: Record<string, string | number> = {};
  const dance = (query.danceType ?? '').trim();
  if (dance) {
    where.push('c.dance_type = @dance');
    params['dance'] = dance;
  }
  if (Number.isInteger(query.teacherId)) {
    where.push('COALESCE(sch.teacher_id, c.teacher_id) = @tid');
    params['tid'] = query.teacherId as number;
  }
  return getDb()
    .prepare(
      `SELECT sch.id AS scheduleId, sch.class_id AS classId, c.name AS className,
              c.dance_type AS danceType, c.level, sch.weekday,
              sch.start_time AS startTime, sch.end_time AS endTime,
              COALESCE(sch.teacher_id, c.teacher_id) AS teacherId,
              t.name AS teacherName,
              COALESCE(NULLIF(sch.room, ''), c.room) AS room,
              (SELECT COUNT(*) FROM class_students cs
                WHERE cs.class_id = c.id AND cs.left_at IS NULL) AS activeRosterCount
         FROM class_schedules sch
         JOIN classes c ON c.id = sch.class_id
         LEFT JOIN teachers t ON t.id = COALESCE(sch.teacher_id, c.teacher_id)
        WHERE ${where.join(' AND ')}
        ORDER BY sch.weekday, sch.start_time, c.name COLLATE NOCASE`,
    )
    .all(params) as WeeklyTimetableEntry[];
}
