import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import * as path from 'node:path';

/**
 * 设置页「预警阈值」端到端测试：
 *   默认值 3 → 改成 5 并保存 → 刷新后仍是 5 → 报表页课时余额预警 KPI 卡随之变化 →
 *   非法输入（负数）就地报错，不落库。
 */

let app: ElectronApplication;
let page: Page;
let dbDir: string;

test.beforeEach(async () => {
  dbDir = mkdtempSync(path.join('test-results', 'settings-threshold-e2e-'));

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
  }
  env.STUDIO_DB_PATH = path.join(dbDir, 'test.db');

  app = await electron.launch({ args: ['.', '--no-sandbox'], env });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterEach(async () => {
  await app.close();
  rmSync(dbDir, { recursive: true, force: true });
});

async function gotoSettings(): Promise<void> {
  await page.locator('.settings-link').click();
  await page.waitForURL(/settings\.html/);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('#low-balance-threshold');
}

test('默认阈值 3；改成 5 保存后刷新仍是 5，且报表页 KPI 随之变化', async () => {
  await gotoSettings();
  const input = page.locator('#low-balance-threshold');
  await expect(input).toHaveValue('3');

  await input.fill('5');
  await page.locator('#btn-save-threshold').click();
  await expect(page.locator('#toast')).toHaveText('预警阈值已保存');

  await page.reload();
  await page.waitForSelector('#low-balance-threshold');
  await expect(page.locator('#low-balance-threshold')).toHaveValue('5');

  // 种一个剩余课时 4 的学员：阈值 3 时不命中，阈值 5 时命中
  await page.evaluate(async () => {
    const s = window.studioShell;
    const r = await s.students.create({
      name: 'E2E阈值学员',
      phonePrimary: '13911112222',
      remainingLessons: 4,
    });
    if (!r.ok) throw new Error(r.error.message);
  });

  await page.locator('.nav-back').click();
  await page.waitForURL(/index\.html|\/$/);
  await page.locator('.app-card', { hasText: '数据报表' }).click();
  await page.waitForURL(/reports\.html/);
  await page.waitForSelector('.kpi-card');

  const card = page.locator('.kpi-card', { hasText: '课时余额预警' });
  await expect(card).toContainText('≤ 5');
  await expect(card.locator('.kpi-value')).toHaveText('1');
});

test('负数阈值：就地报错，不保存', async () => {
  await gotoSettings();
  const input = page.locator('#low-balance-threshold');

  await input.fill('-1');
  await page.locator('#btn-save-threshold').click();

  await expect(page.locator('#threshold-error')).toHaveText('请填写不小于 0 的整数');
  await expect(page.locator('#threshold-field')).toHaveClass(/has-error/);

  await page.reload();
  await page.waitForSelector('#low-balance-threshold');
  await expect(page.locator('#low-balance-threshold')).toHaveValue('3');
});
