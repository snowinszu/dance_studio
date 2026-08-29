/**
 * 学员档案的权威校验 + 表单描述构造。
 *
 * 整体类比：这是「验收员」。渲染层填完表格递进来，验收员按每一栏该长什么样
 * （文本 / 数字 / 日期 / 手机号 / 单选…）逐项检查，不合格的当场在那一栏画个红叉，
 * 合格的抄写到干净的登记册（values）里交给仓库（repo）入库。
 *
 * 渲染层自己也会做一遍即时提示，但那只是体验；数据能不能进库，以这里为准。
 */
import {
  GROUPS,
  PRESET_FIELDS,
  DEFAULT_STUDENT_STATUS,
} from '../shared/preset-fields';
import type {
  CustomFieldInput,
  FieldDescriptor,
  FieldType,
  GroupKey,
  SchemaGroup,
  StudentInput,
} from '../shared/types';

/** 自定义字段允许的全部类型。 */
export const FIELD_TYPES: readonly FieldType[] = [
  'text',
  'textarea',
  'number',
  'date',
  'select',
  'multiselect',
  'boolean',
  'phone',
  'money',
];

/** 5 个合法分组键。 */
export const GROUP_KEYS: readonly GroupKey[] = GROUPS.map((g) => g.key);

/** 下划线列名 → 驼峰属性名（birth_date → birthDate）。 */
export function toCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/** 预设字段 → 统一的 FieldDescriptor 形态（顺序即 PRESET_FIELDS 顺序）。 */
export function presetDescriptors(): FieldDescriptor[] {
  return PRESET_FIELDS.map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type,
    group: f.group,
    options: f.options ? [...f.options] : [],
    required: f.required ?? false,
    sensitive: f.sensitive ?? false,
    origin: 'preset' as const,
    archived: false,
  }));
}

/**
 * 构造整张表单描述：5 个分组，组内预设在前、自定义在后。
 * @param customDescriptors 已按 sortOrder 排好的自定义字段描述（本阶段传空；#6 起接入）
 */
export function buildSchema(customDescriptors: FieldDescriptor[] = []): SchemaGroup[] {
  const all = [...presetDescriptors(), ...customDescriptors];
  return [...GROUPS]
    .sort((a, b) => a.order - b.order)
    .map((g) => ({
      key: g.key,
      label: g.label,
      fields: all.filter((f) => f.group === g.key),
    }));
}

export interface ValidatedStudent {
  /** 驼峰键的预设字段值 + customFields 子对象，直接交给 repo */
  values: Record<string, unknown> & { customFields: Record<string, unknown> };
  /** 字段 key（下划线/自定义 fieldKey）→ 错误提示；为空表示校验通过 */
  errors: Record<string, string>;
}

/** 空值判定：null / undefined / 空串（trim 后）/ 空数组。数字 0 与布尔 false 不算空。 */
function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

/** 按类型把原始输入归一化成规范形态（不做合法性判断，那是下一步）。 */
function normalize(raw: unknown, type: FieldDescriptor['type']): unknown {
  switch (type) {
    case 'text':
    case 'textarea':
    case 'phone':
    case 'select':
    case 'date':
      return typeof raw === 'string' ? raw.trim() : raw == null ? null : String(raw).trim();
    case 'number':
    case 'money': {
      if (typeof raw === 'number') return raw;
      if (raw == null || raw === '') return null;
      const n = Number(String(raw).trim());
      return Number.isNaN(n) ? String(raw) : n; // 非数字原样留着，让 checkType 报错
    }
    case 'boolean': {
      if (raw === true || raw === false) return raw;
      if (raw === 'true' || raw === 1 || raw === '1' || raw === '是') return true;
      if (raw === 'false' || raw === 0 || raw === '0' || raw === '否') return false;
      if (raw == null || raw === '') return null;
      return raw; // 非法值，交给 checkType
    }
    case 'multiselect': {
      if (Array.isArray(raw)) return raw.map((x) => String(x));
      if (raw == null || raw === '') return [];
      return [String(raw)];
    }
  }
}

/** 该类型的“空值默认落位”：多选是 []，其余是 null。 */
function emptyValue(type: FieldDescriptor['type']): unknown {
  return type === 'multiselect' ? [] : null;
}

