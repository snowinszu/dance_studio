# SPEC: 库存管理（物件台账 + 学员领用 + Excel 导入导出）

> 技术规格，来源 PRD：[tasks/prd-inventory-management.md](./prd-inventory-management.md)
> 生成日期：2026-08-29 ｜ 目标分支：待定 ｜ 基线：无 git（当前非 git 仓库）
> 姊妹规格（架构模板）：[tasks/spec-student-records.md](./spec-student-records.md)

---

## 1. 摘要 / Summary

### 1.1 本 SPEC 覆盖范围

把首页第 4 张卡片「库存管理」从占位页做成完整模块：迁移 v3 新增两张表（物件台账 `inventory_items`、领用流水 `item_allocations`）、物件 CRUD + 软删除、按数量分配给学员并事务化扣减库存、领用流水查询与单条删除（库存回补）、低库存标记与顶部汇总、物件台账 + 领用流水的 Excel 导出、物件台账的 Excel 导入（按物件名累加入库）。

本模块是本项目**第二个带持久化**的功能，**不引入任何新决策**：数据库层、迁移机制、IPC 约定、渲染层结构、Excel 库全部复用「学员档案」SPEC 的既定选择。新增的只有一个域文件、一个校验文件、一个 io 文件、一个 io 工具文件、一个渲染器（`inventory.html` + `inventory.js`），以及对 5 个既有文件的小改动。

### 1.2 PRD 对应

- 来源：`tasks/prd-inventory-management.md`
- 覆盖 User Stories：US-001 ~ US-009（全部）
- 覆盖 Functional Requirements：FR-1 ~ FR-35（全部）

### 1.3 设计决策一览

| 决策 | 选择 | 理由 |
|---|---|---|
| 数据库 / 迁移 / IPC / 渲染层 / Excel 库 | 全部沿用学员档案 SPEC §1.3 | 同一应用、同一套约定，不重复论证 |
| 库存数值来源 | `inventory_items.quantity` 存实数（权威值），非 `SUM(流水)` 实时算 | 用户心智模型即「库存减少」；单机小规模无多端漂移；列表/详情/下拉/预警都直接读一个整数最简 |
| 物件与领用的仓库层 | 合到一个 `src/domain/inventory.repo.ts` | `allocate` / `deleteAllocation` 同时触碰两表，是一个聚合；学员档案拆 3 个 repo 是因为那是 3 个独立聚合 |
| 扣减库存的并发安全 | 带 `AND quantity >= @qty` 守卫的条件 UPDATE + 检查 `changes` | 单进程同步 API 本无竞态；守卫防「渲染层拿旧数据」「导入连领同一物件」，并从 SQL 层面保证不为负 |
| 领用记录的更正方式 | 只能整条删除，删除时事务内把数量加回库存 | PRD 明确本版不做「归还」工作流；删除 + 回补是最小可用的纠错手段 |
| 物件删除 | 一律软删除（写 `deleted_at`），无物理删除、无「有引用则拒绝」 | 领用流水要长期可查、可导出；与学员软删除一致 |
| 分类字段 | 可空 `TEXT`，自由文本，无字典表、无下拉 | PRD 决策 |
| Excel 导入范围 | 仅物件台账；领用流水只导出 | PRD 决策 |
| 导入物件名重复 | 按未删除物件名匹配 → `quantity += 入库数量`；未匹配 → 新建 | PRD 决策（FR-24） |
| io 层公共代码 | 抽 `src/io/xlsx-util.ts`（大小/行数上限、`headerTexts`/`rowTexts`、`showSaveDialog`/`showOpenDialog` 包装）；`inventory-xlsx.ts` 依赖它 | 学员档案 `import-xlsx.ts` 已内联同款 helper，逐字复制不可取；新建工具文件不改动既有 working 代码，风险最低 |
| 既有 `io/import-xlsx.ts` 重构 | **不在本 SPEC 范围**；可在库存合入后另开小 issue 让它改用 `xlsx-util.ts` | 避免动学员档案已通过的测试 |
| 渲染外壳 | 复制 `students.html` 为 `inventory.html`，不抽公共 partial | 渲染层无构建步骤，无法 import 共享 HTML；项目现状即「每模块一套外壳」 |
| 领取时间 | `claimed_at` 存 `YYYY-MM-DD` 字符串 | PRD 决策；与学员档案日期风格一致 |

---

## 2. 架构 / Architecture

### 2.1 系统上下文

