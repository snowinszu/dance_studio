/**
 * 数据库快照备份核心模块（src/db/backup.ts）单测。
 *
 * 与多数单测不同，这里不能用 `:memory:` ——要断言真的落了一个能独立打开的快照文件，
 * 所以用一个临时目录里的文件库当源。整套在 Electron 的 Node 运行时下跑
 * （见 scripts/test-unit.js），加载的 better-sqlite3 与应用运行时同一套 ABI。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { run } from '../../src/db/migrations';
import { getDb, closeDb } from '../../src/db/connection';
import {
  createMilestoneSnapshot,
  createSnapshot,
  ensureDailySnapshot,
  hasRecentDailySnapshot,
  listSnapshots,
  pruneSnapshots,
} from '../../src/db/backup';

const ONE_DAY = 24 * 60 * 60 * 1000;
const workDir = mkdtempSync(path.join(tmpdir(), 'ds-backup-'));
// connection.ts 只在首次 getDb() 时解析路径，所以此刻设 env 仍来得及
process.env['STUDIO_DB_PATH'] = path.join(workDir, 'source.db');

const NOW = new Date().toISOString();
run(getDb());
getDb()
  .prepare(
    `INSERT INTO students (name, phone_primary, dance_types, custom_fields, created_at, updated_at)
     VALUES (?, ?, '[]', '{}', ?, ?)`,
  )
  .run('张三', '13700000001', NOW, NOW);
const SOURCE_ROWS = (
  getDb().prepare('SELECT count(*) AS c FROM students').get() as { c: number }
).c;

after(() => {
  closeDb();
  rmSync(workDir, { recursive: true, force: true });
});

/** 造一个「长得像快照」的假文件（只测 list/prune 时不需要是真 SQLite），并把 mtime 定死。 */
function fakeSnapshot(dir: string, name: string, mtimeEpochSec: number): string {
  mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  writeFileSync(p, 'not-a-real-db');
  utimesSync(p, mtimeEpochSec, mtimeEpochSec);
  return p;
}

test('createSnapshot：产出文件可独立打开，quick_check=ok，行数与源库一致，.tmp 不残留', async () => {
  const dir = path.join(workDir, 'daily');
  const meta = await createSnapshot({ dir });

  assert.match(meta.name, /^dance-studio-\d{8}-\d{6}\.db$/);
  assert.equal(meta.kind, 'daily');
  assert.ok(meta.bytes > 0);
  assert.equal(typeof meta.userVersion, 'number');
  assert.ok(existsSync(meta.path));
  assert.ok(!existsSync(`${meta.path}.tmp`), '.tmp 不应残留');
  // 快照应是自包含单文件：不带 WAL 伴生文件，也没有 .tmp-wal/.tmp-shm 遗留
  for (const junk of ['-wal', '-shm', '.tmp-wal', '.tmp-shm']) {
    assert.ok(!existsSync(`${meta.path}${junk}`), `不应残留 ${junk}`);
  }

  const copy = new Database(meta.path, { readonly: true });
  try {
    assert.equal(copy.pragma('quick_check', { simple: true }), 'ok');
    const rows = (copy.prepare('SELECT count(*) AS c FROM students').get() as { c: number }).c;
    assert.equal(rows, SOURCE_ROWS);
  } finally {
    copy.close();
  }
});

test('createMilestoneSnapshot：文件名带 -premigrate-vN，kind=milestone，且能打开', () => {
  const dir = path.join(workDir, 'milestone');
  const meta = createMilestoneSnapshot({ dir, version: 6 });

  assert.match(meta.name, /^dance-studio-\d{8}-\d{6}-premigrate-v6\.db$/);
  assert.equal(meta.kind, 'milestone');
  assert.ok(!existsSync(`${meta.path}.tmp`));

  const copy = new Database(meta.path, { readonly: true });
  try {
    assert.equal(copy.pragma('quick_check', { simple: true }), 'ok');
  } finally {
    copy.close();
  }
});

test('createSnapshot：目录父级不可用时抛错，不留下任何文件', async () => {
  const badParent = path.join(workDir, 'a-file-not-a-dir');
  writeFileSync(badParent, 'x');
  // 父级是文件 → mkdirSync 直接 ENOTDIR
  await assert.rejects(() => createSnapshot({ dir: path.join(badParent, 'backups') }));
  assert.ok(!existsSync(path.join(badParent, 'backups')));
});

