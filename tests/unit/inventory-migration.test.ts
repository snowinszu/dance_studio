/**
 * 库存管理迁移 v3 的单测。
 *
 * 与 migrations.test.ts 同款：better-sqlite3 内存库现场建表，跑完即弃。
 * 关注点：v3 把两张表 + 6 个索引建齐、幂等、以及某版 up 抛错时整体回滚。
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

test('空库跑迁移 → 库存的两张表和 6 个索引都建出来，user_version 到最新', () => {
  const db = freshDb();
  try {
    run(db);

    const tables = names(db, 'table');
    for (const t of ['inventory_items', 'item_allocations']) {
      assert.ok(tables.has(t), `应存在表 ${t}`);
    }

    const indexes = names(db, 'index');
    for (const idx of [
      'idx_items_name',
      'idx_items_category',
      'idx_items_deleted',
      'idx_alloc_item',
      'idx_alloc_student',
      'idx_alloc_date',
    ]) {
      assert.ok(indexes.has(idx), `应存在索引 ${idx}`);
    }

    assert.equal(db.pragma('user_version', { simple: true }), LATEST_VERSION);
    assert.ok(LATEST_VERSION >= 4, '库存迁移（v4）应已纳入 MIGRATIONS');
  } finally {
    db.close();
  }
});

test('库已在 v3（跑过并行的班级字段分支，无库存表）→ 再 run() 会补建库存表', () => {
  const db = freshDb();
  try {
    // 用「库存迁移之前」的迁移把库推到 v2
    const preInventory = MIGRATIONS.filter((m) => m.version < 4);
    run(db, preInventory);
    assert.equal(db.pragma('user_version', { simple: true }), 2);

    // 模拟 feat/class-name-field 分支的 v3：加一列 + 把版本号顶到 3
    db.exec('ALTER TABLE students ADD COLUMN class_name TEXT');
    db.pragma('user_version = 3');
    assert.ok(!names(db, 'table').has('inventory_items'), '此刻还没有库存表');

    // 跑完整 MIGRATIONS：v4 > 3，应补建库存表
    run(db);
    assert.ok(names(db, 'table').has('inventory_items'));
    assert.ok(names(db, 'table').has('item_allocations'));
    assert.equal(db.pragma('user_version', { simple: true }), LATEST_VERSION);
  } finally {
    db.close();
  }
});

test('inventory_items 的列与缺省值符合规格', () => {
  const db = freshDb();
  try {
    run(db);
    const cols = (
      db.prepare(`PRAGMA table_info(inventory_items)`).all() as {
        name: string;
        notnull: number;
        dflt_value: string | null;
      }[]
    ).reduce<Record<string, { notnull: number; dflt: string | null }>>((acc, c) => {
      acc[c.name] = { notnull: c.notnull, dflt: c.dflt_value };
      return acc;
    }, {});

    assert.equal(cols['name']?.notnull, 1);
    assert.equal(cols['unit']?.notnull, 1);
    assert.equal(cols['unit']?.dflt, "'件'");
    assert.equal(cols['quantity']?.notnull, 1);
    assert.equal(cols['quantity']?.dflt, '0');
    assert.equal(cols['low_stock_threshold']?.dflt, '0');
    // 可空列
    for (const c of ['category', 'note', 'deleted_at']) {
      assert.equal(cols[c]?.notnull, 0, `${c} 应可空`);
    }
  } finally {
    db.close();
  }
});

test('item_allocations 的外键指向两表且未开级联删除', () => {
  const db = freshDb();
  try {
    run(db);
    const fks = db.prepare(`PRAGMA foreign_key_list(item_allocations)`).all() as {
      table: string;
      on_delete: string;
    }[];
    const targets = new Set(fks.map((f) => f.table));
    assert.ok(targets.has('inventory_items'));
    assert.ok(targets.has('students'));
    for (const f of fks) {
      assert.notEqual(f.on_delete, 'CASCADE', '不应开 ON DELETE CASCADE');
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

    assert.doesNotThrow(() => run(db));

    assert.equal(db.pragma('user_version', { simple: true }), v);
    assert.deepEqual([...names(db, 'table')].sort(), tablesBefore);
  } finally {
    db.close();
  }
});

test('v3 up 中途抛错 → 该版整体回滚，user_version 停在 2', () => {
  const db = freshDb();
  try {
    // 复用真实 v1 / v2，把 v3 换成「建了一半就炸」的版本
    const real = new Map(MIGRATIONS.map((m) => [m.version, m]));
    const boom: readonly Migration[] = [
      real.get(1)!,
      real.get(2)!,
      {
        version: 3,
        up: (d) => {
          d.exec('CREATE TABLE inventory_items (id INTEGER PRIMARY KEY)');
          throw new Error('模拟 v3 失败');
        },
      },
    ];

    assert.throws(() => run(db, boom), /模拟 v3 失败/);

    assert.equal(db.pragma('user_version', { simple: true }), 2);
    assert.ok(!names(db, 'table').has('inventory_items'), 'v3 的表应随事务回滚被丢弃');
  } finally {
    db.close();
  }
});
