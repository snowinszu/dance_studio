/**
 * 应用运行时的关键目录解析。
 *
 * 单独一个文件，是为了 main.ts 与 ipc/register.ts 共用同一份「备份目录在哪」的定义，
 * 不各写一份易走样。
 */
import * as path from 'node:path';
import { app } from 'electron';

/**
 * 用户数据目录（Electron 的 `userData`）。
 *
 * 单元测试用 ELECTRON_RUN_AS_NODE 把 Electron 当 node 跑，此时 `app` 为 undefined ——
 * 与 db/connection.ts 同款，用可选链兜底，退回当前工作目录。
 */
export function userDataDir(): string {
  return typeof app?.getPath === 'function' ? app.getPath('userData') : process.cwd();
}

/** 数据库快照备份目录：`<userData>/backups`。 */
export function backupDir(): string {
  return path.join(userDataDir(), 'backups');
}
