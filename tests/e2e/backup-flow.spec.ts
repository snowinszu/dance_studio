import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { chmodSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';

// 在非 Electron 的 Node 里 require('electron') 返回可执行文件路径字符串（同 scripts/test-unit.js）。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const electronBinary: string = require('electron');

/**
 * 用 Electron 的 Node 运行时（ELECTRON_RUN_AS_NODE）打开一个 SQLite 文件，
 * 返回 quick_check 结果和表清单。放 Playwright 测试进程里直接 require('better-sqlite3')
 * 会 ABI 不匹配，所以借 electron 二进制来跑。
 */
function inspectDb(file: string): { qc: string; tables: string[] } {
  const script =
    "const D=require('better-sqlite3');" +
    "const db=new D(process.argv[1],{readonly:true});" +
    "const qc=db.pragma('quick_check',{simple:true});" +
    "const t=db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name\").all().map(r=>r.name);" +
    'db.close();' +
    "process.stdout.write(JSON.stringify({qc:String(qc),tables:t}));";
  const out = execFileSync(electronBinary, ['-e', script, file], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
  });
  return JSON.parse(out) as { qc: string; tables: string[] };
}

/**
 * 数据库快照备份模块的端到端测试：
 *   启动即自动留快照 → 首页「设置与备份」入口 → 设置页看到备份列表 →
 *   「立即备份」列表 +1 → 校验任一快照文件可独立打开且结构与主库一致 →
 *   备份目录不可写时「立即备份」报错但页面不崩、按钮恢复。
 *
 * 每个用例自起 / 自关 Electron，用独立临时目录当 userData（备份目录即落在其下的
 * backups/），跑完即删——绝不碰用户真实的备份目录。
 */

let app: ElectronApplication;
let page: Page;
let pageErrors: string[];
let workDir: string;
let backupsDir: string;
let launchArgs: string[];
let launchEnv: Record<string, string>;

/** 起一个应用实例并挂好 page / pageErrors。用同一份 args/env，供恢复用例重启后再起。 */
async function launchApp(): Promise<void> {
  app = await electron.launch({ args: launchArgs, env: launchEnv });
  page = await app.firstWindow();
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(msg.text());
  });
  await page.waitForLoadState('domcontentloaded');
}

test.beforeEach(async () => {
  pageErrors = [];
  workDir = mkdtempSync(path.join('test-results', 'backup-e2e-'));
  const userDataDir = path.join(workDir, 'udata');
  backupsDir = path.join(userDataDir, 'backups');

  launchEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') launchEnv[key] = value;
  }
  launchEnv.STUDIO_DB_PATH = path.join(workDir, 'test.db');
  launchArgs = ['.', `--user-data-dir=${userDataDir}`, '--no-sandbox'];

  await launchApp();
});

test.afterEach(async () => {
  await app.close();
  // 失败用例会把 backups 目录设成只读，先恢复权限再删，否则 rmSync 删不掉
  try {
    chmodSync(backupsDir, 0o700);
  } catch {
    /* 目录可能不存在，忽略 */
  }
  rmSync(workDir, { recursive: true, force: true });
});

/** 备份目录里的快照文件名（只认本模块命名）。 */
function snapshotFiles(): string[] {
  try {
    return readdirSync(backupsDir).filter((f) => /^dance-studio-\d{8}-\d{6}.*\.db$/.test(f));
  } catch {
    return [];
  }
}

async function gotoSettings(): Promise<void> {
  await page.locator('[data-od-id="nav-settings"]').click();
  await page.waitForURL(/settings\.html/);
  await page.waitForSelector('#backup-card-title');
}

