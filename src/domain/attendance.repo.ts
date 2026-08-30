/**
 * 考勤管理的数据读写（仓库层）。
 *
 * 整体类比：前台手里的考勤登记簿 + 每个学员的课时存折。核心动作 createRecord =
 * 「往登记簿记一行 + 改一下存折余额」，两步绑在一个事务里：不允许记了考勤却没扣课时，
 * 也不允许（非强制时）把课时扣成负数。
 *
 * students.remaining_lessons 是「剩余课时」的权威缓存，列表 / 学员档案直接读它，
 * 不靠汇总 attendance_records 实时算——与 inventory_items.quantity 同一套路。
 *
 * 所有 SQL 走预编译语句 + 命名参数，绝不把用户输入拼进语句。
 */
import { getDb } from '../db/connection';
import { AppError } from '../shared/app-error';
import type {
  AttendanceListQuery,
  AttendanceListResult,
  AttendanceRecord,
  BatchCheckInResult,
  BatchCheckInRowResult,
  CheckInResult,
  MonthlySummaryRow,
  RosterCandidate,
  RosterCandidateQuery,
} from '../shared/types';
import type { CorrectionValues, RecordValues } from './attendance.validation';

function nowIso(): string {
  return new Date().toISOString();
}

/** LIKE 通配符转义：% _ \ 前面加反斜杠，配合 SQL 里的 ESCAPE '\'。 */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** SELECT 出来的列名 → AttendanceRecord 字段的映射，多处复用。 */
const RECORD_COLUMNS = `
  a.id,
  a.student_id     AS studentId,
  s.name           AS studentName,
  s.phone_primary  AS studentPhone,
  a.session_id     AS sessionId,
  a.class_name     AS className,
  a.teacher,
  a.attend_date    AS attendDate,
  a.attend_time    AS attendTime,
  a.type,
  a.lessons_delta  AS lessonsDelta,
  a.reason,
  a.operator,
  a.note,
  a.created_at     AS createdAt,
  a.updated_at     AS updatedAt,
  a.deleted_at     AS deletedAt
`;

/** 读某学员当前剩余课时（createRecord 之后必为真实整数）。 */
function readBalance(studentId: number): number {
  const row = getDb()
    .prepare(`SELECT COALESCE(remaining_lessons, 0) AS bal FROM students WHERE id = ?`)
    .get(studentId) as { bal: number } | undefined;
  return row ? Number(row.bal) : 0;
}

/**
 * 记一条考勤（或一条课时调整）：一个事务里「查重 → 余额守卫 → 改余额 → 插流水」。
 *
 * - `type='调整'` 跳过重复检测。
 * - `force` 跳过余额守卫，允许 remaining_lessons 记为负数（欠课是真实场景）。
 * - 改余额的 `UPDATE ... WHERE id=? AND deleted_at IS NULL`，changes!=1 即学员不存在 / 已软删 → NOT_FOUND。
 * - 守卫用「事务内先读后写」而非原子 WHERE 条件：better-sqlite3 同步 + 单进程单连接无并发，
 *   且 force 分支本就要允许 UPDATE 把余额改负，原子条件反而碍事。
 *
 * @returns 新流水 id + 该学员写入后的剩余课时
 */
