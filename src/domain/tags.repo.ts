/**
 * 标签的读写（仓库层）。
 *
 * 整体类比：一叠可反复贴撕的便利贴。tags 表是「便利贴样式册」，
 * student_tags 是「谁身上贴了哪几张」。撕掉一种便利贴（删标签），
 * 靠数据库外键的 ON DELETE CASCADE 自动把所有人身上对应的那张也撕掉
 * （前提是连接层开了 PRAGMA foreign_keys=ON，见 db/connection.ts）。
 */
import { getDb } from '../db/connection';
import { AppError } from '../shared/app-error';
import type { Tag } from '../shared/types';

function rowToTag(row: Record<string, unknown>): Tag {
  return {
    id: Number(row['id']),
    name: String(row['name']),
    color: row['color'] === null || row['color'] === undefined ? null : String(row['color']),
  };
}

/** 全部标签，按名称不区分大小写排序。 */
export function list(): Tag[] {
  return (
    getDb()
      .prepare(`SELECT id, name, color FROM tags ORDER BY name COLLATE NOCASE`)
      .all() as Record<string, unknown>[]
  ).map(rowToTag);
}

export function getById(id: number): Tag | null {
  const row = getDb().prepare(`SELECT id, name, color FROM tags WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToTag(row) : null;
}

/** 新建标签；重名（不区分大小写）→ TAG_NAME_CONFLICT。 */
export function create(input: { name?: string; color?: string | null }): Tag {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0) throw new AppError('BAD_REQUEST', '标签名不能为空');
  if (name.length > 20) throw new AppError('BAD_REQUEST', '标签名不超过 20 字');

  const db = getDb();
  const dup = db.prepare(`SELECT 1 FROM tags WHERE name = ? COLLATE NOCASE`).get(name);
  if (dup) throw new AppError('TAG_NAME_CONFLICT', '标签已存在');

  const color = typeof input.color === 'string' && input.color.length > 0 ? input.color : null;
  const info = db.prepare(`INSERT INTO tags (name, color) VALUES (?, ?)`).run(name, color);
  return getById(Number(info.lastInsertRowid))!;
}

/** 重命名 / 改色。重名 → TAG_NAME_CONFLICT。 */
export function update(id: number, patch: { name?: string; color?: string | null }): Tag {
  const current = getById(id);
  if (!current) throw new AppError('NOT_FOUND', '标签不存在');

  const db = getDb();
  const sets: Record<string, string | null> = {};

  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (name.length === 0) throw new AppError('BAD_REQUEST', '标签名不能为空');
    if (name.length > 20) throw new AppError('BAD_REQUEST', '标签名不超过 20 字');
    const dup = db
      .prepare(`SELECT 1 FROM tags WHERE name = ? COLLATE NOCASE AND id <> ?`)
      .get(name, id);
    if (dup) throw new AppError('TAG_NAME_CONFLICT', '标签已存在');
    sets['name'] = name;
  }
  if (patch.color !== undefined) {
    sets['color'] = typeof patch.color === 'string' && patch.color.length > 0 ? patch.color : null;
  }

  if (Object.keys(sets).length > 0) {
    const assignments = Object.keys(sets)
      .map((c) => `${c} = @${c}`)
      .join(', ');
    db.prepare(`UPDATE tags SET ${assignments} WHERE id = @id`).run({ ...sets, id });
  }
  return getById(id)!;
}

/** 删除标签；student_tags 里的关联由外键级联清除。 */
export function remove(id: number): { id: number } {
  const current = getById(id);
  if (!current) throw new AppError('NOT_FOUND', '标签不存在');
  getDb().prepare(`DELETE FROM tags WHERE id = ?`).run(id);
  return { id };
}

/** 该学员当前的标签。 */
export function forStudent(studentId: number): Tag[] {
  return (
    getDb()
      .prepare(
        `SELECT t.id, t.name, t.color
           FROM tags t
           JOIN student_tags st ON st.tag_id = t.id
          WHERE st.student_id = ?
          ORDER BY t.name COLLATE NOCASE`,
      )
      .all(studentId) as Record<string, unknown>[]
  ).map(rowToTag);
}

/** 全量重写某学员的标签集合，返回重写后的标签列表。 */
export function setForStudent(studentId: number, tagIds: number[]): Tag[] {
  const db = getDb();
  const exists = db
    .prepare(`SELECT 1 FROM students WHERE id = ? AND deleted_at IS NULL`)
    .get(studentId);
  if (!exists) throw new AppError('NOT_FOUND', '学员不存在，可能已被删除');

  const uniqueIds = [...new Set(tagIds.map(Number).filter((n) => Number.isInteger(n)))];
  const validIds = uniqueIds.filter((tid) => db.prepare(`SELECT 1 FROM tags WHERE id = ?`).get(tid));

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM student_tags WHERE student_id = ?`).run(studentId);
    const ins = db.prepare(`INSERT INTO student_tags (student_id, tag_id) VALUES (?, ?)`);
    for (const tid of validIds) ins.run(studentId, tid);
  });
  tx();

  return forStudent(studentId);
}
