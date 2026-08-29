/**
 * Excel 导入导出的通用零件。
 *
 * 整体类比：一套「拆包 / 打包」工具——把外面拿来的 .xlsx 撬开取第一张表、
 * 逐行读成文本；以及弹系统「另存为 / 打开」对话框拿路径。具体每列是什么业务含义，
 * 由 inventory-xlsx.ts / export-xlsx.ts 这些「装配线」决定，这里不管。
 *
 * 注意：dialog 相关函数会 require('electron')，只能在主进程调用；单元测试直接传 filePath
 * 跑装配线，不碰这两个函数。
 */
import { statSync } from 'node:fs';
import { dialog } from 'electron';
import ExcelJS from 'exceljs';
import { AppError } from '../shared/app-error';

/** 单次导入的硬上限，防止超大 / 恶意文件把主进程拖垮。 */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_IMPORT_ROWS = 5000; // 数据行（不含表头）

/** 今天，紧凑格式 YYYYMMDD——用于默认文件名。 */
export function ymdCompact(d: Date = new Date()): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** 打开工作簿的第一张表；坏文件 → IMPORT_FILE_INVALID。附带 10MB 上限校验。 */
export async function openFirstSheet(filePath: string): Promise<ExcelJS.Worksheet> {
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch {
    throw new AppError('IMPORT_FILE_INVALID', '找不到文件');
  }
  if (size > MAX_IMPORT_BYTES) {
    throw new AppError('IMPORT_TOO_LARGE', '文件超过 10MB，请拆分后再导入');
  }

  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.readFile(filePath);
  } catch {
    throw new AppError('IMPORT_FILE_INVALID', '文件无法识别，请用模板另存为 .xlsx');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new AppError('IMPORT_FILE_INVALID', '文件里没有工作表');
  return ws;
}

/** 取一行各单元格的显示文本（1-based → 数组，去首尾空白）。 */
export function rowTexts(row: ExcelJS.Row, width: number): string[] {
  const out: string[] = [];
  for (let c = 1; c <= width; c += 1) {
    const cell = row.getCell(c);
    out.push((cell.text ?? '').toString().trim());
  }
  return out;
}

/** 表头文本数组（第 1 行）。 */
export function headerTexts(ws: ExcelJS.Worksheet): string[] {
  const header = ws.getRow(1);
  const width = Math.max(header.cellCount, header.actualCellCount);
  return rowTexts(header, width);
}

/**
 * 弹「另存为」对话框拿一个 .xlsx 路径。用户取消 → IO_CANCELLED。
 * 仅主进程可用。
 */
export async function pickSavePath(title: string, defaultName: string): Promise<string> {
  const picked = await dialog.showSaveDialog({
    title,
    defaultPath: defaultName,
    filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
  });
  if (picked.canceled || !picked.filePath) throw new AppError('IO_CANCELLED', '已取消');
  return picked.filePath;
}

/**
 * 弹「打开文件」对话框拿一个 .xlsx 路径。用户取消 → IO_CANCELLED。
 * 仅主进程可用。
 */
export async function pickOpenPath(title: string): Promise<string> {
  const picked = await dialog.showOpenDialog({
    title,
    properties: ['openFile'],
    filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
  });
  const file = picked.filePaths[0];
  if (picked.canceled || !file) throw new AppError('IO_CANCELLED', '已取消');
  return file;
}
