/**
 * 迁移器单测。
 *
 * 用 better-sqlite3 的内存库现场建表，不碰任何文件。
 * 本套件在 Electron 的 Node 运行时下执行（见 scripts/test-unit.js），
 * 这样加载的 better-sqlite3 二进制与应用运行时是同一套 ABI。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { run, MIGRATIONS, LATEST_VERSION, type Migration } from '../../src/db/migrations';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

function tableNames(db: Database.Database): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

test('空库跑一次 → v1 的四张表和索引都建出来，user_version 前进到最新', () => {
  const db = freshDb();
  try {
    assert.equal(db.pragma('user_version', { simple: true }), 0);

    run(db);

    const tables = tableNames(db);
    for (const t of ['students', 'field_definitions', 'tags', 'student_tags']) {
      assert.ok(tables.has(t), `应存在表 ${t}`);
    }

    const indexes = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'students'`)
        .all() as { name: string }[]
    ).map((r) => r.name);
    for (const idx of [
      'idx_students_name',
      'idx_students_phone',
      'idx_students_status',
      'idx_students_deleted',
    ]) {
      assert.ok(indexes.includes(idx), `应存在索引 ${idx}`);
    }

    assert.equal(db.pragma('user_version', { simple: true }), LATEST_VERSION);
  } finally {
    db.close();
  }
});

test('重复调用是幂等的：跑两次不抛错，结构和版本号不变', () => {
  const db = freshDb();
  try {
    run(db);
    const versionAfterFirst = db.pragma('user_version', { simple: true });
    const tablesAfterFirst = [...tableNames(db)].sort();

    assert.doesNotThrow(() => run(db));

    assert.equal(db.pragma('user_version', { simple: true }), versionAfterFirst);
    assert.deepEqual([...tableNames(db)].sort(), tablesAfterFirst);
  } finally {
    db.close();
  }
});

test('某一版 up 中途抛错 → 该版整体回滚，user_version 不前进', () => {
  const db = freshDb();
  try {
    const boom: readonly Migration[] = [
      { version: 1, up: (d) => d.exec('CREATE TABLE ok_table (id INTEGER PRIMARY KEY)') },
      {
        version: 2,
        up: (d) => {
          d.exec('CREATE TABLE half_baked (id INTEGER PRIMARY KEY)');
          throw new Error('模拟迁移失败');
        },
      },
    ];

    assert.throws(() => run(db, boom), /模拟迁移失败/);

    // v1 已提交
    assert.equal(db.pragma('user_version', { simple: true }), 1);
    assert.ok(tableNames(db).has('ok_table'));
    // v2 事务回滚，half_baked 不应残留
    assert.ok(!tableNames(db).has('half_baked'), 'v2 的表应随事务回滚被丢弃');
  } finally {
    db.close();
  }
});

test('MIGRATIONS 的 version 从 1 起、连续且升序', () => {
  const versions = MIGRATIONS.map((m) => m.version);
  assert.deepEqual(
    versions,
    versions.map((_, i) => i + 1),
  );
});
