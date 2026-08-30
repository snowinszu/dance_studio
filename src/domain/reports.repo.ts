/**
 * 数据报表的只读聚合查询（仓库层）。
 *
 * 整体类比：一个「读数员」。它只拿着四个模块共用的那本账（同一个 SQLite 连接），
 * 对着账本做汇总、排队、算比例，从不落笔改账。所以本文件只有 SELECT——
 * 报表模块不加任何表 / 迁移，也不碰 students.remaining_lessons 一类权威缓存值。
 *
 * 时间口径约定：
 * - 页面把「本月 / 本年 / 自定义」换算成显式的 { from, to }（'YYYY-MM-DD'，两端闭区间）传进来，
 *   本层只按字符串比较，不自己判断「今天」。
 * - 「近 N 天」这种以「今天」为基准的窗口，用本地时区在 JS 里算好 cutoff 再作为参数绑定，
 *   不在 SQL 里用 date('now')——那是 UTC，与库里本地日期串会差一天。
 */
import { getDb } from '../db/connection';
import type {
  ReportAlerts,
  ReportAttendanceStats,
  ReportCourseStats,
  ReportInventoryStats,
  ReportOverview,
  ReportRange,
  ReportStudentStats,
} from '../shared/types';

/* ───────────────────────── 日期小工具 ───────────────────────── */

/** 一个 Date → 本地时区 'YYYY-MM-DD'。 */
function ymdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 今天（本地）。 */
function todayLocal(): string {
  return ymdLocal(new Date());
}

/** 今天往前推 n 天（本地），含当天口径下作为闭区间下界用。 */
function daysAgoLocal(n: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return ymdLocal(d);
}

/** 取 'YYYY-MM-DD' 的年份，退回当前年。 */
function yearOf(ymd: string): number {
  const y = Number(ymd.slice(0, 4));
  return Number.isInteger(y) && y > 1900 ? y : new Date().getFullYear();
}

/** 'YYYY-MM-DD' → 当月 1 号 'YYYY-MM-01'。 */
function firstOfMonth(ymd: string): string {
  return `${ymd.slice(0, 7)}-01`;
}

/** 'YYYY-MM-DD' → 当年 1 月 1 号。 */
function jan1(ymd: string): string {
  return `${ymd.slice(0, 4)}-01-01`;
}

/**
 * 列出 [from, to] 覆盖的所有自然月，'YYYY-MM' 升序。
 * 用来给「月度趋势」补齐没有数据的月份（补 0），让折线不断档。
 */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4));
  const endM = Number(to.slice(5, 7));
  // 起点晚于终点（理论上 checkedRange 已挡）→ 返回空
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    if (out.length > 600) break; // 安全阀：最多 50 年
  }
  return out;
}

/* ───────────────────────── 概览 KPI ───────────────────────── */

/**
 * 报表页顶部的概览卡片。六个当下就该看见的数字 + 一个「当年未关联课节的出勤条数」提示值。
 *
 * 口径（均排除软删 / 已撤销）：
 * - activeStudents            在读学员数
 * - checkInsInRange           区间内出勤人次（type 出勤 / 补课）
 * - sessionsInRange           区间内正常课节数
 * - newStudentsLast30d        近 30 天新登记学员（enroll_date >= 今天-30，含当天）
 * - lowBalanceCount           在读且剩余课时 <= 3
 * - lowStockCount             未软删物件且库存 <= 预警阈值
 * - unlinkedCheckInsThisYear  当年（取 to 的年份）session_id 为空的出勤 / 补课条数——
 *   这些进不了「按班级」导出，页面用它提示管理者去回填课节
 */
