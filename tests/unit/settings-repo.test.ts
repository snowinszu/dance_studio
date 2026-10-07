/**
 * settings.repo 的键值配置单测：独立进程 / 独立 :memory: 库。
 * 覆盖：未设置过时的默认值、set/get 往返、非法输入拒绝。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import { getLowBalanceThreshold, setLowBalanceThreshold } from '../../src/domain/settings.repo';

process.env['STUDIO_DB_PATH'] = ':memory:';
run(getDb());

test('getLowBalanceThreshold：从未设置过 → 默认值 3', () => {
  assert.equal(getLowBalanceThreshold(), 3);
});

test('setLowBalanceThreshold：往返一致，覆盖写入也生效', () => {
  assert.equal(setLowBalanceThreshold(5), 5);
  assert.equal(getLowBalanceThreshold(), 5);

  assert.equal(setLowBalanceThreshold(0), 0);
  assert.equal(getLowBalanceThreshold(), 0);

  assert.equal(setLowBalanceThreshold(10), 10);
  assert.equal(getLowBalanceThreshold(), 10);
});

test('setLowBalanceThreshold：数字字符串也能归一化为整数', () => {
  assert.equal(setLowBalanceThreshold('7'), 7);
  assert.equal(getLowBalanceThreshold(), 7);
});

test('setLowBalanceThreshold：负数 / 非整数 / 非数字 → VALIDATION_FAILED，不改变原值', () => {
  setLowBalanceThreshold(4);
  for (const bad of [-1, 1.5, NaN, 'abc', undefined]) {
    assert.throws(
      () => setLowBalanceThreshold(bad),
      (e: unknown) => e instanceof Error && (e as { code?: string }).code === 'VALIDATION_FAILED',
    );
  }
  assert.equal(getLowBalanceThreshold(), 4, '非法输入不应改变已保存的值');
});
