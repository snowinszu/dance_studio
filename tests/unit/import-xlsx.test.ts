/**
 * 导入集成测试：动态生成 fixture xlsx（2 好行 + 1 坏行），跑 importStudents，
 * 断言报告计数与失败行号；另测模板生成、预览、缺必填映射被拒。
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
import * as students from '../../src/domain/students.repo';
import * as fieldDefs from '../../src/domain/field-defs.repo';
import { AppError } from '../../src/shared/app-error';
import {
  buildTemplate,
  importStudents,
  readImportPreview,
} from '../../src/io/import-xlsx';

run(getDb());
const height = fieldDefs.create({ label: '身高', type: 'number', groupKey: 'basic' });

const dir = mkdtempSync(join(tmpdir(), 'ds-import-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

async function writeSheet(name: string, rows: string[][]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (const r of rows) ws.addRow(r);
  const file = join(dir, name);
  await wb.xlsx.writeFile(file);
  return file;
}

test('2 好行 + 1 坏行 → created=2, failed=1，失败行号正确', async () => {
  const file = await writeSheet('data.xlsx', [
    ['姓名', '电话', '舞种', '身高'],
    ['王一', '13800000001', '中国舞、拉丁', '120'], // row 2 好
    ['王二', '13800000002', '', '130'], //             row 3 好
    ['王三', 'not-a-phone', '', ''], //                 row 4 坏（手机号非法）
  ]);

  const report = await importStudents({
    filePath: file,
    mapping: {
      name: '姓名',
      phone_primary: '电话',
      dance_types: '舞种',
      [height.fieldKey]: '身高',
    },
  });

  assert.equal(report.created, 2);
  assert.equal(report.failed, 1);
  assert.equal(report.failures.length, 1);
  assert.equal(report.failures[0]!.row, 4, '坏行是第 4 行');
  assert.match(report.failures[0]!.reason, /phone_primary/);

  // 入库校验：王一的舞种被拆成数组，身高进 custom_fields
  const list = students.list({ search: '王一' });
  assert.equal(list.total, 1);
  const wangyi = students.get(list.rows[0]!.id)!;
  assert.deepEqual(wangyi.danceTypes, ['中国舞', '拉丁']);
  assert.equal(wangyi.customFields[height.fieldKey], 120);
});

test('缺「姓名」或「主联系电话」映射 → BAD_REQUEST', async () => {
  const file = await writeSheet('m.xlsx', [
    ['姓名', '电话'],
    ['甲', '13800000009'],
  ]);
  await assert.rejects(
    () => importStudents({ filePath: file, mapping: { name: '姓名' } }),
    (e: unknown) => e instanceof AppError && e.code === 'BAD_REQUEST',
  );
});

test('坏文件 → IMPORT_FILE_INVALID', async () => {
  const bad = join(dir, 'bad.xlsx');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(bad, 'this is not really an xlsx');
  await assert.rejects(
    () => readImportPreview(bad),
    (e: unknown) => e instanceof AppError && e.code === 'IMPORT_FILE_INVALID',
  );
});

test('readImportPreview 返回表头与样本行', async () => {
  const file = await writeSheet('preview.xlsx', [
    ['姓名', '电话', '备注'],
    ['小明', '13811112222', 'hi'],
    ['小红', '13833334444', ''],
  ]);
  const pv = await readImportPreview(file);
  assert.deepEqual(pv.headers, ['姓名', '电话', '备注']);
  assert.equal(pv.sample.length, 2);
  assert.equal(pv.sample[0]![0], '小明');
});

test('buildTemplate：表头含全部预设字段 + 未归档自定义字段，且有一行示例', async () => {
  const file = join(dir, 'tpl.xlsx');
  await buildTemplate(file);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0]!;
  const headers = (ws.getRow(1).values as unknown[]).slice(1).map(String);
  assert.ok(headers.includes('姓名'));
  assert.ok(headers.includes('主联系电话'));
  assert.ok(headers.includes('身高'), '含未归档自定义字段标签');
  assert.equal(ws.rowCount, 2, '表头 + 1 行示例');
  const example = (ws.getRow(2).values as unknown[]).slice(1).map(String);
  assert.ok(example.includes('张三'));
});
