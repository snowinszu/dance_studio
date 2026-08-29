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
import { AppError } from '../shared/app-error';
import type {
  Allocation,
  AllocationListQuery,
  AllocationListResult,
  InventoryItem,
  InventoryListQuery,
  InventoryListResult,
} from '../shared/types';
import type { AllocationValues, ItemValues } from './inventory.validation';

function nowIso(): string {
  return new Date().toISOString();
}

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

/* ───────────────────────── 物件 CRUD ───────────────────────── */

/** 某物件名是否已被「未软删」物件占用（编辑时排除自身）。 */
function nameTaken(name: string, exceptId?: number): boolean {
  const db = getDb();
  const sql =
    exceptId === undefined
      ? `SELECT 1 FROM inventory_items WHERE name = @name AND deleted_at IS NULL LIMIT 1`
      : `SELECT 1 FROM inventory_items WHERE name = @name AND deleted_at IS NULL AND id != @exceptId LIMIT 1`;
  return db.prepare(sql).get({ name, exceptId }) !== undefined;
}

/** 读一条物件（含已软删除，供详情 / 导出用）；不存在返回 undefined。 */
export function getItem(id: number): InventoryItem | undefined {
  return getDb()
    .prepare(`SELECT ${ITEM_COLUMNS} FROM inventory_items WHERE id = ?`)
    .get(id) as InventoryItem | undefined;
}

/** 新建物件，返回自增 id。重名（未软删）→ ITEM_NAME_CONFLICT。 */
export function createItem(values: ItemValues): { id: number } {
  if (nameTaken(values.name)) {
    throw new AppError('ITEM_NAME_CONFLICT', '物件已存在', { name: '物件已存在' });
  }
  const ts = nowIso();
  const info = getDb()
    .prepare(
      `INSERT INTO inventory_items
         (name, category, unit, quantity, low_stock_threshold, note, created_at, updated_at)
       VALUES (@name, @category, @unit, @quantity, @lowStockThreshold, @note, @ts, @ts)`,
    )
    .run({
      name: values.name,
      category: values.category,
      unit: values.unit,
      quantity: values.quantity ?? 0,
      lowStockThreshold: values.lowStockThreshold,
      note: values.note,
      ts,
    });
  return { id: Number(info.lastInsertRowid) };
}

/**
 * 覆盖式更新一条物件。
 * - quantity 为 undefined 表示「不改这一项」——用于「只想改分类 / 阈值」的场景
 * - id 不存在或已软删除 → NOT_FOUND
 * - 改名撞未软删同名物件 → ITEM_NAME_CONFLICT
 */
