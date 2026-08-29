// 冒烟：用 Playwright 的 Electron 驱动启动「打包后的应用可执行文件」，
// 断言主窗口标题正确，然后关闭。
//
// 用法：node scripts/smoke-packaged.mjs <electronExecutablePath>
//   传入的应是真正的 Electron 二进制（如 NSIS 安装后的
//   %LOCALAPPDATA%\Programs\晓·乐舞艺术空间\晓·乐舞艺术空间.exe）。
import { _electron as electron } from '@playwright/test';

const exe = process.argv[2];
if (!exe) {
  console.error('用法：node scripts/smoke-packaged.mjs <electronExecutablePath>');
  process.exit(2);
}

const EXPECTED_TITLE = '晓·乐舞艺术空间 · 管理中心';

// 某些环境会设 ELECTRON_RUN_AS_NODE=1，会让 Electron 退化成纯 Node、不建窗口
const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
}

const app = await electron.launch({ executablePath: exe, env });
try {
  const page = await app.firstWindow({ timeout: 30_000 });
  await page.waitForLoadState('domcontentloaded');
  const title = await page.title();
  const cards = await page.locator('.app-card').count();
  if (title !== EXPECTED_TITLE) {
    console.error(`::error::窗口标题不符：期望「${EXPECTED_TITLE}」，实际「${title}」`);
    process.exitCode = 1;
  } else if (cards !== 5) {
    console.error(`::error::首页应用卡片数不符：期望 5，实际 ${cards}`);
    process.exitCode = 1;
  } else {
    console.log(`✓ 打包应用启动正常：标题「${title}」、${cards} 张应用卡`);
  }
} finally {
  await app.close();
}

process.exit(process.exitCode ?? 0);
