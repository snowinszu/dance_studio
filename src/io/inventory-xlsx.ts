/**
 * 库存管理的 Excel 导入导出（主进程，用 exceljs）。
 *
 * 整体类比：两条「誊写」流水线——
 *   exportItems       把当前筛选到的物件台账誊到一张表（物件名/分类/单位/当前库存/预警阈值/备注）
 *   exportAllocations 把当前筛选到的领用流水誊到一张表（物件名/学员姓名/电话/领取数量/领取日期/备注）
 * 导入（物件台账）在 #31 接入。
 */
import ExcelJS from 'exceljs';
import { getDb } from '../db/connection';
import { AppError } from '../shared/app-error';
import * as inventoryRepo from '../domain/inventory.repo';
import { headerTexts, MAX_IMPORT_ROWS, openFirstSheet, rowTexts } from './xlsx-util';
import type {
  AllocationListQuery,
  InventoryImportReport,
  InventoryListQuery,
} from '../shared/types';

/** 单元格取值 → 字符串；null/undefined/'' → 空串，数字原样。 */
function cell(v: unknown): string | number {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return v;
  return String(v);
}

/**
 * 导出物件台账到 filePath，返回导出的行数。
 * 取「当前筛选匹配的全部物件」（忽略分页），已软删物件不导出。
 */
export async function exportItems(query: InventoryListQuery, filePath: string): Promise<number> {
  const rows = inventoryRepo.listItems({
    ...query,
    limit: Number.MAX_SAFE_INTEGER,
    offset: 0,
  }).rows;

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('物件台账');
  ws.columns = [
    { header: '物件名', key: 'name', width: 24 },
    { header: '分类', key: 'category', width: 14 },
    { header: '单位', key: 'unit', width: 8 },
    { header: '当前库存', key: 'quantity', width: 10 },
    { header: '预警阈值', key: 'lowStockThreshold', width: 10 },
    { header: '备注', key: 'note', width: 30 },
  ];
  for (const it of rows) {
    ws.addRow({
      name: cell(it.name),
      category: cell(it.category),
      unit: cell(it.unit),
      quantity: cell(it.quantity),
      lowStockThreshold: cell(it.lowStockThreshold),
      note: cell(it.note),
    });
  }

  await wb.xlsx.writeFile(filePath);
  return rows.length;
}

/**
 * 导出领用流水到 filePath，返回导出的行数。
 * 取「当前筛选匹配的全部记录」（忽略分页）。
 */
export async function exportAllocations(
  query: AllocationListQuery,
  filePath: string,
): Promise<number> {
  const rows = inventoryRepo.listAllocations({
    ...query,
    limit: Number.MAX_SAFE_INTEGER,
    offset: 0,
  }).rows;

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('领用流水');
  ws.columns = [
    { header: '物件名', key: 'itemName', width: 24 },
    { header: '学员姓名', key: 'studentName', width: 14 },
    { header: '学员电话', key: 'studentPhone', width: 16 },
    { header: '领取数量', key: 'quantity', width: 10 },
    { header: '领取日期', key: 'claimedAt', width: 14 },
    { header: '备注', key: 'note', width: 30 },
  ];
  for (const a of rows) {
    ws.addRow({
      itemName: cell(a.itemName),
      studentName: cell(a.studentName),
      studentPhone: cell(a.studentPhone),
      quantity: cell(a.quantity),
      claimedAt: cell(a.claimedAt),
      note: cell(a.note),
    });
  }

  await wb.xlsx.writeFile(filePath);
  return rows.length;
}

/* ═══════════════════════ 导入（仅物件台账） ═══════════════════════ */

/** 模板 / 映射用的字段 key → 表头显示名。 */
const TEMPLATE_COLUMNS: { key: string; header: string }[] = [
  { key: 'name', header: '物件名' },
  { key: 'category', header: '分类' },
  { key: 'unit', header: '单位' },
  { key: 'quantity', header: '入库数量' },
  { key: 'lowStockThreshold', header: '预警阈值' },
  { key: 'note', header: '备注' },
];

/** 生成导入模板：表头 6 列 + 一行示例。 */
export async function buildItemTemplate(filePath: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('物件导入模板');
  ws.addRow(TEMPLATE_COLUMNS.map((c) => c.header));
  ws.addRow(['练功服（女·S）', '服装', '件', 10, 5, '示例行，导入前可删除']);
  await wb.xlsx.writeFile(filePath);
}

export interface ImportItemsPreview {
  filePath: string;
  headers: string[];
  sample: string[][];
}

