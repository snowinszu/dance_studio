/**
 * 课程管理的权威校验。
 *
 * 整体类比：教务处的「登记规则手册」。渲染层填的表递进来，这里逐栏按规矩核对——
 * 不合格的当场画红叉（errors），合格的抄进干净的登记值（*Values）交给 repo。
 * 渲染层自己也做一遍即时提示，但那只是体验；能不能入库以这里为准。
 *
 * 日期 / 时间助手（todayYmd / isRealYmd）与库存 / 考勤模块**各留一份**，刻意不抽公共模块——
 * 三个模块间不耦合，改一处不会牵动另外两处。
 */
import type {
  ClassScheduleInput,
  ClassSessionInput,
  ClassStatus,
  CourseClassInput,
  RosterAddInput,
  RosterRemoveInput,
  SessionMonthQuery,
  SessionUpdateAction,
  SessionUpdateInput,
  TeacherInput,
  TeacherStatus,
} from '../shared/types';

const MAX_TEACHER_NAME = 20;
const MAX_CLASS_NAME = 40;
const MAX_DANCE_TYPE = 20;
const MAX_LEVEL = 20;
const MAX_ROOM = 20;
const MAX_NOTE = 200;

export const TEACHER_STATUSES: readonly TeacherStatus[] = ['在职', '离职'];
export const CLASS_STATUSES: readonly ClassStatus[] = ['在读', '停课', '结课'];
export const SESSION_UPDATE_ACTIONS: readonly SessionUpdateAction[] = [
  '停课',
  '恢复',
  '改时间',
  '换老师',
];

/** 'HH:MM'，00:00 ~ 23:59。 */
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 本地今天的 YYYY-MM-DD。 */
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

/**
 * 两个「时间段」是否重叠。用于排课冲突检测（规则层同 weekday、实例层同 session_date）。
 * 半开区间语义：紧挨着（一节 19:00-20:00、另一节 20:00-21:00）不算冲突。
 */
export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * 两个「日期区间」是否相交。null 表示该端不设限。用于周期规则的 effective_from/to 比对。
 */
export function rangeOverlaps(
  aFrom: string | null,
  aTo: string | null,
  bFrom: string | null,
  bTo: string | null,
): boolean {
  if (aTo != null && bFrom != null && aTo < bFrom) return false;
  if (bTo != null && aFrom != null && bTo < aFrom) return false;
  return true;
}

/* ───────────────────────── 通用小工具 ───────────────────────── */

/** trim → 空串视为「未填」返回 null；超长写 errors 并返回 null。 */
function optionalText(
  raw: unknown,
  max: number,
  label: string,
  key: string,
  errors: Record<string, string>,
): string | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s.length === 0) return null;
  if (s.length > max) {
    errors[key] = `${label}不超过 ${max} 字`;
    return null;
  }
  return s;
}

/** 空 / null / '' → undefined；否则转数字（可能是 NaN）。 */
function toNumOrUndefined(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  return typeof raw === 'number' ? raw : Number(String(raw).trim());
}

/** 正整数 id 校验；不合法写 errors。 */
function requireId(raw: unknown, label: string, key: string, errors: Record<string, string>): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    errors[key] = label;
    return 0;
  }
  return n;
}

/** 可选日期：空 → 今天；给出须真实历法日期。 */
function resolveDate(raw: unknown, key: string, errors: Record<string, string>): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s.length === 0) return todayYmd();
  if (!isRealYmd(s)) {
    errors[key] = '日期格式应为 YYYY-MM-DD 且真实存在';
    return todayYmd();
  }
  return s;
}

/* ───────────────────────── 老师 ───────────────────────── */

/** 校验后的老师值。编辑态下省略的字段为 undefined（repo 保持原值）。 */
export interface TeacherValues {
  name: string | undefined;
  status: TeacherStatus | undefined;
}

