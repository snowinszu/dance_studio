/**
 * SQLite 连接（进程内单例）。
 *
 * 整体类比：整个应用共用「一条通往仓库的电话线」。第一次打电话时接通，
 * 之后所有人复用同一条线；进程退出前挂断。better-sqlite3 是同步 API，
 * 单进程单窗口下不存在并发抢线的问题，代码因此可以写得很直。
 *
 * 数据库文件默认放在 Electron 的 userData 目录；测试通过环境变量
 * STUDIO_DB_PATH 把它重定向到临时文件或 ':memory:'，不碰用户真实数据。
 */
import * as path from 'node:path';
import Database from 'better-sqlite3';
// 注意：单元测试用 ELECTRON_RUN_AS_NODE 跑，此时 require('electron') 返回的是
// 二进制路径字符串而非模块，app 会是 undefined —— 下面用可选链兜底。
import { app } from 'electron';

let db: Database.Database | null = null;

/** 解析数据库文件路径：环境变量优先，其次 userData，最后退回当前工作目录。 */
function resolveDbPath(): string {
  const override = process.env.STUDIO_DB_PATH;
  if (override && override.length > 0) return override;

  const userData =
    typeof app?.getPath === 'function' ? app.getPath('userData') : process.cwd();
  return path.join(userData, 'dance-studio.db');
}

/**
 * 取得单例连接。首次调用时打开文件并设好 PRAGMA：
 * - journal_mode = WAL：读不阻塞写，崩溃恢复更稳
 * - foreign_keys = ON：student_tags 的 ON DELETE CASCADE 才会生效
 */
export function getDb(): Database.Database {
  if (db) return db;

  db = new Database(resolveDbPath());
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/** 关闭连接（进程退出前调用）。 */
export function closeDb(): void {
  if (!db) return;
  db.close();
  db = null;
}
