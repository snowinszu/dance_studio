// 用 Electron 的内置 Node 运行时跑单元测试。
//
// 与 scripts/start.js 相反：那个脚本要「关掉」ELECTRON_RUN_AS_NODE 好让 Electron 建窗口；
// 这里要「打开」它，把 Electron 降级成纯 Node 来跑测试——目的是让 require('better-sqlite3')
// 加载到与应用运行时同一套 ABI 的原生模块（postinstall 已用 electron-rebuild 编译过）。
const { spawn } = require('node:child_process');
const path = require('node:path');

// 非 Electron 上下文里 require('electron') 返回可执行文件路径字符串
const electronBinary = require('electron');

const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };

const runner = path.join(__dirname, 'run-unit-tests.mjs');
const child = spawn(electronBinary, [runner], { stdio: 'inherit', env });

child.on('close', (code) => process.exit(code ?? 1));