export function createRecord(v: RecordValues): CheckInResult {
  const db = getDb();
  const now = nowIso();

  const tx = db.transaction((): number => {
    // 1. 重复检测（调整类型不查）
    if (v.type !== '调整' && !v.allowDuplicate) {
      const dup = db
        .prepare(
          `SELECT 1 FROM attendance_records
            WHERE student_id = @sid
              AND attend_date = @date
              AND COALESCE(class_name, '') = COALESCE(@cls, '')
              AND type = @type
              AND deleted_at IS NULL
            LIMIT 1`,
        )
        .get({ sid: v.studentId, date: v.attendDate, cls: v.className, type: v.type });
      if (dup) {
        throw new AppError('DUPLICATE_ATTENDANCE', '该学员这节课已有考勤记录');
      }
    }

    // 2. 余额守卫（仅净消耗且未强制时）
    if (v.lessonsDelta < 0 && !v.force) {
      const bal = db
        .prepare(
          `SELECT COALESCE(remaining_lessons, 0) AS bal
             FROM students WHERE id = ? AND deleted_at IS NULL`,
        )
        .get(v.studentId) as { bal: number } | undefined;
      // 学员不存在的情况留给第 3 步的守卫 UPDATE 处理；这里只在读得到时判余额
      if (bal && bal.bal + v.lessonsDelta < 0) {
        throw new AppError('INSUFFICIENT_LESSONS', '剩余课时不足', { lessons: '剩余课时不足' });
      }
    }

    // 3. 改余额（守卫学员存在且未软删）
    const upd = db
      .prepare(
        `UPDATE students
            SET remaining_lessons = COALESCE(remaining_lessons, 0) + @delta,
                updated_at = @now
          WHERE id = @sid AND deleted_at IS NULL`,
      )
      .run({ delta: v.lessonsDelta, now, sid: v.studentId });
    if (upd.changes !== 1) {
      throw new AppError('NOT_FOUND', '学员不存在，可能已被删除');
    }

    // 4. 插流水
    const ins = db
      .prepare(
        `INSERT INTO attendance_records
           (student_id, session_id, class_name, teacher, attend_date, attend_time,
            type, lessons_delta, reason, operator, note, created_at, updated_at)
         VALUES
           (@sid, @sessionId, @cls, @teacher, @date, @time,
            @type, @delta, @reason, @operator, @note, @now, @now)`,
      )
      .run({
        sid: v.studentId,
        sessionId: v.sessionId,
        cls: v.className,
        teacher: v.teacher,
        date: v.attendDate,
        time: v.attendTime,
        type: v.type,
        delta: v.lessonsDelta,
        reason: v.reason,
        operator: v.operator,
        note: v.note,
        now,
      });
    return Number(ins.lastInsertRowid);
  });

  const id = tx();
  return { id, remainingLessons: readBalance(v.studentId) };
}

/**
 * 撤销一条考勤：软删该行 + 反向回补原 lessons_delta（同一事务）。
 * 对已撤销的行幂等——不再二次回补，直接返回当前余额。
 */
export function voidRecord(id: number): { id: number; studentId: number; remainingLessons: number } {
  const db = getDb();
  const now = nowIso();

  const studentId = db.transaction((): number => {
    const row = db
      .prepare(
        `SELECT student_id AS studentId, lessons_delta AS lessonsDelta, deleted_at AS deletedAt
           FROM attendance_records WHERE id = ?`,
      )
      .get(id) as
      | { studentId: number; lessonsDelta: number; deletedAt: string | null }
      | undefined;
    if (!row) throw new AppError('ATTENDANCE_NOT_FOUND', '考勤记录不存在，可能已被撤销');
    if (row.deletedAt != null) return row.studentId; // 幂等

    db.prepare(
      `UPDATE students
          SET remaining_lessons = COALESCE(remaining_lessons, 0) - @delta, updated_at = @now
        WHERE id = @sid`,
    ).run({ delta: row.lessonsDelta, now, sid: row.studentId });
    db.prepare(
      `UPDATE attendance_records SET deleted_at = @now, updated_at = @now WHERE id = @id`,
    ).run({ now, id });
    return row.studentId;
  })();

  return { id, studentId, remainingLessons: readBalance(studentId) };
}

/**
 * 更正一条考勤：按「新 lessons_delta − 旧 lessons_delta」差额调余额，并覆盖流水字段。
 * - 只对未撤销、非「调整」的记录生效。
 * - 不重跑重复检测（改错字 / 改日期不该被自己旧记录挡）。
 * - 差额为负且会使余额低于 0：未 force 抛 INSUFFICIENT_LESSONS。
 * - 不能改 student_id（换人 = 撤销后重打）。
 */
