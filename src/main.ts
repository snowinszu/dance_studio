/**
 * Electron 主进程入口。
 *
 * 整体类比：主进程像剧院的「后台总控」——它负责搭台子（创建窗口）、
 * 拉幕布（加载页面）、以及在最后一位观众离场时关灯锁门（退出应用）。
 * 舞台上演的内容（首页 HTML/CSS/JS）由渲染进程负责，主进程不直接参与。
 */
import { app, BrowserWindow } from 'electron';
import * as path from 'node:path';

// 单窗口引用挂在模块作用域：若只用局部变量，窗口对象可能被垃圾回收，
// 导致窗口在运行中突然白屏或关闭。
let mainWindow: BrowserWindow | null = null;

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
