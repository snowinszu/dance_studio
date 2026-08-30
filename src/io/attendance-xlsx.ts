/**
 * 考勤管理的 Excel 导入导出（主进程，用 exceljs）。
 *
 * 整体类比：
 *   exportRecords 把当前筛选到的考勤誊成一本工作簿——
 *     sheet「考勤明细」逐条流水，sheet「按月汇总」每人每月一行。
 *   导入（历史考勤补录）在 #43 接入。
 */
import ExcelJS from 'exceljs';
import { getDb } from '../db/connection';
import { AppError } from '../shared/app-error';
import * as attendanceRepo from '../domain/attendance.repo';
import { ALL_TYPES, isRealYmd } from '../domain/attendance.validation';
import { headerTexts, MAX_IMPORT_ROWS, openFirstSheet, rowTexts } from './xlsx-util';
import type {
  AttendanceImportReport,
  AttendanceListQuery,
  AttendanceType,
} from '../shared/types';

/** 单元格取值 → 字符串 / 数字；null/undefined/'' → 空串。 */
function cell(v: unknown): string | number {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return v;
  return String(v);
}

/**
 * 导出考勤到 filePath。遵循当前列表筛选（日期区间 / 关键字 / 类型），忽略分页；
 * 已撤销记录不导出。
 *
 * @returns { detail: 明细行数, summary: 汇总行数 }
 */
export async function exportRecords(
  query: AttendanceListQuery,
  filePath: string,
): Promise<{ detail: number; summary: number }> {
  const detailRows = attendanceRepo.listRecords({
    ...query,
    limit: Number.MAX_SAFE_INTEGER,
    offset: 0,
  }).rows;
  const summaryRows = attendanceRepo.monthlySummary(query);

  const wb = new ExcelJS.Workbook();

  const ws1 = wb.addWorksheet('考勤明细');
  ws1.columns = [
    { header: '学员姓名', key: 'studentName', width: 14 },
    { header: '手机号', key: 'studentPhone', width: 16 },
    { header: '日期', key: 'attendDate', width: 12 },
    { header: '时间', key: 'attendTime', width: 8 },
    { header: '课程', key: 'className', width: 18 },
    { header: '老师', key: 'teacher', width: 12 },
    { header: '类型', key: 'type', width: 8 },
    { header: '课时增减', key: 'lessonsDelta', width: 10 },
    { header: '经办人', key: 'operator', width: 12 },
    { header: '备注', key: 'note', width: 30 },
  ];
  for (const r of detailRows) {
    ws1.addRow({
      studentName: cell(r.studentName),
      studentPhone: cell(r.studentPhone),
      attendDate: cell(r.attendDate),
      attendTime: cell(r.attendTime),
      className: cell(r.className),
      teacher: cell(r.teacher),
      type: cell(r.type),
      lessonsDelta: r.lessonsDelta,
      operator: cell(r.operator),
      note: cell(r.reason ?? r.note),
    });
  }

  const ws2 = wb.addWorksheet('按月汇总');
  ws2.columns = [
    { header: '学员姓名', key: 'studentName', width: 14 },
    { header: '手机号', key: 'studentPhone', width: 16 },
    { header: '月份', key: 'month', width: 10 },
    { header: '出勤', key: 'attendCount', width: 8 },
    { header: '请假', key: 'leaveCount', width: 8 },
    { header: '缺勤', key: 'absentCount', width: 8 },
    { header: '补课', key: 'makeupCount', width: 8 },
    { header: '试听', key: 'trialCount', width: 8 },
    { header: '当月消耗课时', key: 'lessonsConsumed', width: 14 },
    { header: '当前剩余课时', key: 'remainingLessons', width: 14 },
  ];
  for (const m of summaryRows) {
    ws2.addRow({
      studentName: cell(m.studentName),
      studentPhone: cell(m.studentPhone),
      month: cell(m.month),
      attendCount: m.attendCount,
      leaveCount: m.leaveCount,
      absentCount: m.absentCount,
      makeupCount: m.makeupCount,
      trialCount: m.trialCount,
      lessonsConsumed: m.lessonsConsumed,
      remainingLessons: m.remainingLessons ?? '',
    });
  }

  await wb.xlsx.writeFile(filePath);
  return { detail: detailRows.length, summary: summaryRows.length };
}