export function getOverview(range: ReportRange): ReportOverview {
  const db = getDb();
  const { from, to } = range;
  const cutoff30 = daysAgoLocal(30);
  const yr = yearOf(to);
  const yearStart = `${yr}-01-01`;
  const yearEnd = `${yr}-12-31`;

  const scalar = (sql: string, params: Record<string, string> = {}): number =>
    (db.prepare(sql).get(params) as { n: number }).n;

  const activeStudents = scalar(
    `SELECT COUNT(*) AS n FROM students WHERE deleted_at IS NULL AND status = '在读'`,
  );

  const checkInsInRange = scalar(
    `SELECT COUNT(*) AS n FROM attendance_records
      WHERE deleted_at IS NULL AND type IN ('出勤','补课')
        AND attend_date BETWEEN @from AND @to`,
    { from, to },
  );

  const sessionsInRange = scalar(
    `SELECT COUNT(*) AS n FROM class_sessions
      WHERE deleted_at IS NULL AND status = '正常'
        AND session_date BETWEEN @from AND @to`,
    { from, to },
  );

  const newStudentsLast30d = scalar(
    `SELECT COUNT(*) AS n FROM students
      WHERE deleted_at IS NULL AND enroll_date IS NOT NULL AND enroll_date >= @cutoff30`,
    { cutoff30 },
  );

  const lowBalanceCount = scalar(
    `SELECT COUNT(*) AS n FROM students
      WHERE deleted_at IS NULL AND status = '在读'
        AND remaining_lessons IS NOT NULL AND remaining_lessons <= 3`,
  );

  const lowStockCount = scalar(
    `SELECT COUNT(*) AS n FROM inventory_items
      WHERE deleted_at IS NULL AND quantity <= low_stock_threshold`,
  );

  const unlinkedCheckInsThisYear = scalar(
    `SELECT COUNT(*) AS n FROM attendance_records
      WHERE deleted_at IS NULL AND type IN ('出勤','补课') AND session_id IS NULL
        AND attend_date BETWEEN @yearStart AND @yearEnd`,
    { yearStart, yearEnd },
  );

  return {
    activeStudents,
    checkInsInRange,
    sessionsInRange,
    newStudentsLast30d,
    lowBalanceCount,
    lowStockCount,
    unlinkedCheckInsThisYear,
  };
}

/* ───────────────────────── 预警中心 ───────────────────────── */

/** 单组清单的行数硬上限——避免极端数据把 IPC 负载撑爆。 */
const ALERT_LIMIT = 200;

/** 「沉睡」判定窗口：在读学员近 N 天无任何「出勤」即算沉睡。 */
const DORMANT_DAYS = 60;
/** 「空课」回看窗口：近 N 天内、已发生、0 到课人次的正常课节。 */
const EMPTY_SESSION_DAYS = 30;

/** 在读且剩余课时 <= 3 的学员。预警中心与学员指标区共用。 */
function queryLowBalance(): { id: number; name: string; remainingLessons: number }[] {
  return getDb()
    .prepare(
      `SELECT id, name, remaining_lessons AS remainingLessons
         FROM students
        WHERE deleted_at IS NULL AND status = '在读'
          AND remaining_lessons IS NOT NULL AND remaining_lessons <= 3
        ORDER BY remaining_lessons ASC, name COLLATE NOCASE
        LIMIT ${ALERT_LIMIT}`,
    )
    .all() as { id: number; name: string; remainingLessons: number }[];
}

/** 在读、未软删，近 DORMANT_DAYS 天无「出勤」的学员，带历来最近一次出勤日期。共用。 */
function queryDormant(): { id: number; name: string; lastAttendDate: string | null }[] {
  const cutoffDormant = daysAgoLocal(DORMANT_DAYS);
  return getDb()
    .prepare(
      `SELECT s.id, s.name,
              (SELECT MAX(a.attend_date) FROM attendance_records a
                WHERE a.student_id = s.id AND a.deleted_at IS NULL AND a.type = '出勤') AS lastAttendDate
         FROM students s
        WHERE s.deleted_at IS NULL AND s.status = '在读'
          AND NOT EXISTS (
            SELECT 1 FROM attendance_records a
             WHERE a.student_id = s.id AND a.deleted_at IS NULL
               AND a.type = '出勤' AND a.attend_date >= @cutoffDormant)
        ORDER BY (lastAttendDate IS NULL) DESC, lastAttendDate ASC, s.name COLLATE NOCASE
        LIMIT ${ALERT_LIMIT}`,
    )
    .all({ cutoffDormant }) as { id: number; name: string; lastAttendDate: string | null }[];
}

