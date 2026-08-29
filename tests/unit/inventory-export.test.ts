/**
 * 导出集成测试：写到临时文件再用 exceljs 读回，断言表头 / 列顺序 / 行数 / 数据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';

process.env['STUDIO_DB_PATH'] = ':memory:';

import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import { createItem, allocate, softDeleteItem } from '../../src/domain/inventory.repo';
import { validateItem } from '../../src/domain/inventory.validation';
import { exportItems, exportAllocations } from '../../src/io/inventory-xlsx';

run(getDb());

const now = new Date().toISOString();
const stu = Number(
  getDb()
    .prepare(
      `INSERT INTO students (name, phone_primary, status, dance_types, custom_fields, created_at, updated_at)
       VALUES ('王五', '13811112222', '在读', '[]', '{}', @now, @now)`,
    )
    .run({ now }).lastInsertRowid,
);

const nid = (name: string, q: number, extra: Record<string, unknown> = {}) =>
  createItem(validateItem({ name, quantity: q, ...extra }).values).id;

const svc = nid('练功服', 30, { category: '服装', unit: '件', lowStockThreshold: 5 });
nid('把杆', 8, { category: '器材', unit: '根' });
const del = nid('已停用道具', 3);
softDeleteItem(del);

allocate({ itemId: svc, studentId: stu, quantity: 4, claimedAt: '2026-07-01', note: '演出用' });
allocate({ itemId: svc, studentId: stu, quantity: 2, claimedAt: '2026-07-15', note: null });

let dir: string;
test('准备临时目录', () => {
  dir = mkdtempSync(join(tmpdir(), 'inv-export-'));
});

test('exportItems：表头 6 列、行数 = 未软删物件数、数据正确', async () => {
  const file = join(dir, 'items.xlsx');
  const count = await exportItems({}, file);
  assert.equal(count, 2, '已软删物件不导出');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0]!;
  const header = (ws.getRow(1).values as unknown[]).slice(1).map(String);
  assert.deepEqual(header, ['物件名', '分类', '单位', '当前库存', '预警阈值', '备注']);

  // 按物件名排序：把杆 在前，练功服 在后
  const r2 = (ws.getRow(2).values as unknown[]).slice(1);
  const r3 = (ws.getRow(3).values as unknown[]).slice(1);
  assert.equal(r2[0], '把杆');
  assert.equal(r3[0], '练功服');
  assert.equal(r3[2], '件');
  assert.equal(r3[3], 30 - 4 - 2); // 当前库存已被两次领用扣减
  assert.equal(r3[4], 5);
  assert.equal(ws.actualRowCount, 3); // 表头 + 2 行
});

test('exportAllocations：表头含「物件名」「领取日期」、行数 = 记录数、倒序', async () => {
  const file = join(dir, 'allocs.xlsx');
  const count = await exportAllocations({}, file);
  assert.equal(count, 2);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0]!;
  const header = (ws.getRow(1).values as unknown[]).slice(1).map(String);
  assert.deepEqual(header, ['物件名', '学员姓名', '学员电话', '领取数量', '领取日期', '备注']);
  assert.ok(header.includes('物件名'));
  assert.ok(header.includes('领取日期'));

  const r2 = (ws.getRow(2).values as unknown[]).slice(1);
  assert.equal(r2[0], '练功服');
  assert.equal(r2[1], '王五');
  assert.equal(r2[4], '2026-07-15'); // 倒序，晚的在前
  assert.equal(ws.actualRowCount, 3);
});

test('exportAllocations：按日期区间筛选影响导出行数', async () => {
  const file = join(dir, 'allocs-filtered.xlsx');
  const count = await exportAllocations({ dateFrom: '2026-07-10' }, file);
  assert.equal(count, 1);
});

test('清理临时目录', () => {
  rmSync(dir, { recursive: true, force: true });
});
