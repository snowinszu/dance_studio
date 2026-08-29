# SPEC: 学员档案（预设字段 + 管理者自定义字段）

> 技术规格，来源 PRD：[tasks/prd-student-records.md](./prd-student-records.md)
> 生成日期：2026-08-29 ｜ 目标分支：待定 ｜ 基线：无 git（当前非 git 仓库）

---

## 1. 摘要 / Summary

### 1.1 本 SPEC 覆盖范围

把「学员档案」从占位页做成完整模块：SQLite 持久化 + 迁移机制、预设字段（5 组）、管理者可增删的自定义字段（9 种类型）、学员列表/详情/编辑、标签系统、Excel 导入导出。这是本项目**第一个带持久化**的功能，需要新增数据库层、IPC 层与一个单页渲染器。

### 1.2 PRD 对应

- 来源：`tasks/prd-student-records.md`
- 覆盖 User Stories：US-001 ~ US-011（全部）
- 覆盖 Functional Requirements：FR-1 ~ FR-24（全部）

### 1.3 设计决策一览

| 决策 | 选择 | 理由 |
|---|---|---|
| 数据库 | better-sqlite3（同步 API） | PRD 已定；同步 API 在单进程单窗口下无并发竞态，代码最简 |
| 原生模块打包 | `electron-builder` 的 `npmRebuild: true` + `@electron/rebuild` 接入 `postinstall` | 现配置 `npmRebuild: false` 且注明「无原生模块」，须翻转；开发期与打包期都要对 Electron ABI 重建 |
| 迁移机制 | `PRAGMA user_version` + 有序迁移数组，单事务逐个 up | 零依赖，符合项目「无 ORM」基调 |
| 渲染层结构 | 单页 `students.html` + 客端视图切换（hash 路由），渲染逻辑放 `students.js`（ES module，`<script type="module">`，不引入打包器） | 用户选择；模块界面多，多 HTML 文件会重复外壳且无法共享渲染层代码 |
| 主↔渲染通信 | 按操作粒度的 `ipcMain.handle` / `ipcRenderer.invoke`，按域分组；`contextBridge` 扩展 `window.studioShell` 为 `{ students, fieldDefs, tags, io }` | 与现有 `studioShell` 一致；`handle/invoke` 天然 async 且可回传结构化结果 |
| IPC 错误约定 | 处理器永不跨边界 throw，统一返回 `{ ok:true, data } \| { ok:false, error:{ code, message, fields? } }` | 渲染层无 try/catch 噪音，字段级校验错误可直接回填表单 |
| 预设字段来源 | 主进程常量 `src/shared/preset-fields.ts` 为唯一真源；渲染层经 `fieldDefs:schema` IPC 取「预设 + 自定义」合并后的表单描述 | 渲染层不参与构建，无法 import TS 常量；集中在主进程避免两处漂移 |
| 校验归属 | 主进程 `domain/validation.ts` 为权威校验；渲染层只做轻量即时校验（必填/格式提示） | 数据正确性不依赖渲染层；渲染层校验仅为体验 |
| Excel 库 | `exceljs`（主进程） | 纯 JS 无原生依赖，流式读写，API 友好；体积可接受 |
| 单元测试运行器 | Node 内置 `node:test`（`tests/unit/*.test.ts`，tsc 编译后 `node --test`） | 零新依赖；E2E 仍用现有 Playwright |
| 时间戳 | ISO 8601 字符串（`new Date().toISOString()`），SQLite 存 TEXT | SQLite 无日期类型；与现有代码字符串风格一致 |
| 日期字段值 | `YYYY-MM-DD` 字符串；年龄在渲染层按当前日期实时算，不落库 | PRD FR-4 |

---

## 2. 架构 / Architecture

### 2.1 系统上下文

```
┌─────────────────────────── Electron 主进程 (Node) ──────────────────────────┐
│  main.ts                                                                     │
│   ├─ app.whenReady → db/connection.open() → migrations.run()                 │
│   ├─ ipc/register.ts  注册所有 ipcMain.handle                                │
│   └─ BrowserWindow.loadFile(index.html)   (窗口配置不变)                     │
│                                                                             │
│  db/            connection(单例) · migrations(user_version runner)          │
│  domain/        students.repo · field-defs.repo · tags.repo · validation    │
│  io/            export-xlsx(exceljs) · import-xlsx(exceljs)                  │
│  shared/        preset-fields(真源) · types                                  │
└───────────────▲─────────────────────────────────────────────────────────────┘
                │  contextBridge: window.studioShell.{students,fieldDefs,tags,io}
                │  (ipcRenderer.invoke, 全 async, 回传 IpcResult<T>)
┌───────────────┴─────────────────────────────────────────────────────────────┐
│  渲染进程 (Chromium, file://)                                                │
│  index.html          学员档案卡片 href → students.html                       │
│  students.html       单页外壳（顶栏复用 + <main id="view">）                  │
│  students.js (ESM)   hash 路由：#/list #/new #/s/:id #/s/:id/edit            │
│                       #/fields #/tags ；调用 studioShell.* 拉数据、渲染视图   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 组件职责

| 组件 | 职责 | 不负责 |
|---|---|---|
| `db/connection.ts` | 打开 db 文件（路径可被 `STUDIO_DB_PATH` 覆盖）、设 `PRAGMA foreign_keys=ON`、`journal_mode=WAL`；导出单例 `getDb()` | 业务 SQL |
| `db/migrations.ts` | 有序迁移数组 `Migration[]`；`run(db)` 读 `user_version`，在一个事务内逐个执行未应用的 `up`，写回版本号 | 回滚（forward-only，见 3.4） |
| `domain/students.repo.ts` | 学员 CRUD、软删除、`list(query)` 组合筛选 + 分页；读写时 JSON 列的序列化/反序列化；`get` 时 hydrate 标签 | 校验、IPC |
| `domain/field-defs.repo.ts` | 自定义字段定义 CRUD、`archive`/`restore`、`reorder`；`field_key` 生成与查重；拒绝改 `type` | 预设字段（在 shared） |
| `domain/tags.repo.ts` | 标签 CRUD；`setForStudent(studentId, tagIds[])` 重写关联 | — |
| `domain/validation.ts` | `buildSchema()`（合并预设+自定义）、`validateStudent(payload, schema)` → `{ values, errors }`；`validateFieldDef(input)` | 落库 |
| `io/export-xlsx.ts` | 依据结果集 + schema 构造 exceljs Workbook，写到用户选定路径 | 查询（调 repo） |
| `io/import-xlsx.ts` | 解析表头 + 前 N 行样本供映射；按映射逐行校验 + 入库（单事务、失败行不中断）；产出报告 | 映射 UI |
| `ipc/register.ts` | 每个操作一个 `ipcMain.handle`；捕获异常 → `IpcResult`；把渲染层入参交给 domain | 业务规则 |
| `students.js` | hash 路由、视图渲染、表单装配、即时校验提示、调用 `studioShell.*` | 权威校验、SQL、fs |

### 2.3 模块交互（关键流程）

**保存学员（新建/编辑）**
```
students.js  收集表单 → studioShell.students.create(payload)
  → ipcRenderer.invoke('students:create', payload)
    → ipc/register: schema = validation.buildSchema()
                    { values, errors } = validation.validateStudent(payload, schema)
                    errors 非空 → return { ok:false, error:{ code:'VALIDATION_FAILED', fields } }
                    students.repo.create(values)  // 预设→列, 自定义→custom_fields JSON, 维护时间戳
    → return { ok:true, data:{ id } }
  → students.js 跳转 #/s/:id