/**
 * 「今天必须处理」的四组异常，不受页面时间范围约束（窗口是固定常量）。
 *
 * - lowStock       未软删物件，库存 <= 预警阈值，最紧缺在前
 * - lowBalance     在读学员，剩余课时 <= 3
 * - dormant        在读、未软删，近 DORMANT_DAYS 天无「出勤」记录；带最近一次出勤日期
 * - emptySessions  近 EMPTY_SESSION_DAYS 天内、已发生、status='正常'、关联出勤/补课人次为 0 的课节
 */
export function getAlerts(): ReportAlerts {
  const db = getDb();
  const today = todayLocal();
  const cutoffEmpty = daysAgoLocal(EMPTY_SESSION_DAYS);

  const lowStock = db
    .prepare(
      `SELECT id, name, quantity, low_stock_threshold AS threshold
         FROM inventory_items
        WHERE deleted_at IS NULL AND quantity <= low_stock_threshold
        ORDER BY (quantity - low_stock_threshold) ASC, name COLLATE NOCASE
        LIMIT ${ALERT_LIMIT}`,
    )
    .all() as ReportAlerts['lowStock'];

  const lowBalance = queryLowBalance();
  const dormant = queryDormant();

  const emptySessions = db
    .prepare(
      `SELECT s.id AS sessionId, c.name AS className,
              s.session_date AS sessionDate, s.start_time AS startTime
         FROM class_sessions s JOIN classes c ON c.id = s.class_id
        WHERE s.deleted_at IS NULL AND s.status = '正常'
          AND s.session_date BETWEEN @cutoffEmpty AND @today
          AND NOT EXISTS (
            SELECT 1 FROM attendance_records a
             WHERE a.session_id = s.id AND a.deleted_at IS NULL
               AND a.type IN ('出勤','补课'))
        ORDER BY s.session_date DESC, s.start_time DESC
        LIMIT ${ALERT_LIMIT}`,
    )
    .all({ cutoffEmpty, today }) as ReportAlerts['emptySessions'];

  return { lowStock, lowBalance, dormant, emptySessions };
}

/* ───────────────────────── 考勤指标 ───────────────────────── */

/** 排行 / TOP 榜的返回行数上限。 */
const TOP_LIMIT = 10;

/**
 * 考勤维度的趋势、排名、缺勤预警、分布、时段热力。
 *
 * - sessionsThisMonth / sessionsThisYear 由 to 推（该月 1 号→to、该年 1/1→to），
 *   恒定展示，不受传入 range 影响
 * - monthlyCheckIns 出勤人次（出勤+补课）按自然月分组，repo 补齐 [from,to] 的每个月
 * - ranking 每个「区间内有任意考勤记录」的学员：
 *     attendCount = 出勤+补课（「按次数」列）
 *     attendOnly  = 出勤
 *     scheduled   = 出勤+缺勤+请假
 *     rate = scheduled>0 ? attendOnly/scheduled : null（「按出勤率」列）
 *   JOIN students 不加 deleted 过滤——离校学员的历史仍要能看到
 * - absenceTop 近 30 天缺勤+请假最多的前 10
 * - byTeacher / byDanceType 按 attendance_records.teacher / class_name 分组的出勤人次
 * - hourHeatmap 星期(0=周日) × 2 小时时段桶(0..11) 的出勤人次；attend_time 为空归 bucket=-1
 */
