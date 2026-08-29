# PRD: 库存管理（物件台账 + 学员领用 + Excel 导入导出）

> 生成日期：2026-08-29 ｜ 来源：用户需求 + 与「学员档案」模块对齐
> 目标：把首页第 4 张卡片「库存管理」（`placeholder.html?app=inventory`，主题色 `--cc-2` 鼠尾草绿）
> 从占位页做成完整模块。

---

## 1. Introduction / 概述

舞蹈教室日常要管一批「物件」——练功服、演出服、道具、教材等。目前没有任何记录手段：
剩多少全靠脑子记，谁领走了什么也无据可查。

本模块提供两本「账」：

- **物件台账**：有哪些物件、每种现在还剩多少（`inventory_items` 表）。
- **领用流水**：某个学员在某一天领走了某物件几件（`item_allocations` 表）。

核心动作「把物件分配给学员」= **同时往流水记一笔 + 把台账余量改小**，两步绑在一个数据库事务里，
不允许记了流水却没扣库存，也不允许把库存扣成负数。

本模块是本项目第二个带持久化的功能，**完全沿用「学员档案」已经趟通的架构流水线**
（`better-sqlite3` + `PRAGMA user_version` 迁移 + 按操作粒度的 IPC + 单页免打包渲染器 + `exceljs`），
读者可参考 [tasks/spec-student-records.md](./spec-student-records.md)。

---

## 2. Goals / 目标

- 管理者可添加、编辑物件，维护每种物件的当前库存数。
- 管理者可把某物件按数量分配给某学员，系统自动扣减对应库存，且库存永不为负。
- 每一次领用都留下「学员 + 物件名 + 领取日期 + 数量」的流水记录，可按日期 / 学员 / 物件筛选查看。
- 支持把「物件台账」和「领用流水」导出为 `.xlsx`；支持用 `.xlsx` 批量导入 / 补充物件台账。
- 低于预警阈值的物件在列表中被标记，库存页顶部显示低库存物件总数。
- 全程遵循设计系统（`colors_and_type.css` 令牌、Mobile First、`--accent` 每屏至多两处）。

---

## 3. User Stories

> 编号 US-001 起，每个故事可在一个专注的 agent 会话内独立完成。最后一个是强制 E2E 故事。
> 阶段顺序参考「学员档案」：先 DB 地基 → 域层+IPC → 渲染外壳+列表 → 详情/表单 → 分配 → 流水 → 导出 → 导入 → E2E。

### US-001: 数据库地基（迁移 v3 + 共享类型）
**Description:** 作为开发者，我需要新增库存相关的表结构与类型定义，让物件和领用记录能持久化。

**Acceptance Criteria:**
- [ ] `src/db/migrations.ts` 的 `MIGRATIONS` 数组末尾追加 `{ version: 3, up: v3 }`，不修改 v1/v2
- [ ] v3 建 `inventory_items` 表：`id` / `name`(NOT NULL) / `category`(TEXT，可空) / `unit`(NOT NULL DEFAULT '件') / `quantity`(INTEGER NOT NULL DEFAULT 0) / `low_stock_threshold`(INTEGER NOT NULL DEFAULT 0) / `note`(TEXT) / `created_at` / `updated_at` / `deleted_at`(可空)
- [ ] v3 建 `item_allocations` 表：`id` / `item_id`(NOT NULL，REFERENCES inventory_items(id)，不写 ON DELETE CASCADE) / `student_id`(NOT NULL，REFERENCES students(id)) / `quantity`(INTEGER NOT NULL DEFAULT 1) / `claimed_at`(TEXT NOT NULL，'YYYY-MM-DD') / `note`(TEXT) / `created_at`(TEXT NOT NULL)
- [ ] 建索引：`idx_items_name(name)`、`idx_items_category(category)`、`idx_items_deleted(deleted_at)`、`idx_alloc_item(item_id)`、`idx_alloc_student(student_id)`、`idx_alloc_date(claimed_at)`
- [ ] `src/shared/types.ts` 新增 `InventoryItem` / `InventoryItemInput` / `InventoryListQuery` / `InventoryListResult` / `Allocation` / `AllocationInput` / `AllocationListQuery` / `InventoryImportReport` 类型
- [ ] `IpcErrorCode` 联合类型新增 `INSUFFICIENT_STOCK`、`ITEM_NAME_CONFLICT`、`ITEM_IN_USE`
- [ ] `migrations.test.ts` 断言：空库连续 `run` 到 v3、表与索引齐全、重复 `run` 幂等、v3 `up` 中途抛错则回滚且 `user_version` 停在 2
- [ ] Typecheck / lint 通过

