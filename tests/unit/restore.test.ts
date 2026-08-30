/**
 * 数据库恢复机制（src/db/restore.ts）单测。用临时文件库，不碰 Electron API。
 * 在 Electron 的 Node 运行时下跑（见 scripts/test-unit.js）。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { AppError } from '../../src/shared/app-error';
import {
  applyPendingRestore,
  clearPendingRestore,
  markPendingRestore,
  readPendingRestore,
  validateRestoreSource,
} from '../../src/db/restore';

const workDir = mkdtempSync(path.join(tmpdir(), 'ds-restore-'));

after(() => rmSync(workDir, { recursive: true, force: true }));

/** 造一个带 students 表、且塞了 `marker` 这条学员的迷你库，返回文件路径。 */
function makeStudentsDb(name: string, marker: string): string {
  const p = path.join(workDir, name);
  const db = new Database(p);
  db.exec('CREATE TABLE students (id INTEGER PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO students (name) VALUES (?)').run(marker);
  db.close();
  return p;
}

/** 读回某个库里 students 的名字列表。 */
function namesIn(dbFile: string): string[] {
  const db = new Database(dbFile, { readonly: true });
  try {
    return (db.prepare('SELECT name FROM students ORDER BY id').all() as { name: string }[]).map(
      (r) => r.name,
    );
  } finally {
    db.close();
  }
}

test('validateRestoreSource：合法的 students 库 → 返回 userVersion', () => {
  const src = makeStudentsDb('valid.db', '张三');
  const { userVersion } = validateRestoreSource(src);
  assert.equal(typeof userVersion, 'number');
});

test('validateRestoreSource：文件不存在 → NOT_FOUND', () => {
  assert.throws(
    () => validateRestoreSource(path.join(workDir, 'nope.db')),
    (e) => e instanceof AppError && e.code === 'NOT_FOUND',
  );
});

test('validateRestoreSource：不是 SQLite → BACKUP_VERIFY_FAILED', () => {
  const junk = path.join(workDir, 'junk.db');
  writeFileSync(junk, 'this is definitely not a sqlite file');
  assert.throws(
    () => validateRestoreSource(junk),
    (e) => e instanceof AppError && e.code === 'BACKUP_VERIFY_FAILED',
  );
});

test('validateRestoreSource：是 SQLite 但没有 students 表 → BACKUP_VERIFY_FAILED', () => {
  const p = path.join(workDir, 'other.db');
  const db = new Database(p);
  db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY)');
  db.close();
  assert.throws(
    () => validateRestoreSource(p),
    (e) => e instanceof AppError && e.code === 'BACKUP_VERIFY_FAILED',
  );
});

test('恢复标记：写 → 读回一致 → 清除后为 null', () => {
  const dir = path.join(workDir, 'marker-1');
  mkdirSync(dir, { recursive: true });
  markPendingRestore(dir, '/some/where/backup.db');
  const back = readPendingRestore(dir);
  assert.equal(back?.source, '/some/where/backup.db');
  assert.ok(back?.requestedAt);

  clearPendingRestore(dir);
  assert.equal(readPendingRestore(dir), null);
});

test('readPendingRestore：内容损坏 → 返回 null 并删掉坏文件', () => {
  const dir = path.join(workDir, 'marker-2');
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'pending-restore.json');
  writeFileSync(f, '{ not valid json');
  assert.equal(readPendingRestore(dir), null);
  assert.ok(!existsSync(f), '坏的标记文件应被删掉');
});

test('applyPendingRestore：换入源库，旧库改名留底，无 .restoring 残留', () => {
  const dbPath = path.join(workDir, 'live', 'dance-studio.db');
  mkdirSync(path.dirname(dbPath), { recursive: true });
  // 现役库：有「旧数据」
  const old = makeStudentsDb('live/dance-studio.db', '旧同学');
  assert.equal(old, dbPath);
  // 现役库带个 -wal 伴生文件，验证会被清掉
  writeFileSync(`${dbPath}-wal`, 'stale wal');
  const source = makeStudentsDb('source-new.db', '新同学');

  const res = applyPendingRestore(dbPath, source);

  assert.deepEqual(namesIn(dbPath), ['新同学']);
  assert.ok(res.preservedTo && existsSync(res.preservedTo));
  assert.deepEqual(namesIn(res.preservedTo), ['旧同学']);
  assert.ok(!existsSync(`${dbPath}.restoring`), '.restoring 不应残留');
  assert.ok(!existsSync(`${dbPath}-wal`), '旧库的 -wal 应被清掉');
});

test('applyPendingRestore：原本没有现役库 → preservedTo 为 null，直接落成源库', () => {
  const dbPath = path.join(workDir, 'fresh', 'dance-studio.db');
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const source = makeStudentsDb('source-fresh.db', '首位同学');

  const res = applyPendingRestore(dbPath, source);

  assert.equal(res.preservedTo, null);
  assert.deepEqual(namesIn(dbPath), ['首位同学']);
});
