/**
 * 应用级设置：数量很少、改动也很少的全局配置，存在 app_settings 键值表。
 *
 * 整体类比：店门口的「规则便签」，内容不多，不值得为每一项单独开列、单独写
 * 校验文件——这里按「每个设置一对有类型、有校验的读写函数」的思路封装，
 * 调用方（reports 仓库、设置页 IPC）不需要关心底下是 key-value 还是独立列。
 */
import { getDb } from '../db/connection';
import { AppError } from '../shared/app-error';

function nowIso(): string {
  return new Date().toISOString();
}

function getRaw(key: string): string | undefined {
  const row = getDb()
    .prepare(`SELECT value FROM app_settings WHERE key = @key`)
    .get({ key }) as { value: string } | undefined;
  return row?.value;
}

function setRaw(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO app_settings (key, value, updated_at) VALUES (@key, @value, @ts)
         ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @ts`,
    )
    .run({ key, value, ts: nowIso() });
}

/** 课时余额预警阈值：在读学员剩余课时 <= 此值即计入「课时余额预警」。未设置过时的缺省值。 */
const LOW_BALANCE_THRESHOLD_KEY = 'lowBalanceThreshold';
const DEFAULT_LOW_BALANCE_THRESHOLD = 3;

/** 读取课时余额预警阈值；从未设置过则回退默认值 3（与原硬编码口径一致）。 */
export function getLowBalanceThreshold(): number {
  const raw = getRaw(LOW_BALANCE_THRESHOLD_KEY);
  if (raw === undefined) return DEFAULT_LOW_BALANCE_THRESHOLD;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_LOW_BALANCE_THRESHOLD;
}

/** 设置课时余额预警阈值；必须是不小于 0 的整数，否则抛 VALIDATION_FAILED。 */
export function setLowBalanceThreshold(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new AppError('VALIDATION_FAILED', '预警阈值必须是不小于 0 的整数', {
      threshold: '预警阈值必须是不小于 0 的整数',
    });
  }
  setRaw(LOW_BALANCE_THRESHOLD_KEY, String(n));
  return n;
}
