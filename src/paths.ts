/**
 * 应用运行时的关键目录解析。
 *
 * 单独一个文件，是为了 main.ts 与 ipc/register.ts 共用同一份「备份目录在哪」的定义，
 * 不各写一份易走样。
 */
import * as path from 'node:path';
import { app } from 'electron';

/**
 * 数据库快照备份目录：`<userData>/backups`。
 *
 * 单元测试用 ELECTRON_RUN_AS_NODE 把 Electron 当 node 跑，此时 `app` 为 undefined ——
 * 与 db/connection.ts 同款，用可选链兜底，退回当前工作目录。
 */
export function backupDir(): string {
  const base =
    typeof app?.getPath === 'function' ? app.getPath('userData') : process.cwd();
  return path.join(base, 'backups');
}
