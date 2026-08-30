import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import ExcelJS from 'exceljs';

/**
 * 数据报表模块的端到端测试：
 *   首页 → 数据报表卡片 → 概览 KPI 随时间范围跳变 → 出勤排名可切排序键 →
 *   导出 Excel（mock 保存框）→ exceljs 读回校验 sheet / 数值 / 标黄标红。
 * 外加一条空库边界：各区空态、导出命中 REPORT_EMPTY 且不写文件。
 *
 * 每个用例自己启动 / 关闭 Electron，用独立临时数据库，跑完即删。
 */

let app: ElectronApplication;
let page: Page;
let pageErrors: string[];
let dbDir: string;

test.beforeEach(async () => {
  pageErrors = [];
  dbDir = mkdtempSync(path.join('test-results', 'reports-e2e-'));

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
  }
  env.STUDIO_DB_PATH = path.join(dbDir, 'test.db');

  app = await electron.launch({ args: ['.', '--no-sandbox'], env });
  page = await app.firstWindow();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(msg.text());
  });
  await page.waitForLoadState('domcontentloaded');
});

test.afterEach(async () => {
  await app.close();
  rmSync(dbDir, { recursive: true, force: true });
});

async function gotoReports(): Promise<void> {
  await page.locator('.app-card', { hasText: '数据报表' }).click();
  await page.waitForURL(/reports\.html/);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.report-section');
}

// 预警中心暂时下线（reports.js SHOW_ALERTS=false）
const EXPECTED_SECTIONS = ['概览', '考勤指标', '课程指标', '学员指标', '库存指标'];

/** 播种一套跨月的完整数据；返回当前年份。 */
async function seed(): Promise<number> {
  return page.evaluate(async () => {
    const s = window.studioShell;
    const y = new Date().getFullYear();
    const now = new Date();
    const u = (r) => {
      if (!r || !r.ok) throw new Error(`${r && r.error && r.error.code}: ${r && r.error && r.error.message}`);
      return r.data;
    };

    const t1 = u(await s.course.teacherCreate({ name: '张老师' })).id;
    const c1 = u(await s.course.classCreate({ name: 'E2E甲班', danceType: '中国舞', teacherId: t1 })).id;
    u(await s.course.classCreate({ name: 'E2E乙班', danceType: '爵士舞' }));

    const zhun = u(await s.students.create({ name: 'E2E准', phonePrimary: '13900000001' })).id;
    const que = u(await s.students.create({ name: 'E2E缺', phonePrimary: '13900000002' })).id;
    const duo = u(await s.students.create({ name: 'E2E多', phonePrimary: '13900000003' })).id;

    u(await s.course.rosterAdd({ classId: c1, studentId: zhun }));
    u(await s.course.rosterAdd({ classId: c1, studentId: que }));
    u(await s.course.scheduleCreate({ classId: c1, weekday: now.getDay(), startTime: '10:00', endTime: '11:00' }));
    u(await s.course.generateMonth({ year: y, month: now.getMonth() + 1 }));
    const sess = u(await s.course.sessionsByMonth({ year: y, month: now.getMonth() + 1 }));
    const sessId = sess[0].id;

    // 关联课节：准 出勤 / 缺 缺勤，日期落在 2 月（本年内、非本月）
    u(
      await s.attendance.batchCheckIn({
        sessionId: sessId,
        attendDate: `${y}-02-15`,
        className: 'E2E甲班',
        force: true,
        entries: [
          { studentId: zhun, type: '出勤' },
          { studentId: que, type: '缺勤' },
        ],
      }),
    );
    // 未关联课节：准 补课(3月) + 请假(3月)
    u(await s.attendance.quickCheckIn({ studentId: zhun, type: '补课', attendDate: `${y}-03-10`, force: true }));
    u(await s.attendance.quickCheckIn({ studentId: zhun, type: '请假', attendDate: `${y}-03-11` }));
    // 多：出勤 ×5（1 月）+ 缺勤 ×7（1 月）→ 次数最多、出勤率中等
    for (let d = 1; d <= 5; d += 1) {
      u(await s.attendance.quickCheckIn({ studentId: duo, type: '出勤', attendDate: `${y}-01-0${d}`, force: true }));
    }
    for (let d = 10; d <= 16; d += 1) {
      u(await s.attendance.quickCheckIn({ studentId: duo, type: '缺勤', attendDate: `${y}-01-${d}` }));
    }

    const it = u(
      await s.inventory.createItem({ name: 'E2E把杆', unit: '根', quantity: 10, lowStockThreshold: 3 }),
    ).id;
    u(await s.inventory.allocate({ itemId: it, studentId: zhun, quantity: 2, claimedAt: `${y}-01-10` }));

    return y;
  });
}