```
┌─────────────────────────── Electron 主进程 (Node) ──────────────────────────┐
│  main.ts                                                                     │
│   ├─ app.whenReady → db/connection.getDb() → migrations.run()  (→ v3)        │
│   ├─ ipc/register.ts  registerIpc()  新增 inventory:* 处理器                  │
│   └─ BrowserWindow.loadFile(index.html)                                      │
│                                                                             │
│  db/            connection(单例) · migrations(追加 v3)                        │
│  domain/        inventory.repo · inventory.validation   [NEW]                │
│  io/            inventory-xlsx(exceljs) · xlsx-util     [NEW]                │
│  shared/        types(追加库存类型 + 错误码)                                  │
└───────────────▲─────────────────────────────────────────────────────────────┘
                │  contextBridge: window.studioShell.inventory.*
                │  (ipcRenderer.invoke, 全 async, 回传 IpcResult<T>)
┌───────────────┴─────────────────────────────────────────────────────────────┐
│  渲染进程 (Chromium, file://)                                                │
│  index.html          库存卡片 href → inventory.html                          │
│  inventory.html      单页外壳（复制 students.html：顶栏 + <main id="view">）  │
│  inventory.js (ESM)  hash 路由：#/items #/items/new #/items/:id              │
│                       #/items/:id/edit #/allocate #/allocations              │
│                       调 studioShell.inventory.* 与 studioShell.students.list │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 组件职责

| 组件 | 职责 | 不负责 |
|---|---|---|
| `db/migrations.ts` (MODIFY) | 追加 `{ version: 3, up: v3 }`：建两表 + 6 个索引 | 业务 SQL |
| `domain/inventory.repo.ts` (NEW) | 物件 CRUD、软删除、`listItems(query)`（筛选+分页+`lowStockCount`）、`getItem`、`allocate`（事务：守卫扣减 + 插流水）、`listAllocations(query)`（JOIN + 筛选 + 分页）、`deleteAllocation`（事务：删行 + 回补） | 校验、IPC、dialog |
| `domain/inventory.validation.ts` (NEW) | `validateItem(input)`、`validateAllocation(input, item)` → `{ values, errors }` | 落库 |
| `io/xlsx-util.ts` (NEW) | `MAX_IMPORT_BYTES`/`MAX_IMPORT_ROWS` 常量、`openFirstSheet`、`headerTexts`、`rowTexts`、`pickSavePath`/`pickOpenPath`（薄封装 `dialog`）、`ymdCompact()` | 具体业务列 |
| `io/inventory-xlsx.ts` (NEW) | `exportItems(query, filePath)`、`exportAllocations(query, filePath)`、`buildItemTemplate(filePath)`、`readItemsPreview(filePath)`、`importItems({filePath, mapping})` | 查询（调 repo）、dialog（调 util / register） |
| `ipc/channels.ts` (MODIFY) | 追加 `inventory:*` 频道名常量 | — |
| `ipc/register.ts` (MODIFY) | 逐个 `handle(CH.inventoryXxx, fn)`；dialog 交互与学员档案 io 处理器同构 | 业务规则 |
| `preload.ts` (MODIFY) | `studioShell` 追加 `inventory` 命名空间（字面量重复频道名，与现状一致） | — |
| `inventory.js` (NEW) | hash 路由、6 个视图渲染、表单装配、即时校验提示、调 `studioShell.*` | 权威校验、SQL、fs |

### 2.3 关键流程

**分配物件给学员（US-005）**
```
inventory.js  收集表单 → studioShell.inventory.allocate({ itemId, studentId, quantity, claimedAt, note })
  → ipcRenderer.invoke('inventory:allocate', payload)
    → register: item = inventoryRepo.getItem(itemId)
                item 不存在/已软删 → AppError('NOT_FOUND')
                { values, errors } = validateAllocation(payload, item)
                errors 非空 → AppError('VALIDATION_FAILED', fields)
                inventoryRepo.allocate(values)          // 见 §5.1-A
                  ├ UPDATE ... SET quantity = quantity - @qty WHERE id=@id AND deleted_at IS NULL AND quantity >= @qty
                  │   changes !== 1 → AppError('INSUFFICIENT_STOCK', { quantity: `库存不足，当前仅剩 ${item.quantity}` })
                  └ INSERT INTO item_allocations (...)
    → return { ok:true, data:{ id, remaining } }
  → inventory.js 跳 #/allocations 或回 #/items
```

**删除领用记录（US-006）**
```
inventory.js  确认对话框 → studioShell.inventory.deleteAllocation(id)
  → register → inventoryRepo.deleteAllocation(id)      // 见 §5.1-B
      事务：SELECT item_id, quantity FROM item_allocations WHERE id=@id
            未找到 → AppError('NOT_FOUND')
            DELETE FROM item_allocations WHERE id=@id
            UPDATE inventory_items SET quantity = quantity + @qty, updated_at=@now WHERE id=@itemId
  → { ok:true, data:{ id, itemId, remaining } }
```

**导入物件台账（US-008）**
```
inventory.js → studioShell.inventory.pickImportFile()   → { filePath, headers, sample }
渲染「列映射」UI（物件名、入库数量 必须映射）
             → studioShell.inventory.importItems({ filePath, mapping })
  → io/inventory-xlsx.importItems:
      openFirstSheet + 上限校验（10MB / 5000 行）
      校验 mapping.name && mapping.quantity 存在
      db.transaction：逐数据行
        组 { name, category?, unit?, quantity, lowStockThreshold?, note? }
        validateItem(row) 失败 → failures.push({ row, reason }); continue
        SELECT id FROM inventory_items WHERE name=@name AND deleted_at IS NULL
          命中 → UPDATE quantity = quantity + @qty，行内非空字段一并 SET；updated++
          未命中 → INSERT 新物件，初始 quantity=@qty；created++
  ← { created, updated, failed, failures }
```

### 2.4 文件结构

```
src/
├── db/
│   └── migrations.ts              [MODIFY] 追加 v3（inventory_items + item_allocations + 索引）
├── shared/
│   └── types.ts                   [MODIFY] 库存实体/入参/查询/报告类型 + 3 个 IpcErrorCode
├── domain/
│   ├── inventory.repo.ts          [NEW]
│   └── inventory.validation.ts    [NEW]
├── io/
│   ├── xlsx-util.ts               [NEW] 通用：上限常量 + 表格读取 helper + dialog 封装
│   └── inventory-xlsx.ts          [NEW] 台账导出 / 流水导出 / 台账模板 / 台账预览 / 台账导入
└── ipc/
    ├── channels.ts                [MODIFY] 追加 inventory:* 频道
    └── register.ts                [MODIFY] 注册 inventory:* 处理器

inventory.html                     [NEW] 渲染器外壳（复制 students.html）
inventory.js                       [NEW] 渲染器控制器（ESM）
studioShell.d.ts                   [MODIFY] window.studioShell.inventory 环境类型
index.html                         [MODIFY] app-card-inventory 的 href → inventory.html
placeholder.html                   [MODIFY] APP_NAMES 移除 'inventory' 键
electron-builder.yml               [MODIFY] files += inventory.html, inventory.js
tests/
├── unit/
│   ├── inventory-migration.test.ts   [NEW]
│   ├── inventory-validation.test.ts  [NEW]
│   └── inventory-list-query.test.ts  [NEW]
├── integration/
│   └── inventory-ipc.test.ts         [NEW]  (直接调 register 导出的处理器 / 或 repo + io)
└── e2e/
    └── inventory-flow.spec.ts        [NEW]
```

> `preload.ts` 以沙盒预加载运行，不能 require 相对模块，频道名字面量重复一份——与学员档案现状一致，可接受。

---

## 3. 数据模型 / Data Model

### 3.1 迁移 v3（`user_version` 2 → 3）

```sql
-- 物件台账
CREATE TABLE inventory_items (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT    NOT NULL,
  category             TEXT,
  unit                 TEXT    NOT NULL DEFAULT '件',
  quantity             INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold  INTEGER NOT NULL DEFAULT 0,
  note                 TEXT,
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL,
  deleted_at           TEXT
);
CREATE INDEX idx_items_name     ON inventory_items(name);
CREATE INDEX idx_items_category ON inventory_items(category);
CREATE INDEX idx_items_deleted  ON inventory_items(deleted_at);

