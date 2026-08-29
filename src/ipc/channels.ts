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
} as const;

export type ChannelName = (typeof CH)[keyof typeof CH];