export function validateTeacher(
  input: TeacherInput,
  opts: { isEdit?: boolean } = {},
): { values: TeacherValues; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const isEdit = opts.isEdit === true;

  let name: string | undefined;
  const nameRaw = typeof input.name === 'string' ? input.name.trim() : '';
  if (nameRaw.length === 0) {
    if (!isEdit || input.name !== undefined) errors['name'] = '请填写老师姓名';
    name = undefined;
  } else if (nameRaw.length > MAX_TEACHER_NAME) {
    errors['name'] = `姓名不超过 ${MAX_TEACHER_NAME} 字`;
    name = undefined;
  } else {
    name = nameRaw;
  }

  let status: TeacherStatus | undefined;
  if (input.status === undefined || input.status === null) {
    status = isEdit ? undefined : '在职';
  } else if ((TEACHER_STATUSES as readonly string[]).includes(input.status)) {
    status = input.status;
  } else {
    errors['status'] = '老师状态不合法';
    status = undefined;
  }

  return { values: { name, status }, errors };
}

/* ───────────────────────── 班级 ───────────────────────── */

/** 校验后的班级值（覆盖式写入，字段齐全）。 */
export interface ClassValues {
  name: string;
  danceType: string;
  level: string | null;
  teacherId: number | null;
  room: string | null;
  capacity: number | null;
  startDate: string | null;
  endDate: string | null;
  status: ClassStatus;
  note: string | null;
}

export function validateClass(input: CourseClassInput): {
  values: ClassValues;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0) errors['name'] = '请填写班级名';
  else if (name.length > MAX_CLASS_NAME) errors['name'] = `班级名不超过 ${MAX_CLASS_NAME} 字`;

  const danceType = typeof input.danceType === 'string' ? input.danceType.trim() : '';
  if (danceType.length === 0) errors['danceType'] = '请填写舞种';
  else if (danceType.length > MAX_DANCE_TYPE)
    errors['danceType'] = `舞种不超过 ${MAX_DANCE_TYPE} 字`;

  const level = optionalText(input.level, MAX_LEVEL, '级别', 'level', errors);
  const room = optionalText(input.room, MAX_ROOM, '教室', 'room', errors);
  const note = optionalText(input.note, MAX_NOTE, '备注', 'note', errors);

  // teacherId：空 → null；给出须正整数（存在性由 repo 兜底）
  let teacherId: number | null = null;
  const tRaw = toNumOrUndefined(input.teacherId);
  if (tRaw !== undefined) {
    if (!Number.isInteger(tRaw) || tRaw <= 0) errors['teacherId'] = '主教选择无效';
    else teacherId = tRaw;
  }

  // capacity：空 → null；给出须正整数
  let capacity: number | null = null;
  const cRaw = toNumOrUndefined(input.capacity);
  if (cRaw !== undefined) {
    if (!Number.isInteger(cRaw) || cRaw < 1) errors['capacity'] = '容量必须是不小于 1 的整数';
    else capacity = cRaw;
  }

  // 开班 / 结课日期：空 → null；给出须真实日期；都给时 endDate >= startDate
  const startDate = resolveOptionalYmd(input.startDate, 'startDate', errors);
  const endDate = resolveOptionalYmd(input.endDate, 'endDate', errors);
  if (startDate && endDate && endDate < startDate) {
    errors['endDate'] = '结课日期不能早于开班日期';
  }

  let status: ClassStatus = '在读';
  if (input.status !== undefined && input.status !== null) {
    if ((CLASS_STATUSES as readonly string[]).includes(input.status)) status = input.status;
    else errors['status'] = '班级状态不合法';
  }

  return {
    values: { name, danceType, level, teacherId, room, capacity, startDate, endDate, status, note },
    errors,
  };
}

/** 可选日期：空 → null；给出须真实历法日期，否则写 errors 并返回 null。 */
function resolveOptionalYmd(
  raw: unknown,
  key: string,
  errors: Record<string, string>,
): string | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (s.length === 0) return null;
  if (!isRealYmd(s)) {
    errors[key] = '日期格式应为 YYYY-MM-DD 且真实存在';
    return null;
  }
  return s;
}

