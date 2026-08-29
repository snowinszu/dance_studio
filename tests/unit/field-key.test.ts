/**
 * slugifyKey 单测：英文名转 slug、纯中文回退、冲突加后缀、首字符非字母前置。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { slugifyKey } from '../../src/domain/validation';

test('英文显示名 → 小写下划线 slug', () => {
  assert.equal(slugifyKey('Height'), 'height');
  assert.equal(slugifyKey('Height (cm)'), 'height_cm');
  assert.equal(slugifyKey('  Emergency   Contact  '), 'emergency_contact');
  assert.equal(slugifyKey('Level-2 progress!!'), 'level_2_progress');
});

test('纯中文（无 ascii 字母数字）→ field_ 前缀的生成式 key', () => {
  const k = slugifyKey('身高');
  assert.match(k, /^field_[a-z0-9]+$/);
});

test('首字符非字母 → 前置 f_', () => {
  assert.equal(slugifyKey('3rd Level'), 'f_3rd_level');
  assert.equal(slugifyKey('123'), 'f_123');
});

test('与既有 key 冲突 → 依次加 _2 / _3', () => {
  assert.equal(slugifyKey('Height', ['height']), 'height_2');
  assert.equal(slugifyKey('Height', ['height', 'height_2']), 'height_3');
  assert.equal(slugifyKey('Height', ['height', 'height_3']), 'height_2');
});

test('结果始终匹配 /^[a-z][a-z0-9_]*$/', () => {
  for (const label of ['A', '  ', '风格 Style 2', '!!!', '中文名', 'X']) {
    assert.match(slugifyKey(label), /^[a-z][a-z0-9_]*$/, `label=${JSON.stringify(label)}`);
  }
});
