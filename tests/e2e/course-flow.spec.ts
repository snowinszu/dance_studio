import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import * as path from 'node:path';

/**
 * 课程管理模块端到端：首页进入 → 建老师 → 建班（容量 2）→ 花名册加 3 人（超容量提示）→
 * 周期规则 → 课程表周视图 → 上课时间计划表月视图（改时间 / 停课）→ 规则冲突提示 →
 * 考勤「选择课节」带出花名册并回填 session_id。
 *
 * 每个用例自起自关 Electron，独立临时数据库（STUDIO_DB_PATH），跑完即删。
 * 预置 3 名学员（各 6 节课时）。
 */

let app: ElectronApplication;
let page: Page;
let pageErrors: string[];
let dbDir: string;

// 取本月 15 号的星期，作为周期规则的 weekday —— 保证当月一定有若干个该 weekday
const PROBE = new Date(new Date().getFullYear(), new Date().getMonth(), 15).getDay();

test.beforeEach(async () => {
  pageErrors = [];
  dbDir = mkdtempSync(path.join('test-results', 'course-e2e-'));

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
    const mk = async (name: string, phone: string) => {
      const r = await window.studioShell.students.create({ name, phonePrimary: phone });
      const id = (r as { data: { id: number } }).data.id;
      await window.studioShell.students.update(id, {
        name,
        phonePrimary: phone,
        remainingLessons: 6,
      } as never);
    };
    await mk('课程甲', '13600000001');
    await mk('课程乙', '13600000002');
    await mk('课程丙', '13600000003');
  });
});

test.afterEach(async () => {
  await app.close();
  rmSync(dbDir, { recursive: true, force: true });
});

async function gotoCourse(): Promise<void> {
  await page.locator('.app-card', { hasText: '课程安排' }).click();
  await page.waitForURL(/course\.html/);
  await page.waitForLoadState('domcontentloaded');
}

