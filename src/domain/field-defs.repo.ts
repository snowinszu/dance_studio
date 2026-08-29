/**
 * 自定义字段定义的读写（仓库层）。
 *
 * 整体类比：这是活页本里那叠「标签说明卡」。管理者写一张新卡（增字段），
 * 系统给它编一个英文抽屉号（field_key），塞进 field_definitions 抽屉。
 * 预设字段不在这里——它们是封面上印死的栏目，由 shared/preset-fields.ts 描述。
 */
import { getDb } from '../db/connection';
import { GROUP_KEYS, slugifyKey, validateFieldDef } from './validation';
import { AppError } from '../shared/app-error';
import type {
  CustomFieldDef,
  CustomFieldInput,
  CustomFieldPatch,
  FieldDescriptor,
} from '../shared/types';

function nowIso(): string {
  return new Date().toISOString();
}

/** field_definitions 行（下划线 + 0/1）→ CustomFieldDef（驼峰 + boolean）。 */
function rowToDef(row: Record<string, unknown>): CustomFieldDef {
  let options: string[] = [];
  try {
    const parsed = JSON.parse(String(row['options'] ?? '[]'));
    if (Array.isArray(parsed)) options = parsed.map((x) => String(x));
  } catch {
    options = [];
  }
  return {
    id: Number(row['id']),
    fieldKey: String(row['field_key']),
    label: String(row['label']),
    type: String(row['type']) as CustomFieldDef['type'],
    options,
    required: Number(row['required']) === 1,
    groupKey: String(row['group_key']) as CustomFieldDef['groupKey'],
    sortOrder: Number(row['sort_order']),
    sensitive: Number(row['sensitive']) === 1,
    archived: Number(row['archived']) === 1,
    defaultValue: row['default_value'] === null || row['default_value'] === undefined
      ? null
      : String(row['default_value']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

export interface ListOpts {
  includeArchived?: boolean;
}

/** 列出自定义字段定义，按 sort_order 再按 id 排序。默认排除已归档。 */
export function list(opts: ListOpts = {}): CustomFieldDef[] {
  const db = getDb();
  const where = opts.includeArchived ? '' : 'WHERE archived = 0';
  const rows = db
    .prepare(`SELECT * FROM field_definitions ${where} ORDER BY sort_order, id`)
    .all() as Record<string, unknown>[];
  return rows.map(rowToDef);
}

/**
 * 未归档自定义字段 → FieldDescriptor（按 sortOrder 排好）。
 * 供 buildSchema 合并、以及导入/导出确定字段类型时复用。
 */
export function descriptors(): FieldDescriptor[] {
  return list({ includeArchived: false })
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((d) => ({
      key: d.fieldKey,
      label: d.label,
      type: d.type,
      group: d.groupKey,
      options: d.options,
      required: d.required,
      sensitive: d.sensitive,
      origin: 'custom' as const,
      archived: false,
    }));
}

/** 按 id 取一条（含已归档）。 */
export function getById(id: number): CustomFieldDef | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM field_definitions WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToDef(row) : null;
}

/** 新增一个自定义字段定义；label 非法时抛 VALIDATION_FAILED。 */
export function create(input: CustomFieldInput): CustomFieldDef {
  const { clean, errors } = validateFieldDef(input);
  if (Object.keys(errors).length > 0) {
    throw new AppError('VALIDATION_FAILED', '请检查字段设置', errors);
  }

  const db = getDb();
  const existingKeys = (
    db.prepare(`SELECT field_key FROM field_definitions`).all() as { field_key: string }[]
  ).map((r) => r.field_key);
  const fieldKey = slugifyKey(clean.label, existingKeys);

  const maxOrder =
    (db.prepare(`SELECT MAX(sort_order) AS m FROM field_definitions`).get() as { m: number | null })
      .m ?? 0;

  const ts = nowIso();
  const info = db
    .prepare(
      `INSERT INTO field_definitions
         (field_key, label, type, options, required, group_key, sort_order, sensitive, archived, default_value, created_at, updated_at)
       VALUES
         (@field_key, @label, @type, @options, @required, @group_key, @sort_order, @sensitive, 0, @default_value, @created_at, @updated_at)`,
    )
    .run({
      field_key: fieldKey,
      label: clean.label,
      type: clean.type,
      options: JSON.stringify(clean.options),
      required: clean.required ? 1 : 0,
      group_key: clean.groupKey,
      sort_order: maxOrder + 1,
      sensitive: clean.sensitive ? 1 : 0,
      default_value: clean.defaultValue,
      created_at: ts,
      updated_at: ts,
    });

  const created = getById(Number(info.lastInsertRowid));
  if (!created) throw new AppError('DB_ERROR', '字段创建后读取失败');
  return created;
}

/**
 * 编辑一个自定义字段。允许改 label / options / required / group_key / sort_order；
 * 明确拒绝改 type（存量数据类型会冲突）。
 */
export function update(id: number, patch: CustomFieldPatch & { type?: unknown }): CustomFieldDef {
  if (patch && 'type' in patch && patch.type !== undefined) {
    throw new AppError('FIELD_TYPE_IMMUTABLE', '字段类型创建后不可修改');
  }
  const current = getById(id);
  if (!current) throw new AppError('NOT_FOUND', '字段不存在');

  const errors: Record<string, string> = {};
  const sets: Record<string, string | number> = {};

  if (patch.label !== undefined) {
    const label = String(patch.label).trim();
    if (label.length === 0) errors['label'] = '请填写显示名称';
    else if (label.length > 40) errors['label'] = '显示名称不超过 40 字';
    else sets['label'] = label;
  }
  if (patch.groupKey !== undefined) {
    if (!GROUP_KEYS.includes(patch.groupKey)) errors['groupKey'] = '未知的分组';
    else sets['group_key'] = patch.groupKey;
  }
  if (patch.required !== undefined) sets['required'] = patch.required ? 1 : 0;
  if (patch.sensitive !== undefined) sets['sensitive'] = patch.sensitive ? 1 : 0;
  if (patch.sortOrder !== undefined && Number.isFinite(Number(patch.sortOrder))) {
    sets['sort_order'] = Number(patch.sortOrder);
  }
  if (patch.options !== undefined) {
    if (current.type === 'select' || current.type === 'multiselect') {
      const opts = [
        ...new Set(
          (Array.isArray(patch.options) ? patch.options : [])
            .map((o) => String(o).trim())
            .filter((o) => o.length > 0),
        ),
      ];
      if (opts.length === 0) errors['options'] = '请至少保留一个选项';
      else if (opts.some((o) => o.length > 40)) errors['options'] = '单个选项不超过 40 字';
      else sets['options'] = JSON.stringify(opts);
    }
    // 非 select/multiselect 传 options 直接忽略
  }

  if (Object.keys(errors).length > 0) {
    throw new AppError('VALIDATION_FAILED', '请检查字段设置', errors);
  }

  if (Object.keys(sets).length > 0) {
    sets['updated_at'] = nowIso();
    const assignments = Object.keys(sets)
      .map((c) => `${c} = @${c}`)
      .join(', ');
    getDb()
      .prepare(`UPDATE field_definitions SET ${assignments} WHERE id = @id`)
      .run({ ...sets, id });
  }

  return getById(id)!;
}

/** 归档：archived=1。不触碰任何学员的 custom_fields。 */
export function archive(id: number): CustomFieldDef {
  return setArchived(id, true);
}

/** 恢复：archived=0。 */
export function restore(id: number): CustomFieldDef {
  return setArchived(id, false);
}

function setArchived(id: number, archived: boolean): CustomFieldDef {
  const current = getById(id);
  if (!current) throw new AppError('NOT_FOUND', '字段不存在');
  getDb()
    .prepare(`UPDATE field_definitions SET archived = @a, updated_at = @ts WHERE id = @id`)
    .run({ a: archived ? 1 : 0, ts: nowIso(), id });
  return getById(id)!;
}

/**
 * 按给定 id 顺序重写 sort_order（0,1,2…）。未在列表中的字段保持原值。
 * 在一个事务里完成，避免中途出现重复序号。
 */
export function reorder(ids: number[]): CustomFieldDef[] {
  const db = getDb();
  const stmt = db.prepare(`UPDATE field_definitions SET sort_order = @o, updated_at = @ts WHERE id = @id`);
  const ts = nowIso();
  const tx = db.transaction((list: number[]) => {
    list.forEach((id, i) => stmt.run({ o: i, ts, id }));
  });
  tx(ids);
  return list({ includeArchived: true });
}
