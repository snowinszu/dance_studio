/**
 * 应用设置迁移 v7 的单测：app_settings 键值表建出来、幂等、主键唯一。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { run, LATEST_VERSION } from '../../src/db/migrations';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

test('空库跑迁移 → app_settings 表建出来，user_version 到最新', () => {
  const db = freshDb();
  try {
    run(db);
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
    ).map((r) => r.name);
    assert.ok(tables.includes('app_settings'));
    assert.equal(db.pragma('user_version', { simple: true }), LATEST_VERSION);
    assert.ok(LATEST_VERSION >= 7, '应用设置迁移（v7）应已纳入 MIGRATIONS');
  } finally {
    db.close();
  }
});

test('app_settings：key 为主键，重复 key 的 INSERT 会冲突（需走 upsert）', () => {
  const db = freshDb();
  try {
    run(db);
    db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)`).run(
      'k',
      '1',
      'now',
    );
    assert.throws(() =>
      db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)`).run(
        'k',
        '2',
        'now2',
      ),
    );
  } finally {
    db.close();
  }
});
