/**
 * 库存管理的数据读写（仓库层）。
 *
 * 整体类比：仓管员手里的两本账——物件台账（inventory_items）和领用流水
 * （item_allocations）。本文件按操作把这两本账的读写封起来；「分配扣减」「删除回补」
 * 这类要同时动两本账的操作，一律包在一个事务里（见后续 issue）。
 *
 * 所有 SQL 走预编译语句 + 命名参数，绝不把用户输入拼进语句。
 */
import { getDb } from '../db/connection';
import type {
  InventoryItem,
  InventoryListQuery,
  InventoryListResult,
} from '../shared/types';

/** LIKE 通配符转义：% _ \ 前面加反斜杠，配合 SQL 里的 ESCAPE '\'。 */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** SELECT 出来的列名 → InventoryItem 字段的映射，多处复用。 */
const ITEM_COLUMNS = `
  id,
  name,
  category,
  unit,
  quantity,
  low_stock_threshold AS lowStockThreshold,
  note,
  created_at          AS createdAt,
  updated_at          AS updatedAt,
  deleted_at          AS deletedAt
`;

/**
 * 物件列表：默认排除已软删除，按物件名不区分大小写排序，分页返回。
 *
 * - search 命中 name 子串（% _ \ 已转义）
 * - category 精确匹配（空字符串视为不筛选）
 * - lowStockOnly 只留 quantity <= low_stock_threshold 的物件
 *
 * 返回里的 lowStockCount 是**独立统计**：未软删物件中低于阈值的总数，
 * 不受 search / category / 分页影响——给列表顶部「N 个物件库存偏低」用。
 */
export function listItems(query: InventoryListQuery = {}): InventoryListResult {
  const db = getDb();
  const where: string[] = ['deleted_at IS NULL'];
  const params: Record<string, string | number> = {};

  const search = (query.search ?? '').trim();
  if (search) {
    params['kw'] = `%${escapeLike(search)}%`;
    where.push(`name LIKE @kw ESCAPE '\\'`);
  }

  const category = (query.category ?? '').trim();
  if (category) {
    params['cat'] = category;
    where.push('category = @cat');
  }

  if (query.lowStockOnly === true) {
    where.push('quantity <= low_stock_threshold');
  }

  const whereSql = where.join(' AND ');

  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM inventory_items WHERE ${whereSql}`).get(params) as {
      n: number;
    }
  ).n;

  const limit = Number.isInteger(query.limit) ? Math.max(1, query.limit as number) : 100;
  const offset = Number.isInteger(query.offset) ? Math.max(0, query.offset as number) : 0;
  params['lim'] = limit;
  params['off'] = offset;

  const rows = db
    .prepare(
      `SELECT ${ITEM_COLUMNS}
         FROM inventory_items
        WHERE ${whereSql}
        ORDER BY name COLLATE NOCASE
        LIMIT @lim OFFSET @off`,
    )
    .all(params) as InventoryItem[];

  const lowStockCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM inventory_items
          WHERE deleted_at IS NULL AND quantity <= low_stock_threshold`,
      )
      .get() as { n: number }
  ).n;

  return { rows, total, lowStockCount };
}