### US-002: 域层 + 读写 IPC
**Description:** 作为开发者，我需要物件与领用的仓库层、校验层，以及供渲染层调用的 IPC 频道。

**Acceptance Criteria:**
- [ ] 新增 `src/domain/inventory.repo.ts`：
  - `createItem(values)` / `updateItem(id, values)`（含直接写 `quantity`）/ `getItem(id)` / `softDeleteItem(id)`（仅写 `deleted_at`）
  - `listItems(query)`：`deleted_at IS NULL` 基础上按 `search`（`name` LIKE，`%`/`_`/`\` 转义 `ESCAPE '\'`）、`category`、`lowStockOnly`（`quantity <= low_stock_threshold`）组合筛选 + `limit`/`offset` 分页，返回 `{ rows, total, lowStockCount }`
  - `allocate(input)`：单个 `db.transaction` 内先 `UPDATE inventory_items SET quantity = quantity - @qty, updated_at=@now WHERE id=@itemId AND deleted_at IS NULL AND quantity >= @qty`，`changes !== 1` 抛 `AppError('INSUFFICIENT_STOCK')`；再 `INSERT` 一行 `item_allocations`
  - `listAllocations(query)`：按 `dateFrom`/`dateTo`（`claimed_at` 闭区间）、`studentId`、`itemId` 筛选，JOIN 出 `itemName` / `studentName` / `studentPhone`，按 `claimed_at DESC, id DESC` 排序 + 分页
  - `deleteAllocation(id)`：`db.transaction` 内删该行并 `UPDATE inventory_items SET quantity = quantity + @qty`（物件已软删也加回）
- [ ] 新增 `src/domain/inventory.validation.ts`：`validateItem(input)` / `validateAllocation(input, item)`，返回 `{ values, errors }`，规则见 §4
- [ ] `src/ipc/channels.ts` 新增 `inventory:*` 频道组常量（见 §7）
- [ ] `src/ipc/register.ts` 用现有 `handle(channel, fn)` 包裹器逐个注册，处理器永不 throw 过边界，统一返回 `IpcResult<T>`；`toIpcError` 映射新增的具名错误
- [ ] `src/preload.ts` 经 `contextBridge` 把 `window.studioShell` 扩展出 `inventory` 命名空间（新增字段，向后兼容）
- [ ] `studioShell.d.ts` 补 `inventory` 命名空间的环境类型
- [ ] 集成测试（直接调 `register.ts` 导出的处理器函数，对临时文件库）：建物件 → 分配 → `getItem` 库存已减 → 再分配到超库存返回 `INSUFFICIENT_STOCK` → 删领用记录 → 库存加回；`listAllocations` 按 `itemId` / 日期区间筛选命中正确
- [ ] Typecheck / lint 通过

### US-003: 渲染外壳 + 物件列表
**Description:** 作为管理者，我要打开「库存管理」看到所有物件、当前库存和低库存提醒。

