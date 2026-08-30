/**
 * 预加载脚本。
 *
 * 在 contextIsolation 开启的前提下，这里是主进程与页面之间唯一安全的桥梁：
 * 页面本身拿不到 Node 能力，需要什么都得经由 contextBridge 显式、按需地暴露。
 *
 * 这里只把「学员档案」用到的几个窄接口挂到 window.studioShell 上，
 * 不暴露 ipcRenderer 本体，也不暴露 fs / path 等系统模块。
 *
 * 注意：本文件以「沙盒预加载」方式运行，其 require 只能加载 electron 等极少数内建模块，
 * 不能 require 相对路径模块。因此频道名在这里以字面量重复一份（权威定义见
 * src/ipc/channels.ts，两处需保持一致——数量少、极少变动，可接受）。
 */
import { contextBridge, ipcRenderer } from 'electron';

const CH = {
  studentsList: 'students:list',
  studentsGet: 'students:get',
  studentsCreate: 'students:create',
  studentsUpdate: 'students:update',
  studentsDelete: 'students:delete',
  fieldDefsSchema: 'fieldDefs:schema',
  fieldDefsList: 'fieldDefs:list',
  fieldDefsCreate: 'fieldDefs:create',
  fieldDefsUpdate: 'fieldDefs:update',
  fieldDefsArchive: 'fieldDefs:archive',
  fieldDefsRestore: 'fieldDefs:restore',
  fieldDefsReorder: 'fieldDefs:reorder',
  tagsList: 'tags:list',
  tagsCreate: 'tags:create',
  tagsUpdate: 'tags:update',
  tagsDelete: 'tags:delete',
  tagsSetForStudent: 'tags:setForStudent',
  ioExportStudents: 'io:exportStudents',
  ioDownloadTemplate: 'io:downloadTemplate',
  ioPickImportFile: 'io:pickImportFile',
  ioImportStudents: 'io:importStudents',
  inventoryListItems: 'inventory:listItems',
  inventoryGetItem: 'inventory:getItem',
  inventoryCreateItem: 'inventory:createItem',
  inventoryUpdateItem: 'inventory:updateItem',
  inventoryDeleteItem: 'inventory:deleteItem',
  inventoryAllocate: 'inventory:allocate',
  inventoryListAllocations: 'inventory:listAllocations',
  inventoryDeleteAllocation: 'inventory:deleteAllocation',
  inventoryExportItems: 'inventory:exportItems',
  inventoryExportAllocations: 'inventory:exportAllocations',
  inventoryDownloadTemplate: 'inventory:downloadTemplate',
  inventoryPickImportFile: 'inventory:pickImportFile',
  inventoryImportItems: 'inventory:importItems',
  attendanceList: 'attendance:list',
  attendanceQuickCheckIn: 'attendance:quickCheckIn',
  attendanceBatchCheckIn: 'attendance:batchCheckIn',
  attendanceRosterCandidates: 'attendance:rosterCandidates',
  attendanceCorrect: 'attendance:correct',
  attendanceVoid: 'attendance:void',
  attendanceAdjustLessons: 'attendance:adjustLessons',
  attendanceExport: 'attendance:export',
  attendanceDownloadTemplate: 'attendance:downloadTemplate',
  attendancePickImportFile: 'attendance:pickImportFile',
  attendanceImport: 'attendance:import',
  courseTeacherList: 'course:teacherList',
  courseTeacherCreate: 'course:teacherCreate',
  courseTeacherUpdate: 'course:teacherUpdate',
  courseTeacherDelete: 'course:teacherDelete',
  courseClassList: 'course:classList',
  courseClassGet: 'course:classGet',
  courseClassCreate: 'course:classCreate',
  courseClassUpdate: 'course:classUpdate',
  courseClassDelete: 'course:classDelete',
  courseRosterList: 'course:rosterList',
  courseRosterAdd: 'course:rosterAdd',
  courseRosterRemove: 'course:rosterRemove',
  courseScheduleList: 'course:scheduleList',
  courseScheduleCreate: 'course:scheduleCreate',
  courseScheduleUpdate: 'course:scheduleUpdate',
  courseScheduleDelete: 'course:scheduleDelete',
  courseWeeklyTimetable: 'course:weeklyTimetable',
  courseGenerateMonth: 'course:generateMonth',
  courseSessionsByMonth: 'course:sessionsByMonth',
  courseSessionsByDate: 'course:sessionsByDate',
  courseSessionCreate: 'course:sessionCreate',
  courseSessionUpdate: 'course:sessionUpdate',
  courseSessionDelete: 'course:sessionDelete',
  reportsOverview: 'reports:overview',
  reportsAlerts: 'reports:alerts',
  reportsAttendanceStats: 'reports:attendanceStats',
  reportsCourseStats: 'reports:courseStats',
  reportsStudentStats: 'reports:studentStats',
  reportsInventoryStats: 'reports:inventoryStats',
  reportsExportAttendanceByClass: 'reports:exportAttendanceByClass',
  reportsHomeSummary: 'reports:homeSummary',
  backupCreate: 'backup:create',
  backupList: 'backup:list',
} as const;

