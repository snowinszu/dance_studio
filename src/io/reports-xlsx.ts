/**
 * 数据报表的 Excel 导出（主进程，用 exceljs）。
 *
 * 整体类比：一条「誊表」流水线——从 reports.repo 拿到「全校汇总 + 每班一块」的年度出勤矩阵，
 * 逐块誊成一张 sheet：第一行标题、第二行图例、第三行表头，往下每个学员一行，列是 1–12 月的
 * 上课次数（出勤 + 补课）加全年合计。当月缺勤率 ≥ 50% 的月份格标浅黄，全年没到过课的学员
 * 姓名格标浅红。
 *
 * 只读：本文件只从 repo 读、往用户选定的 .xlsx 写，不碰数据库。
 */
import ExcelJS from 'exceljs';
import { getClassAttendanceMatrix } from '../domain/reports.repo';
import { AppError } from '../shared/app-error';
import type { ClassMatrixBlock } from '../shared/types';

/** 浅黄：当月缺勤率 ≥ 50%。浅红：全年未到课。用 Excel 标准色调的 ARGB。 */
const FILL_YELLOW = 'FFFFF2CC';
const FILL_RED = 'FFF8CBAD';

const MONTH_LABELS = Array.from({ length: 12 }, (_, i) => `${i + 1}月`);
/** 表头行 + 姓名列冻结：前 3 行、第 1 列 */
const FROZEN = { state: 'frozen' as const, xSplit: 1, ySplit: 3 };

/** sheet 名清洗：去掉 Excel 不允许的字符，截断到 31，空名兜底。 */
function sanitizeSheetName(raw: string): string {
  const cleaned = (raw || '').replace(/[:\\/?*[\]]/g, '').trim();
  return (cleaned || '未命名班级').slice(0, 31);
}

/** 在 used 里挑一个不冲突的 sheet 名：先加 #classId，再退而加 ~2 / ~3…，始终 ≤ 31。 */
function uniqueSheetName(base: string, classId: number | null, used: Set<string>): string {
  let name = base;
  if (used.has(name) && classId !== null) name = `${base}#${classId}`.slice(0, 31);
  let i = 2;
  while (used.has(name)) {
    name = `${base}~${i}`.slice(0, 31);
    i += 1;
  }
  used.add(name);
  return name;
}

function solidFill(argb: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

/** 把一个矩阵块誊成一张 sheet。 */
function buildSheet(
  wb: ExcelJS.Workbook,
  block: ClassMatrixBlock,
  year: number,
  used: Set<string>,
): void {
  const name = uniqueSheetName(sanitizeSheetName(block.className), block.classId, used);
  const ws = wb.addWorksheet(name);
  ws.columns = [{ width: 20 }, ...MONTH_LABELS.map(() => ({ width: 6 })), { width: 10 }];

  ws.mergeCells(1, 1, 1, 14);
  const titleCell = ws.getCell(1, 1);
  titleCell.value = `${block.className} · ${year}年 出勤统计`;
  titleCell.font = { bold: true, size: 13 };

  ws.mergeCells(2, 1, 2, 14);
  const legendCell = ws.getCell(2, 1);
  legendCell.value = '图例：黄底 = 当月缺勤率 ≥ 50%　红底 = 全年未到课（出勤 + 补课 = 0）';
  legendCell.font = { italic: true, size: 10 };

  // 用显式单元格赋值（不用 row.values = array），避开 exceljs 对 0 基 / 1 基数组的歧义
  const headerCells = ['学员姓名', ...MONTH_LABELS, '全年合计'];
  headerCells.forEach((v, i) => {
    ws.getCell(3, i + 1).value = v;
  });
  ws.getRow(3).font = { bold: true };

  let r = 4;
  for (const row of block.rows) {
    const suffix = block.classId !== null && row.left ? '（已离班）' : '';
    const cells = [row.studentName + suffix, ...row.monthly, row.yearTotal];
    cells.forEach((v, i) => {
      ws.getCell(r, i + 1).value = v;
    });

    for (let m = 0; m < 12; m += 1) {
      const sched = row.monthlyScheduled[m] ?? 0;
      const absent = row.monthlyAbsent[m] ?? 0;
      if (sched > 0 && absent / sched >= 0.5) {
        ws.getCell(r, 2 + m).fill = solidFill(FILL_YELLOW);
      }
    }
    if (row.yearTotal === 0) {
      ws.getCell(r, 1).fill = solidFill(FILL_RED);
    }
    r += 1;
  }

  ws.views = [FROZEN];
}

/**
 * 导出年度出勤统计到 filePath。首个 sheet 为「全校汇总」，其后每个当年有课节的班级一张。
 * 全校汇总与所有班级都无数据 → REPORT_EMPTY（register 已先探测，这里是双保险）。
 *
 * @returns sheetCount = 1 + 班级数；classCount = 班级数
 */
export async function exportAttendanceByClass(
  year: number,
  filePath: string,
): Promise<{ sheetCount: number; classCount: number }> {
  const matrix = getClassAttendanceMatrix({ year });
  if (matrix.schoolWide.rows.length === 0 && matrix.classes.length === 0) {
    throw new AppError('REPORT_EMPTY', '所选年份没有可导出的数据');
  }

  const wb = new ExcelJS.Workbook();
  const used = new Set<string>();
  buildSheet(wb, matrix.schoolWide, year, used);
  for (const block of matrix.classes) buildSheet(wb, block, year, used);

  await wb.xlsx.writeFile(filePath);
  return { sheetCount: 1 + matrix.classes.length, classCount: matrix.classes.length };
}