**Acceptance Criteria:**
- [ ] 新增 `inventory.html`（复制 `students.html` 外壳：复用顶栏 + `<main id="view">` + `:root` 令牌兜底 + 链接 `colors_and_type.css`）
- [ ] 新增 `inventory.js`（ESM，`<script type="module">`，不引入打包器），hash 路由骨架：`#/items`、`#/items/new`、`#/items/:id`、`#/items/:id/edit`、`#/allocate`、`#/allocations`
- [ ] `#/items` 列表每行显示：物件名、分类、单位、当前库存、`quantity <= low_stock_threshold` 时显示「库存偏低」标记（用既有语义令牌，不新造 hex）
- [ ] 列表顶部显示汇总：「N 个物件库存偏低」（N 来自 `listItems` 返回的 `lowStockCount`；N=0 时该提示不出现）
- [ ] 列表支持按物件名搜索、按分类筛选；结果为空显示空状态文案
- [ ] 列表服务端分页（默认 `limit=100`），超出显示「加载更多」
- [ ] `index.html` 中 `app-card-inventory` 的 `href` 由 `placeholder.html?app=inventory` 改为 `inventory.html`
- [ ] `placeholder.html` 的 `APP_NAMES` 去掉 `inventory` 键
- [ ] `electron-builder.yml` 的 `files:` 白名单追加 `inventory.html`、`inventory.js`
- [ ] 现有指向占位页的相关 E2E 用例（若有 `inventory` 占位断言）同步更新
- [ ] Typecheck / lint 通过
- [ ] 在浏览器/应用中核对（可用 `run` skill）

### US-004: 物件新建 / 编辑 / 详情
**Description:** 作为管理者，我要添加新物件、修改物件信息、直接调整某物件的库存数。

**Acceptance Criteria:**
- [ ] `#/items/new` 表单字段：物件名（必填）、分类（自由文本）、单位（默认「件」）、库存数量（整数 ≥ 0）、预警阈值（整数 ≥ 0）、备注
- [ ] 保存调用 `inventory.create`；物件名与未删除物件重名 → 返回 `ITEM_NAME_CONFLICT`，输入框下红字「物件已存在」，不提交
- [ ] `#/items/:id` 详情显示物件全部字段 + 该物件的领用历史（调 `inventory.allocations({ itemId })`，按日期倒序，显示学员名 / 数量 / 领取日期）
- [ ] `#/items/:id/edit` 可修改上述所有字段，含**直接把库存数量改成任意非负整数**（不记录调整痕迹）
- [ ] 校验失败时字段下逐条显示 `error.fields` 里的提示，不提交
- [ ] 已软删除物件：`getItem` 仍可按 id 取到（用于历史与导出），但不出现在 `#/items` 列表和分配下拉
- [ ] Typecheck / lint 通过
- [ ] 在浏览器/应用中核对（可用 `run` skill）

### US-005: 把物件分配给学员（扣减库存）
**Description:** 作为管理者，我要把某物件按数量发给某学员，库存自动减少并留下流水。

**Acceptance Criteria:**
- [ ] `#/allocate` 表单：选物件（下拉，仅未软删且 `quantity > 0`，显示「名称（剩 N 件）」）、选学员（复用 `studioShell.students.list` 搜索选择）、领取数量（整数 ≥ 1）、领取日期（`YYYY-MM-DD`，默认今天）、备注（可空）
- [ ] 提交调用 `inventory.allocate`；成功后库存减少对应数量，`#/items` 与物件详情反映新库存，`#/allocations` 出现该记录
- [ ] 领取数量 > 当前库存 → 返回 `INSUFFICIENT_STOCK`，数量输入框下红字「库存不足，当前仅剩 N」，不写库、不扣减
- [ ] 领取日期格式非 `YYYY-MM-DD` 或非法历法日 → 字段红字，不提交
- [ ] 未选物件 / 未选学员 → 对应字段红字，不提交
- [ ] Typecheck / lint 通过
- [ ] 在浏览器/应用中核对（可用 `run` skill）