-- 领用流水（一行 = 一次领取）
CREATE TABLE item_allocations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES inventory_items(id),
  student_id  INTEGER NOT NULL REFERENCES students(id),
  quantity    INTEGER NOT NULL DEFAULT 1,
  claimed_at  TEXT    NOT NULL,          -- 'YYYY-MM-DD'
  note        TEXT,
  created_at  TEXT    NOT NULL
);
CREATE INDEX idx_alloc_item    ON item_allocations(item_id);
CREATE INDEX idx_alloc_student ON item_allocations(student_id);
CREATE INDEX idx_alloc_date    ON item_allocations(claimed_at);
```

要点：

- **不写 `ON DELETE CASCADE`**：物件用软删除；学员本就是软删除。删了也要能在流水/导出里看到历史。连接级 `PRAGMA foreign_keys = ON` 已由 `connection.ts` 设好——这里的 FK 只做「插入时 `item_id` / `student_id` 必须存在」的完整性校验（`allocate` 前 `getItem` 已先查，属双保险）。
- `quantity` / `low_stock_threshold` 为 `INTEGER NOT NULL`，无 `CHECK(quantity >= 0)`——不为负由 `allocate` 的守卫 UPDATE 保证；加 `CHECK` 会让「删除领用记录回补」等场景更脆，且迁移期无历史数据不需要。
- 无更新触发器；`updated_at` 由 repo 每次写操作显式赋值（与 `students.repo` 一致）。
- v3 `up` 只做 DDL，不塞数据。

### 3.2 实体定义（追加到 `src/shared/types.ts`）

```ts
export interface InventoryItem {
  id: number;
  name: string;
  category: string | null;
  unit: string;                 // 默认 '件'
  quantity: number;             // 当前在库数，整数 >= 0
  lowStockThreshold: number;    // 整数 >= 0
  note: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** 新建/编辑物件入参（编辑时 quantity 可直接改，不留调整痕迹） */
export interface InventoryItemInput {
  name: string;
  category?: string | null;
  unit?: string | null;         // 省略/空 → '件'
  quantity?: number;            // 省略 → 0（新建）；编辑省略 → 保持不变由 register 处理
  lowStockThreshold?: number;   // 省略 → 0
  note?: string | null;
}

export interface InventoryListQuery {
  search?: string;              // 匹配 name 子串
  category?: string;            // 精确匹配
  lowStockOnly?: boolean;       // quantity <= low_stock_threshold
  limit?: number;               // 默认 100
  offset?: number;              // 默认 0
}
export interface InventoryListResult {
  rows: InventoryItem[];
  total: number;                // 满足筛选（除分页）的物件数
  lowStockCount: number;        // 未软删物件中 quantity <= low_stock_threshold 的数量（不受 search/category 影响）
}

export interface Allocation {
  id: number;
  itemId: number;
  itemName: string;             // JOIN 出，含已软删物件
  studentId: number;
  studentName: string;          // JOIN 出
  studentPhone: string;         // JOIN 出（phone_primary）
  quantity: number;
  claimedAt: string;            // 'YYYY-MM-DD'
  note: string | null;
  createdAt: string;
}

export interface AllocationInput {
  itemId: number;
  studentId: number;
  quantity: number;             // 整数 >= 1
  claimedAt?: string;           // 省略 → 今天（YYYY-MM-DD）
  note?: string | null;
}

export interface AllocationListQuery {
  dateFrom?: string;            // 'YYYY-MM-DD'，claimed_at >= dateFrom
  dateTo?: string;              // 'YYYY-MM-DD'，claimed_at <= dateTo
  studentId?: number;
  itemId?: number;
  limit?: number;               // 默认 100
  offset?: number;
}
export interface AllocationListResult { rows: Allocation[]; total: number; }

export interface InventoryImportReport {
  created: number;
  updated: number;
  failed: number;
  failures: { row: number; reason: string }[];   // row = xlsx 行号（含表头，从 2 起）
}
```

`IpcErrorCode` 追加：`'INSUFFICIENT_STOCK'`（库存不足）、`'ITEM_NAME_CONFLICT'`（物件重名）。
> PRD 草案里提过的 `ITEM_IN_USE` **不引入**——删物件一律软删、恒成功，无「有引用则拒绝」路径。

### 3.3 关系

- `item_allocations.item_id` → `inventory_items.id`（多对一，无级联）
- `item_allocations.student_id` → `students.id`（多对一，无级联）
- 物件的「当前库存」不是关系派生值，是 `inventory_items.quantity` 列本身
- 与学员档案模块唯一耦合点：`allocate` 表单里选学员复用 `studioShell.students.list`（无新频道）；流水 JOIN `students` 取姓名/电话

### 3.4 迁移计划

- 前向单向，追加 `{ version: 3, up: v3 }` 到 `MIGRATIONS`。`run()` 逻辑不变：读 `user_version`，对 `version > cur` 的迁移在单事务内执行、写回版本号。
- 无 down。开发期回滚 = 删 db 文件重建。
- v3 `up` 抛错 → 该事务回滚，`user_version` 停在 2，下次启动重试。
- 单测用 `better-sqlite3(':memory:')` + `migrations.run()` 现场建库。

---

## 4. 接口设计 / IPC Surface

### 4.1 频道清单（全部 `ipcMain.handle` / `ipcRenderer.invoke`，返回 `IpcResult<T>`）

| 频道 | 渲染层入口 | 入参 | 成功数据 | 说明 |
|---|---|---|---|---|
| `inventory:listItems` | `studioShell.inventory.listItems(q)` | `InventoryListQuery` | `InventoryListResult` | 服务端筛选 + 分页；不含已软删物件 |
| `inventory:getItem` | `.inventory.getItem(id)` | `number` | `InventoryItem` | 未找到（含已软删则视调用方需要）→ `NOT_FOUND`；详情页用 |
| `inventory:createItem` | `.inventory.createItem(p)` | `InventoryItemInput` | `{ id: number }` | 重名 → `ITEM_NAME_CONFLICT`；校验失败 → `VALIDATION_FAILED` + `fields` |
| `inventory:updateItem` | `.inventory.updateItem(id, p)` | `(number, InventoryItemInput)` | `{ id: number }` | 同上；`id` 不存在/已软删 → `NOT_FOUND`；`quantity` 省略则保持原值 |
| `inventory:deleteItem` | `.inventory.deleteItem(id)` | `number` | `{ id: number }` | 仅写 `deleted_at`；`id` 不存在/已软删 → `NOT_FOUND` |
| `inventory:allocate` | `.inventory.allocate(p)` | `AllocationInput` | `{ id: number; remaining: number }` | 见 §5.1-A；库存不足 → `INSUFFICIENT_STOCK` |
| `inventory:listAllocations` | `.inventory.allocations(q)` | `AllocationListQuery` | `AllocationListResult` | JOIN item/student；按 `claimed_at DESC, id DESC` |
| `inventory:deleteAllocation` | `.inventory.deleteAllocation(id)` | `number` | `{ id: number; itemId: number; remaining: number }` | 见 §5.1-B；未找到 → `NOT_FOUND` |
| `inventory:exportItems` | `.inventory.exportItems(q)` | `InventoryListQuery`（忽略分页，导全量匹配） | `{ filePath: string; count: number }` | `showSaveDialog`；取消 → `IO_CANCELLED`；写失败 → `IO_WRITE_FAILED` |
| `inventory:exportAllocations` | `.inventory.exportAllocations(q)` | `AllocationListQuery`（忽略分页） | `{ filePath: string; count: number }` | 同上 |
| `inventory:downloadTemplate` | `.inventory.downloadTemplate()` | — | `{ filePath: string }` | 生成台账导入模板 xlsx |
| `inventory:pickImportFile` | `.inventory.pickImportFile()` | — | `{ filePath: string; headers: string[]; sample: string[][] }` | `showOpenDialog` + 读表头/前 3 行；超限 → `IMPORT_TOO_LARGE`；坏文件 → `IMPORT_FILE_INVALID` |
| `inventory:importItems` | `.inventory.importItems(args)` | `{ filePath: string; mapping: Record<string,string> }` | `InventoryImportReport` | 逐行；失败行不中断 |

### 4.2 `channels.ts` 常量（追加）

```ts
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
```

### 4.3 `preload.ts` 追加

```ts
inventory: {
  listItems: (q?: unknown) => invoke(CH.inventoryListItems, q),
  getItem: (id: number) => invoke(CH.inventoryGetItem, id),
  createItem: (p: unknown) => invoke(CH.inventoryCreateItem, p),
  updateItem: (id: number, p: unknown) => invoke(CH.inventoryUpdateItem, id, p),
  deleteItem: (id: number) => invoke(CH.inventoryDeleteItem, id),
  allocate: (p: unknown) => invoke(CH.inventoryAllocate, p),
  allocations: (q?: unknown) => invoke(CH.inventoryListAllocations, q),
  deleteAllocation: (id: number) => invoke(CH.inventoryDeleteAllocation, id),
  exportItems: (q?: unknown) => invoke(CH.inventoryExportItems, q),
  exportAllocations: (q?: unknown) => invoke(CH.inventoryExportAllocations, q),
  downloadTemplate: () => invoke(CH.inventoryDownloadTemplate),
  pickImportFile: () => invoke(CH.inventoryPickImportFile),
  importItems: (args: unknown) => invoke(CH.inventoryImportItems, args),
},
```

### 4.4 错误响应

沿用学员档案：处理器**不把异常抛过 IPC 边界**，`handle()` 包裹器 `try/catch` → `toIpcError`。domain 抛 `AppError(code, message, fields?)`。字段级校验错误放 `fields`，渲染层回填到对应输入框下。

### 4.5 破坏性变更

- `window.studioShell` 追加 `inventory` 命名空间——**新增字段，向后兼容**。
- `index.html` 库存卡片 `href`：`placeholder.html?app=inventory` → `inventory.html`；`placeholder.html` 的 `APP_NAMES` 去 `inventory` 键。若现有 E2E 有「首页 → 库存占位页」断言，随 US-003 改为「首页 → 库存列表页」。

---

## 5. 业务逻辑 / Business Logic

### 5.1 核心算法

**A. `inventoryRepo.allocate(values)`**（`inventory.repo.ts`）
```
now = new Date().toISOString()
tx = db.transaction(() => {
  info = db.prepare(`
    UPDATE inventory_items
       SET quantity = quantity - @qty, updated_at = @now
     WHERE id = @itemId AND deleted_at IS NULL AND quantity >= @qty
  `).run({ itemId, qty, now })

  if (info.changes !== 1) throw new AppError('INSUFFICIENT_STOCK', '库存不足')

  ins = db.prepare(`
    INSERT INTO item_allocations (item_id, student_id, quantity, claimed_at, note, created_at)
    VALUES (@itemId, @studentId, @qty, @claimedAt, @note, @now)
  `).run({ itemId, studentId, qty, claimedAt, note: note ?? null, now })

  return Number(ins.lastInsertRowid)
})
id = tx()
remaining = db.prepare('SELECT quantity FROM inventory_items WHERE id=?').get(itemId).quantity
return { id, remaining }
```
> `getItem` 在 register 层已先做「物件存在且未软删」检查并把 `item.quantity` 带进错误提示；repo 里的守卫是并发/竞态兜底与「不为负」的硬保证。

**B. `inventoryRepo.deleteAllocation(id)`**
```
now = ISO
tx = db.transaction(() => {
  row = db.prepare('SELECT item_id, quantity FROM item_allocations WHERE id=?').get(id)
  if (!row) throw new AppError('NOT_FOUND', '领用记录不存在')
  db.prepare('DELETE FROM item_allocations WHERE id=?').run(id)
  db.prepare(`
    UPDATE inventory_items SET quantity = quantity + @qty, updated_at = @now WHERE id = @itemId
  `).run({ qty: row.quantity, itemId: row.item_id, now })   // 物件已软删也照常加回
  return row.item_id
})
itemId = tx()
remaining = SELECT quantity ... WHERE id = itemId
return { id, itemId, remaining }
```

**C. `inventoryRepo.listItems(query)`** — 动态 WHERE，全参数化
```
base:      WHERE deleted_at IS NULL
search:    AND name LIKE @kw ESCAPE '\'          // @kw = '%'+escapeLike(search)+'%'
category:  AND category = @category
lowStock:  AND quantity <= low_stock_threshold
total:     SELECT COUNT(*) 套上述条件
rows:      SELECT * ... ORDER BY name COLLATE NOCASE LIMIT @limit OFFSET @offset
lowStockCount: SELECT COUNT(*) FROM inventory_items
               WHERE deleted_at IS NULL AND quantity <= low_stock_threshold   // 不含 search/category
```
> `escapeLike` 复用 `students.repo` 里同款实现（可提到 `xlsx-util` 之外的小工具，或各 repo 各留一份——本 SPEC 取「`inventory.repo` 内部私有一份」，与 `students.repo` 对称，避免跨模块耦合）。

**D. `inventoryRepo.listAllocations(query)`**
```
SELECT a.id, a.item_id, i.name AS item_name, a.student_id,
       s.name AS student_name, s.phone_primary AS student_phone,
       a.quantity, a.claimed_at, a.note, a.created_at
  FROM item_allocations a
  JOIN inventory_items i ON i.id = a.item_id
  JOIN students        s ON s.id = a.student_id
 WHERE 1=1
   [AND a.claimed_at >= @dateFrom]
   [AND a.claimed_at <= @dateTo]
   [AND a.student_id  = @studentId]
   [AND a.item_id     = @itemId]
 ORDER BY a.claimed_at DESC, a.id DESC
 LIMIT @limit OFFSET @offset
total: 同 WHERE 套 COUNT(*)
```
> `JOIN`（非 `LEFT JOIN`）可接受：`item_id` / `student_id` 均 `NOT NULL` 且 FK 保证存在；软删除不删行，故 JOIN 不会丢记录。

**E. `importItems({ filePath, mapping })`**（`inventory-xlsx.ts`）
```
1. ws = openFirstSheet(filePath)                       // 坏文件 → IMPORT_FILE_INVALID
   size > 10MB → IMPORT_TOO_LARGE ; dataRows > 5000 → IMPORT_TOO_LARGE
2. mapping.name && mapping.quantity 必须存在 → 否则 BAD_REQUEST
3. headers = headerTexts(ws) ; colOf(h) = headers.indexOf(h)
4. report = { created:0, updated:0, failed:0, failures:[] }
5. db.transaction(() => {
     for r = 2 .. ws.rowCount:
       cells = rowTexts(ws.getRow(r), headers.length)
       if 全空 → continue
       raw = { name, category, unit, quantity, lowStockThreshold, note } 按 mapping 取
       { values, errors } = validateItem(raw)          // 见 §5.2
       if errors 非空 → report.failed++ ; failures.push({ row:r, reason: 首个错误 }) ; continue
       hit = SELECT id FROM inventory_items WHERE name=@name AND deleted_at IS NULL
       if hit:
         UPDATE inventory_items
            SET quantity = quantity + @qty,
                category = COALESCE(@category, category),   // 行内留空 → 不动
                unit     = COALESCE(NULLIF(@unit,''), unit),
                low_stock_threshold = COALESCE(@lowStock, low_stock_threshold),
                note     = COALESCE(@note, note),
                updated_at = @now
          WHERE id = @hitId
         report.updated++
       else:
         INSERT INTO inventory_items (name, category, unit, quantity, low_stock_threshold, note, created_at, updated_at)
         VALUES (@name, @category, COALESCE(NULLIF(@unit,''),'件'), @qty, COALESCE(@lowStock,0), @note, @now, @now)
         report.created++
   })
6. return report
```
> 「行内留空 → 不覆盖」用「取值为空串时传 `null`，SQL 用 `COALESCE`」实现。`quantity` 是**累加**不是覆盖，语义上「入库数量」。

**F. 导出**（`exportItems` / `exportAllocations`）
```
exportItems(query): rows = listItems({ ...query, limit: 大数, offset: 0 }).rows
  列：物件名 | 分类 | 单位 | 当前库存 | 预警阈值 | 备注
exportAllocations(query): rows = listAllocations({ ...query, limit: 大数 }).rows
  列：物件名 | 学员姓名 | 学员电话 | 领取数量 | 领取日期 | 备注
两者：new ExcelJS.Workbook → addWorksheet → ws.columns = [...] → 逐行 addRow
       await wb.xlsx.writeFile(filePath) → return rows.length
空值 → 空串；数字直接写数字。
```

**G. 默认领取日期**（渲染层 & register 双保险）：`claimedAt` 省略时 `new Date()` 取本地日期拼 `YYYY-MM-DD`。

### 5.2 校验规则

`validateItem(input)`：

| 字段 | 规则 | 失败 key |
|---|---|---|
| name | 非空、trim 后 ≤ 40 字符 | `name` |
| category | 可空；≤ 40 字符 | `category` |
| unit | 可空（空 → '件'）；≤ 10 字符 | `unit` |
| quantity | `Number.isInteger` 且 ≥ 0（新建省略 → 0） | `quantity` |
| lowStockThreshold | `Number.isInteger` 且 ≥ 0（省略 → 0） | `lowStockThreshold` |
| note | 可空；≤ 200 字符 | `note` |

> 重名不在 `validateItem` 内查（需 DB）——由 `inventory.repo.createItem` / `updateItem` 查 `name` + `deleted_at IS NULL`，命中抛 `AppError('ITEM_NAME_CONFLICT', '物件已存在', { name: '物件已存在' })`。编辑时排除自身 id。

`validateAllocation(input, item)`：

| 字段 | 规则 | 失败 key |
|---|---|---|
| itemId | `Number.isFinite`；`item` 已由 register 取到且未软删 | `itemId` |
| studentId | `Number.isFinite`（存在性由 FK + 可选预查） | `studentId` |
| quantity | `Number.isInteger` 且 ≥ 1 | `quantity` |
| （库存充足） | `quantity <= item.quantity`；否则提示「库存不足，当前仅剩 N」 | `quantity` |
| claimedAt | 省略 → 今天；否则 `/^\d{4}-\d{2}-\d{2}$/` 且 `new Date(x)` 回读一致 | `claimedAt` |
| note | 可空；≤ 200 字符 | `note` |

> 「库存充足」在 validation 里做一次（体验：即时红字），repo 的守卫 UPDATE 再兜一次（正确性）。两处都命中才算安全。

### 5.3 状态与生命周期

- 物件无业务状态机；唯一生命周期是软删除：`deletedAt = null`（在册） ↔ `deletedAt = ISO`（已删）。本版无恢复入口（开放问题）。
- 领用记录不可编辑，只能整条删除（删除即库存回补）。无「已归还」状态（本版不做归还）。
- `quantity` 随 `allocate`（-）、`deleteAllocation`（+）、`updateItem`（直接赋值）、`importItems`（+）变化，永不 < 0。

### 5.4 边界情况

| 场景 | 处理 |
|---|---|
| 领取数量 > 当前库存 | validation 红字 + repo 守卫 UPDATE `changes=0` → `INSUFFICIENT_STOCK`，不写流水、不扣减 |
| 并发/旧数据导致的超扣 | 守卫 UPDATE 的 `AND quantity >= @qty` 拦截，`changes !== 1` 抛错 |
| 删除领用记录时对应物件已软删 | 仍删记录并 `quantity += n`（物件行仍在，只是 `deleted_at` 非空） |
| 分配下拉里的物件 | 仅 `deleted_at IS NULL AND quantity > 0`；`quantity = 0` 的物件不可选 |
| 物件列表 / 详情 | 不显示已软删物件；`getItem(id)` 对已软删物件仍返回（导出、流水详情跳转用） |
| 导入：物件名重复（同一文件内两行同名） | 第一行按新建/累加，第二行此时已能 `SELECT` 到 → 走累加分支（事务内可见）|
| 导入：物件名匹配到「已软删」的同名物件 | 视为未匹配 → 新建一个在册物件（软删物件不参与匹配）|
| 导入行 `入库数量` 为负 / 非整数 / 空 | 计入 `failures`，其余行继续 |
| 导入未映射「物件名」或「入库数量」 | 向导禁用「开始导入」；后端二次校验 `BAD_REQUEST` |
| `listItems` 顶部汇总 `lowStockCount` | 独立 COUNT，不受 `search` / `category` / 分页影响；随每次 `listItems` 返回 |
| 低库存判定含 `quantity = 0` 且 `threshold = 0` | `0 <= 0` 为真 → 计入低库存（合理：没货了）|
| 领用流水按日期区间筛选 | `claimed_at` 是 `YYYY-MM-DD` 字符串，字典序 = 时间序，直接 `>=` / `<=` |
| db 打不开 / 迁移失败 | 沿用学员档案 `main.ts` 既有处理（`showErrorBox` + 列表错误态），本模块不额外处理 |

---

## 6. 错误处理 / Error Handling

### 6.1 错误分类

| code | 触发条件 | 渲染层表现 |
|---|---|---|
| `BAD_REQUEST` | 缺 id、导入 mapping 缺必填列 | toast「操作参数有误」 |
| `VALIDATION_FAILED` | `validateItem` / `validateAllocation` 返回非空 errors | 对应输入框下红字（用 `error.fields`），不提交 |
| `NOT_FOUND` | 按 id 取物件 / 领用记录不存在（或物件已软删而上下文要求在册） | toast「记录不存在，可能已被删除」→ 返回列表 |
| `ITEM_NAME_CONFLICT` | 新建/改名撞未删除物件同名 | 物件名输入框下红字「物件已存在」 |
| `INSUFFICIENT_STOCK` | 领取数量 > 当前库存（validation 或守卫 UPDATE） | 数量输入框下红字「库存不足，当前仅剩 N」 |
| `IMPORT_FILE_INVALID` | exceljs 无法解析 / 无 worksheet | 导入向导 toast「文件无法识别，请用模板另存为 .xlsx」 |
| `IMPORT_TOO_LARGE` | > 10MB 或 > 5000 数据行 | toast「单次最多导入 5000 行」 |
| `IO_CANCELLED` | 用户在系统对话框点取消 | 静默，无 toast |
| `IO_WRITE_FAILED` | 写 xlsx 失败（磁盘满 / 无权限） | toast「导出失败：<原因>」 |
| `DB_ERROR` | 未归类 SQLite 异常 | toast「数据库错误，请重试」；`console.error` 原始栈 |

### 6.2 重试策略

同步、本地、无内置重试。导入失败行汇总进报告，用户改表后重导（注意：重导已成功的行会再次累加库存——向导提示用户只保留失败行）。

### 6.3 失败模式

- 迁移中途失败：单事务回滚，`user_version` 停在 2，下次启动重试。
- exceljs 抛错：`io/*` 捕获 → `IMPORT_FILE_INVALID` / `IO_WRITE_FAILED`，不影响主流程。
- `allocate` 事务中任一步抛错：整体回滚，库存与流水都不变。

---

## 7. 安全 / Security

- 沿用学员档案：无登录、无角色；所有 IPC 对渲染进程开放；本地单机单用户，攻击面仅本机用户自身。
- **SQL 注入**：全部预编译 + 命名参数；`LIKE` 对 `%` `_` `\` 转义并 `ESCAPE '\'`。
- **导入**：文件大小上限 10MB、数据行上限 5000；只读用户经 `dialog` 选定的路径；`exceljs` 解析全程 try/catch。
- **渲染进程**：保持 `contextIsolation: true`、`nodeIntegration: false`；`preload` 只经 `contextBridge` 暴露 `studioShell.inventory.*` 具名方法，不暴露 `ipcRenderer` / `fs` / `path`。
- 无敏感字段、无脱敏需求；无审计日志（仅 `created_at` / `updated_at`）。

---

## 8. 性能 / Performance

### 8.1 预期负载

单机单用户；物件数百、领用流水数千 ~ 上万。写操作低频（人工录入 / 偶发导入）；读以列表 + 流水检索为主。

### 8.2 优化策略

- `listItems` / `listAllocations` 服务端筛选 + 分页（默认 `limit=100`），渲染层「加载更多」增量取。
- `lowStockCount` 单独一条 `COUNT(*)`，走 `idx_items_deleted`（覆盖 `deleted_at`）+ 行内比较，规模下 < 1ms。
- 导出用 `workbook.xlsx.writeFile` 流式落盘。
- 导入整批包一个 `db.transaction`（5000 行单事务）。
- 渲染层视图切换为 DOM 显隐 + 局部重渲染，无整页刷新。

### 8.3 数据库考量

- 索引：`idx_items_name`（`ORDER BY name COLLATE NOCASE` + 搜索）、`idx_items_category`、`idx_items_deleted`、`idx_alloc_item`、`idx_alloc_student`、`idx_alloc_date`。
- `item_allocations` 的三条筛选（item / student / date）各有单列索引；组合筛选下 SQLite 选最优单列 + 行过滤，规模下足够。
- WAL 模式、连接单例（`connection.ts` 已有），进程退出 `closeDb()`。
- 成功指标：1000 物件 + 5000 流水下，`listItems` / `listAllocations` P95 < 200ms（`inventory-list-query.test.ts` 造数据基准）。

---

## 9. 测试策略 / Testing Strategy

### 9.1 单元测试（`node:test`，`tests/unit/*.test.ts`）

| 文件 | 覆盖 |
|---|---|
| `inventory-migration.test.ts` | 空库 `run` 到 v3：两表 + 6 索引齐全；重复 `run` 幂等；v3 `up` 中途抛错 → 回滚且 `user_version` 停在 2 |
| `inventory-validation.test.ts` | `validateItem`：name 空/超 40、quantity 非整数/负、threshold 负、各字段长度上限；`validateAllocation`：quantity < 1、非整数、超库存提示、claimedAt 格式与历法（`2026-02-30` 拒）、默认今天 |
| `inventory-list-query.test.ts` | `listItems`：search（`%`/`_`/`\` 转义）、category、lowStockOnly 组合 WHERE；`total` 与 `rows` 一致；`lowStockCount` 不受 search/category 影响；`listAllocations`：日期区间 / student / item 筛选；排序；分页；1000+5000 行基准计时 |

> 需要 db 的单测用 `better-sqlite3(':memory:')` + `migrations.run()` 现场建库（`STUDIO_DB_PATH=':memory:'` 或临时文件）。

### 9.2 集成测试（`tests/integration/inventory-ipc.test.ts`，直接调 repo + io，不经 Electron）

- 全链路：`createItem`（库存 10）→ `getItem` 核对 → `allocate`(3) → `getItem` 库存 7 + `listAllocations` 有 1 条 → 再 `allocate`(100) 抛 `INSUFFICIENT_STOCK` 且库存仍 7 → `deleteAllocation` → 库存 10、流水空
- 重名：`createItem('练功服')` 两次 → 第二次 `ITEM_NAME_CONFLICT`；`updateItem` 改名撞已有 → 同；改名为自身原名 → 放行
- 软删：`deleteItem` → `listItems` 不含、`getItem` 仍返回；对已软删物件的历史流水 `deleteAllocation` → 库存字段照常 +n
- 导出：`exportItems` / `exportAllocations` 到 tmp，`exceljs` 读回断言列顺序、表头文字、行数、数据
- 导入：fixture「1 新物件行 + 1 已存在物件补库存行 + 1 坏行（数量为负）」→ `{ created:1, updated:1, failed:1 }`，坏行 `row` 正确，已存在物件库存 = 原值 + 入库数量；未映射「入库数量」→ `BAD_REQUEST`

### 9.3 边界用例测试（对应 §5.4）

同一导入文件内两行同名 → 第二行走累加；导入匹配到已软删同名物件 → 新建在册物件；`quantity=0` 物件不进分配下拉；`lowStockCount` 随分配跨过阈值而 +1。

### 9.4 E2E（Playwright，`tests/e2e/inventory-flow.spec.ts`）

沿用 `home-flow.spec.ts` 的 `_electron.launch`；`env.STUDIO_DB_PATH` 指向 `test-results/` 下每次运行唯一临时 `.db`，`beforeEach` 删除。**E2E 需要一个已存在学员**——在 `beforeAll` 用 `studioShell.students.create` 或直接建库插入。

- happy：首页「库存管理」→ `#/items` 空态 → 新建（名 + 库存 10 + 阈值 3）→ 列表出现、库存 10 → `#/allocate` 选物件 + 选学员 + 数量 3 + 日期 → 保存 → `#/items` 库存 7 → `#/allocations` 出现该记录（物件名 / 日期 / 数量正确）
- 边界 1：再分配 100 → 数量框「库存不足」红字，`#/items` 仍 7
- 边界 2：再分配 5（库存 2 ≤ 阈值 3）→ 顶部「1 个物件库存偏低」+ 该行「库存偏低」标记
- 边界 3：`#/allocations` 删除数量 3 那条 → 确认对话框 → 确认 → `#/items` 库存 +3
- 导出：`#/allocations` 点「导出流水」写 tmp 路径 → `exceljs` 读回断言含「物件名」「领取日期」两列、行数正确
- 全程 `pageErrors` 为空；自建自清数据

### 9.5 验收标准映射

| US / FR | 测试 | 类型 |
|---|---|---|
| US-001 / FR-1,3 | `inventory-migration.test.ts` | 单元 |
| US-002 / FR-2,11-15,18,32,33 | `inventory-ipc.test.ts` | 集成 |
| US-003 / FR-8,9,10,34,35 | `inventory-list-query.test.ts` + E2E | 单元 + E2E |
| US-004 / FR-4,5,6,7,27,28 | `inventory-validation.test.ts` + 集成重名/软删 | 单元 + 集成 |
| US-005 / FR-11,12,13,14,29,30 | 集成全链路 + E2E happy/边界1 | 集成 + E2E |
| US-006 / FR-16,17,18 | 集成 deleteAllocation + E2E 边界3 | 集成 + E2E |
| US-007 / FR-19,20,21 | 集成导出读回 + E2E 导出 | 集成 + E2E |
| US-008 / FR-22,23,24,25,26 | 集成导入 fixture | 集成 |
| US-009 | `inventory-flow.spec.ts` | E2E |
| FR-31 | `inventory-list-query.test.ts`（转义用例） | 单元 |
| FR-35 | 无裸 hex 静态检查 + 人工视觉核对 | 审查 |

---

## 10. 实施计划 / Implementation Plan

### 10.1 阶段与顺序

1. **DB 地基**（US-001）：`migrations.ts` 追加 v3；`shared/types.ts` 加类型 + 错误码；`inventory-migration.test.ts`
2. **域层 + 读写 IPC**（US-002）：`inventory.repo.ts`（items CRUD / listItems / allocate / listAllocations / deleteAllocation）+ `inventory.validation.ts`；`channels.ts` + `register.ts` 接线；`preload.ts` + `studioShell.d.ts`；`inventory-validation.test.ts` + `inventory-list-query.test.ts` + `inventory-ipc.test.ts`（不含 io 部分）
3. **渲染外壳 + 物件列表**（US-003）：复制 `inventory.html` + `inventory.js`（hash 路由骨架 + `#/items` + 搜索/分类筛选 + 低库存标记 + 顶部汇总）；`index.html` 改 href；`placeholder.html` 去键；`electron-builder.yml` 白名单；改现有占位 E2E 断言（若有）
4. **物件详情 + 表单**（US-004）：`#/items/new`、`#/items/:id`（含该物件领用历史）、`#/items/:id/edit`（可直接改库存）
5. **分配给学员**（US-005）：`#/allocate`（物件下拉 + 复用 `students.list` 选人 + 数量 + 日期 + 备注）；即时校验
6. **领用流水页**（US-006）：`#/allocations`（日期区间/学员/物件筛选 + 分页 + 删除确认 + 库存回补）
7. **导出**（US-007）：`io/xlsx-util.ts` + `io/inventory-xlsx.ts` 的 `exportItems`/`exportAllocations`；`inventory:exportItems`/`exportAllocations` + 两页「导出」按钮；集成读回测试
8. **导入台账**（US-008）：`inventory-xlsx.ts` 的 `buildItemTemplate`/`readItemsPreview`/`importItems`；`downloadTemplate`/`pickImportFile`/`importItems` 频道 + 列映射向导；集成 fixture 测试
9. **E2E**（US-009）：`inventory-flow.spec.ts`

### 10.2 Issue 映射

| Issue | SPEC 章节 | 优先级 | 依赖 |
|---|---|---|---|
| #1 DB 地基 | 2.4, 3.1-3.4, 9.1 | 高 | — |
| #2 域层 + 读写 IPC | 2.2, 2.3, 4.1-4.4, 5.1A-D, 5.2 | 高 | #1 |
| #3 渲染外壳 + 物件列表 | 2.1, 4.5, 5.1C, 5.4 | 高 | #2 |
| #4 物件详情 + 表单 | 5.2, 5.3, 6.1 | 高 | #2, #3 |
| #5 分配给学员 | 5.1A, 5.2, 5.4 | 高 | #2, #3 |
| #6 领用流水页 | 5.1B,D, 5.4 | 中 | #3, #5 |
| #7 导出 | 5.1F, 2.2(xlsx-util) | 中 | #2 |
| #8 导入台账 | 5.1E, 6.1, 7 | 中 | #2, #3 |
| #9 E2E | 9.4 | 高 | #3–#8 |

### 10.3 增量交付

- 无 feature flag：入口即 `inventory.html`，未合入前首页卡片暂留指向 `placeholder.html?app=inventory`。
- #1–#2 合入后即可用集成测试验证后端，不阻塞前端。
- #3+#4+#5 合入后「物件列表 + 增删改 + 分配扣减」已是可用最小闭环，#6–#8 逐步增强。
- #7 的 `io/xlsx-util.ts` 一旦落地，可另开 issue 让 `io/import-xlsx.ts` 改用它（非必须、不在本 SPEC）。

---

## 11. 开放问题与风险 / Open Questions & Risks

### 11.1 待明确（PRD 已列，实施前可不阻塞）

- 归还 / 部分归还：v2 候选，本 SPEC 只提供「删除领用记录 + 库存回补」作纠错。
- 导入领用流水：不做；仅导入台账。
- 首页概况显示低库存数：属「管理首页」模块。
- 物件分类是否收敛为字典 + 下拉：暂自由文本。
- 已软删物件的恢复入口 / 「已删除物件」视图：不做。
- 导入重导时对已成功行的重复累加：本 SPEC 靠向导文案提示用户「只留失败行」，不做幂等键。

### 11.2 技术风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 抽 `io/xlsx-util.ts` 时若顺手重构 `import-xlsx.ts` 触发学员档案 E2E 回归 | CI 阻塞 | 本 SPEC 明确 `import-xlsx.ts` 重构**不在范围**；`xlsx-util.ts` 为纯新增 |
| `inventory.js` 单文件膨胀（6 视图） | 可维护性 | 允许拆 `renderer/inventory/*.js`（免构建，加打包白名单） |
| `electron-builder.yml` 的 `files` 漏加 `inventory.html`/`inventory.js` | 打包后白屏 | US-003 AC 显式包含；`scripts/smoke-packaged.mjs` 可加断言 `inventory.html` 存在 |
| 渲染层非 TS，`studioShell.inventory` 拼写漂移 | 运行时报错 | 手写 `studioShell.d.ts`；渲染层薄，权威校验在主进程 |
| 导入「行内留空不覆盖」的 `COALESCE`/`NULLIF` 语义写错，误清字段 | 数据损坏 | `inventory-ipc.test.ts` 专门断言「补库存行只带数量、其余字段不变」 |
| 现有 `home-flow.spec.ts` 因 href 变更变红 | CI 阻塞 | US-003 内同步改该用例 |
| better-sqlite3 / Electron 43 ABI（学员档案已趟过） | 打包崩溃 | 已由 `@electron/rebuild` + `npmRebuild: true` 解决，本模块无新增原生依赖 |

### 11.3 假设（实施前校验）

- 学员档案模块已合入：`students` 表、`connection.ts`、`migrations.run()`、`ipc/register.ts` 的 `handle()` 包裹器、`preload.ts` 的 `invoke()`、`AppError` / `toIpcError` 均已就绪（本 SPEC 直接复用）。
- 当前 `user_version` 已到 2（v1 + v2 已应用）；v3 是下一个。
- `claimed_at` 用 `YYYY-MM-DD` 字符串，字典序等价时间序，日期区间筛选直接字符串比较成立。
- Electron 43 Chromium 支持 `file://` 下 ES modules、`<dialog>`、`URLSearchParams` 等（学员档案已验证）。
- 设计令牌：`inventory.html` 沿用 `students.html` 的 `:root` 兜底 + `colors_and_type.css`；「库存偏低」标记取既有语义/`--cc-*` 令牌，不新造 hex。
```
