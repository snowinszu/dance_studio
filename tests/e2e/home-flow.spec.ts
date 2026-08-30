import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import * as path from 'node:path';

/**
 * 端到端：启动真实 Electron → 首页 → 点「学员档案」进入其列表页 → 点「返回首页」回首页，
 * 外加占位页边界，以及首页「今日概况」四张卡的真实数据 / 获焦刷新 / 空库不报错。
 *
 * 每个用例都自己启动 / 关闭应用（beforeEach / afterEach），用独立临时数据库
 * （STUDIO_DB_PATH），彼此独立、可重复。
 */

// 首页本期已移除的三个应用，正文里不应再出现
const REMOVED_APPS = ['收支记账', '通知公告', '教室预约'] as const;

let app: ElectronApplication;
let page: Page;
let pageErrors: string[];
let dbDir: string;

test.beforeEach(async () => {
  pageErrors = [];
  dbDir = mkdtempSync(path.join('test-results', 'home-e2e-'));

  // 某些环境（本机终端、CI 容器）会设 ELECTRON_RUN_AS_NODE=1，
  // 这会让 Electron 退化成纯 Node、不创建窗口 —— 启动前剔除该变量。
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
  }
  env.STUDIO_DB_PATH = path.join(dbDir, 'test.db');

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
  rmSync(dbDir, { recursive: true, force: true });
});

test('首页 → 学员档案列表页 → 返回首页 的完整流程', async () => {
  // —— 首页：恰好 5 张卡，且不含已移除的应用 ——
  await expect(page.locator('.app-card')).toHaveCount(5);
  await expect(page.locator('.apps-count')).toHaveText('5 个应用');

  const homeText = await page.locator('body').innerText();
  for (const name of REMOVED_APPS) {
    expect(homeText, `首页不应再出现「${name}」`).not.toContain(name);
  }

  // —— 点「学员档案」卡片，同一窗口导航到其列表页 ——
  await page.locator('.app-card', { hasText: '学员档案' }).click();
  await page.waitForURL(/students\.html(?:#.*)?$/);
  await page.waitForLoadState('domcontentloaded');

  await expect(page.locator('.page-title')).toHaveText('学员档案');
  await expect(page).toHaveTitle(/学员档案/);
  // 列表页骨架：新建入口 + 列表容器（可能是空态）
  await expect(page.getByRole('button', { name: /新建学员/ })).toBeVisible();
  await expect(page.locator('#list-body')).toBeVisible();

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

test('首页概况卡：空库为 0 → 播种后显示真实数据 → 获焦刷新在籍 +1', async () => {
  const num = (id: string) => page.locator(`[data-od-id="${id}"] .stat-num`);
  const sub = (id: string) => page.locator(`[data-od-id="${id}"] .stat-sub`);

  // —— 空库：四张卡为 0，第 4 卡标签已是「库存状态」 ——
  await expect(num('stat-students')).toHaveText('0');
  await expect(num('stat-inventory')).toHaveText('0');
  await expect(page.locator('[data-od-id="stat-inventory"] .stat-label')).toHaveText('库存状态');
  await expect(page.locator('[data-od-id="stat-revenue"]')).toHaveCount(0);
  expect(pageErrors, '空库首页不应报错').toEqual([]);

  // —— 播种：2 在读学员 / 1 当天带教室的正常课节 / 1 当天出勤 / 1 低库存物件 ——
  await page.evaluate(async () => {
    const s = window.studioShell;
    const u = (r: { ok: boolean; data?: unknown; error?: { code: string } }) => {
      if (!r.ok) throw new Error(r.error?.code);
      return r.data as { id: number };
    };
    const today = new Date().toISOString().slice(0, 10);
    const sa = u(await s.students.create({ name: 'HS甲', phonePrimary: '13900010001' })).id;
    u(await s.students.create({ name: 'HS乙', phonePrimary: '13900010002' }));
    const t = u(await s.course.teacherCreate({ name: 'HS老师' })).id;
    const c = u(
      await s.course.classCreate({ name: 'HS班', danceType: '中国舞', teacherId: t }),
    ).id;
    u(
      await s.course.sessionCreate({
        classId: c,
        sessionDate: today,
        startTime: '10:00',
        endTime: '11:00',
        room: 'R1',
      }),
    );
    u(await s.attendance.quickCheckIn({ studentId: sa, type: '出勤', attendDate: today, force: true }));
    u(await s.inventory.createItem({ name: 'HS袜子', unit: '双', quantity: 2, lowStockThreshold: 5 }));
  });

  // —— 获焦刷新：四张卡显示真实数据 ——
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(num('stat-students')).toHaveText('2');
  await expect(num('stat-attendance')).toHaveText('1');
  await expect(sub('stat-attendance')).toContainText('出勤率');
  await expect(num('stat-classes')).toHaveText('1');
  await expect(sub('stat-classes')).toHaveText('1 间教室使用中');
  await expect(num('stat-inventory')).toHaveText('2'); // 在库总件数
  await expect(sub('stat-inventory')).toContainText('偏低');

  // —— 再加一个在读学员 → 获焦 → 在籍 +1 ——
  await page.evaluate(async () => {
    await window.studioShell.students.create({ name: 'HS丙', phonePrimary: '13900010003' });
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(num('stat-students')).toHaveText('3');

  expect(pageErrors, '整个流程不应有页面错误').toEqual([]);
});