### US-006: 领用流水页
**Description:** 作为管理者，我要查看所有领用记录，能按条件筛选，并能删除错录的记录。

**Acceptance Criteria:**
- [ ] `#/allocations` 列表每行显示：物件名、学员姓名、学员电话、领取数量、领取日期、备注
- [ ] 支持按领取日期区间、学员、物件筛选；默认按领取日期倒序；服务端分页（默认 100/页）
- [ ] 结果为空显示空状态文案
- [ ] 每行可删除，删除前弹确认对话框（说明「将把 N 件加回库存」）；确认后调 `inventory.deleteAllocation`，该物件库存加回对应数量，列表移除该行
- [ ] 被删记录对应的物件已软删除时，删除仍成功且库存字段照常加回
- [ ] Typecheck / lint 通过
- [ ] 在浏览器/应用中核对（可用 `run` skill）

### US-007: 导出 Excel（物件台账 + 领用流水）
**Description:** 作为管理者，我要把物件台账或领用流水导出成 Excel。

**Acceptance Criteria:**
- [ ] 新增 `src/io/inventory-xlsx.ts`，用 `exceljs`，`workbook.xlsx.writeFile` 流式落盘
- [ ] `#/items` 页「导出台账」按钮：`dialog.showSaveDialog`（默认名 `物件台账-YYYYMMDD.xlsx`）→ 导出当前筛选匹配的全部物件（不分页），列：物件名、分类、单位、当前库存、预警阈值、备注
- [ ] `#/allocations` 页「导出流水」按钮：默认名 `领用流水-YYYYMMDD.xlsx` → 导出当前筛选匹配的全部记录，列：**物件名**、学员姓名、学员电话、领取数量、**领取日期**、备注
- [ ] 用户在系统对话框点取消 → 返回 `IO_CANCELLED`，静默无 toast
- [ ] 写文件失败（磁盘满 / 无权限）→ 返回 `IO_WRITE_FAILED`，toast「导出失败：<原因>」
- [ ] 集成测试：跑导出到临时路径，用 `exceljs` 读回，断言两种表的列顺序、表头文字、行数与数据正确
- [ ] Typecheck / lint 通过

### US-008: 导入物件台账 Excel（按物件名累加入库）
**Description:** 作为管理者，我要用 Excel 批量新建物件或给已有物件补库存。

**Acceptance Criteria:**
- [ ] `#/items` 页「导入台账」入口，沿用「学员档案」的三步：`downloadTemplate` → `pickImportFile`（读表头 + 前 3 行样本）→ 列映射 → `importItems`
- [ ] 模板表头：物件名、分类、单位、入库数量、预警阈值、备注；含一行示例
- [ ] 列映射向导：「物件名」和「入库数量」必须映射到某列，否则「开始导入」按钮禁用；后端二次校验缺列 → `BAD_REQUEST`
- [ ] 导入文件大小上限 10MB、数据行上限 5000，超限 → `IMPORT_TOO_LARGE`；`exceljs` 无法解析 / 无工作表 → `IMPORT_FILE_INVALID`
- [ ] 逐行处理（整批包一个事务只为性能）：
  - 物件名在未删除物件中**已存在** → 该物件 `quantity += 入库数量`，`updated_at` 刷新；若行内填了分类/单位/阈值/备注则一并更新，留空则不动
  - 物件名**不存在** → 新建物件，初始库存 = 入库数量
  - 行校验失败（物件名空、入库数量非非负整数等）→ 计入 `failures: [{ row, reason }]`，**不中断**其余行
- [ ] 返回 `InventoryImportReport { created, updated, failed, failures }`，向导展示计数与失败行号 + 原因
- [ ] 集成测试：喂一个含「1 新物件行 + 1 已存在物件补库存行 + 1 坏行」的 `.xlsx` fixture，断言 `{ created:1, updated:1, failed:1 }` 且坏行 `row` 正确、已存在物件库存为累加后的值
- [ ] Typecheck / lint 通过
- [ ] 在浏览器/应用中核对（可用 `run` skill）

