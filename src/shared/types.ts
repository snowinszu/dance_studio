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
  | 'INVALID_ADJUSTMENT'
  // —— 课程管理 ——
  /** teacher_id 不存在 */
  | 'TEACHER_NOT_FOUND'
  /** class_id 不存在或已软删 */
  | 'CLASS_NOT_FOUND'
  /** 周期规则不存在或已软删 */
  | 'SCHEDULE_NOT_FOUND'
  /** 排课实例不存在或已软删 */
  | 'SESSION_NOT_FOUND'
  /** 该学员在该班已有在册记录 */
  | 'STUDENT_ALREADY_IN_CLASS'
  /** 同班同日同开始时间已有未软删课节 */
  | 'DUPLICATE_SESSION'
  /** 时间格式非法或 end_time <= start_time */
  | 'INVALID_TIME_RANGE'
  /** weekday 非 0–6 整数 */
  | 'INVALID_WEEKDAY';

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
  /** 关联的课节 id（course.class_sessions）；快速打卡或未选课节的批量点名为 null。逻辑关联、无外键 */
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
  /**
   * 课程管理上线后：批量点名关联的课节 id（course:sessionsByDate 选中的那节）。
   * 给出则每条流水回填 attendance_records.session_id；省略 → null，行为不变。
   */
  sessionId?: number | null;
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

// ===========================================================================
// 课程管理模块
// ===========================================================================
//
// 两个视图、一份数据：
// - 「课程表」（学生向）读周期规则 ClassSchedule——不带日期的星期模板。
// - 「上课时间计划表」（老师向）读排课实例 ClassSession——真实日期，由 generateMonth 按规则物化。
// 显示用的班名 / 老师名一律 JOIN 取（不快照）；ClassSession.teacherId 是「这天谁上」的权威，可被代课改写。

export type TeacherStatus = '在职' | '离职';
export type ClassStatus = '在读' | '停课' | '结课';
export type SessionStatus = '正常' | '停课';
export type SessionOrigin = '计划' | '手动';
export type SessionUpdateAction = '停课' | '恢复' | '改时间' | '换老师';

/** 一位老师。轻量字典：只有姓名 + 状态两个业务字段。 */
export interface Teacher {
  id: number;
  name: string;
  status: TeacherStatus;
  createdAt: string;
  updatedAt: string;
  /** 非 null 即已软删：历史 JOIN 仍带出姓名 */
  deletedAt: string | null;
}

export interface TeacherInput {
  name: string;
  /** 省略 → '在职' */
  status?: TeacherStatus;
}

