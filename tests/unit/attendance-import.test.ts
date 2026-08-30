/**
 * 考勤导入集成：用 exceljs 造 fixture，跑 importRecords，断言
 * 正常 / 疑似重复跳过 / 学员不存在 / 非法类型 / 调整留空 各归类正确，
 * 且成功行确实改动了对应学员余额，negativeBalance 计数正确。
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
import { buildTemplate, importRecords, readImportPreview } from '../../src/io/attendance-xlsx';

run(getDb());

const dir = mkdtempSync(join(tmpdir(), 'att-import-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const now = new Date().toISOString();
function mkStudent(name: string, phone: string, remaining: number): number {
  return Number(
    getDb()
      .prepare(
        `INSERT INTO students (name, phone_primary, status, dance_types, remaining_lessons, custom_fields, created_at, updated_at)
         VALUES (@name, @phone, '在读', '[]', @rem, '{}', @now, @now)`,
      )
      .run({ name, phone, rem: remaining, now }).lastInsertRowid,
  );
}
function balanceOf(id: number): number {
  return (
    getDb().prepare(`SELECT remaining_lessons AS r FROM students WHERE id = ?`).get(id) as {
      r: number;
    }
  ).r;
}

const amy = mkStudent('艾米', '13900000001', 3);
const ben = mkStudent('本', '13900000002', 1);

const HEADERS = [
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
];
const MAPPING = {
  studentName: '学员姓名',
  phone: '手机号',
  date: '日期',
  time: '时间',
  className: '课程',
  teacher: '老师',
  type: '类型',
  lessons: '课时增减',
  operator: '经办人',
  note: '备注',
};

async function writeFixture(name: string, rows: (string | number)[][]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(HEADERS);
  for (const r of rows) ws.addRow(r);
  const file = join(dir, name);
  await wb.xlsx.writeFile(file);
  return file;
}

test('buildTemplate + readImportPreview：表头 10 列，含示例行', async () => {
  const tpl = join(dir, 'tpl.xlsx');
  await buildTemplate(tpl);
  const pv = await readImportPreview(tpl);
  assert.deepEqual(pv.headers, HEADERS);
  assert.equal(pv.sample[0]?.[0], '张三');
});

test('混合文件：正常 / 疑似重复 / 学员不存在 / 非法类型 / 调整留空 各归类，余额随成功行变化', async () => {
  const file = await writeFixture('mix.xlsx', [
    ['艾米', '13900000001', '2026-05-01', '', '芭蕾', '王', '出勤', '', '前台', ''], // 成功：扣 1 → 2
    ['艾米', '13900000001', '2026-05-01', '', '芭蕾', '王', '出勤', '', '前台', ''], // 疑似重复 → skip
    ['艾米', '13900000001', '2026-05-02', '', '芭蕾', '王', '请假', '', '', ''], // 成功：不扣
    ['无此人', '10000000000', '2026-05-01', '', '', '', '出勤', '', '', ''], // 失败：学员不存在
    ['本', '13900000002', '2026-05-03', '', '现代舞', '', '蹦迪', '', '', ''], // 失败：非法类型
    ['本', '13900000002', '2026-05-03', '', '现代舞', '', '调整', '', '', ''], // 失败：调整留空
    ['本', '13900000002', '2026-05-04', '', '现代舞', '', '出勤', '2', '', ''], // 成功：私教扣 2 → 余额 -1（negativeBalance）
  ]);
  const report = await importRecords({ filePath: file, mapping: MAPPING });

  assert.equal(report.succeeded, 3);
  assert.equal(report.skipped, 1);
  assert.equal(report.failed, 3);
  assert.equal(report.negativeBalance, 1);

  const reasons = report.failures.map((f) => `${f.row}:${f.reason}`).join(' | ');
  assert.match(reasons, /5:学员不存在/);
  assert.match(reasons, /6:类型不合法/);
  assert.match(reasons, /7:调整必须填写非零课时/);

  assert.equal(balanceOf(amy), 2); // 3 - 1（请假不扣）
  assert.equal(balanceOf(ben), -1); // 1 - 2
});

test('缺必填列映射 → BAD_REQUEST', async () => {
  const file = await writeFixture('bad.xlsx', [['艾米', '13900000001', '2026-05-01', '', '', '', '出勤', '', '', '']]);
  await assert.rejects(
    () => importRecords({ filePath: file, mapping: { studentName: '学员姓名' } }),
    (e: unknown) => (e as { code?: string }).code === 'BAD_REQUEST',
  );
});
