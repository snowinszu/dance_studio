/**
 * 库存管理的 Excel 导入导出（主进程，用 exceljs）。
 *
 * 整体类比：两条「誊写」流水线——
 *   exportItems       把当前筛选到的物件台账誊到一张表（物件名/分类/单位/当前库存/预警阈值/备注）
 *   exportAllocations 把当前筛选到的领用流水誊到一张表（物件名/学员姓名/电话/领取数量/领取日期/备注）
 * 导入（物件台账）在 #31 接入。
 */
import ExcelJS from 'exceljs';
import * as inventoryRepo from '../domain/inventory.repo';
import type { AllocationListQuery, InventoryListQuery } from '../shared/types';

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