test('happy path：启动自动备份 → 设置页列表 → 立即备份 +1 → 快照文件完整且结构一致', async () => {
  // 启动即生成「迁移前里程碑」+「每日」两份，且都通过完整性校验
  await expect
    .poll(() => snapshotFiles().length, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(1);
  const bootFiles = snapshotFiles();

  await gotoSettings();

  // 列表至少一行，且类型徽章看得见
  const rows = page.locator('.data-table tbody tr');
  await expect(rows.first()).toBeVisible();
  const bootRowCount = await rows.count();
  expect(bootRowCount).toBeGreaterThanOrEqual(1);
  await expect(page.locator('.badge').first()).toBeVisible();

  // 立即备份 → 行数 +1、成功 toast 带路径、磁盘多一个文件
  await page.waitForTimeout(1100); // 文件名到秒；错开与启动快照同秒
  await page.locator('#btn-backup-now').click();
  await expect(rows).toHaveCount(bootRowCount + 1, { timeout: 10_000 });
  await expect(page.locator('#toast')).toContainText('已备份到');
  expect(snapshotFiles().length).toBe(bootFiles.length + 1);

  // 任取一份快照：独立打开，断言 quick_check 通过、且表清单是完整的 v6 结构
  // （主库正被运行中的应用以 WAL 占用，不宜再开第二个连接去比，这里对齐固定的表清单）
  const EXPECTED_TABLES = [
    'attendance_records',
    'class_schedules',
    'class_sessions',
    'class_students',
    'classes',
    'field_definitions',
    'inventory_items',
    'item_allocations',
    'student_tags',
    'students',
    'tags',
    'teachers',
  ];
  // 取一份「日常」快照（迁移之后生成，带完整数据结构）
  const daily = snapshotFiles().filter((f) => !f.includes('-premigrate-v'));
  expect(daily.length).toBeGreaterThanOrEqual(1);
  const snap = inspectDb(path.join(backupsDir, daily[0]!));
  expect(snap.qc).toBe('ok');
  expect(snap.tables).toEqual(EXPECTED_TABLES);

  expect(pageErrors, '流程中不应有页面错误').toEqual([]);
});

test('边界：备份目录不可写 → 立即备份报错，页面不崩、按钮恢复可用', async () => {
  // 先等启动快照落地，再把目录设为只读
  await expect.poll(() => snapshotFiles().length, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  chmodSync(backupsDir, 0o500); // owner r-x，不能在里面创建文件

  await gotoSettings();
  const rows = page.locator('.data-table tbody tr');
  const bootRowCount = await rows.count();

  await page.locator('#btn-backup-now').click();

  // 出错提示（toast 文案含「失败」），且列表没有新增
  await expect(page.locator('#toast')).toContainText('失败', { timeout: 10_000 });
  await expect(rows).toHaveCount(bootRowCount);
  // 按钮回到可用
  await expect(page.locator('#btn-backup-now')).toBeEnabled();
  await expect(page.locator('#btn-backup-now')).toHaveText('立即备份');

  expect(pageErrors, '备份失败不应产生未捕获的页面错误').toEqual([]);
});

test('恢复：从备份列表恢复 → 应用自动重启 → 数据回到那份备份的状态', async () => {
  const addStudent = (phone: string): Promise<unknown> =>
    page.evaluate(
      (p) =>
        window.studioShell.students.create({ name: `恢复测试${p.slice(-3)}`, phonePrimary: p }),
      phone,
    );
  const studentTotal = (): Promise<number> =>
    page.evaluate(async () => {
      const r = await window.studioShell.students.list();
      return r.ok ? r.data.total : -1;
    });

  // 播种 2 名学员 → 备份（快照里是 2 人）
  await addStudent('13800138001');
  await addStudent('13800138002');
  expect(await studentTotal()).toBe(2);

  await gotoSettings();
  await page.waitForTimeout(1100); // 文件名到秒，错开与启动快照同秒
  await page.locator('#btn-backup-now').click();
  await expect(page.locator('#toast')).toContainText('已备份到');
  const rows = page.locator('.data-table tbody tr');
  await expect(rows.first()).toBeVisible();

  // 再加 1 名 → 现在 3 人（这一步之后的改动，恢复时应被丢弃）
  await addStudent('13800138003');
  expect(await studentTotal()).toBe(3);

  // stub 原生二次确认框（点「恢复并重启」）+ relaunch（免得真的 spawn 新进程）
  await app.evaluate(({ dialog, app: elApp }) => {
    // @ts-expect-error 测试替身，签名简化
    dialog.showMessageBox = async () => ({ response: 1 });
    elApp.relaunch = () => undefined;
  });

  // 点最新一行（刚才的手动备份）的「恢复」→ startRestore 会 app.exit(0)
  await rows.first().locator('.row-btn').click();
  await app.waitForEvent('close').catch(() => undefined);
  await app.close().catch(() => undefined);

  // 重新起一个（同 userData / env）→ 启动最早期 maybeApplyPendingRestore 换库
  await launchApp();

  // 数据回到备份那一刻的 2 人
  await expect.poll(() => studentTotal(), { timeout: 10_000 }).toBe(2);

  // 备份目录 / 列表里出现一份「恢复前」留底快照
  expect(snapshotFiles().some((f) => f.includes('-pre-restore'))).toBe(true);
  await gotoSettings();
  await expect(page.locator('.badge-prerestore').first()).toHaveText('恢复前');

  expect(pageErrors, '恢复往返不应有未捕获页面错误').toEqual([]);
});
