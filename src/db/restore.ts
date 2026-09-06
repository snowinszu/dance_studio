/**
 * 用一份快照恢复数据库。
 *
 * 整体类比：换仓库的总账本。账本平时锁在保险柜里、有人一直在用（数据库连接在
 * 进程启动时就打开、整进程占用），没法一边用一边换。所以恢复分两次：
 *
 *  1.（用户点「恢复」时，库还开着）先给现在的账本拍一张快照留底，再在保险柜门口
 *     贴一张便条 `pending-restore.json` 写明「下次开门先换成这本」，然后关门重启。
 *  2.（下次启动最早期，库还没打开）看到便条就动手：把要恢复的文件拷进来、把旧账本
 *     改名留在原地、撕掉便条，照常开门。
 *
 * 本模块只做第 2 步的机械操作和文件校验，不碰 Electron API——目录 / 路径都由调用方传入，
 * 方便单测。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { AppError } from '../shared/app-error';

/** 「下次启动执行恢复」的标记文件名，落在 userData 目录。 */
const MARKER_FILE = 'pending-restore.json';

export interface PendingRestore {
  /** 要恢复的备份文件绝对路径 */
  source: string;
  /** 写标记的时间（ISO 8601） */
  requestedAt: string;
}

/**
 * 校验一个文件确实是一份能用的、属于本系统的 SQLite 数据库。
 * 不合法一律抛 AppError（挡住「选了个随便的文件」/「文件坏了」）。返回其结构版本号。
 */
export function validateRestoreSource(file: string): { userVersion: number } {
  if (!fs.existsSync(file)) {
    throw new AppError('NOT_FOUND', '找不到这个文件，可能已被移动或删除');
  }

  // better-sqlite3 是惰性打开：文件不是数据库时，错误往往在第一次查询才抛出，
  // 所以把「打开 + 查询」整个包起来，非 AppError 的异常一律归到「不是有效数据库」。
  let probe: Database.Database | null = null;
  try {
    probe = new Database(file, { readonly: true, fileMustExist: true });
    const qc = probe.pragma('quick_check', { simple: true });
    if (qc !== 'ok') {
      throw new AppError('BACKUP_VERIFY_FAILED', `这份备份完整性校验未通过：${String(qc)}`);
    }
    // 至少要有 students 表，挡住「是 sqlite 但不是本系统的库」
    const hasCore = probe
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'students'`)
      .get();
    if (!hasCore) {
      throw new AppError('BACKUP_VERIFY_FAILED', '这个数据库里没有本系统的数据表，不像是有效备份');
    }
    return { userVersion: probe.pragma('user_version', { simple: true }) as number };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('BACKUP_VERIFY_FAILED', '这个文件不是有效的数据库');
  } finally {
    probe?.close();
  }
}

/** 在 userData 目录写下恢复标记。 */
export function markPendingRestore(userDataDir: string, source: string): PendingRestore {
  const marker: PendingRestore = { source, requestedAt: new Date().toISOString() };
  fs.writeFileSync(
    path.join(userDataDir, MARKER_FILE),
    JSON.stringify(marker, null, 2),
    'utf8',
  );
  return marker;
}

/** 读恢复标记；没有返回 null；内容损坏也返回 null（并顺手删掉那个坏文件）。 */
export function readPendingRestore(userDataDir: string): PendingRestore | null {
  const p = path.join(userDataDir, MARKER_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
  try {
    const obj = JSON.parse(raw) as Partial<PendingRestore>;
    if (obj && typeof obj.source === 'string' && obj.source.length > 0) {
      return { source: obj.source, requestedAt: obj.requestedAt ?? '' };
    }
  } catch {
    /* 落到下面清掉 */
  }
  fs.rmSync(p, { force: true });
  return null;
}

/** 删掉恢复标记（成功、失败、内容非法都要清，避免下次启动又试一遍）。 */
export function clearPendingRestore(userDataDir: string): void {
  fs.rmSync(path.join(userDataDir, MARKER_FILE), { force: true });
}

/** 删掉某个 db 文件带出的伴生文件（-wal / -shm / -journal），不存在则忽略。 */
function rmSidecars(dbFile: string): void {
  for (const ext of ['-wal', '-shm', '-journal']) {
    fs.rmSync(`${dbFile}${ext}`, { force: true });
  }
}

/** 本地时间 `YYYYMMDD-HHmmss`，用作留底文件名后缀。 */
function localStamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export interface ApplyRestoreResult {
  /** 原库被改名留底到这里；原本没有库文件时为 null */
  preservedTo: string | null;
  /** 恢复所用的源文件 */
  source: string;
}

/**
 * 真正换库。**必须在数据库连接尚未打开时调用**（启动最早期）。
 *
 *   1. 把源文件先拷成 `<dbPath>.restoring`——先拷贝、暂不碰现役库，拷失败也没损失
 *   2. 现役库改名留底 `<dbPath>.pre-restore-<时间>`（多一道后悔药）
 *   3. 删掉现役库的 -wal / -shm（它们属于旧库，留着会和新库对不上）
 *   4. `.restoring` 原子改名成正式库名
 *
 * 任何一步失败：尽力把现役库名改回去，删掉半成品，再把错误抛给调用方。
 */
export function applyPendingRestore(dbPath: string, source: string): ApplyRestoreResult {
  const restoring = `${dbPath}.restoring`;
  fs.rmSync(restoring, { force: true });
  fs.copyFileSync(source, restoring); // 源不存在 / 读不了会在这里抛
  // copyFileSync 在 macOS 上会带上源文件的权限位：若源文件本身只读（外部只读挂载盘 /
  // 解压 / 网盘同步得到的 0444 文件），拷出来的库也会只读，导致 better-sqlite3 打开后
  // 连 WAL pragma 都写不进去（attempt to write a readonly database）。这里强制改回可写，
  // 不依赖源文件权限。
  fs.chmodSync(restoring, 0o644);

  let preservedTo: string | null = null;
  if (fs.existsSync(dbPath)) {
    preservedTo = `${dbPath}.pre-restore-${localStamp()}`;
    fs.renameSync(dbPath, preservedTo);
  }

  try {
    rmSidecars(dbPath);
    fs.renameSync(restoring, dbPath);
  } catch (err) {
    // 回滚：把留底名改回去，清掉半成品
    if (preservedTo && fs.existsSync(preservedTo) && !fs.existsSync(dbPath)) {
      fs.renameSync(preservedTo, dbPath);
    }
    fs.rmSync(restoring, { force: true });
    throw err;
  }

  return { preservedTo, source };
}
