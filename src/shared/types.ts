/**
 * 学员档案模块的共享类型。
 *
 * 整体类比：这份文件是「模具册」——主进程按它造数据、渲染层按它读数据，
 * IPC 两端拿着同一套模具，才不会一边倒水泥、一边收到石膏。
 * 渲染层（students.js）本身不参与 TypeScript 构建，但 studioShell.d.ts 会引用这里，
 * 让编辑器仍能对着同一套模具给提示。
 */

/** 自定义字段支持的 9 种类型。预设字段也复用同一套取值。 */
export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'select'
  | 'multiselect'
  | 'boolean'
  | 'phone'
  | 'money';

/** 档案分组。固定 5 组，管理者只能把字段归到其中之一，不能自定义分组。 */
export type GroupKey = 'basic' | 'contact' | 'course' | 'health' | 'ops';

/** 一个分组的元信息。 */
export interface GroupMeta {
  key: GroupKey;
  label: string;
  order: number;
}

/**
 * 预设字段定义：落在 students 表的真实列上，由 shared/preset-fields.ts 描述，
 * 不进 field_definitions 表。key 必须与 students 列名（下划线风格）一致。
 */
export interface PresetFieldDef {
  key: string;
  label: string;
  type: FieldType;
  group: GroupKey;
  order: number;
  /** select / multiselect 的候选项 */
  options?: readonly string[];
  /** 预设强制必填（当前仅 name / phone_primary） */
  required?: boolean;
  /** 仅打「敏感」标签，本版不做按角色脱敏 */
  sensitive?: boolean;
}

/**
 * 自定义字段定义：值存在 students.custom_fields JSON 对象里，键为 fieldKey。
 * 与数据库表 field_definitions 一一对应（列名下划线 → 这里驼峰）。
 */
export interface CustomFieldDef {
  id: number;
  fieldKey: string;
  label: string;
  type: FieldType;
  /** 仅 select / multiselect 有意义；其余类型为空数组 */
  options: string[];
  required: boolean;
  groupKey: GroupKey;
  sortOrder: number;
  /** 保留字段：UI 可显示「敏感」徽标，本版不强制脱敏 */
  sensitive: boolean;
  /** 软删除：归档后表单/详情不再展示，但学员里的历史值保留 */
  archived: boolean;
  defaultValue: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 渲染层拿到的、与「预设 / 自定义」来源无关的统一字段描述。
 * 表单和详情页都按这个形态渲染控件。
 */
export interface FieldDescriptor {
  key: string;
  label: string;
  type: FieldType;
  group: GroupKey;
  options: string[];
  required: boolean;
  sensitive: boolean;
  origin: 'preset' | 'custom';
  /** 归档字段不进表单；仅在「导出」等需要回显历史值的场景出现 */
  archived: boolean;
}

/** 一个分组 + 组内已排序的字段列表（预设在前，自定义在后）。 */
export interface SchemaGroup {
  key: GroupKey;
  label: string;
  fields: FieldDescriptor[];
}

export interface Tag {
  id: number;
  name: string;
  /** 设计令牌名，如 'cc-3'；null 表示未指定颜色 */
  color: string | null;
}

/**
 * 一条学员档案。预设字段用驼峰键平铺在顶层，自定义字段收在 customFields。
 * 时间戳为 ISO 8601 字符串（SQLite 无日期类型，统一存 TEXT）。
 */
export interface Student {
  id: number;

  // —— 基本信息 ——
  name: string;
  nickname: string | null;
  gender: string | null;
  /** 出生日期 YYYY-MM-DD；年龄在渲染层按当前日期实时算，不落库 */
  birthDate: string | null;

  // —— 联系方式 ——
  guardianName: string | null;
  guardianRelation: string | null;
  phonePrimary: string;
  phoneSecondary: string | null;
  wechat: string | null;
  address: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;

