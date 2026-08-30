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
  },
};

contextBridge.exposeInMainWorld('studioShell', api);

export type StudioShell = typeof api;
