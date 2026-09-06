/**
 * IPC 处理器注册。
 *
 * 整体类比：这是「服务台」。每个窗口（频道）对应一项业务，来人（渲染进程）
 * 递单子，服务台叫后台（domain 层）办，办好把结果装进统一信封递回去。
 * 后台如果撂挑子（抛异常），服务台也不让异常飞出去，而是回一个「办不成 + 原因」的信封。
 */
import { app, dialog, ipcMain, shell } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  AllocationInput,
  AllocationListQuery,
  AttendanceCorrectionInput,
  AttendanceListQuery,
  BatchCheckInInput,
  ClassScheduleInput,
  ClassSessionInput,
  CourseClassInput,
  CourseClassListQuery,
  CustomFieldInput,
  CustomFieldPatch,
  InventoryItemInput,
  InventoryListQuery,
  IpcResult,
  LessonAdjustmentInput,
  ListQuery,
  QuickCheckInInput,
  ReportRange,
  RosterAddInput,
  RosterCandidateQuery,
  RosterRemoveInput,
  SessionMonthQuery,
  SessionUpdateInput,
  StudentInput,
  TeacherInput,
  WeeklyTimetableQuery,
} from '../shared/types';
import { validateAllocation, validateItem } from '../domain/inventory.validation';
import {
  validateAdjustment,
  validateBatchCheckIn,
  validateCorrection,
  validateQuickCheckIn,
} from '../domain/attendance.validation';
import {
  buildItemTemplate,
  exportAllocations,
  exportItems,
  importItems,
  readItemsPreview,
} from '../io/inventory-xlsx';
import {
  buildTemplate as buildAttendanceTemplate,
  exportRecords,
  importRecords,
  readImportPreview as readAttendanceImportPreview,
} from '../io/attendance-xlsx';
import { exportAttendanceByClass } from '../io/reports-xlsx';
import { pickOpenPath, pickSavePath, ymdCompact } from '../io/xlsx-util';
import { CH } from './channels';
import { AppError, ok, toIpcError } from './errors';
import { backupDir, userDataDir } from '../paths';
import { createSnapshot, listSnapshots } from '../db/backup';
import { closeDb } from '../db/connection';
import { markPendingRestore, validateRestoreSource } from '../db/restore';
import * as studentsRepo from '../domain/students.repo';
import * as fieldDefsRepo from '../domain/field-defs.repo';
import * as tagsRepo from '../domain/tags.repo';
import * as inventoryRepo from '../domain/inventory.repo';
import * as attendanceRepo from '../domain/attendance.repo';
import * as courseRepo from '../domain/course.repo';
import * as reportsRepo from '../domain/reports.repo';
import {
  validateClass,
  validateMonthQuery,
  validateRosterAdd,
  validateRosterRemove,
  validateSchedule,
  validateSessionCreate,
  validateSessionUpdate,
  validateTeacher,
} from '../domain/course.validation';
import { buildSchema, validateStudent } from '../domain/validation';
import { exportStudents } from '../io/export-xlsx';
import { buildTemplate, importStudents, readImportPreview } from '../io/import-xlsx';

/** 统一包裹：把处理函数的返回值 / 异常都转成 IpcResult 信封。 */
function handle<A extends unknown[], R>(
  channel: string,
  fn: (...args: A) => R | Promise<R>,
): void {
  ipcMain.handle(channel, async (_evt, ...args): Promise<IpcResult<R>> => {
    try {
      return ok(await fn(...(args as A)));
    } catch (err) {
      return toIpcError(err);
    }
  });
}

/** 当前完整表单描述（预设 + 未归档自定义）。 */
function currentSchema() {
  return buildSchema(fieldDefsRepo.descriptors());
}

/**
 * 校验并规整报表时间范围。页面理应已把 preset 换算成合法日期串，这里是最后一道闸：
 * 格式不对或起 > 止 → BAD_REQUEST，绝不把脏范围喂给 SQL。
 */