test('listSnapshots：只认本模块的命名、区分 daily/milestone、按创建时间倒序', () => {
  const dir = path.join(workDir, 'list-test');
  fakeSnapshot(dir, 'dance-studio-20260101-090000.db', 1_700_000_000);
  fakeSnapshot(dir, 'dance-studio-20260102-090000.db', 1_700_100_000);
  fakeSnapshot(dir, 'dance-studio-20260103-090000-premigrate-v6.db', 1_700_200_000);
  fakeSnapshot(dir, 'notes.txt', 1_700_300_000);
  fakeSnapshot(dir, 'backup.db', 1_700_300_000);

  const list = listSnapshots(dir);
  assert.deepEqual(
    list.map((s) => s.name),
    [
      'dance-studio-20260103-090000-premigrate-v6.db',
      'dance-studio-20260102-090000.db',
      'dance-studio-20260101-090000.db',
    ],
  );
  assert.deepEqual(
    list.map((s) => s.kind),
    ['milestone', 'daily', 'daily'],
  );
});

test('listSnapshots：目录不存在 → 空数组', () => {
  assert.deepEqual(listSnapshots(path.join(workDir, 'never-created')), []);
});

test('pruneSnapshots：keep=3 → 5 份日常删最旧 2 份，里程碑 / 恢复前留底一份不动', () => {
  const dir = path.join(workDir, 'prune-test');
  for (let i = 1; i <= 5; i += 1) {
    fakeSnapshot(dir, `dance-studio-2026010${i}-090000.db`, 1_700_000_000 + i * 1000);
  }
  fakeSnapshot(dir, 'dance-studio-20260201-090000-premigrate-v5.db', 1_700_000_500);
  fakeSnapshot(dir, 'dance-studio-20260202-090000-premigrate-v6.db', 1_700_000_600);
  fakeSnapshot(dir, 'dance-studio-20260203-090000-pre-restore.db', 1_700_000_700);

  const removed = pruneSnapshots({ dir, keep: 3 });

  assert.equal(removed.length, 2);
  assert.ok(!existsSync(path.join(dir, 'dance-studio-20260101-090000.db')));
  assert.ok(!existsSync(path.join(dir, 'dance-studio-20260102-090000.db')));
  assert.ok(existsSync(path.join(dir, 'dance-studio-20260103-090000.db')));

  const left = listSnapshots(dir);
  assert.equal(left.filter((s) => s.kind === 'daily').length, 3);
  assert.equal(left.filter((s) => s.kind === 'milestone').length, 2);
  assert.equal(left.filter((s) => s.kind === 'pre-restore').length, 1);
});

test('hasRecentDailySnapshot：窗口内有 daily → 应跳过；只有超期 daily 或里程碑 → 应备份', () => {
  const dir = path.join(workDir, 'recent-test');
  const now = Date.parse('2026-08-30T12:00:00Z');
  const hoursAgo = (h: number): number => (now - h * 3_600_000) / 1000;

  // 20h 前的一份 daily —— 在 24h 窗口内 → 应跳过
  const only = fakeSnapshot(dir, 'dance-studio-20260830-000000.db', hoursAgo(20));
  assert.equal(hasRecentDailySnapshot(dir, ONE_DAY, now), true);

  // 改成 30h 前 —— 超期 → 应备份
  utimesSync(only, hoursAgo(30), hoursAgo(30));
  assert.equal(hasRecentDailySnapshot(dir, ONE_DAY, now), false);

  // 再加一份 1h 前的「里程碑」—— 里程碑不算「daily 近备」 → 仍应备份
  fakeSnapshot(dir, 'dance-studio-20260830-110000-premigrate-v6.db', hoursAgo(1));
  assert.equal(hasRecentDailySnapshot(dir, ONE_DAY, now), false);
});

test('ensureDailySnapshot：已有近 24h 的 daily 时跳过（返回 null，不新增文件）', async () => {
  const dir = path.join(workDir, 'ensure-skip');
  fakeSnapshot(dir, 'dance-studio-20990101-000000.db', Date.now() / 1000);
  const before = listSnapshots(dir).length;

  const meta = await ensureDailySnapshot({ dir, keep: 20 });

  assert.equal(meta, null);
  assert.equal(listSnapshots(dir).length, before);
});