/** 统一走 invoke：异步、可回传结构化结果（IpcResult 信封）。 */
function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

const api = {
  // 保留：首页脚本历史上用作「preload 已执行」的可观测标记
  ready: true,

  students: {
    list: (query?: unknown) => invoke(CH.studentsList, query),
    get: (id: number) => invoke(CH.studentsGet, id),
    create: (input: unknown) => invoke(CH.studentsCreate, input),
    update: (id: number, input: unknown) => invoke(CH.studentsUpdate, id, input),
    softDelete: (id: number) => invoke(CH.studentsDelete, id),
  },

  fieldDefs: {
    schema: () => invoke(CH.fieldDefsSchema),
    list: (opts?: unknown) => invoke(CH.fieldDefsList, opts),
    create: (input: unknown) => invoke(CH.fieldDefsCreate, input),
    update: (id: number, patch: unknown) => invoke(CH.fieldDefsUpdate, id, patch),
    archive: (id: number) => invoke(CH.fieldDefsArchive, id),
    restore: (id: number) => invoke(CH.fieldDefsRestore, id),
    reorder: (ids: number[]) => invoke(CH.fieldDefsReorder, ids),
  },

  tags: {
    list: () => invoke(CH.tagsList),
    create: (input: unknown) => invoke(CH.tagsCreate, input),
    update: (id: number, patch: unknown) => invoke(CH.tagsUpdate, id, patch),
    remove: (id: number) => invoke(CH.tagsDelete, id),
    setForStudent: (studentId: number, tagIds: number[]) =>
      invoke(CH.tagsSetForStudent, studentId, tagIds),
  },

  io: {
    exportStudents: (query?: unknown) => invoke(CH.ioExportStudents, query),
    downloadTemplate: () => invoke(CH.ioDownloadTemplate),
    pickImportFile: () => invoke(CH.ioPickImportFile),
    importStudents: (args: unknown) => invoke(CH.ioImportStudents, args),
  },

  inventory: {
    listItems: (query?: unknown) => invoke(CH.inventoryListItems, query),
    getItem: (id: number) => invoke(CH.inventoryGetItem, id),
    createItem: (input: unknown) => invoke(CH.inventoryCreateItem, input),
    updateItem: (id: number, input: unknown) => invoke(CH.inventoryUpdateItem, id, input),
    deleteItem: (id: number) => invoke(CH.inventoryDeleteItem, id),
    allocate: (input: unknown) => invoke(CH.inventoryAllocate, input),
    allocations: (query?: unknown) => invoke(CH.inventoryListAllocations, query),
    deleteAllocation: (id: number) => invoke(CH.inventoryDeleteAllocation, id),
    exportItems: (query?: unknown) => invoke(CH.inventoryExportItems, query),
    exportAllocations: (query?: unknown) => invoke(CH.inventoryExportAllocations, query),
    downloadTemplate: () => invoke(CH.inventoryDownloadTemplate),
    pickImportFile: () => invoke(CH.inventoryPickImportFile),
    importItems: (args: unknown) => invoke(CH.inventoryImportItems, args),
  },

  attendance: {
    list: (query?: unknown) => invoke(CH.attendanceList, query),
    quickCheckIn: (input: unknown) => invoke(CH.attendanceQuickCheckIn, input),
    batchCheckIn: (input: unknown) => invoke(CH.attendanceBatchCheckIn, input),
    rosterCandidates: (query?: unknown) => invoke(CH.attendanceRosterCandidates, query),
    correct: (input: unknown) => invoke(CH.attendanceCorrect, input),
    voidRecord: (id: number) => invoke(CH.attendanceVoid, id),
    adjustLessons: (input: unknown) => invoke(CH.attendanceAdjustLessons, input),
    export: (query?: unknown) => invoke(CH.attendanceExport, query),
    downloadTemplate: () => invoke(CH.attendanceDownloadTemplate),
    pickImportFile: () => invoke(CH.attendancePickImportFile),
    import: (args: unknown) => invoke(CH.attendanceImport, args),
  },

  course: {
    teacherList: (opts?: unknown) => invoke(CH.courseTeacherList, opts),
    teacherCreate: (input: unknown) => invoke(CH.courseTeacherCreate, input),
    teacherUpdate: (id: number, input: unknown) => invoke(CH.courseTeacherUpdate, id, input),
    teacherDelete: (id: number) => invoke(CH.courseTeacherDelete, id),
    classList: (query?: unknown) => invoke(CH.courseClassList, query),
    classGet: (id: number) => invoke(CH.courseClassGet, id),
    classCreate: (input: unknown) => invoke(CH.courseClassCreate, input),
    classUpdate: (id: number, input: unknown) => invoke(CH.courseClassUpdate, id, input),
    classDelete: (id: number) => invoke(CH.courseClassDelete, id),
    rosterList: (classId: number) => invoke(CH.courseRosterList, classId),
    rosterAdd: (input: unknown) => invoke(CH.courseRosterAdd, input),
    rosterRemove: (input: unknown) => invoke(CH.courseRosterRemove, input),
    scheduleList: (classId: number) => invoke(CH.courseScheduleList, classId),
    scheduleCreate: (input: unknown) => invoke(CH.courseScheduleCreate, input),
    scheduleUpdate: (id: number, input: unknown) => invoke(CH.courseScheduleUpdate, id, input),
    scheduleDelete: (id: number) => invoke(CH.courseScheduleDelete, id),
    weeklyTimetable: (query?: unknown) => invoke(CH.courseWeeklyTimetable, query),
    generateMonth: (args: unknown) => invoke(CH.courseGenerateMonth, args),
    sessionsByMonth: (query: unknown) => invoke(CH.courseSessionsByMonth, query),
    sessionsByDate: (args: unknown) => invoke(CH.courseSessionsByDate, args),
    sessionCreate: (input: unknown) => invoke(CH.courseSessionCreate, input),
    sessionUpdate: (input: unknown) => invoke(CH.courseSessionUpdate, input),
    sessionDelete: (id: number) => invoke(CH.courseSessionDelete, id),
  },

  // 数据报表：纯只读聚合。频道随各指标区 issue 逐个接入。
  reports: {
    overview: (range: { from: string; to: string }) => invoke(CH.reportsOverview, range),
    alerts: () => invoke(CH.reportsAlerts),
    attendanceStats: (range: { from: string; to: string }) =>
      invoke(CH.reportsAttendanceStats, range),
    courseStats: (range: { from: string; to: string }) => invoke(CH.reportsCourseStats, range),
    studentStats: (range: { from: string; to: string }) => invoke(CH.reportsStudentStats, range),
    inventoryStats: (range: { from: string; to: string }) =>
      invoke(CH.reportsInventoryStats, range),
    exportAttendanceByClass: (year: number) =>
      invoke(CH.reportsExportAttendanceByClass, { year }),
    homeSummary: () => invoke(CH.reportsHomeSummary),
  },

  // 数据库快照备份
  backup: {
    create: () => invoke(CH.backupCreate),
    list: () => invoke(CH.backupList),
  },
};

contextBridge.exposeInMainWorld('studioShell', api);

export type StudioShell = typeof api;
