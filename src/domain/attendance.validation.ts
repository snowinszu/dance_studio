/**
 * 考勤管理的权威校验。
 *
 * 整体类比：前台的「点名登记规则手册」。渲染层填的表递进来，这里逐栏按规矩核对，
 * 不合格的当场画红叉（errors），合格的抄进干净的登记值（RecordValues）交给 repo 入库。
 * 渲染层自己也做一遍即时提示，但那只是体验；能不能入库以这里为准。
 *
 * 课时符号约定：入参 `lessons` 是**正整数**（只有「出勤」用得上，缺省 1，私教填 2），
 * 这里把它翻成落库真值 `lessonsDelta`（消耗为负）。请假 / 缺勤 / 补课 / 试听 一律 0。
 * 「调整」类型的 delta 由 LessonAdjustmentInput.delta 直接给（带符号），不经 deltaFor。
 */
import type {
  AttendanceCorrectionInput,
  AttendanceEventType,
  AttendanceType,
  BatchCheckInInput,
  LessonAdjustmentInput,
  QuickCheckInInput,
} from '../shared/types';

const MAX_CLASS_NAME = 40;
const MAX_TEACHER = 20;
const MAX_OPERATOR = 20;
const MAX_NOTE = 200;
const MAX_REASON = 200;

/** 除「调整」外的五个考勤事件类型——快速打卡 / 批量点名 / 更正只接受这些。 */
export const EVENT_TYPES: readonly AttendanceEventType[] = [
  '出勤',
  '请假',
  '缺勤',
  '补课',
  '试听',
];

/** 六个全类型——导入时校验用。 */
export const ALL_TYPES: readonly AttendanceType[] = [...EVENT_TYPES, '调整'];

/** 本地今天的 YYYY-MM-DD。与 inventory.validation 同款、刻意各留一份，模块间不耦合。 */
export function todayYmd(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 是否合法历法日期（拦截 2026-02-30 这种）。 */
export function isRealYmd(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** HH:MM，00:00 ~ 23:59。 */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 校验后、可直接交给 repo 的一行考勤值。force / allowDuplicate 一并带上，批量点名逐条复用。 */
export interface RecordValues {
  studentId: number;
  type: AttendanceType;
  attendDate: string;
  attendTime: string | null;
  className: string | null;
  teacher: string | null;
  /** 已翻负 / 带符号的落库真值 */
  lessonsDelta: number;
  reason: string | null;
  operator: string | null;
  note: string | null;
  /** 批量点名「选择课节」带来的关联 id；快速打卡 / 未选课节时为 null。不校验其是否存在。 */
  sessionId: number | null;
  force: boolean;
  allowDuplicate: boolean;
}

/** 归一化可选的 sessionId：空 → null；正整数 → number；其它 → 报错。 */
function resolveSessionId(raw: unknown): { value: number | null } | { error: string } {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n) || n <= 0) return { error: '课节关联无效' };
  return { value: n };
}

/**
 * 由类型 + 正整数 lessons 算出落库 delta。
 * 只有「出勤」看 lessons（缺省 1）；其它类型恒 0。非正整数 → 返回错误原因。
 */
export function deltaFor(
  type: AttendanceType,
  lessons: unknown,
): { delta: number } | { error: string } {
  if (type !== '出勤') return { delta: 0 };
  if (lessons === undefined || lessons === null || lessons === '') return { delta: -1 };
  const n = typeof lessons === 'number' ? lessons : Number(String(lessons).trim());
  if (!Number.isInteger(n) || n < 1) return { error: '课时数必须是不小于 1 的整数' };
  return { delta: -n };
}

/** trim → 空串视为「未填」返回 null；超长返回错误。 */
function optionalText(
  raw: unknown,
  max: number,
  label: string,
): { value: string | null } | { error: string } {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s.length === 0) return { value: null };
  if (s.length > max) return { error: `${label}不超过 ${max} 字` };
  return { value: s };
}

/** 校验日期：空 → 今天；给出则须真实历法日期。 */
function resolveDate(raw: unknown): { value: string } | { error: string } {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s.length === 0) return { value: todayYmd() };
  if (!isRealYmd(s)) return { error: '日期格式应为 YYYY-MM-DD 且真实存在' };
  return { value: s };
}

/** 校验时间：空 → null；给出则须 HH:MM。 */
function resolveTime(raw: unknown): { value: string | null } | { error: string } {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s.length === 0) return { value: null };
  if (!TIME_RE.test(s)) return { error: '时间格式应为 HH:MM' };
  return { value: s };
}

