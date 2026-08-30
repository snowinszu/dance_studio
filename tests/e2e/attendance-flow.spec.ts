import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import ExcelJS from 'exceljs';

/**
 * 考勤管理模块端到端：从首页进入，走通
 *   快速打卡扣课时 → 批量点名缺勤不扣 → 撤销回补 → 余额不足确认框 → 导出两 sheet。
 *
 * 每个用例自起自关 Electron，用独立临时数据库（STUDIO_DB_PATH），跑完即删。
 * 预置两名学员：A（剩 2 节）、B（剩 0 节）。
 */

let app: ElectronApplication;
let page: Page;
let pageErrors: string[];
let dbDir: string;

test.beforeEach(async () => {
  pageErrors = [];
  dbDir = mkdtempSync(path.join('test-results', 'attendance-e2e-'));

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

  await page.evaluate(async () => {
    const mk = async (name: string, phone: string, rem: number) => {
      const r = await window.studioShell.students.create({ name, phonePrimary: phone });
      const id = (r as { data: { id: number } }).data.id;
      await window.studioShell.students.update(id, {
        name,
        phonePrimary: phone,
        danceTypes: ['芭蕾'],
        remainingLessons: rem,
      } as never);
    };
    await mk('甲学员', '13800000001', 2);
    await mk('乙学员', '13800000002', 0);
  });
});

test.afterEach(async () => {
  await app.close();
  rmSync(dbDir, { recursive: true, force: true });
});

async function gotoAttendance(): Promise<void> {
  await page.locator('.app-card', { hasText: '考勤管理' }).click();
  await page.waitForURL(/attendance\.html/);
  await page.waitForLoadState('domcontentloaded');
}

async function balanceOf(name: string): Promise<number | null> {
  return page.evaluate(async (n) => {
    const r = await window.studioShell.attendance.rosterCandidates({ keyword: n });
    const rows = (r as { data: { name: string; remainingLessons: number | null }[] }).data;
    return rows.find((x) => x.name === n)?.remainingLessons ?? null;
  }, name);
}

test('首页 → 快速打卡扣课时 → 批量缺勤不扣 → 撤销回补 → 余额不足确认框 → 导出两 sheet', async () => {
  await gotoAttendance();
  await expect(page.locator('.page-title')).toHaveText('考勤流水');
  await expect(page.locator('.result-count')).toHaveText('共 0 条');

  // 快速打卡：甲学员出勤 → 列表 +1，余额 2 → 1
  await page.locator('.nav-tab', { hasText: '快速打卡' }).click();
  await page.fill('#q-search', '甲学员');
  await page.locator('.candidate', { hasText: '甲学员' }).click();
  await page.fill('#q-class', '芭蕾基础');
  await page.getByRole('button', { name: '确认打卡' }).click();
  await expect(page.locator('#toast')).toContainText('甲学员 剩 1 节');
  await page.locator('.nav-tab', { hasText: '考勤流水' }).click();
  await expect(page.locator('table.records tbody tr')).toHaveCount(1);
  expect(await balanceOf('甲学员')).toBe(1);

  // 批量点名：甲学员缺勤 → 记录 +1，余额仍 1
  await page.locator('.nav-tab', { hasText: '批量点名' }).click();
  await page.fill('#r-class', '芭蕾提高');
  await page.selectOption('.toolbar-select', '芭蕾');
  const row = page.locator('#roster-list .roster-row', { hasText: '甲学员' });
  await row.locator('input[type=checkbox]').check();
  await row.getByRole('button', { name: '缺勤', exact: true }).click();
  await page.getByRole('button', { name: '提交点名' }).click();
  await expect(page.locator('.summary-box .sum-head')).toContainText('成功 1，跳过 0');
  expect(await balanceOf('甲学员')).toBe(1);
  await page.locator('.nav-tab', { hasText: '考勤流水' }).click();
  await expect(page.locator('table.records tbody tr')).toHaveCount(2);

  // 撤销那条出勤 → 甲学员余额回到 2
  await page
    .locator('table.records tbody tr', { hasText: '出勤' })
    .getByRole('button', { name: '撤销' })
    .click();
  await page.locator('.modal').getByRole('button', { name: '撤销' }).click();
  await expect(page.locator('#toast')).toContainText('已撤销');
  expect(await balanceOf('甲学员')).toBe(2);
  await expect(page.locator('table.records tbody tr')).toHaveCount(1);

  // 余额不足确认框：乙学员出勤 → 弹框 → 取消 → 无新记录、余额仍 0
  await page.locator('.nav-tab', { hasText: '快速打卡' }).click();
  await page.fill('#q-search', '乙学员');
  await page.locator('.candidate', { hasText: '乙学员' }).click();
  await page.getByRole('button', { name: '确认打卡' }).click();
  await expect(page.locator('.modal')).toContainText('剩余课时不足');
  await page.locator('.modal').getByRole('button', { name: '取消' }).click();
  await expect(page.locator('.modal')).toHaveCount(0);
  expect(await balanceOf('乙学员')).toBe(0);
  await page.locator('.nav-tab', { hasText: '考勤流水' }).click();
  await expect(page.locator('table.records tbody tr')).toHaveCount(1);

  // 导出：xlsx 含「考勤明细」「按月汇总」两个 sheet
  const outFile = path.join(dbDir, 'export.xlsx');
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
  }, outFile);
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('已导出');
  expect(existsSync(outFile)).toBe(true);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(outFile);
  expect(wb.worksheets.map((w) => w.name)).toEqual(['考勤明细', '按月汇总']);

  expect(pageErrors, '流程中不应有页面错误').toEqual([]);
});

test('直接打开 #/import 子页也能用：下载模板入口存在，返回流水可回到列表', async () => {
  await gotoAttendance();
  await page.evaluate(() => {
    window.location.hash = '#/import';
  });
  await expect(page.locator('.page-title')).toHaveText('导入历史考勤');
  await expect(page.getByRole('button', { name: '下载模板' })).toBeVisible();
  await page.getByRole('button', { name: '返回流水' }).click();
  await page.waitForFunction(() => location.hash === '#/records');
  await expect(page.locator('.page-title')).toHaveText('考勤流水');
  expect(pageErrors).toEqual([]);
});
