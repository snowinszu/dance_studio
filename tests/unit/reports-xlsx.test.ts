/**
 * 按班级导出 Excel 出勤统计的单测：生成到临时文件后用 exceljs 读回校验。
 * 独立进程 / 独立 :memory: 库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import { exportAttendanceByClass } from '../../src/io/reports-xlsx';
import { canExportAttendance } from '../../src/domain/reports.repo';

process.env['STUDIO_DB_PATH'] = ':memory:';
run(getDb());

const db = getDb();
const NOW = new Date().toISOString();
const YEAR = 2025;

function mkStudent(name: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO students (name, phone_primary, status, dance_types, custom_fields, created_at, updated_at)
         VALUES (@n, @p, '在读', '[]', '{}', @now, @now)`,
      )
      .run({ n: name, p: `137${Math.floor(Math.random() * 9e6 + 1e6)}`, now: NOW }).lastInsertRowid,
  );
}
function mkClass(name: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO classes (name, dance_type, status, created_at, updated_at)
         VALUES (@n, '中国舞', '在读', @now, @now)`,
      )
      .run({ n: name, now: NOW }).lastInsertRowid,
  );
}
function mkRoster(classId: number, studentId: number, left: boolean): void {
  db.prepare(
    `INSERT INTO class_students (class_id, student_id, joined_at, left_at, created_at, updated_at)
     VALUES (@c, @s, '2025-01-01', @l, @now, @now)`,
  ).run({ c: classId, s: studentId, l: left ? '2025-05-01' : null, now: NOW });
}
function mkSession(classId: number, date: string, start: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO class_sessions
           (class_id, session_date, start_time, end_time, status, origin, created_at, updated_at)
         VALUES (@c, @d, @s, '23:59', '正常', '手动', @now, @now)`,
      )
      .run({ c: classId, d: date, s: start, now: NOW }).lastInsertRowid,
  );
}
function mkAtt(studentId: number, date: string, type: string, sessionId: number | null): void {
  db.prepare(
    `INSERT INTO attendance_records
       (student_id, session_id, attend_date, type, lessons_delta, created_at, updated_at)
     VALUES (@sid, @sess, @d, @t, 0, @now, @now)`,
  ).run({ sid: studentId, sess: sessionId, d: date, t: type, now: NOW });
}

/* ─────────────────────── 夹具 ─────────────────────── */

const SA = mkStudent('甲');
const SB = mkStudent('乙');
const SC = mkStudent('丙');

const C1 = mkClass('启蒙/A班'); // sanitize → 启蒙A班
const C2 = mkClass('启蒙:A班'); // sanitize → 启蒙A班（与 C1 冲突 → 加 #id）
const C3 = mkClass('进阶班');

const S1 = mkSession(C1, '2025-02-05', '09:00');
const S2 = mkSession(C1, '2025-03-05', '09:00');
const S3 = mkSession(C2, '2025-02-06', '09:00');
const S4 = mkSession(C3, '2025-02-07', '09:00');

mkRoster(C1, SA, false);
mkRoster(C1, SB, false);
mkRoster(C1, SC, true); // 已离班
mkRoster(C2, SA, false);
mkRoster(C3, SB, false);

// SA：C1 两次出勤 + C2 一次出勤 + 一条未关联课节的出勤（只进全校汇总）
mkAtt(SA, '2025-02-05', '出勤', S1);
mkAtt(SA, '2025-03-05', '出勤', S2);
mkAtt(SA, '2025-02-06', '出勤', S3);
mkAtt(SA, '2025-04-10', '出勤', null);
// SB：C1 两次缺勤（全年 0 到课 → 姓名标红；每月缺勤率 100% → 标黄）；C3 一次出勤
mkAtt(SB, '2025-02-05', '缺勤', S1);
mkAtt(SB, '2025-03-05', '缺勤', S2);
mkAtt(SB, '2025-02-07', '出勤', S4);
// SC：离班前在 C1 出勤一次
mkAtt(SC, '2025-02-05', '出勤', S1);

/* ─────────────────────── 断言 ─────────────────────── */

