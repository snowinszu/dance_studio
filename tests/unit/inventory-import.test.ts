/**
 * 物件台账导入集成测试：用 exceljs 造 fixture，跑 importItems，断言
 * 新建 / 累加 / 失败行不中断 / 留空不覆盖 / 同名行累加 / 缺必填列报错。
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
import { createItem, getItem, listItems } from '../../src/domain/inventory.repo';
import { validateItem } from '../../src/domain/inventory.validation';
import { importItems, readItemsPreview } from '../../src/io/inventory-xlsx';

run(getDb());

const dir = mkdtempSync(join(tmpdir(), 'inv-import-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

// 预置一个已有物件：练功服，库存 5，分类「服装」，单位「件」，阈值 2，备注「原备注」
const existingId = createItem(
  validateItem({ name: '练功服', quantity: 5, category: '服装', unit: '件', lowStockThreshold: 2, note: '原备注' }).values,
).id;

async function writeFixture(name: string, rows: (string | number)[][]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(['物件名', '分类', '单位', '入库数量', '预警阈值', '备注']);
  for (const r of rows) ws.addRow(r);
  const file = join(dir, name);
  await wb.xlsx.writeFile(file);
  return file;
}

const MAPPING = {
  name: '物件名',
  category: '分类',
  unit: '单位',
  quantity: '入库数量',
  lowStockThreshold: '预警阈值',
  note: '备注',
};

test('readItemsPreview 返回表头与样本行', async () => {
  const file = await writeFixture('preview.xlsx', [['伞', '道具', '把', 3, 1, '']]);
  const pv = await readItemsPreview(file);
  assert.deepEqual(pv.headers, ['物件名', '分类', '单位', '入库数量', '预警阈值', '备注']);
  assert.equal(pv.sample[0]?.[0], '伞');
});

test('新建 1 + 累加 1 + 坏行 1；坏行不中断', async () => {
  const file = await writeFixture('mix.xlsx', [
    ['把杆', '器材', '根', 4, 1, '新物件'], // 新建
    ['练功服', '', '', 3, '', ''], // 已存在 → 累加 3，其它列留空不覆盖
    ['坏行', '', '', -2, '', ''], // 入库数量为负 → 失败
  ]);
  const report = await importItems({ filePath: file, mapping: MAPPING });
  assert.deepEqual(
    { created: report.created, updated: report.updated, failed: report.failed },
    { created: 1, updated: 1, failed: 1 },
  );
  assert.equal(report.failures[0]?.row, 4); // 表头第 1 行，数据从第 2 行起，坏行是第 4 行
  assert.match(report.failures[0]?.reason ?? '', /不小于 0/);

  // 累加：5 + 3 = 8；留空的分类/单位/阈值/备注保持原值
  const ex = getItem(existingId)!;
  assert.equal(ex.quantity, 8);
  assert.equal(ex.category, '服装');
  assert.equal(ex.unit, '件');
  assert.equal(ex.lowStockThreshold, 2);
  assert.equal(ex.note, '原备注');

  // 新建
  const created = listItems({ search: '把杆' }).rows[0]!;
  assert.equal(created.quantity, 4);
  assert.equal(created.category, '器材');
  assert.equal(created.unit, '根');
});

test('同一文件内两行同名 → 第二行走累加分支', async () => {
  const file = await writeFixture('dupe.xlsx', [
    ['新扇子', '道具', '把', 10, 2, ''],
    ['新扇子', '', '', 5, '', ''],
  ]);
  const report = await importItems({ filePath: file, mapping: MAPPING });
  assert.equal(report.created, 1);
  assert.equal(report.updated, 1);
  assert.equal(listItems({ search: '新扇子' }).rows[0]?.quantity, 15);
});

test('行内给了新的分类/备注 → 覆盖旧值', async () => {
  const file = await writeFixture('overwrite.xlsx', [['练功服', '演出服装', '套', 1, 9, '换了备注']]);
  await importItems({ filePath: file, mapping: MAPPING });
  const ex = getItem(existingId)!;
  assert.equal(ex.category, '演出服装');
  assert.equal(ex.unit, '套');
  assert.equal(ex.lowStockThreshold, 9);
  assert.equal(ex.note, '换了备注');
});

test('mapping 缺「入库数量」→ BAD_REQUEST', async () => {
  const file = await writeFixture('nomap.xlsx', [['x', '', '', 1, '', '']]);
  await assert.rejects(
    () => importItems({ filePath: file, mapping: { name: '物件名' } }),
    (e: unknown) => (e as { code?: string }).code === 'BAD_REQUEST',
  );
});

test('入库数量留空 → 该行失败', async () => {
  const file = await writeFixture('blankqty.xlsx', [['空数量物件', '', '', '', '', '']]);
  const report = await importItems({ filePath: file, mapping: MAPPING });
  assert.equal(report.failed, 1);
  assert.match(report.failures[0]?.reason ?? '', /入库数量必填/);
});
