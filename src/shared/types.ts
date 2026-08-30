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
  | 'DB_ERROR'
  // —— 库存管理 ——
  /** 领取数量大于当前库存 */
  | 'INSUFFICIENT_STOCK'
  /** 物件名与未软删物件重名 */
  | 'ITEM_NAME_CONFLICT'
  // —— 考勤管理 ——
  /** 净消耗使剩余课时 < 0 且未强制 */
  | 'INSUFFICIENT_LESSONS'
  /** 考勤记录不存在或已撤销 */
  | 'ATTENDANCE_NOT_FOUND'
  /** 同学员 + 日期 + 课程 + 类型 已有未撤销记录，且未允许重复 */
  | 'DUPLICATE_ATTENDANCE'
  /** 手动调整课时的增减数为 0 或非整数 */
  | 'INVALID_ADJUSTMENT';

// ===========================================================================
// 库存管理模块
// ===========================================================================

/**
 * 一件「物件」（练功服 / 道具 / 教材……）的台账。
 * quantity 是当前在库数的权威值——不是汇总领用流水实时算出来的。
 * 时间戳同样是 ISO 8601 字符串。
 */
export interface InventoryItem {
  id: number;
  name: string;
  /** 自由文本分类，可空；无字典表、无下拉 */
  category: string | null;
  /** 计量单位，缺省「件」 */
  unit: string;
  /** 当前在库数，整数 ≥ 0 */
  quantity: number;
  /** 低于等于此值，列表标「库存偏低」；整数 ≥ 0 */
  lowStockThreshold: number;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  /** 非 null 即已软删除：不进列表 / 分配下拉，但历史流水与导出仍可见 */
  deletedAt: string | null;
}

/**
 * 新建 / 编辑物件的入参。
 * 编辑时 quantity 省略则保持原值，给出则直接覆盖（不留调整痕迹）。
 */
export interface InventoryItemInput {
  name: string;
  category?: string | null;
  /** 省略或空串 → '件' */
  unit?: string | null;
  /** 新建省略 → 0 */
  quantity?: number;
  /** 省略 → 0 */
  lowStockThreshold?: number;
  note?: string | null;
}

/** 物件列表查询条件。 */
export interface InventoryListQuery {
  /** 匹配 name 子串 */
  search?: string;
  /** 精确匹配分类 */
  category?: string;
  /** 只看 quantity <= low_stock_threshold 的物件 */
  lowStockOnly?: boolean;
  /** 默认 100 */
  limit?: number;
  /** 默认 0 */
  offset?: number;
}

export interface InventoryListResult {
  rows: InventoryItem[];
  /** 满足筛选（除分页）的物件数 */
  total: number;
  /**
   * 未软删物件中 quantity <= low_stock_threshold 的数量。
   * 独立统计，不受 search / category / 分页影响——供列表顶部「N 个物件库存偏低」汇总。
   */
  lowStockCount: number;
}

/**
 * 一条领用流水。itemName / studentName / studentPhone 由 JOIN 得到，
 * 即使对应物件已软删也照常带出（历史可查）。
 */
export interface Allocation {
  id: number;
  itemId: number;
  itemName: string;
  studentId: number;
  studentName: string;
  studentPhone: string;
  quantity: number;
  /** 领取日期 'YYYY-MM-DD' */
  claimedAt: string;
  note: string | null;
  createdAt: string;
}

/** 提交一次领用的入参。 */
export interface AllocationInput {
  itemId: number;
  studentId: number;
  /** 整数 ≥ 1 */
  quantity: number;
  /** 省略 → 今天（YYYY-MM-DD） */
  claimedAt?: string;
  note?: string | null;
}

/** 领用流水查询条件。claimed_at 是 YYYY-MM-DD 字符串，直接字符串比较即时间序。 */
export interface AllocationListQuery {
  /** claimed_at >= dateFrom */
  dateFrom?: string;
  /** claimed_at <= dateTo */
  dateTo?: string;
  studentId?: number;
  itemId?: number;
  /** 默认 100 */
  limit?: number;
  /** 默认 0 */
  offset?: number;
}

export interface AllocationListResult {
  rows: Allocation[];
  total: number;
}

/** 物件台账导入结果报告。 */
export interface InventoryImportReport {
  /** 新建的物件数 */
  created: number;
  /** 按物件名匹配到、累加了库存的物件数 */
  updated: number;
  /** 校验失败被跳过的行数 */
  failed: number;
  /** row = xlsx 行号（含表头，从 2 起） */
  failures: { row: number; reason: string }[];
}

// ===========================================================================
// 考勤管理模块
// ===========================================================================

/**
 * 一条考勤流水的类型。前五个是「考勤事件」，`调整` 是「手动增减课时」。
 * 只有 `出勤` 默认消耗课时（-1，私教可 -2）；请假 / 缺勤 / 补课 / 试听 落库 lessons_delta = 0。
 */
export type AttendanceType = '出勤' | '请假' | '缺勤' | '补课' | '试听' | '调整';

/** 除「调整」外的考勤事件类型——快速打卡 / 批量点名 / 更正只接受这五个。 */
export type AttendanceEventType = Exclude<AttendanceType, '调整'>;

/**
 * 一条考勤流水。studentName / studentPhone 由 JOIN students 得到（学员软删后照常带出）。
 * lessons_delta 是落库真值：消耗为负、增加为正、不影响为 0。
 */