### US-009: 端到端测试库存管理全流程
**Description:** 作为 QA，我要一套自动化 E2E 测试覆盖库存管理的完整旅程，防止跨栈回归。

**Acceptance Criteria:**
- [ ] 沿用 `home-flow.spec.ts` 的 `_electron.launch` 模式；`env.STUDIO_DB_PATH` 指向 `test-results/` 下每次运行唯一的临时 `.db`，`beforeEach` 删除
- [ ] Happy path：首页点「库存管理」→ `#/items` 空态 → 新建物件（名称 + 库存 10 + 阈值 3）→ 列表出现该物件、库存 10 → `#/allocate` 选该物件 + 选一个已有学员 + 数量 3 + 领取日期 → 保存 → `#/items` 该物件库存变 7 → `#/allocations` 出现该记录且物件名 / 领取日期 / 数量正确
- [ ] 边界 1（库存不足）：对上面物件再分配数量 100 → 出现「库存不足」红字，`#/items` 库存仍为 7（未扣减）
- [ ] 边界 2（低库存汇总）：把该物件再分配 5（库存变 2 ≤ 阈值 3）→ `#/items` 顶部出现「1 个物件库存偏低」、该行出现「库存偏低」标记
- [ ] 边界 3（删除领用记录加回库存）：在 `#/allocations` 删除那条数量 3 的记录 → 确认对话框出现 → 确认后 `#/items` 该物件库存 +3
- [ ] 导出：在 `#/allocations` 点「导出流水」写到临时路径，用 `exceljs` 读回断言含「物件名」「领取日期」两列且行数正确
- [ ] 全程 `pageErrors` 为空；测试自建自清数据
- [ ] 测试在 CI 中运行并通过

---

## 4. Functional Requirements

**数据与迁移**
- FR-1：系统必须在 `MIGRATIONS` 末尾追加 v3 迁移，新建 `inventory_items` 与 `item_allocations` 两表及其索引，不改动既有迁移。
- FR-2：`inventory_items.quantity` 必须为该物件当前在库数的权威值，列表、详情、分配下拉、预警均直接读取它。
- FR-3：两表均不使用 `ON DELETE CASCADE`；物件用软删除（`deleted_at`），领用记录随物件/学员软删除而保留。

**物件管理**
- FR-4：系统必须允许管理者新建物件，字段为物件名（必填）、分类（自由文本，可空）、单位（默认「件」）、库存数量、预警阈值、备注。
- FR-5：系统必须拒绝与未删除物件同名的新建 / 改名，返回 `ITEM_NAME_CONFLICT`。
- FR-6：系统必须允许管理者在编辑物件时直接把库存数量设为任意非负整数，且不产生调整审计记录。
- FR-7：系统必须支持软删除物件（仅写 `deleted_at`），软删后不出现在物件列表与分配下拉，但仍可被 `getItem` 与导出取到。
- FR-8：物件列表必须支持按物件名子串搜索、按分类精确筛选、按「仅看低库存」筛选，并服务端分页（默认每页 100）。
- FR-9：`quantity <= low_stock_threshold` 的物件在列表中必须显示「库存偏低」标记。
- FR-10：物件列表页顶部必须显示「N 个物件库存偏低」汇总，N=0 时不显示该提示。

**领用（分配扣减）**
- FR-11：系统必须允许管理者选择一个物件、一个学员、一个领取数量（整数 ≥ 1）、一个领取日期（`YYYY-MM-DD`，默认当天）、可选备注，提交一次领用。
- FR-12：提交领用时，系统必须在单个数据库事务内完成「扣减该物件库存」与「插入一行 `item_allocations`」，任一失败则整体不生效。
- FR-13：当领取数量大于该物件当前库存时，系统必须拒绝该次领用并返回 `INSUFFICIENT_STOCK`，不扣减、不写流水。
- FR-14：系统必须保证任何路径下 `inventory_items.quantity` 不会变为负数。
- FR-15：学员选择必须复用现有 `studioShell.students.list`，不新增学员查询频道。

