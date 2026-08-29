/**
 * 学员档案的数据读写（仓库层）。
 *
 * 整体类比：这是「档案柜管理员」。上面（IPC / 校验层）把整理好的登记册递进来，
 * 管理员按格子（列）放进柜子；要查的时候按姓名、电话、状态翻找，一次只端一叠出来（分页）。
 * 所有 SQL 都用占位符，绝不把用户填的字拼进语句里。
 */
import { getDb } from '../db/connection';
import { DEFAULT_STUDENT_STATUS, PRESET_COLUMN_NAMES } from '../shared/preset-fields';
import type {
  CustomFieldValue,
  ListQuery,
  ListResult,
  Student,
  StudentListItem,
} from '../shared/types';
import { toCamel } from './validation';
import * as tagsRepo from './tags.repo';

/** 以 JSON 文本存储的列：写入时 stringify，读取时 parse。 */
const JSON_COLUMNS = new Set(['dance_types', 'custom_fields']);

/** 除预设列外，写入时还要带上的元数据列。 */
function nowIso(): string {
  return new Date().toISOString();
}

/** 校验层产出的值对象：驼峰键的预设字段 + customFields 子对象。 */
export interface StudentValues {
  [prop: string]: unknown;
  customFields: Record<string, unknown>;
}

/** 把驼峰值对象转成「列名 → 可绑定值」。数组/对象列转 JSON 文本。 */
function toRow(values: StudentValues): Record<string, string | number | null> {
  const row: Record<string, string | number | null> = {};

  for (const col of PRESET_COLUMN_NAMES) {
    if (col === 'dance_types') continue; // 单独处理
    const v = values[toCamel(col)];
    if (v === undefined || v === null) {
      row[col] = null;
    } else if (typeof v === 'number') {
      row[col] = v;
    } else {
      row[col] = String(v);
    }
  }

  row['dance_types'] = JSON.stringify(
    Array.isArray(values['danceTypes']) ? values['danceTypes'] : [],
  );
  row['custom_fields'] = JSON.stringify(values.customFields ?? {});

  return row;
}

export interface CreateResult {
  id: number;
}

/** 新建一条学员档案，返回自增 id。 */
export function create(values: StudentValues): CreateResult {
  const db = getDb();
  const row = toRow(values);
  // 兜底：status 列非空。正常经 validateStudent 一定有值，这里防御直调 repo 的情况。
  if (row['status'] === null || row['status'] === '') row['status'] = DEFAULT_STUDENT_STATUS;
  const ts = nowIso();
  row['created_at'] = ts;
  row['updated_at'] = ts;

  const cols = Object.keys(row);
  const placeholders = cols.map((c) => `@${c}`).join(', ');
  const stmt = db.prepare(
    `INSERT INTO students (${cols.join(', ')}) VALUES (${placeholders})`,
  );
  const info = stmt.run(row);
  return { id: Number(info.lastInsertRowid) };
}

/** 某 id 是否存在一条“未软删除”的学员。 */
function activeExists(id: number): boolean {
  const db = getDb();
  const row = db
    .prepare(`SELECT 1 FROM students WHERE id = ? AND deleted_at IS NULL`)
    .get(id);
  return row !== undefined;
}

export interface UpdateResult {
  id: number;
}

/** 覆盖式更新一条学员档案；id 不存在（或已软删除）时返回 null。 */
export function update(id: number, values: StudentValues): UpdateResult | null {
  if (!activeExists(id)) return null;
  const db = getDb();
  const row = toRow(values);
  row['updated_at'] = nowIso();

  const assignments = Object.keys(row)
    .map((c) => `${c} = @${c}`)
    .join(', ');
  db.prepare(`UPDATE students SET ${assignments} WHERE id = @id`).run({ ...row, id });
  return { id };
}

/** 软删除：只写 deleted_at 时间戳，不物理删除。id 不存在（或已删）返回 null。 */
export function softDelete(id: number): { id: number } | null {
  if (!activeExists(id)) return null;
  const db = getDb();
  db.prepare(`UPDATE students SET deleted_at = @ts, updated_at = @ts WHERE id = @id`).run({
    ts: nowIso(),
    id,
  });
  return { id };
}

/** LIKE 通配符转义：% _ \ 前面加反斜杠，配合 SQL 里的 ESCAPE '\'。 */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * 列表查询：默认排除已软删除，按姓名不区分大小写排序，分页返回。
 * search 命中 姓名 或 主/备用电话 子串；status 任一命中。
 * （tagIds 在 #8 接入）
 */