```

**渲染表单/详情所需的字段描述**
```
students.js  → studioShell.fieldDefs.schema()
  → ipc: PRESET_FIELDS(常量) + field-defs.repo.list({ archived:false })
         按 group 分组、组内 preset 在前(order)、custom 在后(sortOrder)
  → data: { groups: [{ key,label, fields:[FieldDescriptor...] }] }
```

**导入**
```
students.js  → studioShell.io.pickImportFile()          // 主进程 dialog.showOpenDialog
             ← { filePath, headers:[...], sample:[row,row,row] }
渲染「列映射」UI（模板字段 ← 表格列），姓名/主电话必须映射
             → studioShell.io.importStudents({ filePath, mapping })
  → io/import-xlsx: 逐行 → validateStudent → ok 则 repo.create；失败推入 report.failures
  ← { created:N, failed:M, failures:[{ row, reason }] }
```

### 2.4 文件结构

```
src/
├── main.ts                      [MODIFY] ready 时 open db + run migrations + registerIpc()
├── preload.ts                   [MODIFY] 扩展 studioShell 为 { ready, students, fieldDefs, tags, io }
├── shared/
│   ├── preset-fields.ts         [NEW] PRESET_FIELDS 常量 + GROUPS 常量（唯一真源）
│   └── types.ts                 [NEW] FieldType/GroupKey/Student/CustomFieldDef/Tag/IpcResult...
├── db/
│   ├── connection.ts            [NEW] getDb() 单例, PRAGMA, STUDIO_DB_PATH 覆盖
│   └── migrations.ts            [NEW] Migration[] + run(db)  (user_version)
├── domain/
│   ├── students.repo.ts         [NEW]
│   ├── field-defs.repo.ts       [NEW]
│   ├── tags.repo.ts             [NEW]
│   └── validation.ts            [NEW] buildSchema / validateStudent / validateFieldDef / slugifyKey
├── io/
│   ├── export-xlsx.ts           [NEW]
│   └── import-xlsx.ts           [NEW]
└── ipc/
    ├── channels.ts              [NEW] 频道名常量 + 各频道 payload/return 类型
    └── register.ts              [NEW] registerIpc(): 逐个 ipcMain.handle

students.html                    [NEW] 渲染器外壳（复用顶栏 + #view 容器 + 令牌兜底 :root）
students.js                      [NEW] 渲染器控制器（ESM）
studioShell.d.ts                 [NEW] window.studioShell 环境类型（供编辑器/可选 tsc 检查）
index.html                       [MODIFY] 学员档案卡片 href: placeholder.html?app=students → students.html
placeholder.html                 [MODIFY] APP_NAMES 移除 'students' 键
electron-builder.yml             [MODIFY] npmRebuild: true；files += students.html, students.js, studioShell.d.ts 不打包
package.json                     [MODIFY] deps: better-sqlite3, exceljs；devDeps: @electron/rebuild, @types/better-sqlite3；scripts: test:unit, 调整 postinstall
tests/
├── e2e/students-flow.spec.ts    [NEW] Playwright（STUDIO_DB_PATH 指向临时库）
└── unit/                        [NEW]
    ├── validation.test.ts
    ├── migrations.test.ts
    ├── preset-schema.test.ts
    └── list-query.test.ts
```

> 渲染层保持无打包器：`students.js` 为单个 ES module，可再 `import './renderer/*.js'` 拆分（同样免构建）。所有新 HTML/JS 需加入 `electron-builder.yml` 的 `files` 白名单，否则打包产物缺文件。

---

## 3. 数据模型 / Data Model

### 3.1 Schema（迁移 v1，`user_version` 0 → 1）

见 PRD 附录 B 的完整建表 SQL。要点补充：

- 连接级 `PRAGMA foreign_keys = ON`（better-sqlite3 默认关闭）——`student_tags` 的 `ON DELETE CASCADE` 才生效
- `PRAGMA journal_mode = WAL`——桌面单用户下提升写入与崩溃恢复
- `students.custom_fields` / `field_definitions.options` / `students.dance_types` 均为 TEXT 存 JSON，`NOT NULL DEFAULT '{}'`（数组列默认 `'[]'`）
- 索引：`idx_students_name(name)`、`idx_students_phone(phone_primary)`、`idx_students_status(status)`、`idx_students_deleted(deleted_at)`
- `field_definitions.field_key` 唯一约束
- 金额（`money` 类型的自定义字段值）在 JSON 中以 `number` 存储，单位元，最多两位小数（校验保证）；`remaining_lessons` 为 `INTEGER` 列

### 3.2 实体定义（`src/shared/types.ts`）

```ts
export type FieldType =
  | 'text' | 'textarea' | 'number' | 'date'
  | 'select' | 'multiselect' | 'boolean' | 'phone' | 'money';

export type GroupKey = 'basic' | 'contact' | 'course' | 'health' | 'ops';

