import { defineConfig } from '@playwright/test';

/**
 * 只跑 Electron 端到端测试（tests/e2e）。
 * 不声明浏览器 project —— _electron.launch 用的是 electron 包自带的二进制，
 * 不需要 `playwright install` 下载 Chromium/Firefox/WebKit。
 */
export default defineConfig({
  testDir: './tests/e2e',
  // Electron 应用启动开销大且共用同一个可执行文件，串行更稳
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  expect: { timeout: 10_000 },
});