/** 公共字段（日期 / 时间 / 课程 / 老师 / 经办人）的校验，快速打卡与批量点名共用。 */
interface CommonFields {
  attendDate: string;
  attendTime: string | null;
  className: string | null;
  teacher: string | null;
  operator: string | null;
}

function validateCommon(
  input: {
    attendDate?: string;
    attendTime?: string | null;
    className?: string | null;
    teacher?: string | null;
    operator?: string | null;
  },
  errors: Record<string, string>,
): CommonFields {
  const date = resolveDate(input.attendDate);
  if ('error' in date) errors['attendDate'] = date.error;

  const time = resolveTime(input.attendTime);
  if ('error' in time) errors['attendTime'] = time.error;

  const cls = optionalText(input.className, MAX_CLASS_NAME, '课程名');
  if ('error' in cls) errors['className'] = cls.error;

  const teacher = optionalText(input.teacher, MAX_TEACHER, '老师');
  if ('error' in teacher) errors['teacher'] = teacher.error;

  const operator = optionalText(input.operator, MAX_OPERATOR, '经办人');
  if ('error' in operator) errors['operator'] = operator.error;

  return {
    attendDate: 'value' in date ? date.value : todayYmd(),
    attendTime: 'value' in time ? time.value : null,
    className: 'value' in cls ? cls.value : null,
    teacher: 'value' in teacher ? teacher.value : null,
    operator: 'value' in operator ? operator.value : null,
  };
}

/** 单条快速打卡入参校验。 */
export function validateQuickCheckIn(input: QuickCheckInInput): {
  values: RecordValues;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};

  const studentId = Number(input.studentId);
  if (!Number.isInteger(studentId) || studentId <= 0) errors['studentId'] = '请选择学员';

  const type = input.type;
  if (!EVENT_TYPES.includes(type)) errors['type'] = '考勤类型不合法';

  const common = validateCommon(input, errors);

  let lessonsDelta = 0;
  if (EVENT_TYPES.includes(type)) {
    const d = deltaFor(type, input.lessons);
    if ('error' in d) errors['lessons'] = d.error;
    else lessonsDelta = d.delta;
  }

  const note = optionalText(input.note, MAX_NOTE, '备注');
  if ('error' in note) errors['note'] = note.error;

  const values: RecordValues = {
    studentId,
    type,
    attendDate: common.attendDate,
    attendTime: common.attendTime,
    className: common.className,
    teacher: common.teacher,
    lessonsDelta,
    reason: null,
    operator: common.operator,
    note: 'value' in note ? note.value : null,
    sessionId: null,
    force: Boolean(input.force),
    allowDuplicate: Boolean(input.allowDuplicate),
  };
  return { values, errors };
}

/**
 * 批量点名入参校验。公共字段错误 → errors 直接带（整批拒绝）；
 * 某一条学员的类型 / 课时非法 → errors['entries.N.xxx'] （也整批拒绝，不进 DB）。
 * 余额不足 / 重复 / 学员不存在 这类**运行期**结果不在这里判，交给 repo 逐条处理。
 */
export function validateBatchCheckIn(input: BatchCheckInInput): {
  values: RecordValues[];
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};
  const common = validateCommon(input, errors);

  const entries = Array.isArray(input.entries) ? input.entries : [];
  if (entries.length === 0) errors['entries'] = '请至少勾选一名学员';

  const sid = resolveSessionId((input as { sessionId?: unknown }).sessionId);
  if ('error' in sid) errors['sessionId'] = sid.error;
  const sessionId = 'value' in sid ? sid.value : null;

  const force = Boolean(input.force);
  const allowDuplicate = Boolean(input.allowDuplicate);

  const values: RecordValues[] = entries.map((e, i) => {
    const studentId = Number(e.studentId);
    if (!Number.isInteger(studentId) || studentId <= 0) {
      errors[`entries.${i}.studentId`] = '学员无效';
    }
    if (!EVENT_TYPES.includes(e.type)) {
      errors[`entries.${i}.type`] = '考勤类型不合法';
    }
    let lessonsDelta = 0;
    if (EVENT_TYPES.includes(e.type)) {
      const d = deltaFor(e.type, e.lessons);
      if ('error' in d) errors[`entries.${i}.lessons`] = d.error;
      else lessonsDelta = d.delta;
    }
    const note = optionalText(e.note, MAX_NOTE, '备注');
    if ('error' in note) errors[`entries.${i}.note`] = note.error;

    return {
      studentId,
      type: e.type,
      attendDate: common.attendDate,
      attendTime: common.attendTime,
      className: common.className,
      teacher: common.teacher,
      lessonsDelta,
      reason: null,
      operator: common.operator,
      note: 'value' in note ? note.value : null,
      sessionId,
      force,
      allowDuplicate,
    };
  });

  return { values, errors };
}