  // —— 课程与会员 ——
  danceTypes: string[];
  className: string | null;
  currentLevel: string | null;
  enrollDate: string | null;
  mainTeacher: string | null;
  classSchedule: string | null;
  cardType: string | null;
  remainingLessons: number | null;
  cardExpireDate: string | null;
  status: string;

  // —— 健康与安全 ——
  healthAllergy: string | null;
  healthHistory: string | null;
  healthNotes: string | null;

  // —— 运营 ——
  sourceChannel: string | null;
  referrer: string | null;
  remark: string | null;

  // —— 自定义 + 元数据 ——
  customFields: Record<string, CustomFieldValue>;
  /** 仅 get() 会 hydrate；list() 不带标签 */
  tags: Tag[];
  createdAt: string;
  updatedAt: string;
  /** 非 null 即已软删除 */
  deletedAt: string | null;
}

/** 自定义字段值的可能形态（按字段 type 决定实际用哪个）。 */
export type CustomFieldValue = string | number | boolean | string[] | null;

/** 列表页每行只需要这几项，避免整条 Student 的开销。 */
export interface StudentListItem {
  id: number;
  name: string;
  phonePrimary: string;
  status: string;
}

/** 新建 / 编辑学员的入参。预设字段用驼峰键，自定义字段收在 customFields。 */
export interface StudentInput {
  name: string;
  phonePrimary: string;
  nickname?: string | null;
  gender?: string | null;
  birthDate?: string | null;
  guardianName?: string | null;
  guardianRelation?: string | null;
  phoneSecondary?: string | null;
  wechat?: string | null;
  address?: string | null;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
  danceTypes?: string[];
  className?: string | null;
  currentLevel?: string | null;
  enrollDate?: string | null;
  mainTeacher?: string | null;
  classSchedule?: string | null;
  cardType?: string | null;
  remainingLessons?: number | null;
  cardExpireDate?: string | null;
  status?: string;
  healthAllergy?: string | null;
  healthHistory?: string | null;
  healthNotes?: string | null;
  sourceChannel?: string | null;
  referrer?: string | null;
  remark?: string | null;
  /** 键 = CustomFieldDef.fieldKey */
  customFields?: Record<string, unknown>;
  /** 一并写 student_tags（可选） */
  tagIds?: number[];
}

/** 列表查询条件。 */
export interface ListQuery {
  /** 匹配 name 或 phone_primary / phone_secondary 子串 */
  search?: string;
  /** 学员状态，任一命中 */
  status?: string[];
  /** 标签 id，任一命中 */
  tagIds?: number[];
  /** 默认 100 */
  limit?: number;
  /** 默认 0 */
  offset?: number;
}

export interface ListResult {
  rows: StudentListItem[];
  total: number;
}

/** 新增自定义字段的入参。 */
export interface CustomFieldInput {
  label: string;
  type: FieldType;
  groupKey: GroupKey;
  required?: boolean;
  /** select / multiselect 必填且非空 */
  options?: string[];
  defaultValue?: string | null;
  sensitive?: boolean;
}

/** 编辑自定义字段：不允许改 type。 */
export type CustomFieldPatch = Partial<Omit<CustomFieldInput, 'type'>> & {
  sortOrder?: number;
};

/** 导入结果报告。 */
export interface ImportReport {
  created: number;
  failed: number;
  /** row = xlsx 行号（含表头，从 2 起） */
  failures: { row: number; reason: string }[];
}

/** IPC 统一返回信封：处理器永不跨边界 throw。 */
export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: IpcError };

export interface IpcError {
  code: IpcErrorCode;
  message: string;
  /** 字段级校验错误：字段 key → 提示文案 */
  fields?: Record<string, string>;
}

export type IpcErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'FIELD_KEY_CONFLICT'
  | 'FIELD_TYPE_IMMUTABLE'
  | 'TAG_NAME_CONFLICT'
  | 'IMPORT_FILE_INVALID'
  | 'IMPORT_TOO_LARGE'
  | 'IO_CANCELLED'
  | 'IO_WRITE_FAILED'
  | 'DB_ERROR';
