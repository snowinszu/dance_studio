// 启动器：清掉 ELECTRON_RUN_AS_NODE 后再拉起 Electron。
//
// 为什么需要它：部分环境（CI、容器、某些终端会话）会把
// ELECTRON_RUN_AS_NODE=1 注入全局环境，Electron 一旦读到这个变量就会
// 退化成「纯 Node 运行时」——不初始化 GUI、app 对象为 undefined、不建窗口。
// 直接 `electron .` 在这类环境下会静默地不弹窗。这里显式剔除该变量，
// 保证 `npm start` 在任何环境都能打开桌面窗口。
const { spawn } = require('node:child_process');

// 在非 Electron 的 Node 上下文里 require('electron') 返回可执行文件路径字符串，
// 这与 Electron 官方 cli.js 的做法一致。
const electronBinary = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// '.' 让 Electron 读取 package.json 的 "main" 字段作为入口；透传其余命令行参数
const child = spawn(electronBinary, ['.', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});

child.on('close', (code) => process.exit(code ?? 1));
