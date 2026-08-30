/**
 * 考勤管理迁移 v5 的单测。
 *
 * 与 migrations.test.ts / inventory-migration.test.ts 同款：better-sqlite3 内存库现场建表，跑完即弃。
 * 关注点：v5 把 attendance_records 表 + 4 个索引建齐、幂等、从 v4 库能补到 v5、以及某版 up 抛错时整体回滚。
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

function names(db: Database.Database, type: 'table' | 'index'): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'`)
    .all(type) as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

test('空库跑迁移 → attendance_records 表和 4 个索引都建出来，user_version 到最新', () => {
  const db = freshDb();
  try {
    run(db);

    assert.ok(names(db, 'table').has('attendance_records'), '应存在表 attendance_records');

    const indexes = names(db, 'index');
    for (const idx of ['idx_att_student', 'idx_att_date', 'idx_att_type', 'idx_att_deleted']) {
      assert.ok(indexes.has(idx), `应存在索引 ${idx}`);
    }

    assert.equal(db.pragma('user_version', { simple: true }), LATEST_VERSION);
    assert.ok(LATEST_VERSION >= 5, '考勤迁移（v5）应已纳入 MIGRATIONS');
  } finally {
    db.close();
  }
});

test('库已在 v4（跑过库存，无考勤表）→ 再 run() 会补建 attendance_records', () => {
  const db = freshDb();
  try {
    const preAttendance = MIGRATIONS.filter((m) => m.version < 5);
    run(db, preAttendance);
    const vBefore = db.pragma('user_version', { simple: true }) as number;
    assert.ok(vBefore < 5);
    assert.ok(!names(db, 'table').has('attendance_records'), '此刻还没有考勤表');

    run(db);

    assert.ok(names(db, 'table').has('attendance_records'));
    assert.equal(db.pragma('user_version', { simple: true }), LATEST_VERSION);
  } finally {
    db.close();
  }
});

test('attendance_records 的列与缺省值符合规格', () => {
  const db = freshDb();
  try {
    run(db);
    const cols = (
      db.prepare(`PRAGMA table_info(attendance_records)`).all() as {
        name: string;
        notnull: number;
        dflt_value: string | null;
      }[]
    ).reduce<Record<string, { notnull: number; dflt: string | null }>>((acc, c) => {
      acc[c.name] = { notnull: c.notnull, dflt: c.dflt_value };
      return acc;
    }, {});

    for (const c of ['student_id', 'attend_date', 'type', 'lessons_delta', 'created_at', 'updated_at']) {
      assert.equal(cols[c]?.notnull, 1, `${c} 应为 NOT NULL`);
    }
    assert.equal(cols['lessons_delta']?.dflt, '0');
    for (const c of [
      'session_id',
      'class_name',
      'teacher',
      'attend_time',
      'reason',
      'operator',
      'note',
      'deleted_at',
    ]) {
      assert.equal(cols[c]?.notnull, 0, `${c} 应可空`);
    }
  } finally {
    db.close();
  }
});

test('attendance_records 的外键指向 students 且未开级联删除', () => {
  const db = freshDb();
  try {
    run(db);
    const fks = db.prepare(`PRAGMA foreign_key_list(attendance_records)`).all() as {
      table: string;
      on_delete: string;
    }[];
    assert.equal(fks.length, 1, '只应有一个外键（student_id → students）');
    assert.equal(fks[0]?.table, 'students');
    assert.notEqual(fks[0]?.on_delete, 'CASCADE', '不应开 ON DELETE CASCADE');
  } finally {
    db.close();
  }
});

test('重复调用 run 是幂等的：结构与版本号不变', () => {
  const db = freshDb();
  try {
    run(db);
    const v = db.pragma('user_version', { simple: true });
    const tablesBefore = [...names(db, 'table')].sort();

    assert.doesNotThrow(() => run(db));

    assert.equal(db.pragma('user_version', { simple: true }), v);
    assert.deepEqual([...names(db, 'table')].sort(), tablesBefore);
  } finally {
    db.close();
  }
});

test('v5 up 中途抛错 → 该版整体回滚，user_version 停在上一版', () => {
  const db = freshDb();
  try {
    // 复用真实的低版本迁移，把 v5 换成「建了一半就炸」的版本
    const real = new Map(MIGRATIONS.map((m) => [m.version, m]));
    const lower = MIGRATIONS.filter((m) => m.version < 5).map((m) => real.get(m.version)!);
    const highestLower = lower[lower.length - 1]!.version;
    const boom: readonly Migration[] = [
      ...lower,
      {
        version: 5,
        up: (d) => {
          d.exec('CREATE TABLE attendance_records (id INTEGER PRIMARY KEY)');
          throw new Error('模拟 v5 失败');
        },
      },
    ];

    assert.throws(() => run(db, boom), /模拟 v5 失败/);

    assert.equal(db.pragma('user_version', { simple: true }), highestLower);
    assert.ok(!names(db, 'table').has('attendance_records'), 'v5 的表应随事务回滚被丢弃');
  } finally {
    db.close();
  }
});