const outFile = join(mkdtempSync(join(tmpdir(), 'ds-xlsx-')), `out-${YEAR}.xlsx`);

/** 在一张 sheet 里按姓名列（A 列，数据从第 4 行起）定位行号；找不到返回 -1。 */
function rowOf(ws: ExcelJS.Worksheet, name: string): number {
  for (let r = 4; r <= ws.rowCount; r += 1) {
    if (ws.getCell(r, 1).value === name) return r;
  }
  return -1;
}

test('exportAttendanceByClass：sheet 结构、数值、标黄/标红、已离班后缀、汇总≥分班之和', async () => {
  const res = await exportAttendanceByClass(YEAR, outFile);
  assert.deepEqual(res, { sheetCount: 4, classCount: 3 });

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(outFile);

  // 首 sheet = 全校汇总；共 1 + 3
  assert.equal(wb.worksheets[0]!.name, '全校汇总');
  assert.equal(wb.worksheets.length, 4);

  // sheet 名清洗 + 去重
  assert.ok(wb.getWorksheet('启蒙A班'), 'C1 → 启蒙A班');
  assert.ok(wb.getWorksheet(`启蒙A班#${C2}`), 'C2 冲突 → 启蒙A班#<id>');
  assert.ok(wb.getWorksheet('进阶班'));

  // —— C1 sheet ——（表头行 3，数据从行 4；行序不依赖排序规则，按姓名定位）
  const c1 = wb.getWorksheet('启蒙A班')!;
  const rA = rowOf(c1, '甲');
  // 甲：2 月(col 3)=1，3 月(col 4)=1，全年合计(col 14)=2
  assert.equal(c1.getCell(rA, 3).value, 1);
  assert.equal(c1.getCell(rA, 4).value, 1);
  assert.equal(c1.getCell(rA, 14).value, 2);
  // 乙：全年合计 0 → 姓名格标红；2 月缺勤率 100% → 该月格标黄
  const rB = rowOf(c1, '乙');
  assert.equal(c1.getCell(rB, 14).value, 0);
  assert.equal((c1.getCell(rB, 1).fill as ExcelJS.FillPattern).fgColor?.argb, 'FFF8CBAD');
  assert.equal((c1.getCell(rB, 3).fill as ExcelJS.FillPattern).fgColor?.argb, 'FFFFF2CC');
  // 丙：已离班后缀
  assert.ok(rowOf(c1, '丙（已离班）') > 0, '丙 应带（已离班）后缀');
  assert.equal(rowOf(c1, '丙'), -1, '不应存在无后缀的「丙」');

  // —— 全校汇总：甲的全年合计 = 2(C1) + 1(C2) + 1(未关联) = 4，> 各班之和 3 ——
  const all = wb.worksheets[0]!;
  const allTotalA = Number(all.getCell(rowOf(all, '甲'), 14).value);
  const c2 = wb.getWorksheet(`启蒙A班#${C2}`)!;
  const classSumA =
    Number(c1.getCell(rA, 14).value) + Number(c2.getCell(rowOf(c2, '甲'), 14).value);
  assert.equal(classSumA, 3);
  assert.equal(allTotalA, 4);
  assert.ok(allTotalA > classSumA);
});

test('canExportAttendance：有数据的年份为真；空年份为假', () => {
  assert.equal(canExportAttendance(YEAR), true);
  assert.equal(canExportAttendance(1999), true); // 仍有在读学员 → 可导出（放宽口径）
});

test('exportAttendanceByClass：全无数据 → REPORT_EMPTY', async () => {
  // 清掉课节 / 考勤，并把学员都改成非在读 → canExport 的三个 EXISTS 全假
  db.exec('DELETE FROM attendance_records; DELETE FROM class_sessions');
  db.prepare(`UPDATE students SET status = '毕业'`).run();
  assert.equal(canExportAttendance(2100), false);
  const f = join(mkdtempSync(join(tmpdir(), 'ds-xlsx-')), 'empty.xlsx');
  await assert.rejects(() => exportAttendanceByClass(2100, f), /REPORT_EMPTY|没有可导出/);
});