/* ───────────────────────── 花名册 ───────────────────────── */

export interface RosterAddValues {
  classId: number;
  studentId: number;
  joinedAt: string;
}

export function validateRosterAdd(input: RosterAddInput): {
  values: RosterAddValues;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};
  const classId = requireId(input.classId, '请选择班级', 'classId', errors);
  const studentId = requireId(input.studentId, '请选择学员', 'studentId', errors);
  const joinedAt = resolveDate(input.joinedAt, 'joinedAt', errors);
  return { values: { classId, studentId, joinedAt }, errors };
}

export interface RosterRemoveValues {
  classId: number;
  studentId: number;
  leftAt: string;
}

export function validateRosterRemove(input: RosterRemoveInput): {
  values: RosterRemoveValues;
  errors: Record<string, string>;
} {
  const errors: Record<string, string> = {};
  const classId = requireId(input.classId, '请选择班级', 'classId', errors);
  const studentId = requireId(input.studentId, '请选择学员', 'studentId', errors);
  const leftAt = resolveDate(input.leftAt, 'leftAt', errors);
  return { values: { classId, studentId, leftAt }, errors };
}

/* ───────────────────────── 周期规则（#49 用） ───────────────────────── */

export interface ScheduleValues {
  classId: number;
  weekday: number;
  startTime: string;
  endTime: string;
  teacherId: number | null;
  room: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

/**
 * 校验周期规则入参。
 * - weekday 非 0–6 整数 → 单独的 weekdayError（register 层据此抛 INVALID_WEEKDAY）
 * - 时间格式非法 / endTime <= startTime → 单独的 timeError（register 层据此抛 INVALID_TIME_RANGE）
 * - 其余字段问题进 errors（→ VALIDATION_FAILED）
 */
export function validateSchedule(input: ClassScheduleInput): {
  values: ScheduleValues;
  errors: Record<string, string>;
  weekdayError?: string;
  timeError?: string;
} {
  const errors: Record<string, string> = {};
  const classId = requireId(input.classId, '请选择班级', 'classId', errors);

  let weekday = 0;
  let weekdayError: string | undefined;
  const wRaw = toNumOrUndefined(input.weekday);
  if (wRaw === undefined || !Number.isInteger(wRaw) || wRaw < 0 || wRaw > 6) {
    weekdayError = '星期取值应为 0（周日）到 6（周六）';
  } else {
    weekday = wRaw;
  }

  const startTime = typeof input.startTime === 'string' ? input.startTime.trim() : '';
  const endTime = typeof input.endTime === 'string' ? input.endTime.trim() : '';
  let timeError: string | undefined;
  if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) {
    timeError = '时间格式应为 HH:MM';
  } else if (endTime <= startTime) {
    timeError = '结束时间必须晚于开始时间';
  }

  let teacherId: number | null = null;
  const tRaw = toNumOrUndefined(input.teacherId);
  if (tRaw !== undefined) {
    if (!Number.isInteger(tRaw) || tRaw <= 0) errors['teacherId'] = '老师选择无效';
    else teacherId = tRaw;
  }
  const room = optionalText(input.room, MAX_ROOM, '教室', 'room', errors);

  const effectiveFrom = resolveOptionalYmd(input.effectiveFrom, 'effectiveFrom', errors);
  const effectiveTo = resolveOptionalYmd(input.effectiveTo, 'effectiveTo', errors);
  if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) {
    errors['effectiveTo'] = '生效结束不能早于生效开始';
  }

  return {
    values: { classId, weekday, startTime, endTime, teacherId, room, effectiveFrom, effectiveTo },
    errors,
    weekdayError,
    timeError,
  };
}

/* ───────────────────────── 排课实例（#51 用） ───────────────────────── */

export interface SessionCreateValues {
  classId: number;
  sessionDate: string;
  startTime: string;
  endTime: string;
  teacherId: number | null;
  room: string | null;
  note: string | null;
}