**领用流水**
- FR-16：系统必须提供领用流水列表，每行显示物件名、学员姓名、学员电话、领取数量、领取日期、备注。
- FR-17：领用流水必须支持按领取日期区间、学员、物件筛选，默认按领取日期倒序，服务端分页。
- FR-18：系统必须允许删除单条领用记录；删除时必须在事务内把该记录数量加回对应物件库存（物件已软删亦然）。

**Excel 导出**
- FR-19：系统必须支持把「当前筛选匹配的全部物件」导出为 `.xlsx`，列为物件名、分类、单位、当前库存、预警阈值、备注。
- FR-20：系统必须支持把「当前筛选匹配的全部领用记录」导出为 `.xlsx`，列为物件名、学员姓名、学员电话、领取数量、领取日期、备注。
- FR-21：导出用户取消返回 `IO_CANCELLED`（静默）；写文件失败返回 `IO_WRITE_FAILED`。

**Excel 导入（仅物件台账）**
- FR-22：系统必须提供导入模板下载，表头为物件名、分类、单位、入库数量、预警阈值、备注，并附一行示例。
- FR-23：导入向导必须要求「物件名」与「入库数量」映射到某列，否则禁止开始导入；后端二次校验缺列返回 `BAD_REQUEST`。
- FR-24：导入时，物件名匹配到未删除物件则该物件库存累加「入库数量」（行内其他非空字段一并更新）；未匹配则按「入库数量」为初始库存新建物件。
- FR-25：导入逐行校验，失败行计入报告的 `failures`（含行号与原因）且不中断其余行；返回 `InventoryImportReport { created, updated, failed, failures }`。
- FR-26：导入文件大小上限 10MB、数据行上限 5000，超限返回 `IMPORT_TOO_LARGE`；无法解析返回 `IMPORT_FILE_INVALID`。

**校验规则**
- FR-27：物件名必须非空且 ≤ 40 字符。
- FR-28：`quantity`、`low_stock_threshold`、导入「入库数量」必须为 `Number.isInteger` 且 ≥ 0。
- FR-29：领取数量必须为整数且 ≥ 1。
- FR-30：`claimed_at` 必须匹配 `/^\d{4}-\d{2}-\d{2}$/` 且构造 `Date` 后回读一致（拦截如 `2026-02-30`）。
- FR-31：所有 SQL 必须走 better-sqlite3 预编译语句 + 命名参数，`LIKE` 搜索对 `%`/`_`/`\` 转义并 `ESCAPE '\'`。

**架构一致性**
- FR-32：所有主↔渲染通信必须是按操作粒度的 `ipcMain.handle` / `ipcRenderer.invoke`，处理器永不 throw 过边界，统一返回 `IpcResult<T>`。
- FR-33：`preload.ts` 只经 `contextBridge` 暴露 `studioShell.inventory` 具名方法，不暴露 `ipcRenderer` 本体 / `fs` / `path`；渲染进程保持 `contextIsolation: true`、`nodeIntegration: false`。
- FR-34：新增 `inventory.html` / `inventory.js` 必须加入 `electron-builder.yml` 的 `files:` 白名单。
- FR-35：所有界面必须使用 `colors_and_type.css` 令牌，禁止裸 hex；`--accent` 每屏至多出现两次；Mobile First 响应式。

---

## 5. Non-Goals（本版不做）

