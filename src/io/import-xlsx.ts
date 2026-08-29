/**
 * 从 .xlsx 批量导入学员（主进程，用 exceljs）。
 *
 * 整体类比：把外面带来的一沓表格，按用户给的「列对应关系」逐行抄进档案柜。
 * 每行先过一遍「验收员」（validateStudent）：合格就入柜，不合格就记进「失败清单」
 * 继续下一行——绝不因为一行错就整批退回。整批包在一个事务里只是为了快。
 * 本版一律按「新建」处理，不按手机号去重。
 */
import { statSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { getDb } from '../db/connection';
import { AppError } from '../shared/app-error';
import { PRESET_COLUMN_NAMES, PRESET_FIELDS } from '../shared/preset-fields';
import { buildSchema, toCamel, validateStudent } from './../domain/validation';
import * as fieldDefsRepo from '../domain/field-defs.repo';
import * as studentsRepo from '../domain/students.repo';
import type { FieldType, ImportReport, StudentInput } from '../shared/types';

const MAX_IMPORT_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_IMPORT_ROWS = 5000; // 数据行上限

const PRESET_KEYS = new Set<string>(PRESET_COLUMN_NAMES);

/** 打开首个工作表，坏文件 → IMPORT_FILE_INVALID。 */
async function openFirstSheet(filePath: string): Promise<ExcelJS.Worksheet> {
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

/** 取一行的各单元格显示文本（1-based → 数组，去首尾空白）。 */
function rowTexts(row: ExcelJS.Row, width: number): string[] {
  const out: string[] = [];
  for (let c = 1; c <= width; c += 1) {
    const cell = row.getCell(c);
    out.push((cell.text ?? '').toString().trim());
  }
  return out;
}

/** 表头文本数组。 */
function headerTexts(ws: ExcelJS.Worksheet): string[] {
  const header = ws.getRow(1);
  const width = Math.max(header.cellCount, header.actualCellCount);
  return rowTexts(header, width);
}

export interface ImportPreview {
  filePath: string;
  headers: string[];
  sample: string[][];
}

/** 读表头 + 前 3 行样本，供渲染层做列映射。含大小 / 行数上限校验。 */
export async function readImportPreview(filePath: string): Promise<ImportPreview> {
  const size = statSync(filePath).size;
  if (size > MAX_IMPORT_BYTES) {
    throw new AppError('IMPORT_TOO_LARGE', '文件超过 10MB，请拆分后再导入');
  }
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

/** 生成导入模板：表头 = 全部预设字段 + 未归档自定义字段，附一行示例。 */
export async function buildTemplate(filePath: string): Promise<void> {
  const customLabels = fieldDefsRepo.descriptors().map((d) => d.label);
  const presetLabels = PRESET_FIELDS.map((f) => f.label);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('学员导入模板');
  ws.addRow([...presetLabels, ...customLabels]);

  // 一行示例：只填姓名和主联系电话，其余留空
  const example = [...presetLabels, ...customLabels].map((label) => {
    if (label === '姓名') return '张三';
    if (label === '主联系电话') return '13800138000';
    return '';
  });
  ws.addRow(example);

  await wb.xlsx.writeFile(filePath);
}

export interface ImportArgs {
  filePath: string;
  /** 模板字段 key（预设用下划线列名 / 自定义用 fieldKey）→ 用户表格里的列表头文本 */
  mapping: Record<string, string>;
}

/** 多选单元格文本 → 数组（支持中英文逗号 / 顿号 / 分号分隔）。 */
function splitMulti(text: string): string[] {
  return text
    .split(/[,，、;；]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 逐行导入，返回报告。失败行不中断其余行。 */
export async function importStudents({ filePath, mapping }: ImportArgs): Promise<ImportReport> {
  if (!mapping || typeof mapping !== 'object') {
    throw new AppError('BAD_REQUEST', '缺少列映射');
  }
  if (!mapping['name'] || !mapping['phone_primary']) {
    throw new AppError('BAD_REQUEST', '「姓名」和「主联系电话」必须映射到某一列');
  }

  const ws = await openFirstSheet(filePath);
  const headers = headerTexts(ws);
  const colOf = (header: string): number => headers.indexOf(header); // 0-based，-1 表示没这列

  const groups = buildSchema(fieldDefsRepo.descriptors());
  const typeByKey = new Map<string, FieldType>();
  for (const g of groups) for (const f of g.fields) typeByKey.set(f.key, f.type);

  const report: ImportReport = { created: 0, failed: 0, failures: [] };
  const db = getDb();

  const runAll = db.transaction(() => {
    for (let r = 2; r <= ws.rowCount; r += 1) {
      const cells = rowTexts(ws.getRow(r), headers.length);
      if (cells.every((c) => c === '')) continue; // 跳过完全空行

      const input: StudentInput & { customFields: Record<string, unknown> } = {
        name: '',
        phonePrimary: '',
        customFields: {},
      };

      for (const [fieldKey, colHeader] of Object.entries(mapping)) {
        const ci = colOf(colHeader);
        if (ci < 0) continue;
        const raw = cells[ci] ?? '';
        const type = typeByKey.get(fieldKey);
        const value: unknown = type === 'multiselect' ? splitMulti(raw) : raw;

        if (PRESET_KEYS.has(fieldKey)) {
          (input as unknown as Record<string, unknown>)[toCamel(fieldKey)] = value;
        } else {
          input.customFields[fieldKey] = value;
        }
      }

      const { values, errors } = validateStudent(input, groups);
      const errKeys = Object.keys(errors);
      if (errKeys.length > 0) {
        report.failed += 1;
        const firstKey = errKeys[0]!;
        report.failures.push({ row: r, reason: `${firstKey}：${errors[firstKey]}` });
        continue;
      }
      studentsRepo.create(values);
      report.created += 1;
    }
  });
  runAll();

  return report;
}
