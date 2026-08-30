/**
 * 考勤管理的 Excel 导入导出（主进程，用 exceljs）。
 *
 * 整体类比：
 *   exportRecords 把当前筛选到的考勤誊成一本工作簿——
 *     sheet「考勤明细」逐条流水，sheet「按月汇总」每人每月一行。
 *   导入（历史考勤补录）在 #43 接入。
 */
import ExcelJS from 'exceljs';
import * as attendanceRepo from '../domain/attendance.repo';
import type { AttendanceListQuery } from '../shared/types';

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
