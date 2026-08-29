/**
 * IPC 处理器注册。
 *
 * 整体类比：这是「服务台」。每个窗口（频道）对应一项业务，来人（渲染进程）
 * 递单子，服务台叫后台（domain 层）办，办好把结果装进统一信封递回去。
 * 后台如果撂挑子（抛异常），服务台也不让异常飞出去，而是回一个「办不成 + 原因」的信封。
 */
import { dialog, ipcMain } from 'electron';
import type {
  AllocationListQuery,
  CustomFieldInput,
  CustomFieldPatch,
  InventoryItemInput,
  InventoryListQuery,
  IpcResult,
  ListQuery,
  StudentInput,
} from '../shared/types';
import { validateItem } from '../domain/inventory.validation';
import { CH } from './channels';
import { AppError, ok, toIpcError } from './errors';
import * as studentsRepo from '../domain/students.repo';
import * as fieldDefsRepo from '../domain/field-defs.repo';
import * as tagsRepo from '../domain/tags.repo';
import * as inventoryRepo from '../domain/inventory.repo';
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

/** 在 app ready 后、创建窗口前调用一次。 */
export function registerIpc(): void {
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

  handle(CH.inventoryListAllocations, (query?: AllocationListQuery) =>
    inventoryRepo.listAllocations(query ?? {}),
  );
}