/* ═══════════════════════ 导入（历史考勤补录） ═══════════════════════ */

/** 模板 / 映射用的字段 key → 表头显示名。 */
const TEMPLATE_COLUMNS: { key: string; header: string }[] = [
  { key: 'studentName', header: '学员姓名' },
  { key: 'phone', header: '手机号' },
  { key: 'date', header: '日期' },
  { key: 'time', header: '时间' },
  { key: 'className', header: '课程' },
  { key: 'teacher', header: '老师' },
  { key: 'type', header: '类型' },
  { key: 'lessons', header: '课时增减' },
  { key: 'operator', header: '经办人' },
  { key: 'note', header: '备注' },
];

/** 生成导入模板：表头 10 列 + 一行示例。 */
export async function buildTemplate(filePath: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('考勤导入模板');
  ws.addRow(TEMPLATE_COLUMNS.map((c) => c.header));
  ws.addRow([
    '张三',
    '13800000000',
    '2026-05-01',
    '19:00',
    '芭蕾基础',
    '王老师',
    '出勤',
    '',
    '前台',
    '示例行，导入前可删除',
  ]);
  await wb.xlsx.writeFile(filePath);
}

export interface ImportRecordsPreview {
  filePath: string;
  headers: string[];
  sample: string[][];
}

/** 读表头 + 前 3 行样本，供渲染层做列映射。含行数上限校验。 */
export async function readImportPreview(filePath: string): Promise<ImportRecordsPreview> {
  const ws = await openFirstSheet(filePath);
  const dataRows = Math.max(0, ws.actualRowCount - 1);
  if (dataRows > MAX_IMPORT_ROWS) {
    throw new AppError('IMPORT_TOO_LARGE', `单次最多导入 ${MAX_IMPORT_ROWS} 行`);
  }
  const headers = headerTexts(ws);
  const sample: string[][] = [];
  for (let r = 2; r <= Math.min(4, ws.rowCount); r += 1) {
    sample.push(rowTexts(ws.getRow(r), headers.length));
  }
  return { filePath, headers, sample };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

interface ParsedRow {
  studentName: string;
  phone: string;
  date: string;
  time: string | null;
  className: string | null;
  teacher: string | null;
  type: AttendanceType;
  lessonsDelta: number;
  operator: string | null;
  note: string | null;
}

/**
 * 解析一行为 ParsedRow，或返回错误原因。
 * 课时增减留空时按类型默认：出勤 -1、请假/缺勤/补课/试听 0、调整 → 报错（必须填非零）。
 */
function parseImportRow(
  cells: string[],
  mapping: Record<string, string>,
  colOf: (header: string) => number,
): { row: ParsedRow } | { error: string } {
  const pick = (key: string): string => {
    const header = mapping[key];
    if (!header) return '';
    const ci = colOf(header);
    return ci < 0 ? '' : (cells[ci] ?? '').trim();
  };

  const studentName = pick('studentName');
  if (studentName.length === 0) return { error: '学员姓名必填' };
  const phone = pick('phone');
  if (phone.length === 0) return { error: '手机号必填' };

  const date = pick('date');
  if (!isRealYmd(date)) return { error: '日期应为 YYYY-MM-DD 且真实存在' };

  const timeText = pick('time');
  if (timeText.length > 0 && !TIME_RE.test(timeText)) return { error: '时间应为 HH:MM' };

  const typeText = pick('type');
  if (!(ALL_TYPES as readonly string[]).includes(typeText)) {
    return { error: `类型不合法（应为 ${ALL_TYPES.join(' / ')}）` };
  }
  const type = typeText as AttendanceType;

  const lessonsText = pick('lessons');
  let lessonsDelta: number;
  if (type === '调整') {
    if (lessonsText.length === 0) return { error: '调整必须填写非零课时' };
    const n = Number(lessonsText);
    if (!Number.isInteger(n) || n === 0) return { error: '课时增减必须是非零整数' };
    lessonsDelta = n;
  } else if (type === '出勤') {
    if (lessonsText.length === 0) {
      lessonsDelta = -1;
    } else {
      const n = Number(lessonsText);
      if (!Number.isInteger(n) || n <= 0) return { error: '出勤的课时增减须为正整数' };
      lessonsDelta = -n;
    }
  } else {
    lessonsDelta = 0;
  }

  return {
    row: {
      studentName,
      phone,
      date,
      time: timeText.length > 0 ? timeText : null,
      className: pick('className') || null,
      teacher: pick('teacher') || null,
      type,
      lessonsDelta,
      operator: pick('operator') || null,
      note: pick('note') || null,
    },
  };
}

/**
 * 导入历史考勤。每一有效行走与快速打卡相同的 attendanceRepo.createRecord 路径
 * （force:true 允许欠课记负、allowDuplicate:true —— 「疑似重复」在这里先自行跳过）。
 * 学员按「姓名 + 手机号」精确匹配未软删学员，0 / 多条命中判失败。
 */
export async function importRecords({
  filePath,
  mapping,
}: {
  filePath: string;
  mapping: Record<string, string>;
}): Promise<AttendanceImportReport> {
  if (!mapping || typeof mapping !== 'object') {
    throw new AppError('BAD_REQUEST', '缺少列映射');
  }
  for (const need of ['studentName', 'phone', 'date', 'type'] as const) {
    if (!mapping[need]) {
      throw new AppError(
        'BAD_REQUEST',
        '「学员姓名」「手机号」「日期」「类型」都必须映射到某一列',
      );
    }
  }

  const ws = await openFirstSheet(filePath);
  const headers = headerTexts(ws);
  const colOf = (header: string): number => headers.indexOf(header);

  const db = getDb();
  const findStudent = db.prepare(
    `SELECT id FROM students WHERE name = @name AND phone_primary = @phone AND deleted_at IS NULL`,
  );
  const findDup = db.prepare(
    `SELECT 1 FROM attendance_records
      WHERE student_id = @sid AND attend_date = @date
        AND COALESCE(class_name, '') = COALESCE(@cls, '')
        AND type = @type AND deleted_at IS NULL
      LIMIT 1`,
  );

  const report: AttendanceImportReport = {
    succeeded: 0,
    skipped: 0,
    failed: 0,
    negativeBalance: 0,
    failures: [],
  };

  for (let r = 2; r <= ws.rowCount; r += 1) {
    const cells = rowTexts(ws.getRow(r), headers.length);
    if (cells.every((c) => c === '')) continue;

    const parsed = parseImportRow(cells, mapping, colOf);
    if ('error' in parsed) {
      report.failed += 1;
      report.failures.push({ row: r, reason: parsed.error });
      continue;
    }
    const row = parsed.row;

    const matches = findStudent.all({ name: row.studentName, phone: row.phone }) as {
      id: number;
    }[];
    if (matches.length === 0) {
      report.failed += 1;
      report.failures.push({ row: r, reason: '学员不存在' });
      continue;
    }
    if (matches.length > 1) {
      report.failed += 1;
      report.failures.push({ row: r, reason: '匹配到多个学员' });
      continue;
    }
    const sid = matches[0]!.id;

    if (
      row.type !== '调整' &&
      findDup.get({ sid, date: row.date, cls: row.className, type: row.type })
    ) {
      report.skipped += 1;
      continue;
    }

    try {
      const res = attendanceRepo.createRecord({
        studentId: sid,
        type: row.type,
        attendDate: row.date,
        attendTime: row.time,
        className: row.className,
        teacher: row.teacher,
        lessonsDelta: row.lessonsDelta,
        reason: row.type === '调整' ? row.note : null,
        operator: row.operator,
        note: row.note,
        sessionId: null,
        force: true,
        allowDuplicate: true,
      });
      report.succeeded += 1;
      if (res.remainingLessons < 0) report.negativeBalance += 1;
    } catch (err) {
      report.failed += 1;
      report.failures.push({
        row: r,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return report;
}