export function getAttendanceStats(range: ReportRange): ReportAttendanceStats {
  const db = getDb();
  const { from, to } = range;
  const cutoff30 = daysAgoLocal(30);

  const sessionCount = (lo: string, hi: string): number =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM class_sessions
            WHERE deleted_at IS NULL AND status = '正常'
              AND session_date BETWEEN @lo AND @hi`,
        )
        .get({ lo, hi }) as { n: number }
    ).n;

  const sessionsThisMonth = sessionCount(firstOfMonth(to), to);
  const sessionsThisYear = sessionCount(jan1(to), to);

  const monthRows = db
    .prepare(
      `SELECT substr(attend_date, 1, 7) AS ym, COUNT(*) AS n
         FROM attendance_records
        WHERE deleted_at IS NULL AND type IN ('出勤','补课')
          AND attend_date BETWEEN @from AND @to
        GROUP BY ym`,
    )
    .all({ from, to }) as { ym: string; n: number }[];
  const monthMap = new Map(monthRows.map((r) => [r.ym, r.n]));
  const monthlyCheckIns = monthsBetween(from, to).map((month) => ({
    month,
    count: monthMap.get(month) ?? 0,
  }));

  const rankingRaw = db
    .prepare(
      `SELECT a.student_id AS studentId, s.name AS name,
              SUM(a.type IN ('出勤','补课'))       AS attendCount,
              SUM(a.type = '出勤')                 AS attendOnly,
              SUM(a.type IN ('出勤','缺勤','请假')) AS scheduled
         FROM attendance_records a
         JOIN students s ON s.id = a.student_id
        WHERE a.deleted_at IS NULL AND a.attend_date BETWEEN @from AND @to
        GROUP BY a.student_id`,
    )
    .all({ from, to }) as {
    studentId: number;
    name: string;
    attendCount: number;
    attendOnly: number;
    scheduled: number;
  }[];
  const ranking = rankingRaw
    .map((r) => ({
      ...r,
      rate: r.scheduled > 0 ? r.attendOnly / r.scheduled : null,
    }))
    .sort(
      (a, b) =>
        b.attendCount - a.attendCount || a.name.localeCompare(b.name, 'zh'),
    );

  const absenceTop = db
    .prepare(
      `SELECT a.student_id AS studentId, s.name AS name, COUNT(*) AS absentPlusLeave
         FROM attendance_records a
         JOIN students s ON s.id = a.student_id
        WHERE a.deleted_at IS NULL AND a.type IN ('缺勤','请假')
          AND a.attend_date >= @cutoff30
        GROUP BY a.student_id
        ORDER BY absentPlusLeave DESC, s.name COLLATE NOCASE
        LIMIT ${TOP_LIMIT}`,
    )
    .all({ cutoff30 }) as ReportAttendanceStats['absenceTop'];

  const byTeacher = db
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(teacher), ''), '未记录') AS teacher, COUNT(*) AS checkIns
         FROM attendance_records
        WHERE deleted_at IS NULL AND type IN ('出勤','补课')
          AND attend_date BETWEEN @from AND @to
        GROUP BY teacher
        ORDER BY checkIns DESC, teacher`,
    )
    .all({ from, to }) as ReportAttendanceStats['byTeacher'];

  const byDanceType = db
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(class_name), ''), '未记录') AS danceType, COUNT(*) AS checkIns
         FROM attendance_records
        WHERE deleted_at IS NULL AND type IN ('出勤','补课')
          AND attend_date BETWEEN @from AND @to
        GROUP BY danceType
        ORDER BY checkIns DESC, danceType`,
    )
    .all({ from, to }) as ReportAttendanceStats['byDanceType'];

  const hourHeatmap = db
    .prepare(
      `SELECT CAST(strftime('%w', attend_date) AS INTEGER) AS weekday,
              CASE WHEN attend_time IS NULL OR attend_time = ''
                   THEN -1 ELSE CAST(substr(attend_time, 1, 2) AS INTEGER) / 2 END AS bucket,
              COUNT(*) AS count
         FROM attendance_records
        WHERE deleted_at IS NULL AND type IN ('出勤','补课')
          AND attend_date BETWEEN @from AND @to
        GROUP BY weekday, bucket`,
    )
    .all({ from, to }) as ReportAttendanceStats['hourHeatmap'];

  return {
    sessionsThisMonth,
    sessionsThisYear,
    monthlyCheckIns,
    ranking,
    absenceTop,
    byTeacher,
    byDanceType,
    hourHeatmap,
  };
}

/* ───────────────────────── 课程指标 ───────────────────────── */

/** SQL 片段：把某列的 'HH:MM' 文本换算成当天分钟数（col 是写死的列名，非用户输入）。 */
function minutesExpr(col: string): string {
  return `(CAST(substr(${col}, 1, 2) AS INTEGER) * 60 + CAST(substr(${col}, 4, 2) AS INTEGER))`;
}

/**
 * 排课与老师负荷。
 *
 * - teacherLoad   区间内正常课节，按 teacher_id 分组的课节数与总时长（分钟）；
 *                 时长 = end_time 分钟数 − start_time 分钟数（'HH:MM' 在 SQL 内换算）；
 *                 teacher_id 为空 → 「未指定」；按总时长降序
 * - cancelRate    区间内未软删课节里，停课占比；分母为 0 → null
 * - classFillRate 每个未结课班级的「在册人数 ÷ capacity」；capacity 缺失或 <=0 → rate 为 null
 * - emptySessions 区间内、已发生、正常、关联出勤/补课人次为 0 的课节
 */
export function getCourseStats(range: ReportRange): ReportCourseStats {
  const db = getDb();
  const { from, to } = range;
  const today = todayLocal();

  const durMinutes = `${minutesExpr('s.end_time')} - ${minutesExpr('s.start_time')}`;

  const teacherLoad = db
    .prepare(
      `SELECT s.teacher_id AS teacherId,
              COALESCE(t.name, '未指定') AS teacherName,
              COUNT(*) AS sessionCount,
              SUM(${durMinutes}) AS minutes
         FROM class_sessions s
         LEFT JOIN teachers t ON t.id = s.teacher_id
        WHERE s.deleted_at IS NULL AND s.status = '正常'
          AND s.session_date BETWEEN @from AND @to
        GROUP BY s.teacher_id
        ORDER BY minutes DESC, teacherName`,
    )
    .all({ from, to }) as ReportCourseStats['teacherLoad'];

  const cr = db
    .prepare(
      `SELECT COALESCE(SUM(status = '正常'), 0) AS normal,
              COALESCE(SUM(status = '停课'), 0) AS cancelled
         FROM class_sessions
        WHERE deleted_at IS NULL AND session_date BETWEEN @from AND @to`,
    )
    .get({ from, to }) as { normal: number; cancelled: number };
  const crTotal = cr.normal + cr.cancelled;
  const cancelRate = {
    normal: cr.normal,
    cancelled: cr.cancelled,
    rate: crTotal > 0 ? cr.cancelled / crTotal : null,
  };

  const fillRaw = db
    .prepare(
      `SELECT c.id AS classId, c.name AS className, c.capacity AS capacity,
              (SELECT COUNT(*) FROM class_students cs
                WHERE cs.class_id = c.id AND cs.left_at IS NULL) AS enrolled
         FROM classes c
        WHERE c.deleted_at IS NULL AND c.status <> '结课'
        ORDER BY c.name COLLATE NOCASE`,
    )
    .all() as { classId: number; className: string; capacity: number | null; enrolled: number }[];
  const classFillRate = fillRaw.map((r) => ({
    ...r,
    rate: r.capacity != null && r.capacity > 0 ? r.enrolled / r.capacity : null,
  }));

  const emptySessions = db
    .prepare(
      `SELECT s.id AS sessionId, c.name AS className,
              s.session_date AS sessionDate, s.start_time AS startTime
         FROM class_sessions s JOIN classes c ON c.id = s.class_id
        WHERE s.deleted_at IS NULL AND s.status = '正常'
          AND s.session_date BETWEEN @from AND @to AND s.session_date <= @today
          AND NOT EXISTS (
            SELECT 1 FROM attendance_records a
             WHERE a.session_id = s.id AND a.deleted_at IS NULL
               AND a.type IN ('出勤','补课'))
        ORDER BY s.session_date DESC, s.start_time DESC
        LIMIT ${ALERT_LIMIT}`,
    )
    .all({ from, to, today }) as ReportCourseStats['emptySessions'];

  return { teacherLoad, cancelRate, classFillRate, emptySessions };
}

/* ───────────────────────── 学员指标 ───────────────────────── */

/** 排行榜返回行数上限。 */
const REFERRER_LIMIT = 10;

/**
 * 学员结构、增长趋势与需跟进清单。
 *
 * - statusDist    按 status 分组计数（排除软删）
 * - danceTypeDist 舞种分布：dance_types 是 JSON 数组串，先在子查询里用 json_valid 过滤掉脏数据，
 *                 再 json_each 展开——一名多舞种学员计入多个 danceType
 * - levelDist     按 current_level 分组，空值归「未分级」
 * - monthlyNew    按 enroll_date 自然月分组的新登记数，repo 补齐 [from,to] 的每个月
 * - referrerTop   按 referrer 分组计数前 10（空值不计）
 * - lowBalance / dormant  与预警中心同口径（复用私有查询）
 */
export function getStudentStats(range: ReportRange): ReportStudentStats {
  const db = getDb();
  const { from, to } = range;

  const statusDist = db
    .prepare(
      `SELECT status, COUNT(*) AS count
         FROM students WHERE deleted_at IS NULL
        GROUP BY status ORDER BY count DESC, status`,
    )
    .all() as ReportStudentStats['statusDist'];

  const danceTypeDist = db
    .prepare(
      `SELECT je.value AS danceType, COUNT(*) AS count
         FROM (SELECT dance_types FROM students
                WHERE deleted_at IS NULL AND json_valid(dance_types)) v,
              json_each(v.dance_types) je
        GROUP BY je.value ORDER BY count DESC, danceType`,
    )
    .all() as ReportStudentStats['danceTypeDist'];

  const levelDist = db
    .prepare(
      `SELECT COALESCE(NULLIF(TRIM(current_level), ''), '未分级') AS level, COUNT(*) AS count
         FROM students WHERE deleted_at IS NULL
        GROUP BY level ORDER BY count DESC, level`,
    )
    .all() as ReportStudentStats['levelDist'];

  const monthNewRows = db
    .prepare(
      `SELECT substr(enroll_date, 1, 7) AS ym, COUNT(*) AS n
         FROM students
        WHERE deleted_at IS NULL AND enroll_date IS NOT NULL
          AND enroll_date BETWEEN @from AND @to
        GROUP BY ym`,
    )
    .all({ from, to }) as { ym: string; n: number }[];
  const newMap = new Map(monthNewRows.map((r) => [r.ym, r.n]));
  const monthlyNew = monthsBetween(from, to).map((month) => ({
    month,
    count: newMap.get(month) ?? 0,
  }));

  const referrerTop = db
    .prepare(
      `SELECT TRIM(referrer) AS referrer, COUNT(*) AS count
         FROM students
        WHERE deleted_at IS NULL AND referrer IS NOT NULL AND TRIM(referrer) <> ''
        GROUP BY TRIM(referrer) ORDER BY count DESC, referrer
        LIMIT ${REFERRER_LIMIT}`,
    )
    .all() as ReportStudentStats['referrerTop'];

  return {
    statusDist,
    danceTypeDist,
    levelDist,
    monthlyNew,
    referrerTop,
    lowBalance: queryLowBalance(),
    dormant: queryDormant(),
  };
}

/* ───────────────────────── 库存指标 ───────────────────────── */

/** 「呆滞物料」判定窗口：物件在库 > 0 且近 N 天无任何领用即算呆滞。 */
const STALE_DAYS = 90;

/**
 * 库存补货预警、领用趋势、TOP 与呆滞物料。
 *
 * - lowStock            库存 <= 阈值的物件（同预警中心口径），最紧缺在前
 * - totals              未软删物件的品类数与件数合计
 * - monthlyAllocations  按 claimed_at 自然月分组的领用件数，repo 补齐区间内每个月
 * - topItems/topStudents 区间内按物件 / 按学员分组的领用件数前 10
 * - staleItems          未软删、在库 > 0、近 STALE_DAYS 天无领用；带历来最近领用日期
 */
export function getInventoryStats(range: ReportRange): ReportInventoryStats {
  const db = getDb();
  const { from, to } = range;
  const cutoffStale = daysAgoLocal(STALE_DAYS);

  const lowStock = db
    .prepare(
      `SELECT id, name, quantity, low_stock_threshold AS threshold
         FROM inventory_items
        WHERE deleted_at IS NULL AND quantity <= low_stock_threshold
        ORDER BY (quantity - low_stock_threshold) ASC, name COLLATE NOCASE
        LIMIT ${ALERT_LIMIT}`,
    )
    .all() as ReportInventoryStats['lowStock'];

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS itemKinds, COALESCE(SUM(quantity), 0) AS totalQuantity
         FROM inventory_items WHERE deleted_at IS NULL`,
    )
    .get() as ReportInventoryStats['totals'];

  const allocRows = db
    .prepare(
      `SELECT substr(claimed_at, 1, 7) AS ym, COALESCE(SUM(quantity), 0) AS q
         FROM item_allocations
        WHERE claimed_at BETWEEN @from AND @to
        GROUP BY ym`,
    )
    .all({ from, to }) as { ym: string; q: number }[];
  const allocMap = new Map(allocRows.map((r) => [r.ym, r.q]));
  const monthlyAllocations = monthsBetween(from, to).map((month) => ({
    month,
    quantity: allocMap.get(month) ?? 0,
  }));

  const topItems = db
    .prepare(
      `SELECT a.item_id AS itemId, i.name AS name, SUM(a.quantity) AS quantity
         FROM item_allocations a JOIN inventory_items i ON i.id = a.item_id
        WHERE a.claimed_at BETWEEN @from AND @to
        GROUP BY a.item_id
        ORDER BY quantity DESC, i.name COLLATE NOCASE
        LIMIT ${TOP_LIMIT}`,
    )
    .all({ from, to }) as ReportInventoryStats['topItems'];

  const topStudents = db
    .prepare(
      `SELECT a.student_id AS studentId, s.name AS name, SUM(a.quantity) AS quantity
         FROM item_allocations a JOIN students s ON s.id = a.student_id
        WHERE a.claimed_at BETWEEN @from AND @to
        GROUP BY a.student_id
        ORDER BY quantity DESC, s.name COLLATE NOCASE
        LIMIT ${TOP_LIMIT}`,
    )
    .all({ from, to }) as ReportInventoryStats['topStudents'];

  const staleItems = db
    .prepare(
      `SELECT i.id, i.name, i.quantity,
              (SELECT MAX(a.claimed_at) FROM item_allocations a WHERE a.item_id = i.id) AS lastClaimedAt
         FROM inventory_items i
        WHERE i.deleted_at IS NULL AND i.quantity > 0
          AND NOT EXISTS (
            SELECT 1 FROM item_allocations a
             WHERE a.item_id = i.id AND a.claimed_at >= @cutoffStale)
        ORDER BY (lastClaimedAt IS NULL) DESC, lastClaimedAt ASC, i.name COLLATE NOCASE
        LIMIT ${ALERT_LIMIT}`,
    )
    .all({ cutoffStale }) as ReportInventoryStats['staleItems'];

  return { lowStock, totals, monthlyAllocations, topItems, topStudents, staleItems };
}
