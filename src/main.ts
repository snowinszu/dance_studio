/**
 * Electron 主进程入口。
 *
 * 整体类比：主进程像剧院的「后台总控」——它负责搭台子（创建窗口）、
 * 拉幕布（加载页面）、以及在最后一位观众离场时关灯锁门（退出应用）。
 * 舞台上演的内容（首页 HTML/CSS/JS）由渲染进程负责，主进程不直接参与。
 */
import { app, BrowserWindow, dialog } from 'electron';
import * as path from 'node:path';
import { getDb } from './db/connection';
import { run as runMigrations, LATEST_VERSION } from './db/migrations';
import { registerIpc } from './ipc/register';

// 单窗口引用挂在模块作用域：若只用局部变量，窗口对象可能被垃圾回收，
// 导致窗口在运行中突然白屏或关闭。
let mainWindow: BrowserWindow | null = null;

/**
 * 打开数据库并把结构迁移到最新版。
 *
 * 失败时不让整个应用崩掉：弹一个错误框告诉用户数据库文件在哪、出了什么问题，
 * 然后照常开窗口（后续的列表页会显示错误态），用户可自行处理文件后重启。
 */
function initDatabase(): void {
  try {
    const db = getDb();
    runMigrations(db);
    // 供打包冒烟脚本（scripts/smoke-packaged.mjs）经 app.evaluate 读取，
    // 确认原生模块在打包产物里能正常加载、迁移能跑通
    process.env.STUDIO_DB_STATUS = 'ready';
    console.log(`[db] 就绪，结构版本 v${LATEST_VERSION}`);
  } catch (err) {
    process.env.STUDIO_DB_STATUS = 'error';
    const detail = err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err);
    console.error('[db] 初始化失败：', err);
    dialog.showErrorBox('数据库打开失败', `无法打开或迁移学员数据库。\n\n${detail}`);
  }
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    // 默认尺寸与模板内容宽度（max-width: 1120px）匹配，两侧留出留白
    width: 1200,
    height: 800,
    // 最小尺寸：低于此值页面响应式布局会开始出现横向溢出
    minWidth: 720,
    minHeight: 600,
    // 页面 <title> 加载后会覆盖此值，这里先设一次避免启动瞬间标题为空
    title: '晓·乐舞艺术空间 · 管理中心',
    webPreferences: {
      // preload 编译产物与 main.js 同级（都在 dist/）
      preload: path.join(__dirname, 'preload.js'),
      // 渲染进程与 Node 环境隔离：页面脚本无法直接触达系统 API
      contextIsolation: true,
      // 页面里不注入 require / process 等 Node 全局
      nodeIntegration: false,
    },
  });

  // index.html 位于项目根，main.js 编译后位于 dist/，所以要上跳一级
  void mainWindow.loadFile(path.join(__dirname, '..', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// app ready 后再建窗口：这是 Electron 能安全创建 BrowserWindow 的最早时机
app.whenReady().then(
  () => {
    // 建窗口前先把数据库准备好、把 IPC 服务台支起来，让首个渲染页面一加载就能读写数据
    initDatabase();
    registerIpc();
    createMainWindow();

    // macOS 习惯：Dock 图标被点击且当前无窗口时，重建一个
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  },
  (err: unknown) => {
    // whenReady 理论上不会 reject，兜底打印便于排查
    console.error('应用启动失败：', err);
    app.quit();
  },
);

// 非 macOS：关掉所有窗口即视为退出应用
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