/** 一个班级。teacherName 由 JOIN teachers 得到（含已软删老师）。 */
export interface CourseClass {
  id: number;
  name: string;
  danceType: string;
  level: string | null;
  teacherId: number | null;
  teacherName: string | null;
  room: string | null;
  capacity: number | null;
  startDate: string | null;
  endDate: string | null;
  status: ClassStatus;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface CourseClassInput {
  name: string;
  danceType: string;
  level?: string | null;
  teacherId?: number | null;
  room?: string | null;
  capacity?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  /** 省略 → '在读' */
  status?: ClassStatus;
  note?: string | null;
}

/** 班级列表 / 详情：带在册人数与是否超容量。 */
export interface CourseClassListItem extends CourseClass {
  /** class_students 中 left_at IS NULL 的计数 */
  activeRosterCount: number;
  /** capacity != null && activeRosterCount > capacity */
  overCapacity: boolean;
}

export interface CourseClassListQuery {
  status?: ClassStatus;
  danceType?: string;
  teacherId?: number;
  /** 班名子串 */
  keyword?: string;
}

/** 花名册里的一名在册学员（JOIN students）。 */
export interface RosterMember {
  studentId: number;
  name: string;
  phone: string;
  remainingLessons: number | null;
  cardExpireDate: string | null;
  joinedAt: string;
}

export interface RosterAddInput {
  classId: number;
  studentId: number;
  /** 省略 → 今天 */
  joinedAt?: string;
}

export interface RosterRemoveInput {
  classId: number;
  studentId: number;
  /** 省略 → 今天 */
  leftAt?: string;
}

export interface RosterMutationResult {
  classId: number;
  activeRosterCount: number;
  overCapacity: boolean;
}

/** 一条周期规则。effective* 是生效老师 / 教室（COALESCE 覆盖值与班默认值）。 */
export interface ClassSchedule {
  id: number;
  classId: number;
  /** 0=周日 … 6=周六 */
  weekday: number;
  /** 'HH:MM' */
  startTime: string;
  endTime: string;
  /** 覆盖值 */
  teacherId: number | null;
  /** 覆盖值 */
  room: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  /** COALESCE(schedule.teacherId, class.teacherId) */
  effectiveTeacherId: number | null;
  effectiveTeacherName: string | null;
  effectiveRoom: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ClassScheduleInput {
  classId: number;
  weekday: number;
  startTime: string;
  endTime: string;
  teacherId?: number | null;
  room?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

/** 一条排课冲突（老师或教室在同一时段被排两次）。非阻断，仅提示。 */
export interface ScheduleConflict {
  kind: '老师' | '教室';
  refType: '规则' | '课节';
  refId: number;
  /** 冲突对象的班名 */
  label: string;
  /** 规则 → String(weekday)；课节 → 'YYYY-MM-DD' */
  weekdayOrDate: string;
  startTime: string;
  endTime: string;
}

export interface ScheduleMutationResult {
  schedule: ClassSchedule;
  /** 非阻断：即使非空，规则也已落库 */
  conflicts: ScheduleConflict[];
}

export interface WeeklyTimetableQuery {
  danceType?: string;
  teacherId?: number;
}

/** 「课程表」周视图的一格：某班某条规则。 */
export interface WeeklyTimetableEntry {
  scheduleId: number;
  classId: number;
  className: string;
  danceType: string;
  level: string | null;
  weekday: number;
  startTime: string;
  endTime: string;
  /** 生效老师 */
  teacherId: number | null;
  teacherName: string | null;
  /** 生效教室 */
  room: string | null;
  activeRosterCount: number;
}

/** 一条排课实例。className / teacherName 由 JOIN 得到（见 ClassSessionListItem）。 */
export interface ClassSession {
  id: number;
  classId: number;
  scheduleId: number | null;
  /** 'YYYY-MM-DD' */
  sessionDate: string;
  startTime: string;
  endTime: string;
  teacherId: number | null;
  room: string | null;
  status: SessionStatus;
  origin: SessionOrigin;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface ClassSessionListItem extends ClassSession {
  className: string;
  danceType: string;
  teacherName: string | null;
}

export interface SessionMonthQuery {
  teacherId?: number;
  year: number;
  /** 1–12 */
  month: number;
}

/** 考勤「选择课节」列出某日课节用。 */
export interface SessionDateItem {
  id: number;
  classId: number;
  className: string;
  teacherId: number | null;
  teacherName: string | null;
  startTime: string;
  endTime: string;
  status: SessionStatus;
  activeRosterCount: number;
}

/** 手动加课的入参。 */
export interface ClassSessionInput {
  classId: number;
  sessionDate: string;
  startTime: string;
  endTime: string;
  teacherId?: number | null;
  room?: string | null;
  note?: string | null;
}

export interface SessionUpdateInput {
  id: number;
  action: SessionUpdateAction;
  /** action='改时间' 必填 */
  startTime?: string;
  /** action='改时间' 必填 */
  endTime?: string;
  /** action='换老师'：给出 → 指派；null → 取消指派 */
  teacherId?: number | null;
  /** action='停课' 可带 */
  note?: string | null;
}

export interface SessionMutationResult {
  session: ClassSessionListItem;
  /** 非阻断；action ∈ {改时间,换老师} 或手动加课时才可能非空 */
  conflicts: ScheduleConflict[];
}

export interface GenerateMonthResult {
  /** 本次新物化的实例数 */
  created: number;
}

/* ───────────────────────── 数据报表（纯只读聚合）───────────────────────── */

/**
 * 报表统计区间。两端闭区间，'YYYY-MM-DD'。
 * 页面把「本月 / 本年 / 自定义」换算成显式日期串后传给主进程；主进程不认 preset 枚举。
 */
export interface ReportRange {
  from: string;
  to: string;
}

/** 报表页顶部的概览卡片。 */
export interface ReportOverview {
  /** 在读学员数（status='在读'，未软删） */
  activeStudents: number;
  /** 区间内出勤人次（type 出勤 / 补课，未撤销） */
  checkInsInRange: number;
  /** 区间内正常课节数（status='正常'，未软删） */
  sessionsInRange: number;
  /** 近 30 天新登记学员（enroll_date >= 今天-30，含当天） */
  newStudentsLast30d: number;
  /** 在读且剩余课时 <= 3 */
  lowBalanceCount: number;
  /** 未软删物件且库存 <= 预警阈值 */
  lowStockCount: number;
  /** 当年（取 to 的年份）session_id 为空的出勤 / 补课条数——进不了「按班级」导出的提示值 */
  unlinkedCheckInsThisYear: number;
}

/**
 * 预警中心的四组清单。窗口是固定常量（不跟随页面时间范围）；每组最多 200 行。
 */
export interface ReportAlerts {
  /** 库存 <= 预警阈值的物件，最紧缺在前 */
  lowStock: { id: number; name: string; quantity: number; threshold: number }[];
  /** 在读且剩余课时 <= 3 的学员 */
  lowBalance: { id: number; name: string; remainingLessons: number }[];
  /** 在读、未软删，近 60 天无「出勤」记录；lastAttendDate 为历来最近一次出勤日期（可能无） */
  dormant: { id: number; name: string; lastAttendDate: string | null }[];
  /** 近 30 天内、已发生、正常、关联出勤/补课人次为 0 的课节 */
  emptySessions: { sessionId: number; className: string; sessionDate: string; startTime: string }[];
}

/** 考勤指标区。 */
export interface ReportAttendanceStats {
  /** 本月课节数（该月 1 号 → to，正常、未软删） */
  sessionsThisMonth: number;
  /** 本年课节数（该年 1/1 → to） */
  sessionsThisYear: number;
  /** 月度出勤人次（出勤+补课），'YYYY-MM' 升序，repo 已补齐区间内每个月（缺月为 0） */
  monthlyCheckIns: { month: string; count: number }[];
  /** 出勤排名（区间内有任意考勤记录的学员）。渲染层按 attendCount 或 rate 排序。 */
  ranking: {
    studentId: number;
    name: string;
    /** 出勤 + 补课 —— 「按次数」列 */
    attendCount: number;
    /** 出勤 —— 出勤率的分子 */
    attendOnly: number;
    /** 出勤 + 缺勤 + 请假 —— 出勤率的分母 */
    scheduled: number;
    /** attendOnly / scheduled；分母为 0 时为 null */
    rate: number | null;
  }[];
  /** 近 30 天缺勤 + 请假最多的前 10 名 */
  absenceTop: { studentId: number; name: string; absentPlusLeave: number }[];
  /** 按 attendance_records.teacher 分组的出勤人次；空值归「未记录」 */
  byTeacher: { teacher: string; checkIns: number }[];
  /** 按 attendance_records.class_name 分组的出勤人次；空值归「未记录」 */
  byDanceType: { danceType: string; checkIns: number }[];
  /** 星期(0=周日..6) × 2 小时时段桶(0..11) 的出勤人次；attend_time 为空 → bucket=-1 */
  hourHeatmap: { weekday: number; bucket: number; count: number }[];
}

/** 课程指标区。 */
export interface ReportCourseStats {
  /** 区间内正常课节，按老师分组的课节数与总时长（分钟）；teacher_id 为空 → 「未指定」；按时长降序 */
  teacherLoad: {
    teacherId: number | null;
    teacherName: string;
    sessionCount: number;
    minutes: number;
  }[];
  /** 区间内未软删课节的停课占比；rate 分母（正常+停课）为 0 时为 null */
  cancelRate: { normal: number; cancelled: number; rate: number | null };
  /** 每个未结课班级的「在册人数 ÷ capacity」；capacity 缺失或 <=0 → rate 为 null */
  classFillRate: {
    classId: number;
    className: string;
    enrolled: number;
    capacity: number | null;
    rate: number | null;
  }[];
  /** 区间内、已发生、正常、关联出勤/补课人次为 0 的课节 */
  emptySessions: { sessionId: number; className: string; sessionDate: string; startTime: string }[];
}

/** 学员指标区。 */
export interface ReportStudentStats {
  /** 按 status 分组计数（排除软删） */
  statusDist: { status: string; count: number }[];
  /** 舞种分布（dance_types JSON 数组展开）；一名多舞种学员计入多个 danceType */
  danceTypeDist: { danceType: string; count: number }[];
  /** 按 current_level 分组，空值归「未分级」 */
  levelDist: { level: string; count: number }[];
  /** 按 enroll_date 自然月分组的新登记数，'YYYY-MM' 升序，repo 已补齐每个月（缺月为 0） */
  monthlyNew: { month: string; count: number }[];
  /** 按 referrer 分组计数前 10（空值不计） */
  referrerTop: { referrer: string; count: number }[];
  /** 在读且剩余课时 <= 3（与预警中心同口径） */
  lowBalance: { id: number; name: string; remainingLessons: number }[];
  /** 在读、未软删，近 60 天无「出勤」（与预警中心同口径） */
  dormant: { id: number; name: string; lastAttendDate: string | null }[];
}