test('课程管理全链路：班级 / 花名册 / 课程表 / 计划表 / 冲突提示 / 考勤联动', async () => {
  // —— 1. 首页 → course.html，默认 #/classes ——
  await gotoCourse();
  await expect(page).toHaveTitle(/课程管理/);
  await expect(page.locator('.page-title')).toHaveText('班级');

  // —— 2. #/teachers 建老师 ——
  await page.locator('.nav-tab', { hasText: '老师' }).click();
  await page.getByRole('button', { name: /新建老师/ }).click();
  await page.locator('.modal input').first().fill('张老师');
  await page.locator('.modal').getByRole('button', { name: '新建' }).click();
  await expect(page.locator('.entity-card .ec-name', { hasText: '张老师' })).toBeVisible();

  // —— 3. #/classes 建班（张老师，容量 2）——
  await page.locator('.nav-tab', { hasText: '班级' }).click();
  await page.getByRole('button', { name: /新建班级/ }).click();
  await page.locator('.modal .field', { hasText: '班级名' }).locator('input').fill('少儿中国舞B');
  await page.locator('.modal .field', { hasText: '舞种' }).locator('input').fill('中国舞');
  await page.locator('.modal .field', { hasText: '主教' }).locator('select').selectOption({ label: '张老师' });
  await page.locator('.modal .field', { hasText: '容量' }).locator('input').fill('2');
  await page.locator('.modal').getByRole('button', { name: '新建' }).click();
  const card = page.locator('.entity-card', { hasText: '少儿中国舞B' });
  await expect(card).toBeVisible();

  // —— 3b. 抽屉里加 2 名学员 ——
  await card.click();
  const addStudent = async (name: string) => {
    await page.locator('.drawer button', { hasText: '加入学员' }).click();
    await page.locator('.modal input[type="search"]').fill(name);
    await page.locator('.candidate', { hasText: name }).click();
    await page.waitForTimeout(200);
  };
  await addStudent('课程甲');
  await addStudent('课程乙');
  await expect(page.locator('.drawer .count-pill')).toHaveText('在册 2/2');

  // —— 4. 加第 3 人 → 超容量提示但仍加入 ——
  await addStudent('课程丙');
  await expect(page.locator('#toast')).toContainText('超容量');
  await expect(page.locator('.drawer .count-pill')).toHaveText('在册 3/2');
  await page.locator('.drawer button', { hasText: '关闭' }).click();

  // —— 5. 从班级抽屉的「课表安排」加周期规则（本月 15 号的星期 · 19:00-20:00）——
  await page.locator('.entity-card', { hasText: '少儿中国舞B' }).click();
  await page.locator('.drawer button', { hasText: '新增规则' }).click();
  await page.locator('.modal .field', { hasText: '星期' }).locator('select').selectOption(String(PROBE));
  await page.locator('.modal .field', { hasText: '开始' }).locator('input').fill('19:00');
  await page.locator('.modal .field', { hasText: '结束' }).locator('input').fill('20:00');
  await page.locator('.modal').getByRole('button', { name: '新增' }).click();
  await page.waitForTimeout(400);
  await expect(page.locator('.drawer', { hasText: '课表安排（1）' })).toBeVisible();
  await page.locator('.drawer button', { hasText: '关闭' }).click();

  // —— 5b. 课程表周视图出现该班色块，点开看 3 名在册学员 ——
  await page.locator('.nav-tab', { hasText: '课程表' }).click();
  await page.waitForTimeout(300);
  const slot = page.locator('.tt-grid .tt-slot', { hasText: '少儿中国舞B' });
  await expect(slot).toBeVisible();
  await slot.click();
  await expect(page.locator('.modal .roster-item')).toHaveCount(3);
  await page.locator('.modal-mask').click({ position: { x: 5, y: 5 } });

  // —— 6. 上课时间计划表：选张老师，本月 → 出现课节 ——
  await page.locator('.nav-tab', { hasText: '上课时间计划表' }).click();
  await page.waitForTimeout(300);
  await page.locator('.toolbar select').first().selectOption({ label: '张老师' });
  await page.waitForTimeout(500);
  const calItem = page.locator('.cal-grid .cal-item', { hasText: '少儿中国舞B' }).first();
  await expect(calItem).toBeVisible();

  // —— 7. 改时间 20:00-21:00 ——
  await calItem.click();
  await page.locator('.modal button', { hasText: '改时间' }).click();
  await page.locator('.modal .field', { hasText: '开始' }).locator('input').fill('20:00');
  await page.locator('.modal .field', { hasText: '结束' }).locator('input').fill('21:00');
  await page.locator('.modal button', { hasText: '保存' }).click();
  await page.waitForTimeout(500);
  await expect(page.locator('.cal-grid .cal-item', { hasText: '20:00' }).first()).toBeVisible();

  // —— 8. 规则冲突提示：另建一个班 + 张老师同 weekday 19:30-20:30 ——
  const conflicts = await page.evaluate(
    async ([wd]) => {
      const S = window.studioShell;
      const t = (await S.course.teacherList()).data.find((x: { name: string }) => x.name === '张老师') as { id: number };
      const c2 = (await S.course.classCreate({ name: '冲突班', danceType: '爵士', teacherId: t.id })).data.id;
      const r = await S.course.scheduleCreate({ classId: c2, weekday: wd, startTime: '19:30', endTime: '20:30' });
      return (r as { data: { conflicts: unknown[] } }).data.conflicts.length;
    },
    [PROBE] as const,
  );
  expect(conflicts, '张老师同 weekday 时段重叠应报冲突').toBeGreaterThan(0);
  // 冲突不阻断：规则已落库
  const c2count = await page.evaluate(async () => {
    const list = (await window.studioShell.course.classList({ keyword: '冲突班' })).data as { id: number }[];
    const sc = await window.studioShell.course.scheduleList(list[0].id);
    return (sc as { data: unknown[] }).data.length;
  });
  expect(c2count).toBe(1);

  // —— 9. 考勤「选择课节」→ 带出花名册 → 提交 → 回填 session_id ——
  await page.getByRole('link', { name: '返回首页' }).click();
  await page.waitForURL(/index\.html/);
  await page.locator('.app-card', { hasText: '考勤管理' }).click();
  await page.waitForURL(/attendance\.html/);
  await page.locator('.nav-tab', { hasText: '批量点名' }).click();
  await page.waitForTimeout(500);
  // 排课实例落在 PROBE 星期的日期上（不一定是今天）——把日期设成本月 15 号（正是 PROBE 星期）
  const now = new Date();
  const mid = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-15`;
  await page.locator('#r-date').fill(mid);
  await page.locator('#r-date').dispatchEvent('change');
  await page.waitForTimeout(500);
  await page.locator('#r-session').selectOption({ index: 1 });
  await page.waitForTimeout(500);
  await expect(page.locator('#r-class')).toHaveValue('少儿中国舞B');
  expect(await page.locator('#roster-list .roster-row').count()).toBe(3);
  await page.locator('.btn-primary', { hasText: '提交点名' }).click();
  await page.waitForTimeout(700);

  const linked = await page.evaluate(async () => {
    const r = await window.studioShell.attendance.list({ keyword: '课程' });
    const rows = (r as { data: { rows: { sessionId: number | null }[] } }).data.rows;
    return { total: rows.length, withSession: rows.filter((x) => x.sessionId != null).length };
  });
  expect(linked.total).toBe(3);
  expect(linked.withSession, '3 条考勤流水都应回填 session_id').toBe(3);

  // —— 10. 全程无页面错误 ——
  expect(pageErrors).toEqual([]);
});