- **归还 / 退还流程**：不做「学员把物件还回来、标记该次领用已归还、库存加回」的独立工作流。错录只能通过「删除领用记录」修正（FR-18）。归还列入开放问题 / v2。
- **导入领用流水**：Excel 只支持导入物件台账，不支持批量导入历史领用记录。
- **库存调整审计**：手动改库存数量不留「原值→新值→原因」的痕迹（用户已确认）。
- **领取时间精确到时刻**：只到日期（`YYYY-MM-DD`），不记录时:分。
- **物件分类的受控管理**：分类是自由文本，不做可维护的分类字典、不做分类下拉。
- **多物件合并领用**：一条领用记录只对应一个物件；一次发多种物件需分多次提交。
- **单位换算 / 规格 / 批次 / 序列号 / 供应商 / 采购单价 / 成本核算**：均不在本版。
- **登录、角色与权限**：沿用现状，无登录、所有 IPC 对渲染进程开放。
- **首页仪表盘联动**：低库存数字是否上首页概况区，属「管理首页」模块范畴，不在本 PRD。
- **软删除物件的恢复入口**、**整库备份 / 恢复**：不在本版。
- **并发 / 多窗口写锁**：单进程 + better-sqlite3 同步 API，无竞态，不处理。

---

## 6. Design Considerations

- 入口卡片：[index.html](../index.html) `app-card-inventory`，主题色 `--cc-2`（鼠尾草绿），`href` 改指 `inventory.html`。
- 渲染外壳直接复制 `students.html`：复用顶栏、`<main id="view">` 容器、`:root` 令牌兜底、`colors_and_type.css` 链接。
- 「库存偏低」标记、状态类文字颜色取既有语义令牌 / `--cc-*`，不新造 hex（见 [DESIGN.md](../DESIGN.md)）。
- 列映射向导、`ImportReport` 展示、`dialog` 交互复用「学员档案」`io/import-xlsx.ts` 的既有形态与文案风格。
- Mobile First：列表在窄屏为卡片式堆叠、宽屏可为表格；表单单列优先；触控目标 ≥ 44px。

---

## 7. Technical Considerations

**沿用 [tasks/spec-student-records.md](./spec-student-records.md) 的既定决策**：同步 `better-sqlite3`、`PRAGMA user_version` 迁移、`exceljs` 主进程、`node:test` 单元 + Playwright E2E、时间戳用 ISO 字符串、日期字段用 `YYYY-MM-DD` 字符串。