function checkedRange(q?: { from?: string; to?: string }): ReportRange {
  const from = (typeof q?.from === 'string' ? q.from : '').trim();
  const to = (typeof q?.to === 'string' ? q.to : '').trim();
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  if (!ymd.test(from) || !ymd.test(to)) {
    throw new AppError('BAD_REQUEST', '缺少合法的起止日期');
  }
  if (from > to) {
    throw new AppError('BAD_REQUEST', '起始日期不能晚于结束日期');
  }
  return { from, to };
}

/** 在 app ready 后、创建窗口前调用一次。 */
export function registerIpc(): void {
  // —— 应用信息 ——
  // app.getVersion() 读 package.json 的 version 字段（打包后读构建配置写入的版本号）
  handle(CH.appVersion, () => app.getVersion());

  // —— 学员档案 ——
  handle(CH.studentsList, (query?: ListQuery) => studentsRepo.list(query ?? {}));

  handle(CH.studentsGet, (id?: number) => {
    const student = studentsRepo.get(Number(id));
    if (!student) throw new AppError('NOT_FOUND', '学员不存在，可能已被删除');
    return student;
  });

  handle(CH.studentsCreate, (input?: StudentInput) => {
    const { values, errors } = validateStudent(input ?? ({} as StudentInput), currentSchema());
    if (Object.keys(errors).length > 0) {
      throw new AppError('VALIDATION_FAILED', '请检查表单填写', errors);
    }
    return studentsRepo.create(values);
  });

  handle(CH.studentsUpdate, (id?: number, input?: StudentInput) => {
    if (!Number.isFinite(Number(id))) throw new AppError('BAD_REQUEST', '缺少学员 id');
    const historical = studentsRepo.historicalValues(Number(id));
    const { values, errors } = validateStudent(
      input ?? ({} as StudentInput),
      currentSchema(),
      historical,
    );
    if (Object.keys(errors).length > 0) {
      throw new AppError('VALIDATION_FAILED', '请检查表单填写', errors);
    }
    const res = studentsRepo.update(Number(id), values);
    if (!res) throw new AppError('NOT_FOUND', '学员不存在，可能已被删除');
    return res;
  });

  handle(CH.studentsDelete, (id?: number) => {
    const res = studentsRepo.softDelete(Number(id));
    if (!res) throw new AppError('NOT_FOUND', '学员不存在，可能已被删除');
    return res;
  });

  // —— 自定义字段定义 ——
  handle(CH.fieldDefsSchema, () => ({ groups: currentSchema() }));

  handle(CH.fieldDefsList, (opts?: { includeArchived?: boolean }) =>
    fieldDefsRepo.list(opts ?? {}),
  );

  handle(CH.fieldDefsCreate, (input?: CustomFieldInput) => {
    if (!input || typeof input !== 'object') throw new AppError('BAD_REQUEST', '缺少字段设置');
    return fieldDefsRepo.create(input);
  });

  handle(CH.fieldDefsUpdate, (id?: number, patch?: CustomFieldPatch) => {
    if (!Number.isFinite(Number(id))) throw new AppError('BAD_REQUEST', '缺少字段 id');
    return fieldDefsRepo.update(Number(id), patch ?? {});
  });

  handle(CH.fieldDefsArchive, (id?: number) => fieldDefsRepo.archive(Number(id)));
  handle(CH.fieldDefsRestore, (id?: number) => fieldDefsRepo.restore(Number(id)));

  handle(CH.fieldDefsReorder, (ids?: number[]) => {
    if (!Array.isArray(ids)) throw new AppError('BAD_REQUEST', '缺少顺序数组');
    return fieldDefsRepo.reorder(ids.map(Number));
  });

  // —— 标签 ——
  handle(CH.tagsList, () => tagsRepo.list());
  handle(CH.tagsCreate, (input?: { name?: string; color?: string | null }) =>
    tagsRepo.create(input ?? {}),
  );
  handle(CH.tagsUpdate, (id?: number, patch?: { name?: string; color?: string | null }) => {
    if (!Number.isFinite(Number(id))) throw new AppError('BAD_REQUEST', '缺少标签 id');
    return tagsRepo.update(Number(id), patch ?? {});
  });
  handle(CH.tagsDelete, (id?: number) => tagsRepo.remove(Number(id)));
  handle(CH.tagsSetForStudent, (studentId?: number, tagIds?: number[]) => {
    if (!Number.isFinite(Number(studentId))) throw new AppError('BAD_REQUEST', '缺少学员 id');
    return tagsRepo.setForStudent(Number(studentId), Array.isArray(tagIds) ? tagIds : []);
  });

  // —— 导入导出 ——
  handle(CH.ioExportStudents, async (query?: ListQuery) => {
    const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const picked = await dialog.showSaveDialog({
      title: '导出学员档案',
      defaultPath: `学员档案-${ymd}.xlsx`,
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
    });
    if (picked.canceled || !picked.filePath) {
      throw new AppError('IO_CANCELLED', '已取消导出');
    }
    try {
      const count = await exportStudents(query ?? {}, picked.filePath);
      return { filePath: picked.filePath, count };
    } catch (err) {
      throw new AppError(
        'IO_WRITE_FAILED',
        `写入失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  handle(CH.ioDownloadTemplate, async () => {
    const picked = await dialog.showSaveDialog({
      title: '下载导入模板',
      defaultPath: '学员导入模板.xlsx',
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
    });
    if (picked.canceled || !picked.filePath) throw new AppError('IO_CANCELLED', '已取消');
    try {
      await buildTemplate(picked.filePath);
      return { filePath: picked.filePath };
    } catch (err) {
      throw new AppError(
        'IO_WRITE_FAILED',
        `写入失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  handle(CH.ioPickImportFile, async () => {
    const picked = await dialog.showOpenDialog({
      title: '选择要导入的 Excel',
      properties: ['openFile'],
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
    });
    const file = picked.filePaths[0];
    if (picked.canceled || !file) throw new AppError('IO_CANCELLED', '已取消');
    return readImportPreview(file);
  });

  handle(CH.ioImportStudents, (args?: { filePath?: string; mapping?: Record<string, string> }) => {
    if (!args?.filePath) throw new AppError('BAD_REQUEST', '缺少文件路径');
    return importStudents({ filePath: args.filePath, mapping: args.mapping ?? {} });
  });

  // —— 库存管理 ——
  handle(CH.inventoryListItems, (query?: InventoryListQuery) =>
    inventoryRepo.listItems(query ?? {}),
  );

  handle(CH.inventoryGetItem, (id?: number) => {
    const item = inventoryRepo.getItem(Number(id));
    if (!item) throw new AppError('NOT_FOUND', '物件不存在，可能已被删除');
    return item;
  });

  handle(CH.inventoryCreateItem, (input?: InventoryItemInput) => {
    const { values, errors } = validateItem(input ?? ({} as InventoryItemInput));
    if (Object.keys(errors).length > 0) {
      throw new AppError('VALIDATION_FAILED', '请检查表单填写', errors);
    }
    return inventoryRepo.createItem(values);
  });

  handle(CH.inventoryUpdateItem, (id?: number, input?: InventoryItemInput) => {
    if (!Number.isFinite(Number(id))) throw new AppError('BAD_REQUEST', '缺少物件 id');
    const { values, errors } = validateItem(input ?? ({} as InventoryItemInput), { isEdit: true });
    if (Object.keys(errors).length > 0) {
      throw new AppError('VALIDATION_FAILED', '请检查表单填写', errors);
    }
    return inventoryRepo.updateItem(Number(id), values);
  });

  handle(CH.inventoryDeleteItem, (id?: number) => inventoryRepo.softDeleteItem(Number(id)));

  handle(CH.inventoryAllocate, (input?: AllocationInput) => {
    const p = input ?? ({} as AllocationInput);
    const item = inventoryRepo.getItem(Number(p.itemId));
    if (!item || item.deletedAt != null) {
      throw new AppError('NOT_FOUND', '物件不存在，可能已被删除');
    }
    const { values, errors } = validateAllocation(p, item);
    if (Object.keys(errors).length > 0) {
      throw new AppError('VALIDATION_FAILED', '请检查表单填写', errors);
    }
    return inventoryRepo.allocate(values);
  });

  handle(CH.inventoryListAllocations, (query?: AllocationListQuery) =>
    inventoryRepo.listAllocations(query ?? {}),
  );

  handle(CH.inventoryDeleteAllocation, (id?: number) => {
    if (!Number.isFinite(Number(id))) throw new AppError('BAD_REQUEST', '缺少领用记录 id');
    return inventoryRepo.deleteAllocation(Number(id));
  });

  handle(CH.inventoryExportItems, async (query?: InventoryListQuery) => {
    const filePath = await pickSavePath('导出物件台账', `物件台账-${ymdCompact()}.xlsx`);
    try {
      const count = await exportItems(query ?? {}, filePath);
      return { filePath, count };
    } catch (err) {
      throw new AppError(
        'IO_WRITE_FAILED',
        `写入失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  handle(CH.inventoryExportAllocations, async (query?: AllocationListQuery) => {
    const filePath = await pickSavePath('导出领用流水', `领用流水-${ymdCompact()}.xlsx`);
    try {
      const count = await exportAllocations(query ?? {}, filePath);
      return { filePath, count };
    } catch (err) {
      throw new AppError(
        'IO_WRITE_FAILED',
        `写入失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  handle(CH.inventoryDownloadTemplate, async () => {
    const filePath = await pickSavePath('下载物件导入模板', '物件导入模板.xlsx');
    try {
      await buildItemTemplate(filePath);
      return { filePath };
    } catch (err) {
      throw new AppError(
        'IO_WRITE_FAILED',
        `写入失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  handle(CH.inventoryPickImportFile, async () => {
    const filePath = await pickOpenPath('选择要导入的 Excel');
    return readItemsPreview(filePath);
  });

  handle(
    CH.inventoryImportItems,
    (args?: { filePath?: string; mapping?: Record<string, string> }) => {
      if (!args?.filePath) throw new AppError('BAD_REQUEST', '缺少文件路径');
      return importItems({ filePath: args.filePath, mapping: args.mapping ?? {} });
    },
  );

  // —— 考勤管理 ——
  handle(CH.attendanceList, (query?: AttendanceListQuery) =>
    attendanceRepo.listRecords(query ?? {}),
  );

  handle(CH.attendanceRosterCandidates, (query?: RosterCandidateQuery) =>
    attendanceRepo.listRosterCandidates(query ?? {}),
  );

  handle(CH.attendanceQuickCheckIn, (input?: QuickCheckInInput) => {
    const { values, errors } = validateQuickCheckIn(input ?? ({} as QuickCheckInInput));
    if (Object.keys(errors).length > 0) {
      throw new AppError('VALIDATION_FAILED', '请检查表单填写', errors);
    }
    return attendanceRepo.createRecord(values);
  });

  handle(CH.attendanceBatchCheckIn, (input?: BatchCheckInInput) => {
    const p = input ?? ({} as BatchCheckInInput);
    if (!Array.isArray(p.entries) || p.entries.length === 0) {
      throw new AppError('BAD_REQUEST', '请至少勾选一名学员');
    }
    const { values, errors } = validateBatchCheckIn(p);
    if (Object.keys(errors).length > 0) {
      throw new AppError('VALIDATION_FAILED', '请检查点名信息', errors);
    }
    return attendanceRepo.batchCreate(values);
  });

  handle(CH.attendanceCorrect, (input?: AttendanceCorrectionInput) => {
    const { values, errors } = validateCorrection(
      input ?? ({} as AttendanceCorrectionInput),
    );
    if (Object.keys(errors).length > 0) {
      throw new AppError('VALIDATION_FAILED', '请检查表单填写', errors);
    }
    return attendanceRepo.correctRecord(values);
  });

  handle(CH.attendanceVoid, (id?: number) => {
    if (!Number.isFinite(Number(id))) throw new AppError('BAD_REQUEST', '缺少记录 id');
    return attendanceRepo.voidRecord(Number(id));
  });

  handle(CH.attendanceAdjustLessons, (input?: LessonAdjustmentInput) => {
    const { values, errors, deltaError } = validateAdjustment(
      input ?? ({} as LessonAdjustmentInput),
    );
    if (deltaError) throw new AppError('INVALID_ADJUSTMENT', deltaError, { delta: deltaError });
    if (Object.keys(errors).length > 0) {
      throw new AppError('VALIDATION_FAILED', '请检查表单填写', errors);
    }
    return attendanceRepo.adjustLessons(values);
  });

  handle(CH.attendanceExport, async (query?: AttendanceListQuery) => {
    const filePath = await pickSavePath('导出考勤记录', `考勤记录-${ymdCompact()}.xlsx`);
    try {
      const r = await exportRecords(query ?? {}, filePath);
      return { filePath, ...r };
    } catch (err) {
      throw new AppError(
        'IO_WRITE_FAILED',
        `写入失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  handle(CH.attendanceDownloadTemplate, async () => {
    const filePath = await pickSavePath('下载考勤导入模板', '考勤导入模板.xlsx');
    try {
      await buildAttendanceTemplate(filePath);
      return { filePath };
    } catch (err) {
      throw new AppError(
        'IO_WRITE_FAILED',
        `写入失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  handle(CH.attendancePickImportFile, async () => {
    const filePath = await pickOpenPath('选择要导入的 Excel');
    return readAttendanceImportPreview(filePath);
  });

  handle(
    CH.attendanceImport,
    (args?: { filePath?: string; mapping?: Record<string, string> }) => {
      if (!args?.filePath) throw new AppError('BAD_REQUEST', '缺少文件路径');
      return importRecords({ filePath: args.filePath, mapping: args.mapping ?? {} });
    },
  );

  // —— 课程管理：老师 / 班级 / 花名册 ——
  handle(CH.courseTeacherList, (opts?: { includeInactive?: boolean }) =>
    courseRepo.teacherList(opts ?? {}),
  );

  handle(CH.courseTeacherCreate, (input?: TeacherInput) => {
    const { values, errors } = validateTeacher(input ?? ({} as TeacherInput));
    if (Object.keys(errors).length > 0) {
      throw new AppError('VALIDATION_FAILED', '请检查表单填写', errors);
    }
    return courseRepo.teacherCreate(values);
  });

  handle(CH.courseTeacherUpdate, (id?: number, input?: TeacherInput) => {
    if (!Number.isFinite(Number(id))) throw new AppError('BAD_REQUEST', '缺少老师 id');
    const { values, errors } = validateTeacher(input ?? ({} as TeacherInput), { isEdit: true });
    if (Object.keys(errors).length > 0) {
      throw new AppError('VALIDATION_FAILED', '请检查表单填写', errors);
    }
    return courseRepo.teacherUpdate(Number(id), values);
  });

  handle(CH.courseTeacherDelete, (id?: number) => {
    if (!Number.isFinite(Number(id))) throw new AppError('BAD_REQUEST', '缺少老师 id');
    return courseRepo.teacherSoftDelete(Number(id));
  });

  handle(CH.courseClassList, (query?: CourseClassListQuery) =>
    courseRepo.classList(query ?? {}),
  );

  handle(CH.courseClassGet, (id?: number) => {
    if (!Number.isFinite(Number(id))) throw new AppError('BAD_REQUEST', '缺少班级 id');
    return courseRepo.classGet(Number(id));
  });

  handle(CH.courseClassCreate, (input?: CourseClassInput) => {
    const { values, errors } = validateClass(input ?? ({} as CourseClassInput));
    if (Object.keys(errors).length > 0) {
      throw new AppError('VALIDATION_FAILED', '请检查表单填写', errors);
    }
    return courseRepo.classCreate(values);
  });

  handle(CH.courseClassUpdate, (id?: number, input?: CourseClassInput) => {
    if (!Number.isFinite(Number(id))) throw new AppError('BAD_REQUEST', '缺少班级 id');
    const { values, errors } = validateClass(input ?? ({} as CourseClassInput));
    if (Object.keys(errors).length > 0) {
      throw new AppError('VALIDATION_FAILED', '请检查表单填写', errors);
    }
    return courseRepo.classUpdate(Number(id), values);
  });

  handle(CH.courseClassDelete, (id?: number) => {
    if (!Number.isFinite(Number(id))) throw new AppError('BAD_REQUEST', '缺少班级 id');
    return courseRepo.classSoftDelete(Number(id));
  });

  handle(CH.courseRosterList, (classId?: number) => {
    if (!Number.isFinite(Number(classId))) throw new AppError('BAD_REQUEST', '缺少班级 id');
    return courseRepo.rosterList(Number(classId));
  });

  handle(CH.courseRosterAdd, (input?: RosterAddInput) => {
    const { values, errors } = validateRosterAdd(input ?? ({} as RosterAddInput));
    if (Object.keys(errors).length > 0) {
      throw new AppError('VALIDATION_FAILED', '请检查表单填写', errors);
    }
    return courseRepo.rosterAdd(values);
  });

  handle(CH.courseRosterRemove, (input?: RosterRemoveInput) => {
    const { values, errors } = validateRosterRemove(input ?? ({} as RosterRemoveInput));
    if (Object.keys(errors).length > 0) {
      throw new AppError('VALIDATION_FAILED', '请检查表单填写', errors);
    }
    return courseRepo.rosterRemove(values);
  });

  // —— 课程管理：周期规则 ——
  handle(CH.courseScheduleList, (classId?: number) => {
    if (!Number.isFinite(Number(classId))) throw new AppError('BAD_REQUEST', '缺少班级 id');
    return courseRepo.scheduleList(Number(classId));
  });

  /** 校验 → 分流 INVALID_WEEKDAY / INVALID_TIME_RANGE / VALIDATION_FAILED；否则落库。 */
  const checkedSchedule = (input: ClassScheduleInput) => {
    const { values, errors, weekdayError, timeError } = validateSchedule(input);
    if (weekdayError) throw new AppError('INVALID_WEEKDAY', weekdayError, { weekday: weekdayError });
    if (timeError) throw new AppError('INVALID_TIME_RANGE', timeError, { endTime: timeError });
    if (Object.keys(errors).length > 0) {
      throw new AppError('VALIDATION_FAILED', '请检查表单填写', errors);
    }
    return values;
  };

  handle(CH.courseScheduleCreate, (input?: ClassScheduleInput) =>
    courseRepo.scheduleCreate(checkedSchedule(input ?? ({} as ClassScheduleInput))),
  );

  handle(CH.courseScheduleUpdate, (id?: number, input?: ClassScheduleInput) => {
    if (!Number.isFinite(Number(id))) throw new AppError('BAD_REQUEST', '缺少规则 id');
    return courseRepo.scheduleUpdate(Number(id), checkedSchedule(input ?? ({} as ClassScheduleInput)));
  });

  handle(CH.courseScheduleDelete, (id?: number) => {
    if (!Number.isFinite(Number(id))) throw new AppError('BAD_REQUEST', '缺少规则 id');
    return courseRepo.scheduleSoftDelete(Number(id));
  });

  // —— 课程管理：课程表（周视图） ——
  handle(CH.courseWeeklyTimetable, (query?: WeeklyTimetableQuery) =>
    courseRepo.weeklyTimetable(query ?? {}),
  );

  // —— 课程管理：排课实例 ——
  handle(CH.courseGenerateMonth, (args?: { year?: number; month?: number }) => {
    const { values, error } = validateMonthQuery((args ?? {}) as SessionMonthQuery);
    if (error) throw new AppError('BAD_REQUEST', error);
    return courseRepo.generateMonth(values.year, values.month);
  });

  handle(CH.courseSessionsByMonth, (query?: SessionMonthQuery) => {
    const { values, error } = validateMonthQuery(query ?? ({} as SessionMonthQuery));
    if (error) throw new AppError('BAD_REQUEST', error);
    return courseRepo.sessionsByMonth(values);
  });

  handle(CH.courseSessionsByWeek, (args?: { date?: string }) => {
    const date = typeof args?.date === 'string' ? args.date.trim() : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new AppError('BAD_REQUEST', '缺少合法日期');
    return courseRepo.sessionsByWeek(date);
  });

  handle(CH.courseSessionCreate, (input?: ClassSessionInput) => {
    const { values, errors, timeError } = validateSessionCreate(input ?? ({} as ClassSessionInput));
    if (timeError) throw new AppError('INVALID_TIME_RANGE', timeError, { endTime: timeError });
    if (Object.keys(errors).length > 0) {
      throw new AppError('VALIDATION_FAILED', '请检查表单填写', errors);
    }
    return courseRepo.sessionCreate(values);
  });

  handle(CH.courseSessionUpdate, (input?: SessionUpdateInput) => {
    const { values, errors, timeError } = validateSessionUpdate(input ?? ({} as SessionUpdateInput));
    if (timeError) throw new AppError('INVALID_TIME_RANGE', timeError, { endTime: timeError });
    if (Object.keys(errors).length > 0) {
      throw new AppError('VALIDATION_FAILED', '请检查操作参数', errors);
    }
    return courseRepo.sessionUpdate(values);
  });

  handle(CH.courseSessionDelete, (id?: number) => {
    if (!Number.isFinite(Number(id))) throw new AppError('BAD_REQUEST', '缺少课节 id');
    return courseRepo.sessionSoftDelete(Number(id));
  });

  // —— 数据报表（纯只读聚合）——
  handle(CH.reportsOverview, (q?: { from?: string; to?: string }) =>
    reportsRepo.getOverview(checkedRange(q)),
  );

  handle(CH.reportsAlerts, () => reportsRepo.getAlerts());

  handle(CH.reportsAttendanceStats, (q?: { from?: string; to?: string }) =>
    reportsRepo.getAttendanceStats(checkedRange(q)),
  );

  handle(CH.reportsCourseStats, (q?: { from?: string; to?: string }) =>
    reportsRepo.getCourseStats(checkedRange(q)),
  );

  handle(CH.reportsStudentStats, (q?: { from?: string; to?: string }) =>
    reportsRepo.getStudentStats(checkedRange(q)),
  );

  handle(CH.reportsInventoryStats, (q?: { from?: string; to?: string }) =>
    reportsRepo.getInventoryStats(checkedRange(q)),
  );

  handle(CH.reportsHomeSummary, () => reportsRepo.getHomeSummary());

  // —— 数据库快照备份 ——
  // 完整性校验失败（BACKUP_VERIFY_FAILED）原样透出；其余（磁盘满 / 无写权限……）
  // 归到 IO_WRITE_FAILED，带上原始 message 方便用户判断。
  const makeSnapshot = async () => {
    try {
      return await createSnapshot({ dir: backupDir() });
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        'IO_WRITE_FAILED',
        `备份写入失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  handle(CH.backupCreate, () => makeSnapshot());

  handle(CH.backupList, () => listSnapshots(backupDir()));

  handle(CH.backupReveal, () => {
    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true }); // 首次、或被手动删空时，先建出来再打开
    void shell.openPath(dir);
    return { dir };
  });

  handle(CH.backupCreateToFolder, async () => {
    const picked = await dialog.showOpenDialog({
      title: '选择另存目录（U 盘 / 网盘等）',
      properties: ['openDirectory', 'createDirectory'],
    });
    const targetDir = picked.filePaths[0];
    if (picked.canceled || !targetDir) {
      throw new AppError('IO_CANCELLED', '已取消');
    }
    // 先在默认备份目录正常生成一份（也进列表），再往用户选的目录拷一份。
    // 跨盘时 rename 会失败，所以这里用 copyFile。
    const primary = await makeSnapshot();
    const copiedTo = path.join(targetDir, primary.name);
    try {
      fs.copyFileSync(primary.path, copiedTo);
    } catch (err) {
      throw new AppError(
        'IO_WRITE_FAILED',
        `已在本机备份成功，但复制到所选目录失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { primary, copiedTo };
  });

  /**
   * 恢复的共同收尾：校验源文件 → 原生二次确认 → 给现役数据留一份 pre-restore 快照 →
   * 关闭连接（把 WAL 落盘，留底才完整）→ 写标记 → 重启。重启后 main.ts 在 getDb() 前换库。
   */
  const startRestore = async (source: string): Promise<{ restarting: true }> => {
    validateRestoreSource(source); // 不合法直接抛 AppError

    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['取消', '恢复并重启'],
      defaultId: 1,
      cancelId: 0,
      title: '用备份恢复数据',
      message: '将用这份备份替换当前所有数据',
      detail:
        `备份文件：\n${source}\n\n` +
        '继续的话，当前数据会先自动备份一份（进备份列表，标签 pre-restore），' +
        '然后应用重启完成恢复。',
    });
    if (response !== 1) throw new AppError('IO_CANCELLED', '已取消');

    // 先给现役数据留底；这一步失败就中止恢复——不能让用户在没有后悔药的情况下换库
    try {
      await createSnapshot({ dir: backupDir(), tag: 'pre-restore' });
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        'IO_WRITE_FAILED',
        `恢复前的自动备份没做成，已中止恢复：${err instanceof Error ? err.message : String(err)}`,
      );
    }

    closeDb(); // WAL 落盘，让留底的旧库文件是完整的
    markPendingRestore(userDataDir(), source);
    app.relaunch();
    app.exit(0);
    return { restarting: true };
  };

  handle(CH.backupRestoreFromList, (args?: { name?: string }) => {
    const name = typeof args?.name === 'string' ? args.name : '';
    // 只接受备份目录下的文件名，挡掉路径穿越
    if (!name || path.basename(name) !== name) {
      throw new AppError('BAD_REQUEST', '缺少合法的备份文件名');
    }
    return startRestore(path.join(backupDir(), name));
  });

  handle(CH.backupRestoreFromFile, async () => {
    const picked = await dialog.showOpenDialog({
      title: '选择要恢复的数据库备份',
      properties: ['openFile'],
      filters: [{ name: '数据库备份', extensions: ['db'] }],
    });
    const file = picked.filePaths[0];
    if (picked.canceled || !file) throw new AppError('IO_CANCELLED', '已取消');
    return startRestore(file);
  });

  handle(CH.reportsExportAttendanceByClass, async (args?: { year?: number }) => {
    const year = Number(args?.year);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new AppError('BAD_REQUEST', '缺少合法年份');
    }
    // 先便宜探测：没有任何可导出数据就不弹保存框（FR-16）
    if (!reportsRepo.canExportAttendance(year)) {
      throw new AppError('REPORT_EMPTY', '所选年份没有排课班级，也没有学员考勤记录，无法导出');
    }
    const filePath = await pickSavePath('导出出勤统计', `出勤统计-${year}-${ymdCompact()}.xlsx`);
    try {
      return await exportAttendanceByClass(year, filePath);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        'IO_WRITE_FAILED',
        `写入失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}