/** 校验后的更正值。studentId 不可改，故不在其中。 */
export interface CorrectionValues {
  id: number;
  type: AttendanceEventType;
  attendDate: string;
  attendTime: string | null;
  className: string | null;
  teacher: string | null;
  lessonsDelta: number;
  operator: string | null;
  note: string | null;
  force: boolean;
}

/** 更正一条考勤记录的入参校验。 */
export function validateCorrection(input: AttendanceCorrectionInput): {
  values: CorrectionValues;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};

  const id = Number(input.id);
  if (!Number.isInteger(id) || id <= 0) errors['id'] = '记录无效';

  const type = input.type;
  if (!EVENT_TYPES.includes(type)) errors['type'] = '考勤类型不合法';

  const date = resolveDate(input.attendDate);
  if ('error' in date) errors['attendDate'] = date.error;

  const time = resolveTime(input.attendTime);
  if ('error' in time) errors['attendTime'] = time.error;

  const cls = optionalText(input.className, MAX_CLASS_NAME, '课程名');
  if ('error' in cls) errors['className'] = cls.error;

  const teacher = optionalText(input.teacher, MAX_TEACHER, '老师');
  if ('error' in teacher) errors['teacher'] = teacher.error;

  const operator = optionalText(input.operator, MAX_OPERATOR, '经办人');
  if ('error' in operator) errors['operator'] = operator.error;

  const note = optionalText(input.note, MAX_NOTE, '备注');
  if ('error' in note) errors['note'] = note.error;

  let lessonsDelta = 0;
  if (EVENT_TYPES.includes(type)) {
    const d = deltaFor(type, input.lessons);
    if ('error' in d) errors['lessons'] = d.error;
    else lessonsDelta = d.delta;
  }

  const values: CorrectionValues = {
    id,
    type,
    attendDate: 'value' in date ? date.value : todayYmd(),
    attendTime: 'value' in time ? time.value : null,
    className: 'value' in cls ? cls.value : null,
    teacher: 'value' in teacher ? teacher.value : null,
    lessonsDelta,
    operator: 'value' in operator ? operator.value : null,
    note: 'value' in note ? note.value : null,
    force: Boolean(input.force),
  };
  return { values, errors };
}

/**
 * 手动调整课时入参校验。
 * delta 的「非零整数」判定单独暴露（register 层据此抛 INVALID_ADJUSTMENT，而非 VALIDATION_FAILED）。
 */
export function validateAdjustment(input: LessonAdjustmentInput): {
  values: RecordValues;
  errors: Record<string, string>;
  deltaError?: string;
} {
  const errors: Record<string, string> = {};

  const studentId = Number(input.studentId);
  if (!Number.isInteger(studentId) || studentId <= 0) errors['studentId'] = '请选择学员';

  const rawDelta = input.delta;
  const n =
    typeof rawDelta === 'number' ? rawDelta : Number(String(rawDelta ?? '').trim());
  let deltaError: string | undefined;
  let delta = 0;
  if (!Number.isInteger(n) || n === 0) {
    deltaError = '请填写非零整数';
  } else {
    delta = n;
  }

  const reasonRaw = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reasonRaw.length === 0) errors['reason'] = '请填写调整原因';
  else if (reasonRaw.length > MAX_REASON) errors['reason'] = `原因不超过 ${MAX_REASON} 字`;

  const date = resolveDate(input.attendDate);
  if ('error' in date) errors['attendDate'] = date.error;

  const operator = optionalText(input.operator, MAX_OPERATOR, '经办人');
  if ('error' in operator) errors['operator'] = operator.error;

  const note = optionalText(input.note, MAX_NOTE, '备注');
  if ('error' in note) errors['note'] = note.error;

  const values: RecordValues = {
    studentId,
    type: '调整',
    attendDate: 'value' in date ? date.value : todayYmd(),
    attendTime: null,
    className: null,
    teacher: null,
    lessonsDelta: delta,
    reason: reasonRaw.length > 0 ? reasonRaw : null,
    operator: 'value' in operator ? operator.value : null,
    note: 'value' in note ? note.value : null,
    sessionId: null,
    force: Boolean(input.force),
    allowDuplicate: true,
  };
  return { values, errors, deltaError };
}