/** 在一张 sheet 里按姓名列（A 列，数据从第 4 行起）定位行号。 */
function rowOf(ws: ExcelJS.Worksheet, name: string): number {
  for (let r = 4; r <= ws.rowCount; r += 1) {
    if (ws.getCell(r, 1).value === name) return r;
  }
  return -1;
}

test('happy path：卡片进入 → KPI 随范围跳变 → 排名切排序 → 导出 Excel 读回校验', async () => {
  const year = await seed();
  await gotoReports();

  const titles = await page.$$eval('.report-section > summary > span:first-child', (ns) =>
    ns.map((n) => n.textContent),
  );
  expect(titles).toEqual(EXPECTED_SECTIONS);

  // 概览：本月出勤人次 0 → 切「本年」变 7（准 出勤1+补课1 + 多 出勤5）
  const checkinKpi = page.locator('.kpi-card', { hasText: '本区间出勤人次' }).locator('.kpi-value');
  await expect(checkinKpi).toHaveText('0');
  await page.getByRole('button', { name: '本年' }).click();
  await expect(checkinKpi).toHaveText('7');

  // 出勤排名：默认按次数 → 首行「E2E多」；点「出勤率」表头 → 首行「E2E准」
  const firstRankCell = page
    .locator('.report-section', { hasText: '考勤指标' })
    .locator('table.data-table tbody tr')
    .first()
    .locator('td')
    .first();
  await expect(firstRankCell).toContainText('E2E多');
  await page
    .locator('.report-section', { hasText: '考勤指标' })
    .locator('table.data-table thead th', { hasText: '出勤率' })
    .click();
  await expect(firstRankCell).toContainText('E2E准');

  // 导出：mock 保存框 → 点导出 → 等 toast → exceljs 读回
  const outFile = path.join(dbDir, 'reports.xlsx');
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
  }, outFile);
  await page.locator('.report-actions button', { hasText: '导出出勤统计' }).click();
  await page.waitForFunction(() => /已导出/.test(document.getElementById('toast')?.textContent ?? ''));

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(outFile);
  expect(wb.worksheets[0]!.name).toBe('全校汇总');
  const c1 = wb.getWorksheet('E2E甲班');
  expect(c1).toBeTruthy();
  const all = wb.worksheets[0]!;

  // 全校汇总：准 全年合计 = 出勤(2月) + 补课(3月) = 2
  const rZhunAll = rowOf(all, 'E2E准');
  expect(Number(all.getCell(rZhunAll, 14).value)).toBe(2);

  // 甲班：准 2 月(col 3)=1；全年合计 = 1（补课未关联课节，不进班级 sheet）
  const rZhun = rowOf(c1!, 'E2E准');
  expect(Number(c1!.getCell(rZhun, 3).value)).toBe(1);
  expect(Number(c1!.getCell(rZhun, 14).value)).toBe(1);
  // 全校汇总合计 > 该学员各班之和
  expect(Number(all.getCell(rZhunAll, 14).value)).toBeGreaterThan(Number(c1!.getCell(rZhun, 14).value));

  // 甲班：缺 全年合计 0 → 姓名格标红；2 月缺勤率 100% → 该月格标黄
  const rQue = rowOf(c1!, 'E2E缺');
  expect(Number(c1!.getCell(rQue, 14).value)).toBe(0);
  expect((c1!.getCell(rQue, 1).fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFF8CBAD');
  expect((c1!.getCell(rQue, 3).fill as ExcelJS.FillPattern).fgColor?.argb).toBe('FFFFF2CC');

  expect(year).toBe(new Date().getFullYear());
  expect(pageErrors, '流程中不应有页面错误').toEqual([]);
});

test('边界：空库 → 各区空态、导出命中 REPORT_EMPTY 且不写文件', async () => {
  await gotoReports();

  const titles = await page.$$eval('.report-section > summary > span:first-child', (ns) =>
    ns.map((n) => n.textContent),
  );
  expect(titles).toEqual(EXPECTED_SECTIONS);

  await expect(
    page.locator('.kpi-card', { hasText: '在读学员' }).locator('.kpi-value'),
  ).toHaveText('0');
  await expect(page.locator('.sec-empty').first()).toBeVisible();

  const outFile = path.join(dbDir, 'should-not-exist.xlsx');
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
  }, outFile);
  await page.locator('.report-actions button', { hasText: '导出出勤统计' }).click();
  await page.waitForFunction(() =>
    /没有|无法导出/.test(document.getElementById('toast')?.textContent ?? ''),
  );
  expect(existsSync(outFile)).toBe(false);

  expect(pageErrors).toEqual([]);
});
