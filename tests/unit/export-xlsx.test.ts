/**
 * 导出集成测试：写到临时文件再用 exceljs 读回，断言列顺序、格式化、软删除排除。
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
import * as tags from '../../src/domain/tags.repo';
import { buildColumns, exportStudents } from '../../src/io/export-xlsx';

run(getDb());

// —— 造数据 ——
const active = fieldDefs.create({ label: '身高', type: 'number', groupKey: 'basic' });
const archived = fieldDefs.create({ label: '旧机构', type: 'text', groupKey: 'ops' });
fieldDefs.archive(archived.id);

const s1 = students.create({
  name: '甲', phonePrimary: '13800000001',
  danceTypes: ['中国舞', '芭蕾'], birthDate: '2015-03-04',
  customFields: { [active.fieldKey]: 130, [archived.fieldKey]: '育才' },
} as never).id;
students.create({
  name: '乙', phonePrimary: '13800000002', customFields: {},
} as never);
const s3 = students.create({
  name: '丙', phonePrimary: '13800000003', customFields: {},
} as never).id;

const vip = tags.create({ name: 'VIP' });
tags.setForStudent(s1, [vip.id]);

// 丙 软删除，不应出现在导出里
students.softDelete(s3);

test('列顺序：预设 → 未归档自定义 → 有值的已归档(带「(已归档)」) → 标签', () => {
  const rows = students.listForExport({});
  const cols = buildColumns(rows).map((c) => c.header);

  assert.equal(cols[0], '姓名', '第一列是预设的姓名');
  const iHeight = cols.indexOf('身高');
  const iArch = cols.indexOf('旧机构(已归档)');
  const iTags = cols.indexOf('标签');
  assert.ok(iHeight > 0);
  assert.ok(iArch > iHeight, '已归档列排在未归档自定义之后');
  assert.equal(iTags, cols.length - 1, '标签是最后一列');
  assert.ok(!cols.includes('旧机构'), '不带后缀的已归档列名不应出现');
});

test('写出文件 → 读回校验单元格格式化，且不含已软删除的学员', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-export-'));
  const file = join(dir, 'out.xlsx');
  try {
    const count = await exportStudents({}, file);
    assert.equal(count, 2, '只导出 2 条（丙已软删除）');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const ws = wb.getWorksheet('学员档案')!;

    const headers = (ws.getRow(1).values as unknown[]).slice(1).map(String);
    const col = (name: string) => headers.indexOf(name) + 1;

    // 找到「甲」那一行
    let jiaRow = -1;
    ws.eachRow((row, n) => {
      if (n > 1 && String(row.getCell(col('姓名')).value) === '甲') jiaRow = n;
    });
    assert.ok(jiaRow > 1, '找到甲的行');
    const cell = (name: string) => String(ws.getRow(jiaRow).getCell(col(name)).value ?? '');

    assert.equal(cell('报读舞种 / 班级'), '中国舞, 芭蕾', 'multiselect 逗号分隔');
    assert.equal(cell('出生日期'), '2015-03-04', 'date 原样 YYYY-MM-DD');
    assert.equal(cell('身高'), '130', '未归档自定义字段值');
    assert.equal(cell('旧机构(已归档)'), '育才', '已归档字段历史值仍导出');
    assert.equal(cell('标签'), 'VIP', '标签列');

    const names: string[] = [];
    ws.eachRow((row, n) => {
      if (n > 1) names.push(String(row.getCell(col('姓名')).value));
    });
    assert.deepEqual(names.sort(), ['乙', '甲']);
    assert.ok(!names.includes('丙'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('按筛选导出：只导出匹配的行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ds-export2-'));
  const file = join(dir, 'out.xlsx');
  try {
    const count = await exportStudents({ search: '甲' }, file);
    assert.equal(count, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
