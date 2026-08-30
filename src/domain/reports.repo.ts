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
import type { ReportAlerts, ReportOverview, ReportRange } from '../shared/types';

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
  const cutoffDormant = daysAgoLocal(DORMANT_DAYS);
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

  const lowBalance = db
    .prepare(
      `SELECT id, name, remaining_lessons AS remainingLessons
         FROM students
        WHERE deleted_at IS NULL AND status = '在读'
          AND remaining_lessons IS NOT NULL AND remaining_lessons <= 3
        ORDER BY remaining_lessons ASC, name COLLATE NOCASE
        LIMIT ${ALERT_LIMIT}`,
    )
    .all() as ReportAlerts['lowBalance'];

  const dormant = db
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
    .all({ cutoffDormant }) as ReportAlerts['dormant'];

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