const PHONE_RE = /^1[3-9]\d{9}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 校验单个已归一化的值；返回错误文案，或 null 表示通过。允许历史值集合放宽 select。 */
function checkType(value: unknown, d: FieldDescriptor, allowedExtra: string[] = []): string | null {
  switch (d.type) {
    case 'text':
      return typeof value === 'string' && value.length > 200 ? '不超过 200 字' : null;
    case 'textarea':
      return typeof value === 'string' && value.length > 2000 ? '不超过 2000 字' : null;
    case 'phone':
      return typeof value === 'string' && PHONE_RE.test(value) ? null : '请输入正确的手机号';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : '请输入数字';
    case 'money': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '请输入金额';
      if (value < 0) return '金额不能为负';
      const decimals = String(value).includes('.') ? String(value).split('.')[1]!.length : 0;
      return decimals > 2 ? '金额最多两位小数' : null;
    }
    case 'date': {
      if (typeof value !== 'string' || !DATE_RE.test(value)) return '日期格式应为 YYYY-MM-DD';
      const [y, m, day] = value.split('-').map(Number) as [number, number, number];
      const dt = new Date(y, m - 1, day);
      const real = dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === day;
      return real ? null : '不是有效日期';
    }
    case 'boolean':
      return value === true || value === false ? null : '取值无效';
    case 'select': {
      const allowed = new Set([...d.options, ...allowedExtra]);
      return typeof value === 'string' && allowed.has(value) ? null : '取值不在候选项内';
    }
    case 'multiselect': {
      if (!Array.isArray(value)) return '取值格式不正确';
      if (d.options.length === 0) return null;
      const allowed = new Set([...d.options, ...allowedExtra]);
      return value.every((x) => allowed.has(String(x))) ? null : '包含不在候选项内的取值';
    }
  }
}

/**
 * 校验一条学员档案输入。
 *
 * @param input 渲染层递交的原始表单值（预设字段用驼峰键，自定义字段在 customFields）
 * @param groups buildSchema() 的结果
 * @param historicalValues 可选：该学员各字段的历史值，用于放宽已被移除的 select 选项（#7 起用）
 */
export function validateStudent(
  input: StudentInput,
  groups: SchemaGroup[],
  historicalValues: Record<string, string[]> = {},
): ValidatedStudent {
  const errors: Record<string, string> = {};
  const values: ValidatedStudent['values'] = { customFields: {} };

  for (const d of groups.flatMap((g) => g.fields)) {
    if (d.archived) continue; // 归档字段不参与录入
    const isCustom = d.origin === 'custom';
    const prop = isCustom ? d.key : toCamel(d.key);
    const raw = isCustom
      ? (input.customFields ?? {})[d.key]
      : (input as unknown as Record<string, unknown>)[prop];

    const norm = normalize(raw, d.type);

    if (isEmpty(norm)) {
      if (d.key === 'status') {
        // 状态是必填 select，但留空时取默认「在读」而非报错
        values['status'] = DEFAULT_STUDENT_STATUS;
      } else if (d.required) {
        errors[d.key] = '此项为必填';
      } else if (isCustom) {
        values.customFields[d.key] = emptyValue(d.type);
      } else {
        values[prop] = emptyValue(d.type);
      }
      continue;
    }

    const err = checkType(norm, d, historicalValues[d.key] ?? []);
    if (err) {
      errors[d.key] = err;
      continue;
    }

    if (isCustom) values.customFields[d.key] = norm;
    else values[prop] = norm;
  }

  // 预设兜底：状态缺省「在读」
  if (isEmpty(values.status)) values.status = DEFAULT_STUDENT_STATUS;

  return { values, errors };
}

/* ─────────────────────── 自定义字段：key 生成 & 校验 ─────────────────────── */

/**
 * 由显示名生成唯一的英文 field_key。
 * - 小写、非 [a-z0-9] 一律转 '_'，压缩并去首尾 '_'
 * - 结果为空（如纯中文）→ field_<base36 时间戳>
 * - 首字符非字母 → 前置 'f_'
 * - 与既有 key 冲突 → 依次尝试 key_2 / key_3 …
 */
export function slugifyKey(label: string, existing: Iterable<string> = []): string {
  let base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (base.length === 0) base = `field_${Date.now().toString(36)}`;
  if (!/^[a-z]/.test(base)) base = `f_${base}`;

  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

/** 校验「新增自定义字段」的入参；返回 { clean, errors }。 */
export function validateFieldDef(input: CustomFieldInput): {
  clean: {
    label: string;
    type: FieldType;
    groupKey: GroupKey;
    required: boolean;
    options: string[];
    defaultValue: string | null;
    sensitive: boolean;
  };
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};

  const label = typeof input.label === 'string' ? input.label.trim() : '';
  if (label.length === 0) errors['label'] = '请填写显示名称';
  else if (label.length > 40) errors['label'] = '显示名称不超过 40 字';

  const type = input.type;
  if (!FIELD_TYPES.includes(type)) errors['type'] = '不支持的字段类型';

  const groupKey = input.groupKey;
  if (!GROUP_KEYS.includes(groupKey)) errors['groupKey'] = '未知的分组';

  let options: string[] = [];
  if (type === 'select' || type === 'multiselect') {
    const raw = Array.isArray(input.options) ? input.options : [];
    options = [...new Set(raw.map((o) => String(o).trim()).filter((o) => o.length > 0))];
    if (options.length === 0) errors['options'] = '请至少添加一个选项';
    else if (options.some((o) => o.length > 40)) errors['options'] = '单个选项不超过 40 字';
  }

  return {
    clean: {
      label,
      type,
      groupKey,
      required: input.required === true,
      options,
      defaultValue:
        typeof input.defaultValue === 'string' && input.defaultValue.length > 0
          ? input.defaultValue
          : null,
      sensitive: input.sensitive === true,
    },
    errors,
  };
}