/** 读表头 + 前 3 行样本，供渲染层做列映射。含行数上限校验。 */
export async function readItemsPreview(filePath: string): Promise<ImportItemsPreview> {
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

export interface ImportItemsArgs {
  filePath: string;
  /** 模板字段 key（name/category/unit/quantity/lowStockThreshold/note）→ 用户表格的列表头文本 */
  mapping: Record<string, string>;
}

interface ParsedRow {
  name: string;
  category: string | null;
  unit: string | null;
  quantity: number;
  lowStockThreshold: number | null;
  note: string | null;
}

/**
 * 解析一行为 ParsedRow，或返回错误原因。
 * 关键点：**留空的字段返回 null**（更新时 COALESCE 保持原值），不像 validateItem 那样给缺省。
 * quantity 语义是「入库数量」——必填、整数、≥ 0。
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

  const name = pick('name');
  if (name.length === 0) return { error: '物件名必填' };
  if (name.length > 40) return { error: '物件名不超过 40 字' };

  const qtyText = pick('quantity');
  if (qtyText.length === 0) return { error: '入库数量必填' };
  const quantity = Number(qtyText);
  if (!Number.isInteger(quantity) || quantity < 0) {
    return { error: '入库数量必须是不小于 0 的整数' };
  }

  const categoryText = pick('category');
  if (categoryText.length > 40) return { error: '分类不超过 40 字' };

  const unitText = pick('unit');
  if (unitText.length > 10) return { error: '单位不超过 10 字' };

  const lowText = pick('lowStockThreshold');
  let lowStockThreshold: number | null = null;
  if (lowText.length > 0) {
    const n = Number(lowText);
    if (!Number.isInteger(n) || n < 0) return { error: '预警阈值必须是不小于 0 的整数' };
    lowStockThreshold = n;
  }

  const noteText = pick('note');
  if (noteText.length > 200) return { error: '备注不超过 200 字' };

  return {
    row: {
      name,
      category: categoryText.length > 0 ? categoryText : null,
      unit: unitText.length > 0 ? unitText : null,
      quantity,
      lowStockThreshold,
      note: noteText.length > 0 ? noteText : null,
    },
  };
}

/**
 * 导入物件台账。
 * - 物件名匹配到「未软删」物件 → quantity += 入库数量，行内非空字段一并更新（留空不覆盖）
 * - 未匹配（含只匹配到已软删同名物件）→ 按入库数量为初始库存新建
 * - 逐行校验，失败行计入 failures 且不中断；整批包一个事务只为性能
 */
export async function importItems({
  filePath,
  mapping,
}: ImportItemsArgs): Promise<InventoryImportReport> {
  if (!mapping || typeof mapping !== 'object') {
    throw new AppError('BAD_REQUEST', '缺少列映射');
  }
  if (!mapping['name'] || !mapping['quantity']) {
    throw new AppError('BAD_REQUEST', '「物件名」和「入库数量」必须映射到某一列');
  }

  const ws = await openFirstSheet(filePath);
  const headers = headerTexts(ws);
  const colOf = (header: string): number => headers.indexOf(header);

  const report: InventoryImportReport = { created: 0, updated: 0, failed: 0, failures: [] };
  const db = getDb();
  const now = new Date().toISOString();

  const findActive = db.prepare(
    `SELECT id FROM inventory_items WHERE name = @name AND deleted_at IS NULL LIMIT 1`,
  );
  const topUp = db.prepare(
    `UPDATE inventory_items
        SET quantity = quantity + @qty,
            category = COALESCE(@category, category),
            unit     = COALESCE(@unit, unit),
            low_stock_threshold = COALESCE(@low, low_stock_threshold),
            note     = COALESCE(@note, note),
            updated_at = @now
      WHERE id = @id`,
  );
  const insertNew = db.prepare(
    `INSERT INTO inventory_items
       (name, category, unit, quantity, low_stock_threshold, note, created_at, updated_at)
     VALUES (@name, @category, COALESCE(@unit, '件'), @qty, COALESCE(@low, 0), @note, @now, @now)`,
  );

  const runAll = db.transaction(() => {
    for (let r = 2; r <= ws.rowCount; r += 1) {
      const cells = rowTexts(ws.getRow(r), headers.length);
      if (cells.every((c) => c === '')) continue; // 跳过完全空行

      const parsed = parseImportRow(cells, mapping, colOf);
      if ('error' in parsed) {
        report.failed += 1;
        report.failures.push({ row: r, reason: parsed.error });
        continue;
      }
      const row = parsed.row;
      const hit = findActive.get({ name: row.name }) as { id: number } | undefined;
      const params = {
        name: row.name,
        category: row.category,
        unit: row.unit,
        low: row.lowStockThreshold,
        note: row.note,
        qty: row.quantity,
        now,
      };
      if (hit) {
        topUp.run({ ...params, id: hit.id });
        report.updated += 1;
      } else {
        insertNew.run(params);
        report.created += 1;
      }
    }
  });
  runAll();

  return report;
}
