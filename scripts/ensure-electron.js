// 确保 Electron 运行时二进制已就位（postinstall 钩子）。
//
// 为什么需要它：从 Electron 42 起，官方发布的 `electron` npm 包
// 去掉了自带的 `postinstall: node install.js` 脚本，因此 `npm install`
// 完成后 node_modules/electron/dist/ 是空的、跑不起来。这里在项目侧补上
// 这一步：调用 Electron 自己的安装器把对应平台的二进制拉下来 / 解压。
//
// 幂等：install.js 会先比对版本与本地缓存，已就位时直接跳过。
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const electronDir = path.join(__dirname, '..', 'node_modules', 'electron');
const distDir = path.join(electronDir, 'dist');
const installer = path.join(electronDir, 'install.js');

// 二进制已存在就什么都不做（install.js 内部也会判断，这里再快筛一层）
if (fs.existsSync(path.join(distDir, 'version'))) {
  process.exit(0);
}

if (!fs.existsSync(installer)) {
  console.warn('[ensure-electron] 未找到 node_modules/electron/install.js，跳过。请确认 electron 依赖已安装。');
  process.exit(0);
}

console.log('[ensure-electron] 正在获取 Electron 运行时二进制…');
execFileSync(process.execPath, [installer], { stdio: 'inherit' });