export function validateSessionCreate(input: ClassSessionInput): {
  values: SessionCreateValues;
  errors: Record<string, string>;
  timeError?: string;
} {
  const errors: Record<string, string> = {};
  const classId = requireId(input.classId, '请选择班级', 'classId', errors);

  const sessionDate = typeof input.sessionDate === 'string' ? input.sessionDate.trim() : '';
  if (!isRealYmd(sessionDate)) errors['sessionDate'] = '日期格式应为 YYYY-MM-DD 且真实存在';

  const startTime = typeof input.startTime === 'string' ? input.startTime.trim() : '';
  const endTime = typeof input.endTime === 'string' ? input.endTime.trim() : '';
  let timeError: string | undefined;
  if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) timeError = '时间格式应为 HH:MM';
  else if (endTime <= startTime) timeError = '结束时间必须晚于开始时间';

  let teacherId: number | null = null;
  const tRaw = toNumOrUndefined(input.teacherId);
  if (tRaw !== undefined) {
    if (!Number.isInteger(tRaw) || tRaw <= 0) errors['teacherId'] = '老师选择无效';
    else teacherId = tRaw;
  }
  const room = optionalText(input.room, MAX_ROOM, '教室', 'room', errors);
  const note = optionalText(input.note, MAX_NOTE, '备注', 'note', errors);

  return {
    values: {
      classId,
      sessionDate: isRealYmd(sessionDate) ? sessionDate : todayYmd(),
      startTime,
      endTime,
      teacherId,
      room,
      note,
    },
    errors,
    timeError,
  };
}

export interface SessionUpdateValues {
  id: number;
  action: SessionUpdateAction;
  startTime: string | null;
  endTime: string | null;
  teacherId: number | null;
  note: string | null;
}

export function validateSessionUpdate(input: SessionUpdateInput): {
  values: SessionUpdateValues;
  errors: Record<string, string>;
  timeError?: string;
} {
  const errors: Record<string, string> = {};
  const id = requireId(input.id, '课节无效', 'id', errors);

  const action = input.action;
  if (!(SESSION_UPDATE_ACTIONS as readonly string[]).includes(action)) {
    errors['action'] = '操作类型不合法';
  }

  let startTime: string | null = null;
  let endTime: string | null = null;
  let timeError: string | undefined;
  if (action === '改时间') {
    const s = typeof input.startTime === 'string' ? input.startTime.trim() : '';
    const e = typeof input.endTime === 'string' ? input.endTime.trim() : '';
    if (!TIME_RE.test(s) || !TIME_RE.test(e)) timeError = '时间格式应为 HH:MM';
    else if (e <= s) timeError = '结束时间必须晚于开始时间';
    else {
      startTime = s;
      endTime = e;
    }
  }

  // 换老师：teacherId 给出须正整数；显式 null = 取消指派
  let teacherId: number | null = null;
  if (action === '换老师') {
    const tRaw = toNumOrUndefined(input.teacherId);
    if (tRaw !== undefined) {
      if (!Number.isInteger(tRaw) || tRaw <= 0) errors['teacherId'] = '老师选择无效';
      else teacherId = tRaw;
    }
  }

  const note = optionalText(input.note, MAX_NOTE, '备注', 'note', errors);

  return {
    values: { id, action: action as SessionUpdateAction, startTime, endTime, teacherId, note },
    errors,
    timeError,
  };
}

/** 校验「按月」查询（year 整数 2000–2100、month 1–12）。 */
export function validateMonthQuery(input: SessionMonthQuery): {
  values: { teacherId: number | null; year: number; month: number };
  error?: string;
} {
  const year = Number(input.year);
  const month = Number(input.month);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return { values: { teacherId: null, year: 0, month: 0 }, error: '年份不合法' };
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return { values: { teacherId: null, year: 0, month: 0 }, error: '月份应为 1 到 12' };
  }
  let teacherId: number | null = null;
  const tRaw = toNumOrUndefined(input.teacherId);
  if (tRaw !== undefined && Number.isInteger(tRaw) && tRaw > 0) teacherId = tRaw;
  return { values: { teacherId, year, month } };
}