/** 预设字段：落在 students 真实列上，由 preset-fields.ts 描述，不入 field_definitions */
export interface PresetFieldDef {
  key: string;               // = students 列名
  label: string;
  type: FieldType;
  group: GroupKey;
  order: number;
  options?: readonly string[];
  required?: boolean;        // 预设强制（仅 name / phone_primary）
  sensitive?: boolean;       // 仅打标签，本版不强制脱敏
}

/** 自定义字段：值存 students.custom_fields[fieldKey] */
export interface CustomFieldDef {
  id: number;
  fieldKey: string;
  label: string;
  type: FieldType;
  options: string[];         // 仅 select/multiselect 有意义
  required: boolean;
  groupKey: GroupKey;
  sortOrder: number;
  sensitive: boolean;
  archived: boolean;
  defaultValue: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 渲染层拿到的、类型无关的字段描述（预设与自定义统一形态） */
export interface FieldDescriptor {
  key: string;
  label: string;
  type: FieldType;
  group: GroupKey;
  options: string[];
  required: boolean;
  sensitive: boolean;
  origin: 'preset' | 'custom';
  archived: boolean;         // 归档字段仅在「有历史值」场景回显，不进表单
}

export interface Tag { id: number; name: string; color: string | null; }

export interface Student {
  id: number;
  // —— 基本 ——
  name: string;
  nickname: string | null;
  gender: string | null;
  birthDate: string | null;         // YYYY-MM-DD
  idCardType: string | null;
  idCardNo: string | null;
  // —— 联系 ——
  guardianName: string | null;
  guardianRelation: string | null;
  phonePrimary: string;
  phoneSecondary: string | null;
  wechat: string | null;
  address: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  // —— 课程与会员 ——
  danceTypes: string[];             // JSON 数组
  currentLevel: string | null;
  enrollDate: string | null;
  mainTeacher: string | null;
  classSchedule: string | null;
  cardType: string | null;
  remainingLessons: number | null;
  cardExpireDate: string | null;
  status: string;                   // 默认「在读」
  // —— 健康 ——
  healthAllergy: string | null;
  healthHistory: string | null;
  healthNotes: string | null;
  // —— 运营 ——
  sourceChannel: string | null;
  referrer: string | null;
  remark: string | null;
  // —— 自定义 + 元数据 ——
  customFields: Record<string, string | number | boolean | string[] | null>;
  tags: Tag[];                      // 仅 get() hydrate；list() 不带
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface StudentListItem {
  id: number; name: string; phonePrimary: string; status: string;
}

export interface ListQuery {
  search?: string;                  // 匹配 name 或 phone_primary/phone_secondary 子串
  status?: string[];                // 任一命中
  tagIds?: number[];                // 任一命中
  limit?: number;                   // 默认 100
  offset?: number;                  // 默认 0
}
export interface ListResult { rows: StudentListItem[]; total: number; }

export type IpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: IpcError };

export interface IpcError {
  code: IpcErrorCode;
  message: string;
  fields?: Record<string, string>;  // 字段级校验错误：key → 提示
}

export type IpcErrorCode =
  | 'BAD_REQUEST' | 'VALIDATION_FAILED' | 'NOT_FOUND'
  | 'FIELD_KEY_CONFLICT' | 'FIELD_TYPE_IMMUTABLE' | 'TAG_NAME_CONFLICT'
  | 'IMPORT_FILE_INVALID' | 'IMPORT_TOO_LARGE'
  | 'IO_CANCELLED' | 'IO_WRITE_FAILED' | 'DB_ERROR';
```

### 3.3 预设字段真源（`src/shared/preset-fields.ts`）

- `GROUPS: {key: GroupKey, label: string, order: number}[]` — basic/contact/course/health/ops，顺序同 PRD 附录 A
- `PRESET_FIELDS: readonly PresetFieldDef[]` — 逐字段照搬 PRD 附录 A（key/label/type/group/order/options/required/sensitive）
- 消费方：`validation.buildSchema()`、`io/export-xlsx`、`io/import-xlsx`（模板表头）、`fieldDefs:schema` 处理器
- 约束：`PRESET_FIELDS[*].key` 必须与 `students` 表列名一一对应；单元测试 `preset-schema.test.ts` 断言这一点

### 3.4 迁移计划

- 前向单向。`migrations.ts` 导出 `MIGRATIONS: Migration[]`，`Migration = { version: number; up(db: Database): void }`
- `run(db)`：`const cur = db.pragma('user_version', { simple:true })`；对 `version > cur` 的迁移按序在 `db.transaction(() => { up(db); db.pragma('user_version = ' + version) })` 中执行
- v1 迁移 = 建 4 张表 + 索引（PRD 附录 B）
- 回滚策略：开发期删除 db 文件重建；不提供 down（greenfield，无线上数据）。整库备份/恢复入口列入 PRD 开放问题，不在本 SPEC
- E2E/单测：`STUDIO_DB_PATH` 指向临时文件或 `:memory:`，每次运行前删除，保证可重复

---

## 4. 接口设计 / IPC Surface

### 4.1 频道清单（全部 `ipcMain.handle` / `ipcRenderer.invoke`，返回 `IpcResult<T>`）

| 频道 | 渲染层入口 | 入参 | 成功数据 | 说明 |
|---|---|---|---|---|
| `students:list` | `studioShell.students.list(q)` | `ListQuery` | `ListResult` | SQL 侧筛选 + 分页；不含已软删除 |
| `students:get` | `.students.get(id)` | `number` | `Student`（hydrate tags） | 未找到 → `NOT_FOUND` |
| `students:create` | `.students.create(p)` | `StudentInput` | `{ id: number }` | 校验 → 落库；失败 → `VALIDATION_FAILED` + `fields` |
| `students:update` | `.students.update(id,p)` | `(number, StudentInput)` | `{ id: number }` | 同上；`id` 不存在 → `NOT_FOUND` |
| `students:delete` | `.students.softDelete(id)` | `number` | `{ id: number }` | 仅写 `deleted_at` |
| `fieldDefs:schema` | `.fieldDefs.schema()` | — | `{ groups: SchemaGroup[] }` | 预设+未归档自定义，供表单/详情渲染 |
| `fieldDefs:list` | `.fieldDefs.list(opts?)` | `{ includeArchived?: boolean }` | `CustomFieldDef[]` | 字段管理页用 |
| `fieldDefs:create` | `.fieldDefs.create(input)` | `CustomFieldInput` | `CustomFieldDef` | 生成唯一 `fieldKey`；重名 label 允许 |
| `fieldDefs:update` | `.fieldDefs.update(id,patch)` | `(number, CustomFieldPatch)` | `CustomFieldDef` | 含 `type` → `FIELD_TYPE_IMMUTABLE` |
| `fieldDefs:archive` | `.fieldDefs.archive(id)` | `number` | `CustomFieldDef` | `archived=1`，不动学员数据 |
| `fieldDefs:restore` | `.fieldDefs.restore(id)` | `number` | `CustomFieldDef` | `archived=0` |
| `fieldDefs:reorder` | `.fieldDefs.reorder(ids)` | `number[]` | `CustomFieldDef[]` | 按数组下标重写 `sort_order` |
| `tags:list` | `.tags.list()` | — | `Tag[]` | |
| `tags:create` | `.tags.create(input)` | `{ name: string; color?: string }` | `Tag` | 重名 → `TAG_NAME_CONFLICT` |
| `tags:update` | `.tags.update(id,patch)` | `(number, {name?,color?})` | `Tag` | |
| `tags:delete` | `.tags.delete(id)` | `number` | `{ id: number }` | 级联删 `student_tags` |
| `tags:setForStudent` | `.tags.setForStudent(sid,ids)` | `(number, number[])` | `Tag[]` | 全量重写该学员标签 |
| `io:exportStudents` | `.io.exportStudents(q)` | `ListQuery`（无分页，导出全量匹配） | `{ filePath: string; count: number }` | `dialog.showSaveDialog`；取消 → `IO_CANCELLED` |
| `io:downloadTemplate` | `.io.downloadTemplate()` | — | `{ filePath: string }` | 生成导入模板 xlsx |
| `io:pickImportFile` | `.io.pickImportFile()` | — | `{ filePath, headers: string[], sample: string[][] }` | `dialog.showOpenDialog`；解析表头 + 前 3 行 |
| `io:importStudents` | `.io.importStudents(args)` | `{ filePath: string; mapping: Record<string,string> }` | `ImportReport` | 逐行校验 + 入库；失败行不中断 |

### 4.2 关键 Schema

```ts
/** 新建/编辑入参：预设字段用驼峰键，自定义字段收在 customFields */
interface StudentInput {
  name: string;
  phonePrimary: string;
  // ...其余预设字段可选（见 types.ts Student，去掉 id/tags/时间戳/deletedAt）
  danceTypes?: string[];
  remainingLessons?: number | null;
  customFields?: Record<string, unknown>;   // key = CustomFieldDef.fieldKey
  tagIds?: number[];                         // 一并写 student_tags（可选）
}

interface CustomFieldInput {
  label: string;
  type: FieldType;
  groupKey: GroupKey;
  required?: boolean;                        // 默认 false
  options?: string[];                        // select/multiselect 必填非空
  defaultValue?: string | null;
  sensitive?: boolean;                       // 默认 false
}
type CustomFieldPatch = Partial<Omit<CustomFieldInput, 'type'>> & { sortOrder?: number };

interface SchemaGroup {
  key: GroupKey; label: string;
  fields: FieldDescriptor[];                 // preset(order) 在前，custom(sortOrder) 在后
}

interface ImportReport {
  created: number;
  failed: number;
  failures: { row: number; reason: string }[];   // row = xlsx 行号（含表头，从 2 起）
}
```

### 4.3 错误响应

见 §6.1。约定：**任何处理器都不把异常抛过 IPC 边界**；`ipc/register.ts` 用统一包裹器 `handle(channel, fn)`：`try { return { ok:true, data: await fn(args) } } catch (e) { return toIpcError(e) }`。`toIpcError` 把 domain 抛出的具名错误（`class ValidationError extends Error { fields }` 等）映射为 `IpcError`；未知错误 → `DB_ERROR` / `BAD_REQUEST` 并 `console.error` 原始栈。

### 4.4 破坏性变更

- `window.studioShell` 由 `{ ready: true }` 扩展为 `{ ready: true, students, fieldDefs, tags, io }`——**新增字段，向后兼容**，现有首页脚本不受影响
- `index.html` 学员档案卡片 `href` 改指 `students.html`；`placeholder.html` 的 `APP_NAMES` 去掉 `students`——现有 E2E `home-flow.spec.ts` 里「首页 → 学员档案占位页」用例需同步改为「首页 → 学员档案列表页」（在 US-004 内处理）

---

## 5. 业务逻辑 / Business Logic

### 5.1 核心算法

**A. `buildSchema()`（validation.ts）**
1. 读 `PRESET_FIELDS` 与 `GROUPS`
2. `field-defs.repo.list({ includeArchived: false })`
3. 按 `GROUPS` 顺序建组；每组 `fields` = 该组预设（按 `order`）+ 该组自定义（按 `sortOrder`）
4. 每个字段产出 `FieldDescriptor`；`options` 对非 select/multiselect 为 `[]`
5. 返回 `{ groups }`；同时返回一个扁平 `Map<key, FieldDescriptor>` 供 `validateStudent` 用

**B. `validateStudent(input, schema)`**
```
values = {}, errors = {}
for each descriptor in schema:
  raw = descriptor.origin==='preset' ? input[camel(key)] : input.customFields?.[key]
  norm = normalizeByType(raw, descriptor.type)      // trim / Number / 数组化 / 布尔化
  if isEmpty(norm):
     if descriptor.required: errors[key] = '此项为必填'
     else values <- null / [] / 保持缺省
     continue
  switch descriptor.type:
     number|money: 非有限数 → errors; money 再查 <0 或小数>2 位
     date:         非 /^\d{4}-\d{2}-\d{2}$/ 或非法历法日 → errors
     phone:        !/^1[3-9]\d{9}$/ → errors
     select:       norm ∉ (options ∪ 该学员历史值) → errors；∈ 历史但 ∉ options → 标记 stale(仍写回)
     multiselect:  非数组或某项 ∉ (options ∪ 历史) → errors
     boolean:      非 true/false → errors
     text:         len>200 → errors ; textarea: len>2000 → errors
  values <- 落位（预设→顶层驼峰键；自定义→ values.customFields[key]）
预设兜底：name / phonePrimary 必填；status 缺省 '在读'
return { values, errors }
```

**C. `students.repo.list(query)`** — 动态 WHERE 构造（全部参数化占位符，无字符串拼接值）
```
base:  WHERE deleted_at IS NULL
search: AND (name LIKE @kw OR phone_primary LIKE @kw OR phone_secondary LIKE @kw)   // @kw = '%'+esc+'%'
status: AND status IN (@s0,@s1,...)
tagIds: AND id IN (SELECT student_id FROM student_tags WHERE tag_id IN (@t0,...))
total:  上述条件套 SELECT COUNT(*)
rows:   SELECT id,name,phone_primary,status ... ORDER BY name COLLATE NOCASE LIMIT @limit OFFSET @offset
```

**D. `fieldKey` 生成（slugifyKey(label, existingKeys)）**
1. `label` 转小写，保留 `[a-z0-9]`，其余转 `_`，压缩连续 `_`，去首尾 `_`
2. 结果为空（如纯中文 label）→ `field_` + `Date.now().toString(36)`
3. 与 `existingKeys` 冲突 → 依次尝试 `key_2`、`key_3` …
4. 结果必须匹配 `/^[a-z][a-z0-9_]*$/`（首字符非字母则前置 `f_`）
> 拼音转写不做（PRD 开放问题），纯中文 label 落到步骤 2 的生成式 key，`label` 仍完整保留用于显示

**E. 导入管线（io/import-xlsx.ts）**
1. `exceljs` 读 `filePath` 第一个 worksheet；超 `MAX_IMPORT_BYTES`(10MB) 或 `MAX_IMPORT_ROWS`(5000) → 抛 `IMPORT_TOO_LARGE`
2. 校验 `mapping`：`name`、`phonePrimary` 必须有映射列，否则 `BAD_REQUEST`
3. `schema = buildSchema()`；开 `db.transaction`
4. 逐数据行：按 `mapping` 组 `StudentInput` → `validateStudent` → ok 则 `students.repo.create(values)`，`created++`；err 则 `failures.push({ row, reason: 概述首个错误 })`，`failed++`——**不 rollback，继续下一行**
5. 提交事务，返回 `ImportReport`
> 事务包裹是为性能（5000 行单事务）；失败行只是跳过不写，不触发整体回滚

**F. 导出（io/export-xlsx.ts）**
1. `students.repo.list({ ...query, limit: 未设上限 })` 取全量匹配（不分页）
2. 列顺序：预设（按 `PRESET_FIELDS` order）→ 未归档自定义（按 `sortOrder`）→ 「有值的已归档自定义」（表头加后缀「(已归档)」）→ `标签`（逗号分隔）
3. 单元格格式化：`multiselect`/`string[]` → 逗号分隔；`date` → `YYYY-MM-DD`；`boolean` → 「是/否」；`null` → 空串
4. `dialog.showSaveDialog`（默认名 `学员档案-YYYYMMDD.xlsx`）；用户取消 → `IO_CANCELLED`
5. `workbook.xlsx.writeFile(path)`；返回 `{ filePath, count }`

**G. 年龄计算（渲染层）** — `age = 今年 - 生年 - (今年生日是否已过 ? 0 : 1)`，`今天 = new Date()`

### 5.2 校验规则汇总

| 类型 | 规则 |
|---|---|
| text | 字符串，trim；≤ 200 字符 |
| textarea | 字符串，trim；≤ 2000 字符 |
| number | `Number.isFinite` |
| money | `Number.isFinite` 且 `>= 0` 且 小数位 ≤ 2 |
| date | `/^\d{4}-\d{2}-\d{2}$/` 且构造 `Date` 后回读一致（拦截 2026-02-30） |
| phone | `/^1[3-9]\d{9}$/` |
| select | 值 ∈ options ∪ 该学员该字段历史值；仅历史命中 → 保留并标「已停用」 |
| multiselect | 数组；每项 ∈ options ∪ 历史值 |
| boolean | 严格 `true` / `false`（渲染层开关；导入接受 是/否/true/false/1/0） |
| required | 空判定：`undefined` / `null` / `''`（trim 后）/ `[]` |
| 预设强制必填 | `name`、`phonePrimary` |
| status | 缺省 `在读`；值须 ∈ 预设 options（在读/请假/停课/毕业/流失） |
| 自定义字段 label | 非空，≤ 40 字符 |
| 自定义 select/multiselect | `options` 非空数组，去重，每项 ≤ 40 字符 |
| 新增 required 自定义字段 | 不阻塞已有档案读取/打开编辑；仅保存时对空值报 `VALIDATION_FAILED`（渲染层显示「待补充」） |

### 5.3 状态与生命周期

- 学员 `status` 是自由业务状态（在读/请假/停课/毕业/流失），非受控状态机——任意值可改任意值，无迁移守卫
- 软删除是唯一的「记录生命周期」：`deletedAt = null`（在册） ↔ `deletedAt = ISO`（已删）。本版**不做**恢复入口（列入开放问题），但 `list` 之外的 `get` 仍可按 id 取到已删记录（用于导出边界与未来恢复）
- 自定义字段：`archived 0 ↔ 1`，`restore` 可逆；`type` 一经创建不可变

### 5.4 边界情况

| 场景 | 处理 |
|---|---|
| 归档字段仍有历史值 | 不进表单/详情；导出仍出该列，表头「(已归档)」 |
| 新增必填自定义字段后打开旧档案 | 可正常打开编辑；该字段渲染「待补充」提示；仅点保存时校验拦截 |
| select 选项被删除、学员已选该值 | 详情/表单回显该值并标「已停用」；保存放行（除非该字段 required 且值被清空） |
| 删除正在被列表筛选的标签 | `tags:delete` 成功后，渲染层从当前筛选条件移除该 tagId 并重拉列表 |
| 导入列未映射姓名/主电话 | 映射阶段禁止「开始导入」按钮；后端二次校验 `BAD_REQUEST` |
| 导入行手机号非法 / 必填空 | 该行计入 `failures`，其余行继续；报告列出行号 + 原因 |
| 导入手机号与库中重复 | 允许，按新建（PRD 明确 v1 不去重） |
| 列表 1000+ 行 | 服务端分页（默认 100/页），渲染层「加载更多」或分页条 |
| `birth_date` 为空 | 详情不显示年龄行 |
| 并发写 | 单进程 + better-sqlite3 同步 API，无竞态；WAL 下读不阻塞 |
| db 文件损坏 / 打不开 | `main.ts` 启动时捕获 → 弹 `dialog.showErrorBox` 并记录路径；窗口仍开（列表页显示错误态），不静默崩溃 |

---

## 6. 错误处理 / Error Handling

### 6.1 错误分类

| code | 触发条件 | 渲染层表现 |
|---|---|---|
| `BAD_REQUEST` | 入参结构非法（缺 id、mapping 缺必填列等） | toast「操作参数有误」 |
| `VALIDATION_FAILED` | `validateStudent` / `validateFieldDef` 返回非空 errors | 表单字段下逐条红字（用 `error.fields`）；不提交 |
| `NOT_FOUND` | 按 id 取学员/字段/标签不存在 | toast「记录不存在，可能已被删除」→ 返回列表 |
| `FIELD_KEY_CONFLICT` | 生成的 `fieldKey` 仍冲突（理论极少） | toast「字段标识冲突，请改个显示名重试」 |
| `FIELD_TYPE_IMMUTABLE` | `fieldDefs:update` 的 patch 含 `type` | 字段管理页类型控件置灰，不应触发；触发则 toast |
| `TAG_NAME_CONFLICT` | 标签重名 | 输入框下红字「标签已存在」 |
| `IMPORT_FILE_INVALID` | exceljs 无法解析 / 无 worksheet | 导入向导 toast「文件无法识别，请用模板另存为 .xlsx」 |
| `IMPORT_TOO_LARGE` | 超 10MB 或 5000 行 | toast「单次最多导入 5000 行」 |
| `IO_CANCELLED` | 用户在系统对话框点取消 | 静默，无 toast |
| `IO_WRITE_FAILED` | 写 xlsx 失败（磁盘满/无权限） | toast「导出失败：<原因>」 |
| `DB_ERROR` | 未归类的 SQLite 异常 | toast「数据库错误，请重试」；`console.error` 原始栈 |

### 6.2 重试策略

- 所有操作同步、本地、幂等性以调用方为准——**不内置重试**
- 导入不重试；失败行汇总进报告，由用户改表后重导（会新建，注意去重是开放问题）

### 6.3 失败模式

- **db 打不开**：启动期 `showErrorBox` + 列表页错误态；用户可关闭应用手动处理文件
- **迁移中途失败**：迁移在单事务内，失败即回滚，`user_version` 不前进；下次启动重试同一迁移
- **exceljs 抛错**：`io/*` 捕获 → `IMPORT_FILE_INVALID` / `IO_WRITE_FAILED`，不影响主流程
- **渲染层 IPC 超时/无响应**：`invoke` 理论不超时；渲染层对每次调用设 loading 态，`ok:false` 或 reject 均回落到错误 toast

---

## 7. 安全 / Security

### 7.1 认证与授权

- 本版**无登录、无角色**（PRD Non-Goals）。所有 IPC 频道对渲染进程完全开放
- `field_definitions.sensitive` 列保留并在字段管理页/详情页渲染「敏感」徽标，**不做**按角色隐藏或脱敏
- 可接受性：本地单机、单用户内部工具，攻击面仅限本机用户自身

### 7.2 输入校验

- 所有 SQL 走 better-sqlite3 预编译语句 + 命名参数，**禁止**把用户值拼进 SQL 字符串——消除注入
- `LIKE` 搜索对 `%` `_` `\` 转义，`ESCAPE '\'`
- JSON 列写入前经 `validateStudent` 归一化；读出时 `JSON.parse` 包 try/catch，坏数据回退为 `{}` / `[]` 并 `console.warn`
- 导入：文件大小上限 10MB、行数上限 5000、只读用户经 `dialog` 选定的路径；exceljs 解析全程 try/catch

### 7.3 数据保护

- 数据库为明文 SQLite 文件，位于 `app.getPath('userData')`——不加密（Non-Goals）
- 无审计日志（Non-Goals）；仅 `created_at` / `updated_at`
- 渲染进程保持 `contextIsolation: true`、`nodeIntegration: false`；`preload` 只经 `contextBridge` 暴露上述具名方法，不暴露 `ipcRenderer` 本体、不暴露 `fs`/`path`

---

## 8. 性能 / Performance

### 8.1 预期负载

- 单机单用户；学员规模数百 ~ 数千；自定义字段数量 < 50；标签 < 100
- 写操作低频（人工录入）；读以列表检索为主

### 8.2 优化策略

- `students:list` 服务端筛选 + 分页（默认 `limit=100`），渲染层「加载更多」增量取
- 详情页 `get` 才 hydrate 标签（`list` 不带），避免列表 N+1
- 导出用 `workbook.xlsx.writeFile` 流式落盘，不在内存拼大字符串
- 渲染层视图切换为 DOM 显隐 + 局部重渲染，无整页刷新
- `fieldDefs:schema` 结果在渲染层内存缓存，字段管理页有变更时失效重取

### 8.3 数据库考量

- 索引：`name`、`phone_primary`、`status`、`deleted_at`（见 3.1）
- `ORDER BY name COLLATE NOCASE`——配合 `idx_students_name`
- `WAL` 模式；连接单例，进程退出前 `db.close()`
- 标签筛选用子查询 `id IN (SELECT student_id FROM student_tags WHERE tag_id IN (...))`，`student_tags` 主键 `(student_id, tag_id)` 覆盖该查询
- 成功指标：1000 条数据下 `students:list` P95 < 200ms（`list-query.test.ts` 造 1000 行基准）

---

## 9. 测试策略 / Testing Strategy

### 9.1 单元测试（`node:test`，`tests/unit/*.test.ts`，`npm run build && node --test dist-test/`）

| 文件 | 覆盖 |
|---|---|
| `validation.test.ts` | 每种类型的通过/失败样本；必填空判定；money 小数位；date 历法非法；select 历史值「已停用」；预设强制必填 |
| `migrations.test.ts` | 空库 → v1 建表齐全；重复 `run` 幂等；中途抛错回滚且 `user_version` 不进 |
| `preset-schema.test.ts` | `PRESET_FIELDS[*].key` 与 `students` 列名集合一致；`buildSchema` 分组顺序、preset 在前 custom 在后 |
| `list-query.test.ts` | search/status/tagIds 组合 WHERE；`%`/`_` 转义；分页 `total` 与 `rows` 一致；1000 行基准计时 |
| `field-key.test.ts` | slug 正常/纯中文回退/冲突加后缀/首字符非字母 |

> 需要 db 的单测用 `better-sqlite3(':memory:')` + `migrations.run()` 现场建库。

### 9.2 集成测试

- 直接调用 `ipc/register.ts` 导出的处理器函数（不经 Electron），对临时文件库跑：create→get→update→list→softDelete 全链路；fieldDefs create→archive→schema 不含→restore→schema 含；tags setForStudent→list 按 tag 筛选
- 导入：喂一个含 2 好行 + 1 坏行的 `.xlsx` fixture，断言 `ImportReport { created:2, failed:1 }` 且坏行 `row` 正确
- 导出：跑 `export-xlsx` 到 tmp 路径，用 exceljs 读回，断言列顺序 + 归档列后缀 + 多选逗号分隔

### 9.3 边界用例测试（对应 §5.4）

归档字段历史值仍导出；新增必填字段后旧档案可打开、保存被拦；select 选项删除后回显「已停用」；删除被筛选的标签后列表刷新；导入未映射必填列被拒。

### 9.4 E2E（Playwright，`tests/e2e/students-flow.spec.ts`）

沿用 `home-flow.spec.ts` 的 `_electron.launch` 模式；`env.STUDIO_DB_PATH` 指向 `test-results/` 下每次运行唯一的临时 `.db`，`beforeEach` 删除。

- happy path：首页点「学员档案」→ 列表页（空态）→ 新建（填姓名+主电话+生日+舞种多选）→ 保存 → 列表出现该学员 → 进详情核对「年龄」显示 → 编辑「剩余课时」保存 → 详情反映
- 自定义字段链路：`#/fields` 新增一个 `select` 字段 → 回 `#/new` 表单该字段出现于对应分组 → 录入并保存 → 详情显示 → `#/fields` 归档该字段 → 表单/详情不再出现 → 导出 xlsx（写 tmp 路径，读回断言含该列 + 表头「(已归档)」+ 历史值）
- 失败路径：新建时姓名留空 + 主电话填 `123` → 两个字段下出现红字校验错误、未写库（返回列表无新增）
- 筛选：造 2 个不同 status + 打不同标签 → 按 status+标签筛选只剩匹配项；筛选无结果显示空状态文案
- 全程 `pageErrors` 为空

### 9.5 验收标准映射

| US / FR | 测试 | 类型 | 说明 |
|---|---|---|---|
| US-001 / FR-1,2 | `migrations.test.ts` | 单元 | 建表齐全、幂等、回滚 |
| US-001 打包 | `scripts/smoke-packaged.mjs`（现有）加断言 | 冒烟 | 打包产物能开库不报原生模块错误 |
| US-002 / FR-13 | 集成 create/get/update/softDelete | 集成 | 软删除不出现在 list |
| US-003 / FR-6,7,8,10,11 | `preset-schema.test.ts` + 集成 fieldDefs | 单元+集成 | type 不可变、归档保数据 |
| US-004 / FR-15,16,17 | `list-query.test.ts` + E2E 筛选 | 单元+E2E | 搜索/筛选/空态 |
| US-005 / FR-4 | E2E happy path 年龄断言 | E2E | 年龄实时算 |
| US-006 / FR-14 | `validation.test.ts` + E2E 失败路径 | 单元+E2E | 类型化校验、字段级报错 |
| US-007 / FR-9,11,12 | 集成 + E2E 自定义字段链路 | 集成+E2E | 新增/归档/待补充 |
| US-008 / FR-18,19 | 集成 tags + E2E 筛选 | 集成+E2E | 多对多、级联删 |
| US-009 / FR-20 | 集成 export 读回 | 集成 | 列顺序、归档列、多选分隔 |
| US-010 / FR-21 | 集成 import fixture | 集成 | 报告计数、失败行号、行不中断 |
| US-011 | `students-flow.spec.ts` | E2E | 全栈 happy + 边界 |
| FR-22,23 | E2E 人工视觉核对 + 无裸 hex 静态检查 | E2E+人工 | 设计系统合规、Mobile First |
| FR-24 | 代码审查 + preload 无 fs 暴露断言 | 审查 | fs 只在主进程 |

---

## 10. 实施计划 / Implementation Plan

### 10.1 阶段与顺序

1. **DB 地基**（US-001）：加 `better-sqlite3` / `exceljs` / `@electron/rebuild` 依赖；`electron-builder.yml` 翻 `npmRebuild: true`；`db/connection.ts` + `db/migrations.ts`（v1）；`shared/types.ts` + `shared/preset-fields.ts`；`main.ts` ready 钩子接 open+run；`migrations.test.ts` / `preset-schema.test.ts`
2. **域层 + IPC 读写**（US-002、US-003）：`domain/*.repo.ts` + `domain/validation.ts`；`ipc/channels.ts` + `ipc/register.ts`（students* / fieldDefs*）；`preload.ts` 扩展 `studioShell`；`studioShell.d.ts`；集成测试
3. **渲染外壳 + 列表**（US-004）：`students.html` + `students.js`（hash 路由骨架、`#/list`）；`index.html` 改 href；`placeholder.html` 去 students 键；改 `home-flow.spec.ts` 对应用例
4. **详情 + 表单**（US-005、US-006）：`#/s/:id`、`#/new`、`#/s/:id/edit`；按 `fieldDefs:schema` 动态渲染 + 类型化控件 + 即时校验
5. **字段管理**（US-007）：`#/fields`；`fieldDefs:list/create/update/archive/restore/reorder` 接线；拖拽排序
6. **标签**（US-008）：`#/tags` + 详情页打标签 + 列表按标签筛选；`tags:*` 接线
7. **导出**（US-009）：`io/export-xlsx.ts` + `io:exportStudents` + 列表页「导出」
8. **导入**（US-010）：`io/import-xlsx.ts` + `io:downloadTemplate/pickImportFile/importStudents` + 列映射向导
9. **E2E**（US-011）：`students-flow.spec.ts`

### 10.2 Issue 映射

| Issue | SPEC 章节 | 优先级 | 依赖 |
|---|---|---|---|
| #1 DB 地基 | 2.4, 3.1, 3.3, 3.4, 9.1 | 高 | — |
| #2 域层+读写 IPC | 2.2, 2.3, 4.1, 4.2, 5.1A-C, 5.2 | 高 | #1 |
| #3 渲染外壳+列表 | 2.1, 4.4, 5.1C, 5.4 | 高 | #2 |
| #4 详情+表单 | 5.1A-B,G, 5.2, 6.1 | 高 | #2, #3 |
| #5 字段管理 | 5.1D, 5.3, 5.4 | 中 | #4 |
| #6 标签 | 4.1(tags*), 5.4 | 中 | #3 |
| #7 导出 | 5.1F, 8.2 | 中 | #2 |
| #8 导入 | 5.1E, 6.1, 7.2 | 中 | #2, #5 |
| #9 E2E | 9.4 | 高 | #3–#8 |

### 10.3 增量交付

- 无 feature flag：模块入口就是 `students.html`，未合入前首页卡片可暂留指向 `placeholder.html?app=students`
- 阶段 1–2 合入后即可用集成测试验证后端，不阻塞前端并行
- 阶段 3 合入后「列表 + 新建 + 详情」已是可用最小闭环，4–8 逐步增强

---

## 11. 开放问题与风险 / Open Questions & Risks

### 11.1 待明确（PRD 已列，实施前需产品确认）

- 拼音首字母搜索：本 SPEC 不做，`fieldKey` 对纯中文 label 用生成式 id
- `remaining_lessons` 是否留变更痕迹：本 SPEC 不做审计
- 自定义「分组」是否可由管理者定义：固定 5 组
- select/multiselect 选项删除后已选值：本 SPEC 定为「回显 + 标『已停用』+ 保存放行」
- 导入手机号重复：本 SPEC 一律新建
- 整库备份/恢复入口 + 软删除恢复入口：均不在本 SPEC

### 11.2 技术风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| better-sqlite3 对 Electron 43 ABI 的预编译/重建在 Windows 打包失败 | US-001 阻塞、打包产物崩溃 | `@electron/rebuild` 接 `postinstall`；`npmRebuild: true`；CI 用现有 `scripts/smoke-packaged.mjs` 断言打包产物能开库；`.nvmrc` 锁 Node 版本 |
| 渲染层非 TypeScript、无法 import `shared/types` | 类型漂移、字段拼写错 | 渲染层保持薄；权威校验在主进程；手写 `studioShell.d.ts` 供编辑器提示；`fieldDefs:schema` 用运行时数据驱动渲染，减少硬编码 key |
| 单文件 `students.js` 膨胀 | 可维护性下降 | 允许拆分为 `renderer/*.js` ES module（免构建），加入打包白名单 |
| `noUncheckedIndexedAccess` 下动态 `customFields` 访问啰嗦 | 开发摩擦 | `customFields` 统一 `Record<string, ...>` 类型 + 取值 helper 做存在性收窄 |
| exceljs 解析恶意/超大 xlsx | 主进程卡死/内存暴涨 | 10MB + 5000 行硬上限；解析全程 try/catch；只读用户选定文件 |
| `electron-builder.yml` `files` 漏加新 HTML/JS | 打包后白屏 | US-004/US-001 的 AC 显式包含更新白名单；`smoke-packaged` 断言 `students.html` 存在 |
| 现有 `home-flow.spec.ts` 因 href 变更而红 | CI 阻塞 | US-004 内同步改该用例（占位页 → 列表页） |

### 11.3 假设（实施前校验）

- Electron 43 的 Chromium 支持 `file://` 下的 ES modules、`<dialog>`/`URLSearchParams`/`structuredClone` 等现代 API（基本确定）
- Electron 43 内置 Node 与 `@electron/rebuild` 产出的 better-sqlite3 二进制兼容
- 单实例单窗口；不考虑多开对同一 db 文件的写锁（WAL 下多读者可接受，多写者不会发生）
- `app.getPath('userData')` 在开发（`npm start`）与打包安装后均可写
- `node:test` 在项目 Node ≥ 22.13 下可用（`package.json` engines 已要求），tsc 编译测试到独立 `dist-test/` 再 `node --test`
- 设计令牌：`students.html` 沿用 `index.html`/`placeholder.html` 的 `:root` 兜底 + `colors_and_type.css`；状态标签颜色取自既有 `--cc-*` / 语义令牌，不新造 hex

---

## 12. 附录

### A. 依赖变更

| 包 | 类型 | 用途 |
|---|---|---|
| `better-sqlite3` | dependencies | 同步 SQLite 驱动 |
| `exceljs` | dependencies | Excel 导入导出（主进程） |
| `@types/better-sqlite3` | devDependencies | 类型 |
| `@electron/rebuild` | devDependencies | 对 Electron ABI 重建原生模块 |

`package.json` 脚本：
- `postinstall`：现有 `ensure-electron.js` 之后追加 `electron-rebuild -f -w better-sqlite3`（或用 `@electron/rebuild` 编程 API）
- `test:unit`：`tsc -p tsconfig.test.json && node --test dist-test/`
- `test`：`npm run test:unit && npm run test:e2e`

`electron-builder.yml`：
- `npmRebuild: true`（删去「无原生模块」注释）
- `files:` 追加 `students.html`、`students.js`（及可能的 `renderer/**/*.js`）

### B. 本地运行

```
nvm use                 # .nvmrc
npm install             # 触发 postinstall：ensure-electron + rebuild better-sqlite3
npm start               # tsc → Electron 窗口；首启自动建 dance-studio.db 并迁移到 v1
npm run test:unit       # 主进程纯逻辑
npm test                # unit + Playwright E2E（E2E 用临时库，不碰真实数据）
npm run dist:win        # Windows 打包（NSIS + portable），含原生模块重建
```

数据库文件：`<userData>/dance-studio.db`（macOS 开发期约为 `~/Library/Application Support/晓·乐舞艺术空间/`）。E2E 通过 `STUDIO_DB_PATH` 环境变量重定向。
