/**
 * 学员档案导出为 .xlsx（主进程，用 exceljs）。
 *
 * 整体类比：把一叠档案卡按固定栏目誊到一张大表上。栏目顺序是死的：
 * 先所有预设字段，再未归档的自定义字段，再「填过值的已归档字段」（表头标『(已归档)』），
 * 最后一列是标签（逗号分隔）。已软删除的学员不誊。
 */
import ExcelJS from 'exceljs';
import { PRESET_FIELDS } from '../shared/preset-fields';
import { toCamel } from '../domain/validation';
import * as studentsRepo from '../domain/students.repo';
import * as fieldDefsRepo from '../domain/field-defs.repo';
import type { CustomFieldValue, FieldType, ListQuery, Student } from '../shared/types';

/** 一个单元格的取值 → 字符串。 */
function formatCell(value: unknown, type: FieldType): string {
  if (value === null || value === undefined || value === '') return '';
  if (Array.isArray(value)) return value.join(', ');
  if (type === 'boolean') return value === true || value === 'true' ? '是' : '否';
  return String(value);
}

interface ColumnSpec {
  header: string;
  key: string;
  type: FieldType;
  pick: (s: Student) => unknown;
}

function hasValue(v: CustomFieldValue | undefined): boolean {
  return v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0);
}

/**
 * 生成导出用的列定义。抽出来是为了让单测能直接断言列顺序，而不必真的写文件。
 */
export function buildColumns(students: Student[]): ColumnSpec[] {
  const customDefs = fieldDefsRepo.list({ includeArchived: true });
  const activeCustom = customDefs
    .filter((d) => !d.archived)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const archivedWithValues = customDefs
    .filter((d) => d.archived)
    .filter((d) => students.some((s) => hasValue(s.customFields?.[d.fieldKey])));

  return [
    ...PRESET_FIELDS.map<ColumnSpec>((f) => ({
      header: f.label,
      key: `p:${f.key}`,
      type: f.type,
      pick: (s) => (s as unknown as Record<string, unknown>)[toCamel(f.key)],
    })),
    ...activeCustom.map<ColumnSpec>((d) => ({
      header: d.label,
      key: `c:${d.fieldKey}`,
      type: d.type,
      pick: (s) => s.customFields?.[d.fieldKey],
    })),
    ...archivedWithValues.map<ColumnSpec>((d) => ({
      header: `${d.label}(已归档)`,
      key: `a:${d.fieldKey}`,
      type: d.type,
      pick: (s) => s.customFields?.[d.fieldKey],
    })),
    {
      header: '标签',
      key: 'tags',
      type: 'text',
      pick: (s) => s.tags.map((t) => t.name),
    },
  ];
}

/**
 * 按筛选条件导出到 filePath，返回导出的行数。
 * 写文件失败时向上抛（由 IPC 层翻译成 IO_WRITE_FAILED）。
 */
export async function exportStudents(query: ListQuery, filePath: string): Promise<number> {
  const students = studentsRepo.listForExport(query);
  const columns = buildColumns(students);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('学员档案');
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: 16 }));

  for (const s of students) {
    const row: Record<string, string> = {};
    for (const c of columns) row[c.key] = formatCell(c.pick(s), c.type);
    ws.addRow(row);
  }

  await wb.xlsx.writeFile(filePath);
  return students.length;
}