**新增文件**

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/db/migrations.ts` | MODIFY | 追加 `v3`（两表 + 索引） |
| `src/shared/types.ts` | MODIFY | 新增库存相关类型 + 3 个错误码 |
| `src/domain/inventory.repo.ts` | NEW | 物件 CRUD、`listItems`、`allocate`、`listAllocations`、`deleteAllocation` |
| `src/domain/inventory.validation.ts` | NEW | `validateItem` / `validateAllocation` |
| `src/io/inventory-xlsx.ts` | NEW | 台账导出 / 流水导出 / 台账导入（模板、预览、逐行入库） |
| `src/ipc/channels.ts` | MODIFY | 追加 `inventory:*` 频道组 |
| `src/ipc/register.ts` | MODIFY | 注册库存处理器 + `toIpcError` 映射新错误 |
| `src/preload.ts` | MODIFY | `studioShell` 扩 `inventory` 命名空间 |
| `studioShell.d.ts` | MODIFY | `inventory` 环境类型 |
| `inventory.html` / `inventory.js` | NEW | 单页渲染器（外壳 + hash 路由） |
| `index.html` | MODIFY | inventory 卡片 `href` |
| `placeholder.html` | MODIFY | `APP_NAMES` 去 `inventory` |
| `electron-builder.yml` | MODIFY | `files:` 加 `inventory.html` / `inventory.js` |
| `tests/unit/inventory-validation.test.ts` 等 | NEW | 见 §9 学员档案对应测试布局 |
| `tests/e2e/inventory-flow.spec.ts` | NEW | US-009 |

**IPC 频道清单**（全部 `handle`/`invoke`，返回 `IpcResult<T>`）

| 频道 | 渲染层入口 | 入参 | 成功数据 |
|---|---|---|---|
| `inventory:listItems` | `studioShell.inventory.listItems(q)` | `InventoryListQuery` | `InventoryListResult`（含 `lowStockCount`） |
| `inventory:getItem` | `.inventory.getItem(id)` | `number` | `InventoryItem`（未找到 → `NOT_FOUND`） |
| `inventory:createItem` | `.inventory.createItem(p)` | `InventoryItemInput` | `{ id }` |
| `inventory:updateItem` | `.inventory.updateItem(id,p)` | `(number, InventoryItemInput)` | `{ id }` |
| `inventory:deleteItem` | `.inventory.deleteItem(id)` | `number` | `{ id }`（有引用时仅软删，恒成功） |
| `inventory:allocate` | `.inventory.allocate(p)` | `AllocationInput` | `{ id, remaining }`（库存不足 → `INSUFFICIENT_STOCK`） |
| `inventory:listAllocations` | `.inventory.allocations(q)` | `AllocationListQuery` | `{ rows, total }` |
| `inventory:deleteAllocation` | `.inventory.deleteAllocation(id)` | `number` | `{ id, itemId, remaining }` |
| `inventory:exportItems` | `.inventory.exportItems(q)` | `InventoryListQuery` | `{ filePath, count }` |
| `inventory:exportAllocations` | `.inventory.exportAllocations(q)` | `AllocationListQuery` | `{ filePath, count }` |
| `inventory:downloadTemplate` | `.inventory.downloadTemplate()` | — | `{ filePath }` |
| `inventory:pickImportFile` | `.inventory.pickImportFile()` | — | `{ filePath, headers, sample }` |
| `inventory:importItems` | `.inventory.importItems(a)` | `{ filePath, mapping }` | `InventoryImportReport` |

**扣减库存核心 SQL**（US-002）

```sql
UPDATE inventory_items
   SET quantity = quantity - @qty, updated_at = @now
 WHERE id = @itemId AND deleted_at IS NULL AND quantity >= @qty;
-- changes !== 1  → 抛 AppError('INSUFFICIENT_STOCK')
```

**性能**：单机单用户，物件数百、领用流水数千 ~ 上万。`listItems` / `listAllocations` 服务端筛选 + 分页；导出流式 `writeFile`；索引覆盖搜索、分类、日期、外键。

---

## 8. Success Metrics

- 新建一个物件 ≤ 3 次点击可完成保存。
- 一次「分配给学员」在一屏内完成（选物件 / 选学员 / 数量 / 日期 / 提交），无跳页。
- 分配后物件列表库存数即时正确（= 原库存 − 领取数量），无需手动刷新。
- 导出的领用流水 `.xlsx` 100% 包含「物件名」「领取日期」两列，行数 = 筛选匹配数。
- 1000 条物件 + 5000 条领用记录下，`listItems` / `listAllocations` P95 < 200ms。
- 全部单元 / 集成 / E2E 测试在 CI 通过；无裸 hex 静态检查通过。

---

## 9. Open Questions

- **归还 / 退还**（v2 候选）：是否需要一个独立的「归还」动作——记录归还日期、归还数量、把该次领用标记为部分/全部已归还，而非只能整条删除？
- **领用记录可编辑性**：本版领用记录只能「删」不能「改」（改 = 删了重录）。是否够用？
- **导入领用流水**（v2 候选）：将来是否要支持从 Excel 批量导入历史领用记录（按物件名 + 学员姓名/电话匹配、校验库存后扣减）？
- **首页概况**：低库存物件数是否要显示在管理首页的「今日概况」区？（归「管理首页」模块排期）
- **物件分类**：自由文本用一段时间后，是否需要收敛为可维护的分类字典 + 下拉？
- **软删除物件的恢复**：是否需要一个「已删除物件」视图与恢复入口？
```