export interface AttendanceRecord {
  id: number;
  studentId: number;
  studentName: string;
  studentPhone: string;
  /** 预留关联「课程安排」，本期恒 null */
  sessionId: number | null;
  className: string | null;
  teacher: string | null;
  /** 'YYYY-MM-DD' */
  attendDate: string;
  /** 'HH:MM'，可空 */
  attendTime: string | null;
  type: AttendanceType;
  lessonsDelta: number;
  reason: string | null;
  operator: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  /** 非 null 即已撤销 */
  deletedAt: string | null;
}

/** 单条快速打卡入参。 */
export interface QuickCheckInInput {
  studentId: number;
  type: AttendanceEventType;
  /** 省略 → 今天（YYYY-MM-DD） */
  attendDate?: string;
  attendTime?: string | null;
  className?: string | null;
  teacher?: string | null;
  /** 仅 type='出勤' 有意义：正整数，省略 → 1；其它类型忽略，落库 delta = 0 */
  lessons?: number;
  operator?: string | null;
  note?: string | null;
  /** 余额不足时放行、允许 remaining_lessons 记负 */
  force?: boolean;
  /** 重复打卡（同学员+日期+课程+类型未撤销）时放行 */
  allowDuplicate?: boolean;
}

/** 写入 / 更正 / 调整成功后的统一返回：新（或被改）记录 id + 该学员写入后的剩余课时。 */
export interface CheckInResult {
  id: number;
  /** force 时可能为负 */
  remainingLessons: number;
}

/** 批量点名里的一名学员。 */
export interface BatchCheckInEntry {
  studentId: number;
  type: AttendanceEventType;
  /** 仅 type='出勤'：正整数，省略 → 1 */
  lessons?: number;
  note?: string | null;
}

/** 批量点名入参：一节课的公共信息 + 若干学员的状态。 */
export interface BatchCheckInInput {
  attendDate?: string;
  attendTime?: string | null;
  className?: string | null;
  teacher?: string | null;
  operator?: string | null;
  force?: boolean;
  allowDuplicate?: boolean;
  entries: BatchCheckInEntry[];
}

/** 批量点名里单个学员的写入结果。 */
export interface BatchCheckInRowResult {
  studentId: number;
  ok: boolean;
  /** ok=true 时给 */
  recordId?: number;
  /** ok=true 时给 */
  remainingLessons?: number;
  /** ok=false 时给 */
  errorCode?: IpcErrorCode;
  /** ok=false 时给 */
  reason?: string;
}

export interface BatchCheckInResult {
  succeeded: number;
  skipped: number;
  rows: BatchCheckInRowResult[];
}

/** 更正一条考勤记录的入参。不能改 studentId（换人 = 撤销后重打）。 */
export interface AttendanceCorrectionInput {
  id: number;
  type: AttendanceEventType;
  attendDate: string;
  attendTime?: string | null;
  className?: string | null;
  teacher?: string | null;
  /** 仅 type='出勤' */
  lessons?: number;
  operator?: string | null;
  note?: string | null;
  /** 新旧 delta 差额使余额变负时放行 */
  force?: boolean;
}

/** 手动增减某学员课时的入参。 */
export interface LessonAdjustmentInput {
  studentId: number;
  /** 带符号非零整数：正 = 加、负 = 减 */
  delta: number;
  /** 必填 */
  reason: string;
  /** 省略 → 今天 */
  attendDate?: string;
  operator?: string | null;
  note?: string | null;
  /** delta<0 且会使余额变负时放行 */
  force?: boolean;
}

/** 考勤流水列表查询。attend_date 是 YYYY-MM-DD 字符串，直接字符串比较即时间序。 */
export interface AttendanceListQuery {
  /** attend_date >= dateFrom */
  dateFrom?: string;
  /** attend_date <= dateTo */
  dateTo?: string;
  /** 匹配学员姓名或手机号子串 */
  keyword?: string;
  type?: AttendanceType;
  /** 默认 100 */
  limit?: number;
  /** 默认 0 */
  offset?: number;
}

export interface AttendanceListResult {
  rows: AttendanceRecord[];
  total: number;
}

/** 批量点名花名册候选查询。 */
export interface RosterCandidateQuery {
  /** 对 students.dance_types(JSON 数组字符串) 做包含匹配 */
  danceType?: string;
  /** 姓名或手机号子串 */
  keyword?: string;
}

/** 花名册候选里的一名学员。 */
export interface RosterCandidate {
  id: number;
  name: string;
  phone: string;
  remainingLessons: number | null;
  cardExpireDate: string | null;
  status: string;
  /** students.dance_types 解析后的数组；渲染层据此拼舞种下拉 */
  danceTypes: string[];
}

/** 按月汇总的一行：某学员某月。仅导出用（无独立 IPC）。 */
export interface MonthlySummaryRow {
  studentId: number;
  studentName: string;
  studentPhone: string;
  /** 'YYYY-MM' */
  month: string;
  attendCount: number;
  leaveCount: number;
  absentCount: number;
  makeupCount: number;
  trialCount: number;
  /** 当月 lessons_delta < 0 的绝对值之和 */
  lessonsConsumed: number;
  /** 当前实时剩余课时 */
  remainingLessons: number | null;
}

/** 考勤导入结果报告。 */
export interface AttendanceImportReport {
  succeeded: number;
  /** 疑似重复被跳过的行数 */
  skipped: number;
  failed: number;
  /** 成功但导致该学员余额为负的行数（提示用） */
  negativeBalance: number;
  /** row = xlsx 行号（含表头，从 2 起） */
  failures: { row: number; reason: string }[];
}