export function correctRecord(v: CorrectionValues): CheckInResult {
  const db = getDb();
  const now = nowIso();

  const studentId = db.transaction((): number => {
    const row = db
      .prepare(
        `SELECT student_id AS studentId, lessons_delta AS lessonsDelta, type
           FROM attendance_records WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(v.id) as { studentId: number; lessonsDelta: number; type: string } | undefined;
    if (!row) throw new AppError('ATTENDANCE_NOT_FOUND', '考勤记录不存在，可能已被撤销');
    if (row.type === '调整') {
      throw new AppError('BAD_REQUEST', '调整记录不支持更正，请撤销后重建');
    }

    const diff = v.lessonsDelta - row.lessonsDelta;
    if (diff < 0 && !v.force) {
      const bal = db
        .prepare(`SELECT COALESCE(remaining_lessons, 0) AS bal FROM students WHERE id = ?`)
        .get(row.studentId) as { bal: number };
      if (bal.bal + diff < 0) {
        throw new AppError('INSUFFICIENT_LESSONS', '剩余课时不足', { lessons: '剩余课时不足' });
      }
    }
    if (diff !== 0) {
      db.prepare(
        `UPDATE students
            SET remaining_lessons = COALESCE(remaining_lessons, 0) + @diff, updated_at = @now
          WHERE id = @sid`,
      ).run({ diff, now, sid: row.studentId });
    }
    db.prepare(
      `UPDATE attendance_records
          SET type = @type, attend_date = @date, attend_time = @time, class_name = @cls,
              teacher = @teacher, lessons_delta = @delta, operator = @operator,
              note = @note, updated_at = @now
        WHERE id = @id`,
    ).run({
      type: v.type,
      date: v.attendDate,
      time: v.attendTime,
      cls: v.className,
      teacher: v.teacher,
      delta: v.lessonsDelta,
      operator: v.operator,
      note: v.note,
      now,
      id: v.id,
    });
    return row.studentId;
  })();

  return { id: v.id, remainingLessons: readBalance(studentId) };
}

/**
 * 手动调整课时：写一条 type='调整' 的流水 + 按带符号 delta 改余额。
 * 复用 createRecord（对「调整」类型跳过重复检测）；delta 为 0 / 非整数的拦截在校验层。
 */
export function adjustLessons(v: RecordValues): CheckInResult {
  return createRecord(v);
}

/**
 * 批量点名：逐条走 createRecord，**每条一个独立事务**。
 * 单条失败（余额不足未强制 / 重复未允许 / 学员不存在）只记进该行结果，不回滚已成功的条目。
 */
export function batchCreate(list: RecordValues[]): BatchCheckInResult {
  const rows: BatchCheckInRowResult[] = [];
  for (const v of list) {
    try {
      const r = createRecord(v);
      rows.push({
        studentId: v.studentId,
        ok: true,
        recordId: r.id,
        remainingLessons: r.remainingLessons,
      });
    } catch (e) {
      if (e instanceof AppError) {
        rows.push({ studentId: v.studentId, ok: false, errorCode: e.code, reason: e.message });
      } else {
        throw e;
      }
    }
  }
  const succeeded = rows.filter((r) => r.ok).length;
  return { succeeded, skipped: rows.length - succeeded, rows };
}

/**
 * 把列表 / 汇总共用的筛选条件（日期区间 / 学员关键字 / 类型 + 排除已撤销）
 * 拼成 WHERE 片段与命名参数。表别名固定 a（attendance_records）、s（students）。
 */
function recordFilter(query: AttendanceListQuery): {
  where: string[];
  params: Record<string, string | number>;
} {
  const where: string[] = ['a.deleted_at IS NULL'];
  const params: Record<string, string | number> = {};

  const from = (query.dateFrom ?? '').trim();
  if (from) {
    params['df'] = from;
    where.push('a.attend_date >= @df');
  }
  const to = (query.dateTo ?? '').trim();
  if (to) {
    params['dt'] = to;
    where.push('a.attend_date <= @dt');
  }
  const kw = (query.keyword ?? '').trim();
  if (kw) {
    params['kw'] = `%${escapeLike(kw)}%`;
    where.push(`(s.name LIKE @kw ESCAPE '\\' OR s.phone_primary LIKE @kw ESCAPE '\\')`);
  }
  const type = (query.type ?? '').trim();
  if (type) {
    params['ty'] = type;
    where.push('a.type = @ty');
  }
  return { where, params };
}

/**
 * 考勤流水列表：JOIN 出学员姓名 / 电话（学员即使已软删也照常带出），
 * 默认排除已撤销行，按考勤日期倒序、同日按 id 倒序，分页。
 */
export function listRecords(query: AttendanceListQuery = {}): AttendanceListResult {
  const db = getDb();
  const { where, params } = recordFilter(query);

  const whereSql = where.join(' AND ');

  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM attendance_records a
           JOIN students s ON s.id = a.student_id
          WHERE ${whereSql}`,
      )
      .get(params) as { n: number }
  ).n;

  const limit = Number.isInteger(query.limit) ? Math.max(1, query.limit as number) : 100;
  const offset = Number.isInteger(query.offset) ? Math.max(0, query.offset as number) : 0;
  params['lim'] = limit;
  params['off'] = offset;

  const rows = db
    .prepare(
      `SELECT ${RECORD_COLUMNS}
         FROM attendance_records a
         JOIN students s ON s.id = a.student_id
        WHERE ${whereSql}
        ORDER BY a.attend_date DESC, a.id DESC
        LIMIT @lim OFFSET @off`,
    )
    .all(params) as AttendanceRecord[];

  return { rows, total };
}

/**
 * 批量点名的花名册候选：未软删学员，可按舞种（对 dance_types JSON 数组做包含匹配）
 * 与姓名 / 手机号关键字筛选，最多 500 行。
 */
export function listRosterCandidates(query: RosterCandidateQuery = {}): RosterCandidate[] {
  const db = getDb();
  const where: string[] = ['deleted_at IS NULL'];
  const params: Record<string, string> = {};

  const dt = (query.danceType ?? '').trim();
  if (dt) {
    // dance_types 存的是 JSON 数组字符串，如 ["街舞","爵士"]；带引号匹配整个元素
    params['dt'] = `%"${escapeLike(dt)}"%`;
    where.push(`dance_types LIKE @dt ESCAPE '\\'`);
  }
  const kw = (query.keyword ?? '').trim();
  if (kw) {
    params['kw'] = `%${escapeLike(kw)}%`;
    where.push(`(name LIKE @kw ESCAPE '\\' OR phone_primary LIKE @kw ESCAPE '\\')`);
  }

  const rows = db
    .prepare(
      `SELECT id,
              name,
              phone_primary     AS phone,
              remaining_lessons AS remainingLessons,
              card_expire_date  AS cardExpireDate,
              status,
              dance_types       AS danceTypesJson
         FROM students
        WHERE ${where.join(' AND ')}
        ORDER BY name COLLATE NOCASE
        LIMIT 500`,
    )
    .all(params) as (Omit<RosterCandidate, 'danceTypes'> & { danceTypesJson: string })[];

  return rows.map(({ danceTypesJson, ...rest }) => ({
    ...rest,
    danceTypes: parseJsonArray(danceTypesJson),
  }));
}

/** 把 dance_types 那串 JSON 数组解析成字符串数组；坏数据按空数组处理。 */
function parseJsonArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 按月汇总：某学员某月的各类型计数 + 当月消耗课时 + 当前实时剩余课时。
 * 遵循与列表同一套筛选（日期区间 / 关键字 / 类型），排除已撤销行。仅导出用，无独立 IPC。
 */
export function monthlySummary(query: AttendanceListQuery = {}): MonthlySummaryRow[] {
  const db = getDb();
  const { where, params } = recordFilter(query);
  return db
    .prepare(
      `SELECT s.id            AS studentId,
              s.name          AS studentName,
              s.phone_primary AS studentPhone,
              substr(a.attend_date, 1, 7) AS month,
              SUM(a.type = '出勤') AS attendCount,
              SUM(a.type = '请假') AS leaveCount,
              SUM(a.type = '缺勤') AS absentCount,
              SUM(a.type = '补课') AS makeupCount,
              SUM(a.type = '试听') AS trialCount,
              COALESCE(SUM(CASE WHEN a.lessons_delta < 0 THEN -a.lessons_delta ELSE 0 END), 0)
                AS lessonsConsumed,
              s.remaining_lessons AS remainingLessons
         FROM attendance_records a
         JOIN students s ON s.id = a.student_id
        WHERE ${where.join(' AND ')}
        GROUP BY s.id, month
        ORDER BY month DESC, s.name COLLATE NOCASE`,
    )
    .all(params) as MonthlySummaryRow[];
}
