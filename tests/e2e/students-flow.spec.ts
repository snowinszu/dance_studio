import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import ExcelJS from 'exceljs';

/**
 * 学员档案模块的端到端测试：从首页进入，走通「新建 → 列表 → 详情 → 编辑」，
 * 自定义字段的「新增 → 录入 → 归档 → 导出仍含历史值」链路，一条校验失败路径，
 * 以及状态 + 标签组合筛选。
 *
 * 每个用例自己启动 / 关闭 Electron，并用独立的临时数据库文件（STUDIO_DB_PATH），
 * 跑完即删，彼此隔离、可重复，绝不碰用户真实数据。
 */

let app: ElectronApplication;
let page: Page;
let pageErrors: string[];
let dbDir: string;

test.beforeEach(async () => {
  pageErrors = [];
  // test-results/ 已在 .gitignore 内；mkdtemp 保证唯一
  dbDir = mkdtempSync(path.join('test-results', 'students-e2e-'));

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

/** 首页 → 学员档案列表页。 */
async function gotoStudents(): Promise<void> {
  await page.locator('.app-card', { hasText: '学员档案' }).click();
  await page.waitForURL(/students\.html/);
  await page.waitForLoadState('domcontentloaded');
}

test('happy path：新建 → 列表 → 详情(年龄) → 编辑 → 详情反映', async () => {
  await gotoStudents();
  await expect(page.locator('.empty')).toContainText('还没有学员');

  await page.getByRole('button', { name: /新建学员/ }).click();
  await page.waitForFunction(() => location.hash === '#/new');

  await page.fill('#f_name', '陈小花');
  await page.fill('#f_phone_primary', '13800138000');
  await page.fill('#f_birth_date', '2016-06-01');
  await page.locator('.field[data-key="dance_types"] input[value="中国舞"]').check();
  await page.locator('.field[data-key="dance_types"] input[value="芭蕾"]').check();
  await page.getByRole('button', { name: '保存' }).click();

  await page.waitForFunction(() => /^#\/s\/\d+$/.test(location.hash));
  await expect(page.locator('.page-title')).toHaveText('陈小花');
  const birthRow = page.locator('.dl-row', { has: page.locator('dt', { hasText: '出生日期' }) });
  await expect(birthRow.locator('dd')).toContainText('2016-06-01');
  await expect(birthRow.locator('dd')).toContainText('年龄');

  // 列表里出现
  await page.locator('.nav-brand').click();
  await gotoStudents();
  await expect(page.locator('.student-row', { hasText: '陈小花' })).toHaveCount(1);

  // 编辑剩余课时
  await page.locator('.student-row', { hasText: '陈小花' }).click();
  await page.waitForFunction(() => /^#\/s\/\d+$/.test(location.hash));
  await page.getByRole('button', { name: '编辑' }).click();
  await page.waitForSelector('#f_remaining_lessons');
  await page.fill('#f_remaining_lessons', '24');
  await page.getByRole('button', { name: '保存' }).click();

  await page.waitForFunction(() => /^#\/s\/\d+$/.test(location.hash));
  const lessonRow = page.locator('.dl-row', { has: page.locator('dt', { hasText: '剩余课时' }) });
  await expect(lessonRow.locator('dd')).toHaveText('24');

  expect(pageErrors, '流程中不应有页面错误').toEqual([]);
});

test('自定义字段：新增 → 录入 → 归档后表单/详情消失 → 导出仍含历史值与「(已归档)」表头', async () => {
  await gotoStudents();

  // 新增一个 select 自定义字段「校区」到「运营」
  await page.getByRole('button', { name: '字段管理' }).click();
  await page.waitForSelector('#fa-label');
  await page.fill('#fa-label', '校区');
  await page.selectOption('#fa-type', 'select');
  await page.selectOption('#fa-group', 'ops');
  await page.fill('#fa-options', '东城\n西城');
  await page.getByRole('button', { name: '添加字段' }).click();
  await page.waitForSelector('.fa-item');

  // 新建学员并选「西城」
  await page.evaluate(() => (location.hash = '#/new'));
  await page.waitForSelector('#f_name');
  const campusWrap = page.locator('.field', { has: page.locator('label', { hasText: '校区' }) });
  await expect(campusWrap).toHaveCount(1);
  await page.fill('#f_name', '林一');
  await page.fill('#f_phone_primary', '13900139000');
  await campusWrap.locator('select').selectOption('西城');
  await page.getByRole('button', { name: '保存' }).click();
  await page.waitForFunction(() => /^#\/s\/\d+$/.test(location.hash));
  await expect(
    page.locator('.dl-row', { has: page.locator('dt', { hasText: '校区' }) }).locator('dd'),
  ).toHaveText('西城');

  // 归档「校区」
  await page.evaluate(() => (location.hash = '#/fields'));
  await page.waitForSelector('.fa-item');
  page.once('dialog', (d) => void d.accept());
  await page.locator('.fa-item', { hasText: '校区' }).getByRole('button', { name: '归档' }).click();
  await page.waitForSelector('.fa-archived');

  // 表单 / 详情不再出现
  await page.evaluate(() => (location.hash = '#/new'));
  await page.waitForSelector('#f_name');
  await expect(page.locator('.field', { has: page.locator('label', { hasText: '校区' }) })).toHaveCount(0);

  // 导出（stub 保存框），读回断言
  const outFile = path.join(dbDir, 'export.xlsx');
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
  }, outFile);
  await page.evaluate(() => (location.hash = '#/list'));
  await page.waitForSelector('.student-row');
  await page.getByRole('button', { name: '导出' }).click();
  await page.waitForFunction(() => /已导出/.test(document.getElementById('toast')?.textContent ?? ''));

  expect(existsSync(outFile)).toBe(true);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(outFile);
  const ws = wb.getWorksheet('学员档案')!;
  const headers = (ws.getRow(1).values as unknown[]).slice(1).map(String);
  expect(headers).toContain('校区(已归档)');
  const col = headers.indexOf('校区(已归档)') + 1;
  expect(String(ws.getRow(2).getCell(col).value ?? '')).toBe('西城');

  expect(pageErrors).toEqual([]);
});

test('校验失败路径：空姓名 + 非法手机号 → 字段级报错且未写库', async () => {
  await gotoStudents();
  await page.getByRole('button', { name: /新建学员/ }).click();
  await page.waitForFunction(() => location.hash === '#/new');

  await page.fill('#f_phone_primary', '123');
  await page.getByRole('button', { name: '保存' }).click();

  await expect(page.locator('.field[data-key="name"].has-error')).toHaveCount(1);
  await expect(page.locator('.field[data-key="phone_primary"].has-error')).toHaveCount(1);
  await expect(page.locator('.field[data-key="phone_primary"] .field-error')).toContainText('手机号');

  // 未写库
  const total = await page.evaluate(async () => {
    const r = await window.studioShell.students.list({});
    return r.ok ? r.data.total : -1;
  });
  expect(total).toBe(0);
  expect(pageErrors).toEqual([]);
});

test('筛选：状态 + 标签组合，无结果显示空态文案', async () => {
  await gotoStudents();

  // 造数据：甲(在读, 标签A)、乙(请假, 标签B)
  await page.evaluate(async () => {
    const a = await window.studioShell.tags.create({ name: 'A' });
    const b = await window.studioShell.tags.create({ name: 'B' });
    const s1 = await window.studioShell.students.create({ name: '甲', phonePrimary: '13800000001', status: '在读', customFields: {} });
    const s2 = await window.studioShell.students.create({ name: '乙', phonePrimary: '13800000002', status: '请假', customFields: {} });
    await window.studioShell.tags.setForStudent(s1.data.id, [a.data.id]);
    await window.studioShell.tags.setForStudent(s2.data.id, [b.data.id]);
  });
  await page.evaluate(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
  await page.waitForSelector('.student-row');
  await expect(page.locator('.student-row')).toHaveCount(2);

  // 状态「在读」+ 标签「A」→ 只剩甲
  await page.locator('.status-filter .chip-toggle', { hasText: '在读' }).first().click();
  await page.locator('.toolbar-tags .chip-toggle', { hasText: 'A' }).click();
  await expect(page.locator('.student-row')).toHaveCount(1);
  await expect(page.locator('.student-row')).toHaveText(/甲/);

  // 再叠加标签「B」（甲没有 B，且状态仍限「在读」）→ 空
  // 先取消标签 A，选 B
  await page.locator('.toolbar-tags .chip-toggle', { hasText: 'A' }).click();
  await page.locator('.toolbar-tags .chip-toggle', { hasText: 'B' }).click();
  await expect(page.locator('.empty')).toContainText('没有符合筛选的学员');

  expect(pageErrors).toEqual([]);
});
