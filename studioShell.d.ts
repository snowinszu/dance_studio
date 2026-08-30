/**
 * window.studioShell 的环境类型声明。
 *
 * 渲染层 students.js 不参与 TypeScript 构建，这份 .d.ts 仅供编辑器给出补全与提示，
 * 不进任何 tsconfig 的 include。真实实现见 src/preload.ts，契约类型见 src/shared/types.ts。
 */
import type {
  AllocationInput,
  AllocationListQuery,
  AllocationListResult,
  AttendanceCorrectionInput,
  AttendanceListQuery,
  AttendanceListResult,
  BatchCheckInInput,
  BatchCheckInResult,
  CheckInResult,
  CustomFieldDef,
  CustomFieldInput,
  CustomFieldPatch,
  ImportReport,
  InventoryImportReport,
  InventoryItem,
  InventoryItemInput,
  InventoryListQuery,
  InventoryListResult,
  IpcResult,
  ListQuery,
  ListResult,
  QuickCheckInInput,
  RosterCandidate,
  RosterCandidateQuery,
  SchemaGroup,
  Student,
  StudentInput,
  Tag,
} from './src/shared/types';

declare global {
  interface StudioShell {
    /** 历史遗留标记：preload 已在隔离世界执行 */
    ready: true;

    students: {
      list(query?: ListQuery): Promise<IpcResult<ListResult>>;
      get(id: number): Promise<IpcResult<Student>>;
      create(input: StudentInput): Promise<IpcResult<{ id: number }>>;
      update(id: number, input: StudentInput): Promise<IpcResult<{ id: number }>>;
      softDelete(id: number): Promise<IpcResult<{ id: number }>>;
    };

    fieldDefs: {
      /** 表单 / 详情渲染用的分组字段描述（预设 + 未归档自定义） */
      schema(): Promise<IpcResult<{ groups: SchemaGroup[] }>>;
      list(opts?: { includeArchived?: boolean }): Promise<IpcResult<CustomFieldDef[]>>;
      create(input: CustomFieldInput): Promise<IpcResult<CustomFieldDef>>;
      update(id: number, patch: CustomFieldPatch): Promise<IpcResult<CustomFieldDef>>;
      archive(id: number): Promise<IpcResult<CustomFieldDef>>;
      restore(id: number): Promise<IpcResult<CustomFieldDef>>;
      reorder(ids: number[]): Promise<IpcResult<CustomFieldDef[]>>;
    };

    tags: {
      list(): Promise<IpcResult<Tag[]>>;
      create(input: { name: string; color?: string | null }): Promise<IpcResult<Tag>>;
      update(id: number, patch: { name?: string; color?: string | null }): Promise<IpcResult<Tag>>;
      remove(id: number): Promise<IpcResult<{ id: number }>>;
      setForStudent(studentId: number, tagIds: number[]): Promise<IpcResult<Tag[]>>;
    };

    io: {
      exportStudents(
        query?: ListQuery,
      ): Promise<IpcResult<{ filePath: string; count: number }>>;
      downloadTemplate(): Promise<IpcResult<{ filePath: string }>>;
      pickImportFile(): Promise<
        IpcResult<{ filePath: string; headers: string[]; sample: string[][] }>
      >;
      importStudents(args: {
        filePath: string;
        mapping: Record<string, string>;
      }): Promise<IpcResult<ImportReport>>;
    };

    inventory: {
      listItems(query?: InventoryListQuery): Promise<IpcResult<InventoryListResult>>;
      getItem(id: number): Promise<IpcResult<InventoryItem>>;
      createItem(input: InventoryItemInput): Promise<IpcResult<{ id: number }>>;
      updateItem(id: number, input: InventoryItemInput): Promise<IpcResult<{ id: number }>>;
      deleteItem(id: number): Promise<IpcResult<{ id: number }>>;
      allocate(
        input: AllocationInput,
      ): Promise<IpcResult<{ id: number; remaining: number }>>;
      allocations(query?: AllocationListQuery): Promise<IpcResult<AllocationListResult>>;
      deleteAllocation(
        id: number,
      ): Promise<IpcResult<{ id: number; itemId: number; remaining: number }>>;
      exportItems(
        query?: InventoryListQuery,
      ): Promise<IpcResult<{ filePath: string; count: number }>>;
      exportAllocations(
        query?: AllocationListQuery,
      ): Promise<IpcResult<{ filePath: string; count: number }>>;
      downloadTemplate(): Promise<IpcResult<{ filePath: string }>>;
      pickImportFile(): Promise<
        IpcResult<{ filePath: string; headers: string[]; sample: string[][] }>
      >;
      importItems(args: {
        filePath: string;
        mapping: Record<string, string>;
      }): Promise<IpcResult<InventoryImportReport>>;
    };

    attendance: {
      list(query?: AttendanceListQuery): Promise<IpcResult<AttendanceListResult>>;
      quickCheckIn(input: QuickCheckInInput): Promise<IpcResult<CheckInResult>>;
      batchCheckIn(input: BatchCheckInInput): Promise<IpcResult<BatchCheckInResult>>;
      rosterCandidates(
        query?: RosterCandidateQuery,
      ): Promise<IpcResult<RosterCandidate[]>>;
      correct(input: AttendanceCorrectionInput): Promise<IpcResult<CheckInResult>>;
      voidRecord(
        id: number,
      ): Promise<IpcResult<{ id: number; studentId: number; remainingLessons: number }>>;
    };
  }

  interface Window {
    studioShell: StudioShell;
  }

  /** 便于其它声明引用 */
  type StudioStudent = Student;
}

export {};
