import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import ExcelJS from 'exceljs';

/**
 * 库存管理模块的端到端测试：从首页进入，走通
 *   新建物件 → 分配给学员 → 库存扣减 → 领用流水出现，
 * 再覆盖三条边界（库存不足 / 低库存汇总跳变 / 删记录回补库存）和一次导出读回。
 *
 * 每个用例自己启动 / 关闭 Electron，用独立临时数据库（STUDIO_DB_PATH），跑完即删。
 */

let app: ElectronApplication;
let page: Page;
let pageErrors: string[];
let dbDir: string;

test.beforeEach(async () => {
  pageErrors = [];
  dbDir = mkdtempSync(path.join('test-results', 'inventory-e2e-'));

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

  // 分配表单需要至少一个学员
  await page.evaluate(() =>
    window.studioShell.students.create({ name: '林同学', phonePrimary: '13800001234' }),
  );
});

test.afterEach(async () => {
  await app.close();
  rmSync(dbDir, { recursive: true, force: true });
});

async function gotoInventory(): Promise<void> {
  await page.locator('.app-card', { hasText: '库存管理' }).click();
  await page.waitForURL(/inventory\.html/);
  await page.waitForLoadState('domcontentloaded');
}

/** 新建一个物件；停在其详情页。 */
async function createItem(name: string, quantity: number, threshold: number): Promise<void> {
  await page.getByRole('button', { name: /新建物件/ }).click();
  await page.waitForFunction(() => location.hash === '#/items/new');
  await page.fill('#f-name', name);
  await page.fill('#f-quantity', String(quantity));
  await page.fill('#f-lowStockThreshold', String(threshold));
  await page.getByRole('button', { name: '保存' }).click();
  await page.waitForFunction(() => /^#\/items\/\d+$/.test(location.hash));
}

/** 在物件详情页点「分配」，填数量并提交。返回是否提交成功（false = 停在表单，有校验错误）。 */
async function allocate(quantity: number): Promise<void> {
  await page.getByRole('button', { name: '分配', exact: true }).click();
  await page.waitForFunction(() => location.hash.startsWith('#/allocate'));
  await page.fill('#f-studentId', '林');
  await page.locator('.candidate', { hasText: '林同学' }).click();
  await page.fill('#f-quantity', String(quantity));
  await page.getByRole('button', { name: '确认分配' }).click();
}

test('happy path：新建 → 分配 → 库存扣减 → 流水出现；库存不足被拒；低库存汇总跳变', async () => {
  await gotoInventory();
  await expect(page.locator('.empty')).toContainText('还没有物件');

  await createItem('演出服', 10, 3);
  await expect(page.locator('.page-sub').first()).toHaveText('当前库存 10 件');

  // 列表出现，库存 10
  await page.getByRole('button', { name: '返回列表' }).click();
  await page.waitForFunction(() => location.hash === '#/items');
  const row = page.locator('#items-body .student-row', { hasText: '演出服' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('剩 10 件');

  // 分配 3
  await row.click();
  await page.waitForFunction(() => /^#\/items\/\d+$/.test(location.hash));
  await allocate(3);
  await page.waitForFunction(() => /^#\/items\/\d+$/.test(location.hash));
  await expect(page.locator('.page-sub').first()).toHaveText('当前库存 7 件');

  // 领用流水出现该记录
  await page.getByRole('button', { name: '返回列表' }).click();
  await page.getByRole('button', { name: '领用流水' }).click();
  await page.waitForFunction(() => location.hash === '#/allocations');
  const flowRow = page.locator('#alloc-body .student-row', { hasText: '演出服' });
  await expect(flowRow).toHaveCount(1);
  await expect(flowRow).toContainText('林同学');
  await expect(flowRow).toContainText('领 3');

  // 边界 1：再分配 100 → 库存不足红字，库存仍 7
  await page.getByRole('button', { name: '返回列表' }).click();
  await page.locator('#items-body .student-row', { hasText: '演出服' }).click();
  await page.waitForFunction(() => /^#\/items\/\d+$/.test(location.hash));
  await allocate(100);
  await expect(page.locator('.field[data-key="quantity"] .field-error')).toContainText('库存不足');
  await page.getByRole('button', { name: '取消' }).click();
  await page.locator('#items-body .student-row', { hasText: '演出服' }).click();
  await expect(page.locator('.page-sub').first()).toHaveText('当前库存 7 件');

  // 边界 2：再分配 5 → 库存 2 ≤ 阈值 3 → 顶部汇总 + 行标记
  await allocate(5);
  await page.waitForFunction(() => /^#\/items\/\d+$/.test(location.hash));
  await expect(page.locator('.page-sub').first()).toHaveText('当前库存 2 件');
  await page.getByRole('button', { name: '返回列表' }).click();
  await page.waitForFunction(() => location.hash === '#/items');
  await expect(page.locator('#items-banner')).toContainText('1 个物件库存偏低');
  await expect(page.locator('#items-body .student-row', { hasText: '演出服' })).toContainText('库存偏低');

  expect(pageErrors, '流程中不应有页面错误').toEqual([]);
});

test('分配物件：按关键字搜索学员——缩小候选、无匹配提示、可更换已选', async () => {
  await page.evaluate(() =>
    window.studioShell.students.create({ name: '林小妹', phonePrimary: '13900009999' }),
  );
  await gotoInventory();
  await createItem('头饰', 10, 2);

  await page.getByRole('button', { name: '分配', exact: true }).click();
  await page.waitForFunction(() => location.hash.startsWith('#/allocate'));

  // 搜「林」→ 两个候选（林同学 / 林小妹）
  await page.fill('#f-studentId', '林');
  await expect(page.locator('.candidate')).toHaveCount(2);

  // 关键字缩小到「同学」→ 只剩「林同学」
  await page.fill('#f-studentId', '同学');
  await expect(page.locator('.candidate')).toHaveCount(1);
  await expect(page.locator('.candidate')).toContainText('林同学');

  // 搜一个不存在的名字 → 「没有匹配的学员」
  await page.fill('#f-studentId', '不存在的名字xyz');
  await expect(page.locator('.field-hint', { hasText: '没有匹配的学员' })).toBeVisible();

  // 重新搜「林小妹」并选中 → 收起成「已选」摘要
  await page.fill('#f-studentId', '林小妹');
  await page.locator('.candidate', { hasText: '林小妹' }).click();
  await expect(page.locator('.candidate.picked')).toContainText('林小妹');

  // 「更换」退回搜索框
  await page.getByRole('button', { name: '更换' }).click();
  await expect(page.locator('#f-studentId')).toBeVisible();

  // 重新选中「林小妹」并提交，库存正确扣减 → 说明隐藏 studentId 真的传对了
  await page.fill('#f-studentId', '林小妹');
  await page.locator('.candidate', { hasText: '林小妹' }).click();
  await page.fill('#f-quantity', '2');
  await page.getByRole('button', { name: '确认分配' }).click();
  await page.waitForFunction(() => /^#\/items\/\d+$/.test(location.hash));
  await expect(page.locator('.page-sub').first()).toHaveText('当前库存 8 件');

  expect(pageErrors).toEqual([]);
});

test('删除领用记录 → 库存回补', async () => {
  await gotoInventory();
  await createItem('道具伞', 20, 2);
  await allocate(3);
  await allocate(5);
  await page.waitForFunction(() => /^#\/items\/\d+$/.test(location.hash));
  await expect(page.locator('.page-sub').first()).toHaveText('当前库存 12 件');

  await page.getByRole('button', { name: '返回列表' }).click();
  await page.getByRole('button', { name: '领用流水' }).click();
  await page.waitForFunction(() => location.hash === '#/allocations');
  await expect(page.locator('#alloc-body .student-row')).toHaveCount(2);

  // 删除「领 3」那条
  page.once('dialog', (d) => void d.accept());
  await page
    .locator('#alloc-body .student-row', { hasText: '领 3' })
    .getByRole('button', { name: '删除' })
    .click();
  await expect(page.locator('#alloc-body .student-row')).toHaveCount(1);

  // 库存回补：12 + 3 = 15
  await page.getByRole('button', { name: '返回列表' }).click();
  await page.locator('#items-body .student-row', { hasText: '道具伞' }).click();
  await expect(page.locator('.page-sub').first()).toHaveText('当前库存 15 件');

  expect(pageErrors).toEqual([]);
});

test('导出领用流水：xlsx 含「物件名」「领取日期」列且行数正确', async () => {
  await gotoInventory();
  await createItem('练功鞋', 30, 5);
  await allocate(2);
  await allocate(4);
  await page.waitForFunction(() => /^#\/items\/\d+$/.test(location.hash));

  await page.getByRole('button', { name: '返回列表' }).click();
  await page.getByRole('button', { name: '领用流水' }).click();
  await page.waitForFunction(() => location.hash === '#/allocations');

  const outFile = path.join(dbDir, 'flow.xlsx');
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
  }, outFile);
  await page.getByRole('button', { name: '导出流水' }).click();
  await page.waitForFunction(() =>
    /已导出/.test(document.getElementById('toast')?.textContent ?? ''),
  );

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(outFile);
  const ws = wb.worksheets[0]!;
  const header = (ws.getRow(1).values as unknown[]).slice(1).map(String);
  expect(header).toContain('物件名');
  expect(header).toContain('领取日期');
  expect(ws.actualRowCount).toBe(3); // 表头 + 2 条记录

  expect(pageErrors).toEqual([]);
});
