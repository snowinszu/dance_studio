/**
 * IPC 频道名常量。
 *
 * 主进程 register.ts 用它注册 ipcMain.handle，preload.ts 用它发 ipcRenderer.invoke，
 * 两边引用同一份常量，避免字符串手抖对不上。命名统一 `域:动作`。
 */
export const CH = {
  // 学员档案
  studentsList: 'students:list',
  studentsGet: 'students:get',
  studentsCreate: 'students:create',
  studentsUpdate: 'students:update',
  studentsDelete: 'students:delete',

  // 字段定义 / 表单描述
  fieldDefsSchema: 'fieldDefs:schema',
  fieldDefsList: 'fieldDefs:list',
  fieldDefsCreate: 'fieldDefs:create',
  fieldDefsUpdate: 'fieldDefs:update',
  fieldDefsArchive: 'fieldDefs:archive',
  fieldDefsRestore: 'fieldDefs:restore',
  fieldDefsReorder: 'fieldDefs:reorder',

  // 标签
  tagsList: 'tags:list',
  tagsCreate: 'tags:create',
  tagsUpdate: 'tags:update',
  tagsDelete: 'tags:delete',
  tagsSetForStudent: 'tags:setForStudent',

  // 导入导出
  ioExportStudents: 'io:exportStudents',
  ioDownloadTemplate: 'io:downloadTemplate',
  ioPickImportFile: 'io:pickImportFile',
  ioImportStudents: 'io:importStudents',

  // 库存管理
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

  // 考勤管理
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

  // 课程管理 —— 老师 / 班级 / 花名册
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

  // 课程管理 —— 周期规则
  courseScheduleList: 'course:scheduleList',
  courseScheduleCreate: 'course:scheduleCreate',
  courseScheduleUpdate: 'course:scheduleUpdate',
  courseScheduleDelete: 'course:scheduleDelete',

  // 课程管理 —— 课程表 / 排课
  courseWeeklyTimetable: 'course:weeklyTimetable',
  courseGenerateMonth: 'course:generateMonth',
  courseSessionsByMonth: 'course:sessionsByMonth',
  courseSessionsByDate: 'course:sessionsByDate',
  courseSessionCreate: 'course:sessionCreate',
  courseSessionUpdate: 'course:sessionUpdate',
  courseSessionDelete: 'course:sessionDelete',

  // 数据报表（纯只读聚合）
  reportsOverview: 'reports:overview',
  reportsAlerts: 'reports:alerts',
  reportsAttendanceStats: 'reports:attendanceStats',
  reportsCourseStats: 'reports:courseStats',
  reportsStudentStats: 'reports:studentStats',
  reportsInventoryStats: 'reports:inventoryStats',
  reportsExportAttendanceByClass: 'reports:exportAttendanceByClass',
  reportsHomeSummary: 'reports:homeSummary',

  // 数据库快照备份
  backupCreate: 'backup:create',
  backupList: 'backup:list',
} as const;

export type ChannelName = (typeof CH)[keyof typeof CH];
