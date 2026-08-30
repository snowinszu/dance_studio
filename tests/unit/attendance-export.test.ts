/**
 * 导出集成：写到临时文件再用 exceljs 读回，断言两个 sheet、明细行数、按月汇总的分组与计数。
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
import { createRecord, voidRecord } from '../../src/domain/attendance.repo';
import { exportRecords } from '../../src/io/attendance-xlsx';
import type { RecordValues } from '../../src/domain/attendance.validation';

run(getDb());

const now = new Date().toISOString();
const stu = Number(
  getDb()
    .prepare(
      `INSERT INTO students (name, phone_primary, status, dance_types, remaining_lessons, custom_fields, created_at, updated_at)
       VALUES ('周杰', '13800001111', '在读', '[]', 20, '{}', @now, @now)`,
    )
    .run({ now }).lastInsertRowid,
);

function rv(over: Partial<RecordValues>): RecordValues {
  return {
    studentId: stu,
    type: '出勤',
    attendDate: '2026-03-01',
    attendTime: null,
    className: '班A',
    teacher: null,
    lessonsDelta: -1,
    reason: null,
    operator: null,
    note: null,
    sessionId: null,
    force: false,
    allowDuplicate: false,
    ...over,
  };
}

// 3 月：2 次出勤（各扣 1）+ 1 次请假；4 月：1 次缺勤；再造 1 条已撤销的出勤（不应计入）
createRecord(rv({ attendDate: '2026-03-01', className: 'A' }));
createRecord(rv({ attendDate: '2026-03-08', className: 'B' }));
createRecord(rv({ attendDate: '2026-03-10', type: '请假', lessonsDelta: 0, className: 'C' }));
createRecord(rv({ attendDate: '2026-04-05', type: '缺勤', lessonsDelta: 0, className: 'D' }));
const voided = createRecord(rv({ attendDate: '2026-03-20', className: 'E' }));
voidRecord(voided.id);

let dir: string;
test('准备临时目录', () => {
  dir = mkdtempSync(join(tmpdir(), 'att-export-'));
});

test('exportRecords：生成「考勤明细」「按月汇总」两个 sheet；明细排除已撤销', async () => {
  const file = join(dir, 'att.xlsx');
  const res = await exportRecords({}, file);
  assert.equal(res.detail, 4, '5 条里 1 条已撤销，明细应为 4');

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  assert.deepEqual(
    wb.worksheets.map((w) => w.name),
    ['考勤明细', '按月汇总'],
  );

  const h1 = (wb.getWorksheet('考勤明细')!.getRow(1).values as unknown[]).slice(1).map(String);
  assert.deepEqual(h1, [
    '学员姓名',
    '手机号',
    '日期',
    '时间',
    '课程',
    '老师',
    '类型',
    '课时增减',
    '经办人',
    '备注',
  ]);
  assert.equal(wb.getWorksheet('考勤明细')!.actualRowCount, 5); // 表头 + 4
});

test('按月汇总：每人每月一行，各类型计数与当月消耗课时正确', async () => {
  const file = join(dir, 'att2.xlsx');
  await exportRecords({}, file);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet('按月汇总')!;

  // 2 个月 → 2 行数据
  assert.equal(ws.actualRowCount, 3);

  const byMonth: Record<string, unknown[]> = {};
  for (let r = 2; r <= ws.rowCount; r += 1) {
    const vals = (ws.getRow(r).values as unknown[]).slice(1);
    byMonth[String(vals[2])] = vals;
  }
  // 2026-03：出勤 2、请假 1、缺勤 0、消耗 2
  const mar = byMonth['2026-03']!;
  assert.equal(mar[3], 2); // 出勤
  assert.equal(mar[4], 1); // 请假
  assert.equal(mar[5], 0); // 缺勤
  assert.equal(mar[8], 2); // 当月消耗课时
  // 2026-04：缺勤 1、消耗 0
  const apr = byMonth['2026-04']!;
  assert.equal(apr[5], 1);
  assert.equal(apr[8], 0);
});

test('筛选：只导 2026-04 → 明细 1 条、汇总 1 行', async () => {
  const file = join(dir, 'att3.xlsx');
  const res = await exportRecords({ dateFrom: '2026-04-01' }, file);
  assert.equal(res.detail, 1);
  assert.equal(res.summary, 1);
});

test('空筛选结果：两个 sheet 仅表头', async () => {
  const file = join(dir, 'att4.xlsx');
  const res = await exportRecords({ keyword: '查无此人' }, file);
  assert.equal(res.detail, 0);
  assert.equal(res.summary, 0);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  assert.equal(wb.getWorksheet('考勤明细')!.actualRowCount, 1);
  assert.equal(wb.getWorksheet('按月汇总')!.actualRowCount, 1);
});

test('清理临时目录', () => {
  rmSync(dir, { recursive: true, force: true });
});
