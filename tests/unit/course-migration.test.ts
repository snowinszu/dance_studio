/**
 * 课程管理迁移 v6 的单测。
 *
 * 与 migrations.test.ts / attendance-migration.test.ts 同款：better-sqlite3 内存库现场建表，跑完即弃。
 * 关注点：v6 把 5 张表 + 全部索引（含两个部分唯一索引）建齐、幂等、从 v5 库能补到 v6、
 * 以及某版 up 抛错时整体回滚。
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

const V6_TABLES = ['teachers', 'classes', 'class_students', 'class_schedules', 'class_sessions'];

const V6_INDEXES = [
  'idx_teachers_status',
  'idx_teachers_deleted',
  'idx_classes_status',
  'idx_classes_dance',
  'idx_classes_teacher',
  'idx_classes_deleted',
  'idx_cs_class',
  'idx_cs_student',
  'uniq_class_student_active',
  'idx_sch_class',
  'idx_sch_weekday',
  'idx_sch_deleted',
  'idx_sess_class',
  'idx_sess_date',
  'idx_sess_teacher',
  'idx_sess_deleted',
  'uniq_sess_slot',
];

test('空库跑迁移 → 课程 5 张表和全部索引都建出来，user_version 到最新', () => {
  const db = freshDb();
  try {
    run(db);

    const tables = names(db, 'table');
    for (const t of V6_TABLES) {
      assert.ok(tables.has(t), `应存在表 ${t}`);
    }

    const indexes = names(db, 'index');
    for (const idx of V6_INDEXES) {
      assert.ok(indexes.has(idx), `应存在索引 ${idx}`);
    }

    assert.equal(db.pragma('user_version', { simple: true }), LATEST_VERSION);
    assert.ok(LATEST_VERSION >= 6, '课程迁移（v6）应已纳入 MIGRATIONS');
  } finally {
    db.close();
  }
});

test('库已在 v5（跑过考勤，无课程表）→ 再 run() 会补建课程 5 张表', () => {
  const db = freshDb();
  try {
    const preCourse = MIGRATIONS.filter((m) => m.version < 6);
    run(db, preCourse);
    const vBefore = db.pragma('user_version', { simple: true }) as number;
    assert.ok(vBefore < 6);
    assert.ok(!names(db, 'table').has('class_sessions'), '此刻还没有课程表');

    run(db);

    const tables = names(db, 'table');
    for (const t of V6_TABLES) {
      assert.ok(tables.has(t), `应补建表 ${t}`);
    }
    assert.equal(db.pragma('user_version', { simple: true }), LATEST_VERSION);
  } finally {
    db.close();
  }
});

test('部分唯一索引带 WHERE 谓词（不是整列唯一）', () => {
  const db = freshDb();
  try {
    run(db);
    const rows = db
      .prepare(
        `SELECT name, sql FROM sqlite_master
          WHERE type = 'index' AND name IN ('uniq_class_student_active', 'uniq_sess_slot')`,
      )
      .all() as { name: string; sql: string }[];
    assert.equal(rows.length, 2, '两个部分唯一索引都应存在');
    for (const r of rows) {
      assert.match(r.sql, /WHERE/i, `${r.name} 应带 WHERE 谓词`);
      assert.match(r.sql, /UNIQUE/i, `${r.name} 应为 UNIQUE`);
    }

    // 行为验证：class_students 离班后可再入班（同 class_id + student_id 第二条 left_at IS NULL 被挡，
    // 但第一条置 left_at 后就不冲突）
    db.prepare(
      `INSERT INTO students (name, phone_primary, created_at, updated_at)
       VALUES ('甲', '13800000001', '2026-01-01', '2026-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO teachers (name, created_at, updated_at) VALUES ('张老师', 'now', 'now')`,
    ).run();
    db.prepare(
      `INSERT INTO classes (name, dance_type, created_at, updated_at)
       VALUES ('A班', '中国舞', 'now', 'now')`,
    ).run();
    const ins = db.prepare(
      `INSERT INTO class_students (class_id, student_id, joined_at, created_at, updated_at)
       VALUES (1, 1, '2026-01-01', 'now', 'now')`,
    );
    ins.run();
    assert.throws(() => ins.run(), /UNIQUE|constraint/i, '第二条在册记录应被部分唯一索引挡下');
    db.prepare(`UPDATE class_students SET left_at = '2026-02-01' WHERE id = 1`).run();
    assert.doesNotThrow(() => ins.run(), '离班后应可再次加入');
  } finally {
    db.close();
  }
});

test('课程表的列与缺省值符合规格', () => {
  const db = freshDb();
  try {
    run(db);
    const info = (table: string) =>
      (
        db.prepare(`PRAGMA table_info(${table})`).all() as {
          name: string;
          notnull: number;
          dflt_value: string | null;
        }[]
      ).reduce<Record<string, { notnull: number; dflt: string | null }>>((acc, c) => {
        acc[c.name] = { notnull: c.notnull, dflt: c.dflt_value };
        return acc;
      }, {});

    const teachers = info('teachers');
    assert.equal(teachers['name']?.notnull, 1);
    assert.equal(teachers['status']?.notnull, 1);
    assert.match(String(teachers['status']?.dflt), /在职/);
    assert.equal(teachers['deleted_at']?.notnull, 0);

    const classes = info('classes');
    for (const c of ['name', 'dance_type', 'status', 'created_at', 'updated_at']) {
      assert.equal(classes[c]?.notnull, 1, `classes.${c} 应为 NOT NULL`);
    }
    assert.match(String(classes['status']?.dflt), /在读/);
    for (const c of ['level', 'teacher_id', 'room', 'capacity', 'start_date', 'end_date', 'note']) {
      assert.equal(classes[c]?.notnull, 0, `classes.${c} 应可空`);
    }

    const schedules = info('class_schedules');
    for (const c of ['class_id', 'weekday', 'start_time', 'end_time']) {
      assert.equal(schedules[c]?.notnull, 1, `class_schedules.${c} 应为 NOT NULL`);
    }
    for (const c of ['teacher_id', 'room', 'effective_from', 'effective_to']) {
      assert.equal(schedules[c]?.notnull, 0, `class_schedules.${c} 应可空`);
    }

    const sessions = info('class_sessions');
    for (const c of ['class_id', 'session_date', 'start_time', 'end_time', 'status', 'origin']) {
      assert.equal(sessions[c]?.notnull, 1, `class_sessions.${c} 应为 NOT NULL`);
    }
    assert.match(String(sessions['status']?.dflt), /正常/);
    for (const c of ['schedule_id', 'teacher_id', 'room', 'note', 'deleted_at']) {
      assert.equal(sessions[c]?.notnull, 0, `class_sessions.${c} 应可空`);
    }
  } finally {
    db.close();
  }
});

test('课程各表的外键都不开级联删除', () => {
  const db = freshDb();
  try {
    run(db);
    for (const table of ['classes', 'class_students', 'class_schedules', 'class_sessions']) {
      const fks = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as {
        table: string;
        on_delete: string;
      }[];
      assert.ok(fks.length >= 1, `${table} 应至少有一个外键`);
      for (const fk of fks) {
        assert.notEqual(fk.on_delete, 'CASCADE', `${table} → ${fk.table} 不应开 ON DELETE CASCADE`);
      }
    }
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
    const indexesBefore = [...names(db, 'index')].sort();

    assert.doesNotThrow(() => run(db));

    assert.equal(db.pragma('user_version', { simple: true }), v);
    assert.deepEqual([...names(db, 'table')].sort(), tablesBefore);
    assert.deepEqual([...names(db, 'index')].sort(), indexesBefore);
  } finally {
    db.close();
  }
});

test('v6 up 中途抛错 → 该版整体回滚，user_version 停在上一版', () => {
  const db = freshDb();
  try {
    const real = new Map(MIGRATIONS.map((m) => [m.version, m]));
    const lower = MIGRATIONS.filter((m) => m.version < 6).map((m) => real.get(m.version)!);
    const highestLower = lower[lower.length - 1]!.version;
    const boom: readonly Migration[] = [
      ...lower,
      {
        version: 6,
        up: (d) => {
          d.exec(`CREATE TABLE teachers (id INTEGER PRIMARY KEY)`);
          throw new Error('模拟 v6 失败');
        },
      },
    ];

    assert.throws(() => run(db, boom), /模拟 v6 失败/);

    assert.equal(db.pragma('user_version', { simple: true }), highestLower);
    assert.ok(!names(db, 'table').has('teachers'), 'v6 的表应随事务回滚被丢弃');
  } finally {
    db.close();
  }
});

test('MIGRATIONS 版本号唯一（run 的重复版本号守卫）', () => {
  const seen = new Set<number>();
  for (const m of MIGRATIONS) {
    assert.ok(!seen.has(m.version), `版本号 v${m.version} 重复`);
    seen.add(m.version);
  }
  assert.ok(seen.has(6), 'v6 应在 MIGRATIONS 中');
});