export function list(query: ListQuery = {}): ListResult {
  const db = getDb();
  const where: string[] = ['deleted_at IS NULL'];
  const params: Record<string, string | number> = {};

  const search = (query.search ?? '').trim();
  if (search) {
    params['kw'] = `%${escapeLike(search)}%`;
    where.push(
      `(name LIKE @kw ESCAPE '\\' OR phone_primary LIKE @kw ESCAPE '\\' OR phone_secondary LIKE @kw ESCAPE '\\')`,
    );
  }

  const statuses = (query.status ?? []).filter((s) => s && s.length > 0);
  if (statuses.length > 0) {
    const keys = statuses.map((s, i) => {
      params[`st${i}`] = s;
      return `@st${i}`;
    });
    where.push(`status IN (${keys.join(', ')})`);
  }

  const tagIds = (query.tagIds ?? []).map(Number).filter((n) => Number.isInteger(n));
  if (tagIds.length > 0) {
    const keys = tagIds.map((tid, i) => {
      params[`tag${i}`] = tid;
      return `@tag${i}`;
    });
    where.push(
      `id IN (SELECT student_id FROM student_tags WHERE tag_id IN (${keys.join(', ')}))`,
    );
  }

  const whereSql = where.join(' AND ');

  const total = (
    db.prepare(`SELECT COUNT(*) AS n FROM students WHERE ${whereSql}`).get(params) as {
      n: number;
    }
  ).n;

  const limit = Number.isInteger(query.limit) ? Math.max(1, query.limit as number) : 100;
  const offset = Number.isInteger(query.offset) ? Math.max(0, query.offset as number) : 0;
  params['lim'] = limit;
  params['off'] = offset;

  const rows = db
    .prepare(
      `SELECT id, name, phone_primary AS phonePrimary, status
         FROM students
        WHERE ${whereSql}
        ORDER BY name COLLATE NOCASE
        LIMIT @lim OFFSET @off`,
    )
    .all(params) as StudentListItem[];

  return { rows, total };
}

/** 供后续 issue 复用：判断某列是否以 JSON 文本存储。 */
export function isJsonColumn(col: string): boolean {
  return JSON_COLUMNS.has(col);
}

/**
 * 导出用：按同一套筛选条件取「全部匹配」的完整学员记录（含自定义字段与标签），
 * 不分页、不含已软删除。学员量大时是 N+1，但导出是一次性动作，可接受。
 */
export function listForExport(query: ListQuery = {}): Student[] {
  const ids = list({ ...query, limit: Number.MAX_SAFE_INTEGER, offset: 0 }).rows.map((r) => r.id);
  const out: Student[] = [];
  for (const id of ids) {
    const s = get(id);
    if (s) out.push(s);
  }
  return out;
}

/* ─────────────────────────── 读取单条 ─────────────────────────── */

/** 坏 JSON 不让整条档案打不开：解析失败退回默认值并告警。 */
function parseJsonArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    console.warn('[students.repo] dance_types JSON 解析失败，按空数组处理：', raw);
    return [];
  }
}

function parseJsonObject(raw: unknown): Record<string, CustomFieldValue> {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, CustomFieldValue>)
      : {};
  } catch {
    console.warn('[students.repo] custom_fields JSON 解析失败，按空对象处理：', raw);
    return {};
  }
}

/** 数据库行（下划线列）→ Student（驼峰属性）。 */
function rowToStudent(row: Record<string, unknown>): Student {
  const str = (col: string): string | null => {
    const v = row[col];
    return v === null || v === undefined ? null : String(v);
  };
  const s: Record<string, unknown> = {
    id: Number(row['id']),
    danceTypes: parseJsonArray(row['dance_types']),
    remainingLessons:
      row['remaining_lessons'] === null || row['remaining_lessons'] === undefined
        ? null
        : Number(row['remaining_lessons']),
    status: String(row['status']),
    customFields: parseJsonObject(row['custom_fields']),
    tags: [], // 标签在 #8 hydrate
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
    deletedAt: str('deleted_at'),
  };

  // 其余预设列：统一按可空字符串搬运（dance_types / remaining_lessons / status 已单独处理）
  for (const col of PRESET_COLUMN_NAMES) {
    if (col === 'dance_types' || col === 'remaining_lessons' || col === 'status') continue;
    s[toCamel(col)] = str(col);
  }

  return s as unknown as Student;
}

/** 按 id 取一条学员（含已软删除的，用于导出边界与未来的恢复）；不存在返回 null。 */
export function get(id: number): Student | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM students WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  const student = rowToStudent(row);
  student.tags = tagsRepo.forStudent(id);
  return student;
}

/**
 * 该学员各字段「已存的值」，键为字段 key（预设用下划线、自定义用 fieldKey），值为字符串数组。
 * 用于编辑校验时放宽 select/multiselect：选项后来被删掉，旧值仍能原样保留。
 */
export function historicalValues(id: number): Record<string, string[]> {
  const student = get(id);
  if (!student) return {};
  const out: Record<string, string[]> = {};

  for (const col of PRESET_COLUMN_NAMES) {
    if (col === 'dance_types') {
      if (student.danceTypes.length) out[col] = [...student.danceTypes];
      continue;
    }
    const v = (student as unknown as Record<string, unknown>)[toCamel(col)];
    if (v !== null && v !== undefined && v !== '') out[col] = [String(v)];
  }

  for (const [key, v] of Object.entries(student.customFields)) {
    if (v === null || v === undefined || v === '') continue;
    out[key] = Array.isArray(v) ? v.map((x) => String(x)) : [String(v)];
  }

  return out;
}
