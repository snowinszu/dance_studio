/**
 * 数据库快照备份。
 *
 * 整体类比：给一间「正在营业的仓库」拍完整清点照片。三件事必须做对：
 *
 *  1. 别在别人搬货时直接拷账本。SQLite 开着 WAL 模式，主文件 `dance-studio.db`
 *     之外还有 `-wal` / `-shm` 两个伴生文件；直接 `fs.copyFile` 主文件会漏掉刚写进
 *     WAL 还没合并的记录，甚至拷到只写了一半的页。所以一律走 SQLite 自己的在线备份：
 *       - `createSnapshot` 用 better-sqlite3 的 `db.backup()`——它在读写间隙一页页拷，
 *         产出的一定是某个一致状态，应用可以照常读写；
 *       - `createMilestoneSnapshot` 用 `VACUUM INTO`——一条 SQL 出一个紧实的单文件，
 *         顺带碎片整理，代价是执行期间持一个读锁，所以只在「迁移前、库还空闲」时用。
 *
 *  2. 先写到 `<最终名>.tmp`，用只读连接跑一次 `PRAGMA quick_check` 验完整性，
 *     通过了才 `fs.renameSync` 成正式名。同一磁盘上 rename 是原子的——崩溃时要么
 *     根本没有这个文件，要么是一份验过的完整文件，绝不会留下「看着像 .db、其实是
 *     半截」的东西骗到日后的恢复操作。
 *
 *  3. 轮换只删「日常」快照，「迁移前里程碑」一份都不动——升级出事时那是唯一的
 *     旧结构还原点。
 *
 * 本模块不碰 Electron API：备份目录由调用方（main.ts / IPC 层）显式传入，
 * 好让单元测试把它指到临时目录。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { getDb } from './connection';
import { AppError } from '../shared/app-error';
import type { SnapshotMeta } from '../shared/types';

/** 文件名里这段标记一份「迁移前里程碑」快照。 */
const MILESTONE_MARKER = '-premigrate-v';

/**
 * 匹配本模块产出的快照文件名：`dance-studio-YYYYMMDD-HHmmss[-premigrate-vN].db`。
 * 用「秒」而非「分」精度，是为了同一分钟内两次手动备份不会重名互相覆盖。
 */
const SNAPSHOT_RE = /^dance-studio-\d{8}-\d{6}(?:-premigrate-v\d+)?\.db$/;

/** 本地时间的 `YYYYMMDD-HHmmss` 串，用作快照文件名的一部分。 */
function localStamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * 打开刚生成的快照做一次完整性自检。
 * `quick_check` 比 `integrity_check` 快得多，对「文件有没有拷坏」这个问题足够；
 * 顺带读回 `user_version` 记进元信息，方便日后判断「这份能不能直接拿来用」。
 */
function verifyFile(file: string): { userVersion: number } {
  const probe = new Database(file, { readonly: true });
  try {
    const result = probe.pragma('quick_check', { simple: true });
    if (result !== 'ok') {
      throw new AppError('BACKUP_VERIFY_FAILED', `快照完整性校验未通过：${String(result)}`);
    }
    return { userVersion: probe.pragma('user_version', { simple: true }) as number };
  } finally {
    probe.close();
  }
}

/** 由已落地的快照文件读出元信息。`kind` 由文件名是否含里程碑标记判定。 */
function statMeta(file: string, userVersion?: number): SnapshotMeta {
  const name = path.basename(file);
  const st = fs.statSync(file);
  const meta: SnapshotMeta = {
    name,
    path: file,
    bytes: st.size,
    createdAt: st.mtime.toISOString(),
    kind: name.includes(MILESTONE_MARKER) ? 'milestone' : 'daily',
  };
  if (userVersion !== undefined) meta.userVersion = userVersion;
  return meta;
}

/** 「校验 .tmp → 原子改名 → 读元信息」的收尾三步，两种生成方式共用。 */
function finalizeVerified(tmpPath: string, finalPath: string): SnapshotMeta {
  const { userVersion } = verifyFile(tmpPath);
  fs.renameSync(tmpPath, finalPath);
  return statMeta(finalPath, userVersion);
}

export interface CreateSnapshotOptions {
  /** 备份目录（绝对路径）。不存在会自动创建。 */
  dir: string;
  /** 追加到文件名的标签，如 `premigrate-v6`；省略即一份普通日常快照。 */
  tag?: string;
}

/**
 * 生成一份日常快照。走 `db.backup()` 在线备份，生成期间应用可继续读写。
 * 失败时不留下正式文件（连 `.tmp` 也清掉），错误交给调用方处理。
 * 标成 `async`：连 `mkdirSync` 这类同步异常也一并变成 reject，调用方只需 catch 一处。
 */
export async function createSnapshot(opts: CreateSnapshotOptions): Promise<SnapshotMeta> {
  fs.mkdirSync(opts.dir, { recursive: true });
  const suffix = opts.tag ? `-${opts.tag}` : '';
  const finalPath = path.join(opts.dir, `dance-studio-${localStamp()}${suffix}.db`);
  const tmpPath = `${finalPath}.tmp`;
  // 上一次失败可能留下 .tmp；先清掉，免得 backup() 往一个旧文件里写
  fs.rmSync(tmpPath, { force: true });
  try {
    await getDb().backup(tmpPath);
    return finalizeVerified(tmpPath, finalPath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
}

export interface MilestoneSnapshotOptions {
  dir: string;
  /** 目标结构版本号，进文件名 `-premigrate-vN`。 */
  version: number;
}

/**
 * 生成一份「迁移前里程碑」快照。用 `VACUUM INTO`：全程同步、产物紧实。
 * 因为执行期间持读锁，调用方须在迁移前、库还空闲时调用——同步返回本身就保证了
 * 「等它完成再迁移」。失败时不留下正式文件。
 */
export function createMilestoneSnapshot(opts: MilestoneSnapshotOptions): SnapshotMeta {
  fs.mkdirSync(opts.dir, { recursive: true });
  const finalPath = path.join(
    opts.dir,
    `dance-studio-${localStamp()}-premigrate-v${opts.version}.db`,
  );
  const tmpPath = `${finalPath}.tmp`;
  fs.rmSync(tmpPath, { force: true });
  try {
    // VACUUM INTO 的目标文件必须不存在（上一行已先删 .tmp）。
    // pragma/VACUUM 不接受占位符参数；tmpPath 由本模块拼接、无用户输入，
    // 转义单引号后内联是安全的。
    getDb().exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
    return finalizeVerified(tmpPath, finalPath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
}

/**
 * 列出备份目录里的全部快照，按创建时间倒序（最新在前）。
 * 目录不存在时返回空数组（首次运行、被手动删空都属正常）。
 */
export function listSnapshots(dir: string): SnapshotMeta[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => SNAPSHOT_RE.test(n))
    .map((n) => statMeta(path.join(dir, n)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export interface PruneOptions {
  dir: string;
  /** 保留的「日常」快照份数（按时间倒序取前 keep 份）。 */
  keep: number;
}

/**
 * 轮换：日常快照只留最近 `keep` 份，多出来的旧的删掉。
 * 「迁移前里程碑」快照一律保留——升级出问题时那是唯一的旧结构还原点。
 * 返回被删文件的路径数组。
 */
export function pruneSnapshots(opts: PruneOptions): string[] {
  const daily = listSnapshots(opts.dir).filter((s) => s.kind === 'daily');
  const removed: string[] = [];
  for (const snap of daily.slice(Math.max(0, opts.keep))) {
    fs.rmSync(snap.path, { force: true });
    removed.push(snap.path);
  }
  return removed;
}
