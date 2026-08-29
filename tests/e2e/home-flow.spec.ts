import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

/**
 * 端到端：启动真实 Electron → 首页 → 点卡片进占位页 → 点「返回首页」回首页，
 * 外加一条边界（占位页无 app 参数）。
 *
 * 每个用例都自己启动 / 关闭应用（beforeEach / afterEach），彼此独立、可重复。
 */

// 首页本期已移除的三个应用，正文里不应再出现
const REMOVED_APPS = ['收支记账', '通知公告', '教室预约'] as const;

let app: ElectronApplication;
let page: Page;
let pageErrors: string[];

test.beforeEach(async () => {
  pageErrors = [];

  // 某些环境（本机终端、CI 容器）会设 ELECTRON_RUN_AS_NODE=1，
  // 这会让 Electron 退化成纯 Node、不创建窗口 —— 启动前剔除该变量。
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
  }

  // args[0] = '.' 让 Electron 读取 package.json 的 "main"（dist/main.js）；
  // --no-sandbox 供 Linux CI 无特权容器使用，macOS 下无副作用。
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
});

test('首页 → 学员档案占位页 → 返回首页 的完整流程', async () => {
  // —— 首页：恰好 5 张卡，且不含已移除的应用 ——
  await expect(page.locator('.app-card')).toHaveCount(5);
  await expect(page.locator('.apps-count')).toHaveText('5 个应用');

  const homeText = await page.locator('body').innerText();
  for (const name of REMOVED_APPS) {
    expect(homeText, `首页不应再出现「${name}」`).not.toContain(name);
  }

  // —— 点「学员档案」卡片，同一窗口导航到占位页 ——
  await page.locator('.app-card', { hasText: '学员档案' }).click();
  await page.waitForURL(/placeholder\.html\?app=students$/);
  await page.waitForLoadState('domcontentloaded');

  await expect(page.locator('#ph-title')).toHaveText('学员档案');
  await expect(page.locator('#ph-standby')).toHaveText('敬请期待');
  await expect(page).toHaveTitle(/学员档案/);
  await expect(page).toHaveTitle(/敬请期待/);

  const placeholderText = await page.locator('body').innerText();
  expect(placeholderText).toContain('学员档案');
  expect(placeholderText).toContain('敬请期待');

  // —— 点「返回首页」回到首页 ——
  await page.getByRole('link', { name: '返回首页' }).click();
  await page.waitForURL(/index\.html$/);
  await page.waitForLoadState('domcontentloaded');

  await expect(page.locator('.app-card')).toHaveCount(5);
  await expect(page).toHaveTitle('晓·乐舞艺术空间 · 管理中心');

  expect(pageErrors, '整个流程不应有页面错误').toEqual([]);
});

test('占位页缺少 app 参数时回退为「敬请期待」且不报错', async () => {
  // 直接导航到无参数的 placeholder.html（相对当前 index.html 的 file:// 解析）
  await page.evaluate(() => {
    window.location.href = 'placeholder.html';
  });
  await page.waitForURL(/placeholder\.html$/);
  await page.waitForLoadState('domcontentloaded');

  await expect(page.locator('#ph-title')).toHaveText('敬请期待');
  await expect(page.locator('#ph-standby')).toBeHidden();
  await expect(page).toHaveTitle('敬请期待 · 晓·乐舞艺术空间');

  expect(pageErrors, '回退分支不应有页面错误').toEqual([]);
});

test('每次启动都是干净的首页（验证用例相互独立、可重复）', async () => {
  await expect(page).toHaveURL(/index\.html$/);
  await expect(page.locator('.app-card')).toHaveCount(5);
});
