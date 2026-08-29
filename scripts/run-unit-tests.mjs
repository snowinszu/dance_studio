// 单元测试执行器（在 Electron 的 Node 运行时里跑）。
//
// 为什么要单独一个执行器：单测里会 `require('better-sqlite3')`，而这个原生模块
// 经 postinstall 的 electron-rebuild 编译成了「Electron ABI」，在普通 node 里加载会报
// NODE_MODULE_VERSION 不匹配。所以 scripts/test-unit.js 用 ELECTRON_RUN_AS_NODE=1
// 把 Electron 当 node 拉起来跑这个文件——此时 ABI 与应用运行时一致。
//
// 用 node:test 的编程式 run() 而非 `--test` 命令行开关：Electron-as-node 对
// 命令行开关的转发不总是可靠，编程式 API 更稳。
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const unitDir = join(here, '..', 'dist-test', 'tests', 'unit');

let files;
try {
  files = readdirSync(unitDir)
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => join(unitDir, f));
} catch {
  console.error(`找不到编译产物目录：${unitDir}\n请先执行：tsc -p tsconfig.test.json`);
  process.exit(2);
}

if (files.length === 0) {
  console.error(`${unitDir} 下没有 *.test.js`);
  process.exit(2);
}

let failed = 0;
const stream = run({ files, concurrency: false });
stream.on('test:fail', () => {
  failed += 1;
});
stream.compose(spec).pipe(process.stdout);
stream.on('end', () => {
  process.exit(failed > 0 ? 1 : 0);
});
