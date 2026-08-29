/**
 * 预加载脚本。
 *
 * 在 contextIsolation 开启的前提下，这里是主进程与页面之间唯一安全的桥梁：
 * 页面本身拿不到 Node 能力，需要什么系统级功能都得经由 contextBridge
 * 在这里显式、按需地暴露。
 *
 * 首页目前是纯静态展示，还不需要任何 IPC 能力。这里只向页面挂一个只读标记，
 * 一是作为「preload 已在隔离世界中执行」的可观测证据，二是给后续能力注入留入口。
 */
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('studioShell', {
  ready: true,
});