export function updateItem(id: number, values: ItemValues): { id: number } {
  const db = getDb();
  const current = db
    .prepare(`SELECT id FROM inventory_items WHERE id = ? AND deleted_at IS NULL`)
    .get(id);
  if (!current) throw new AppError('NOT_FOUND', '物件不存在，可能已被删除');

  if (nameTaken(values.name, id)) {
    throw new AppError('ITEM_NAME_CONFLICT', '物件已存在', { name: '物件已存在' });
  }

  const sets = [
    'name = @name',
    'category = @category',
    'unit = @unit',
    'low_stock_threshold = @lowStockThreshold',
    'note = @note',
    'updated_at = @ts',
  ];
  const params: Record<string, string | number | null> = {
    id,
    name: values.name,
    category: values.category,
    unit: values.unit,
    lowStockThreshold: values.lowStockThreshold,
    note: values.note,
    ts: nowIso(),
  };
  if (values.quantity !== undefined) {
    sets.push('quantity = @quantity');
    params['quantity'] = values.quantity;
  }

  db.prepare(`UPDATE inventory_items SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return { id };
}

/** 软删除：只写 deleted_at。id 不存在或已删 → NOT_FOUND。 */
export function softDeleteItem(id: number): { id: number } {
  const db = getDb();
  const current = db
    .prepare(`SELECT id FROM inventory_items WHERE id = ? AND deleted_at IS NULL`)
    .get(id);
  if (!current) throw new AppError('NOT_FOUND', '物件不存在，可能已被删除');
  const ts = nowIso();
  db.prepare(`UPDATE inventory_items SET deleted_at = @ts, updated_at = @ts WHERE id = @id`).run({
    ts,
    id,
  });
  return { id };
}

/* ───────────────────────── 领用（分配扣减） ───────────────────────── */

/**
 * 分配一件物件给学员：一个事务里「扣库存 + 记流水」，要么都成、要么都不动。
 *
 * 守卫更新 `... WHERE id=@itemId AND deleted_at IS NULL AND quantity >= @qty`：
 * - 从 SQL 层面保证库存**不为负**
 * - 防「渲染层拿了旧数据」「导入连领同一物件」等竞态
 * `changes !== 1` 即没扣成（物件不存在 / 已软删 / 库存不够）→ 抛 INSUFFICIENT_STOCK，事务回滚。
 *
 * @returns 新流水 id + 扣减后的剩余库存
 */
export function allocate(values: AllocationValues): { id: number; remaining: number } {
  const db = getDb();
  const now = nowIso();

  const tx = db.transaction((): number => {
    const upd = db
      .prepare(
        `UPDATE inventory_items
            SET quantity = quantity - @qty, updated_at = @now
          WHERE id = @itemId AND deleted_at IS NULL AND quantity >= @qty`,
      )
      .run({ itemId: values.itemId, qty: values.quantity, now });

    if (upd.changes !== 1) {
      throw new AppError('INSUFFICIENT_STOCK', '库存不足，或物件不存在', {
        quantity: '库存不足',
      });
    }

    const ins = db
      .prepare(
        `INSERT INTO item_allocations
           (item_id, student_id, quantity, claimed_at, note, created_at)
         VALUES (@itemId, @studentId, @qty, @claimedAt, @note, @now)`,
      )
      .run({
        itemId: values.itemId,
        studentId: values.studentId,
        qty: values.quantity,
        claimedAt: values.claimedAt,
        note: values.note,
        now,
      });
    return Number(ins.lastInsertRowid);
  });

  const id = tx();
  const remaining = (
    db.prepare(`SELECT quantity AS n FROM inventory_items WHERE id = ?`).get(values.itemId) as {
      n: number;
    }
  ).n;
  return { id, remaining };
}

/* ───────────────────────── 领用流水（读） ───────────────────────── */

/**
 * 领用流水列表：JOIN 出物件名 / 学员姓名 / 电话（物件即使已软删也照常带出），
 * 按领取日期倒序，分页。claimed_at 是 YYYY-MM-DD 字符串，直接字符串比较即时间序。
 */
export function listAllocations(query: AllocationListQuery = {}): AllocationListResult {
  const db = getDb();
  const where: string[] = ['1 = 1'];
  const params: Record<string, string | number> = {};

  const dateFrom = (query.dateFrom ?? '').trim();
  if (dateFrom) {
    params['df'] = dateFrom;
    where.push('a.claimed_at >= @df');
  }
  const dateTo = (query.dateTo ?? '').trim();
  if (dateTo) {
    params['dt'] = dateTo;
    where.push('a.claimed_at <= @dt');
  }
  if (Number.isInteger(query.studentId)) {
    params['sid'] = query.studentId as number;
    where.push('a.student_id = @sid');
  }
  if (Number.isInteger(query.itemId)) {
    params['iid'] = query.itemId as number;
    where.push('a.item_id = @iid');
  }

  const whereSql = where.join(' AND ');

  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM item_allocations a WHERE ${whereSql}`).get(params) as {
      n: number;
    }
  ).n;

  const limit = Number.isInteger(query.limit) ? Math.max(1, query.limit as number) : 100;
  const offset = Number.isInteger(query.offset) ? Math.max(0, query.offset as number) : 0;
  params['lim'] = limit;
  params['off'] = offset;

  const rows = db
    .prepare(
      `SELECT a.id,
              a.item_id            AS itemId,
              i.name               AS itemName,
              a.student_id         AS studentId,
              s.name               AS studentName,
              s.phone_primary      AS studentPhone,
              a.quantity,
              a.claimed_at         AS claimedAt,
              a.note,
              a.created_at         AS createdAt
         FROM item_allocations a
         JOIN inventory_items i ON i.id = a.item_id
         JOIN students        s ON s.id = a.student_id
        WHERE ${whereSql}
        ORDER BY a.claimed_at DESC, a.id DESC
        LIMIT @lim OFFSET @off`,
    )
    .all(params) as Allocation[];

  return { rows, total };
}
