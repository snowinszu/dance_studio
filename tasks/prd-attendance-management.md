# PRD: 考勤管理（打卡流水 + 课时账本 + 批量点名 + Excel 导入导出）

> 生成日期：2026-08-30 ｜ 来源：用户需求 + 与「学员档案 / 库存管理」两个已上线模块对齐
> 目标：把首页第 3 张卡片「考勤管理」（`placeholder.html?app=attendance`，主题色 `--cc-1` 活力珊瑚）
> 从占位页做成完整模块。

---

## 1. Introduction / 概述

舞蹈教室每天要「点名」——谁来上课了、谁请假、谁没来。来上课要从会员卡里扣一节课时，
现在全靠老师脑子记和纸质名单，扣错、漏扣、查不到历史。

打个比方：`students.remaining_lessons`（学员表上的剩余课时）是**存折上印的余额数字**，
本模块新增的 `attendance_records` 表是**每一笔交易的流水**。核心动作「打一次卡」=
**同时往流水记一笔 + 把存折余额改一下**，两步绑死在一个数据库事务里；只改余额不记流水
（查不到账）或只记流水不改余额（对不上账）都不允许。

本模块是本项目第三个带持久化的功能，**完全沿用前两个模块趟通的架构流水线**
（`better-sqlite3` + `PRAGMA user_version` 迁移 + 按操作粒度的 IPC + 单页免打包渲染器 + `exceljs`），
读者可参考 [tasks/spec-inventory-management.md](./spec-inventory-management.md) 与
[tasks/spec-student-records.md](./spec-student-records.md)。库存模块的「台账 + 领用流水」双账本
结构，就是本模块「余额缓存 + 考勤流水」的直接蓝本。

### 关键规则（本期已定）

- **只有「出勤」扣课时**，默认扣 1，私教课可单条改成 2（任意 ≤ 0 整数）。
  请假、缺勤、补课、试听都**不动余额**（`lessons_delta = 0`）。
- **不建课程表 / 排课表**。批量点名的花名册来自「按舞种 + 关键字从学员库筛选」，
  课程名、老师、上课时间都是自由文本。流水表保留可空 `session_id`，等「课程安排」模块上线再回填关联。
- **打错了两种改法**：撤销（软删该条 + 反向回补余额）或更正（改字段，按新旧 delta 差额重算余额）。
- **课时增加**这一期只做「手动调整课时」（+/- 任意非零整数 + 必填原因），不做购课/金额记录。

---

## 2. Goals / 目标

- 老师/前台可用「批量点名」为一节课的多名学员一次性录入考勤，也可用「快速打卡」为单个学员即时打卡。
- 每录入一条「出勤」，对应学员 `remaining_lessons` 精确 -1（私教 -2）；请假/缺勤/补课/试听不影响余额。
- 每一条考勤都留下「学员 + 日期 + 课程 + 老师 + 类型 + 课时增减 + 经办人」的流水，可按日期区间 / 学员 / 类型筛选查看。
- 打错的记录可撤销（余额精确回补、幂等）或更正（按差额重算余额）。
- 可对单个学员手动增减课时，每次留一条带原因的流水。
- 打卡时对「余额 ≤ 0 / 会员卡已过期 / 重复打卡 / 低余额临期」给出明确提示，其中余额不足默认拦截但可强制。
- 支持把考勤导出为 `.xlsx`（「考勤明细」+「按月汇总」两个工作表）；支持用 `.xlsx` 批量补录历史考勤。
- 全程遵循设计系统（`colors_and_type.css` 令牌、Mobile First、`--accent` 每屏至多两处）。

---

## 3. User Stories

> 编号 US-001 起，每个故事可在一个专注的 agent 会话内独立完成。最后一个是强制 E2E 故事。
> 阶段顺序参考前两个模块：DB 地基 → 域层+IPC → 渲染外壳+列表+首页接线 → 快速打卡 → 批量点名 →
> 更正/撤销 → 手动调整 → 导出 → 导入 → E2E。

### US-001: 数据库地基（迁移 v5 + 共享类型）
**Description:** 作为开发者，我需要新增考勤流水表与类型定义，让打卡记录能持久化。

**Acceptance Criteria:**
- [ ] `src/db/migrations.ts` 的 `MIGRATIONS` 数组末尾追加 `{ version: 5, up: v5 }`，不修改 v1/v2/v4
- [ ] v5 建 `attendance_records` 表，列：`id`(PK AUTOINCREMENT) / `student_id`(INTEGER NOT NULL，REFERENCES students(id)，**不写** ON DELETE CASCADE) / `session_id`(INTEGER，可空，预留关联课程安排，本期恒为 NULL) / `class_name`(TEXT，可空) / `teacher`(TEXT，可空) / `attend_date`(TEXT NOT NULL，`'YYYY-MM-DD'`) / `attend_time`(TEXT，可空，`'HH:MM'`) / `type`(TEXT NOT NULL) / `lessons_delta`(INTEGER NOT NULL DEFAULT 0) / `reason`(TEXT，可空) / `operator`(TEXT，可空) / `note`(TEXT，可空) / `created_at`(TEXT NOT NULL) / `updated_at`(TEXT NOT NULL) / `deleted_at`(TEXT，可空，非空即已撤销)
- [ ] v5 的 DDL 全部 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`（沿用 v4 的抗重复触发写法）
- [ ] 建索引：`idx_att_student(student_id)`、`idx_att_date(attend_date)`、`idx_att_type(type)`、`idx_att_deleted(deleted_at)`
- [ ] 不加 `CHECK(lessons_delta ...)`：正负零都合法，非负约束由域层守卫保证（与 `inventory_items.quantity` 同理）
- [ ] `src/shared/types.ts` 新增：`AttendanceType`(`'出勤'|'请假'|'缺勤'|'补课'|'试听'|'调整'`)、`AttendanceRecord`、`AttendanceListItem`、`AttendanceListQuery`、`AttendanceListResult`、`QuickCheckInInput`、`RosterCandidate`、`BatchCheckInEntry`、`BatchCheckInInput`、`BatchCheckInResult`、`AttendanceCorrectionInput`、`LessonAdjustmentInput`、`MonthlySummaryQuery`、`MonthlySummaryRow`、`AttendanceImportReport`
- [ ] `IpcErrorCode` 联合类型新增 `INSUFFICIENT_LESSONS`、`ATTENDANCE_NOT_FOUND`、`DUPLICATE_ATTENDANCE`、`INVALID_ADJUSTMENT`
- [ ] `tests/unit/migrations.test.ts` 断言：空库连续 `run` 到 v5、表与 4 个索引齐全、重复 `run` 幂等、v5 `up` 中途抛错则回滚且 `user_version` 停在上一版
- [ ] Typecheck / lint 通过

### US-002: 域层 + 读写 IPC
**Description:** 作为开发者，我需要考勤仓库层、校验层，以及供渲染层调用的 IPC，把「记一条考勤 = 插流水 + 按 delta 改学员余额」封装成一个事务化操作。

**Acceptance Criteria:**
- [ ] 新增 `src/domain/attendance.repo.ts` + `attendance.validation.ts`；repo 抛 `AppError(code,msg,fields?)`，绝不 import IPC/dialog
- [ ] `createRecord(input)`：同一 `db.transaction` 内 ① 插入 `attendance_records` 一行 ② `UPDATE students SET remaining_lessons = COALESCE(remaining_lessons,0) + :lessonsDelta, updated_at = :now WHERE id = :studentId`
- [ ] 默认 `lessons_delta` 规则：`出勤` → -1；`请假`/`缺勤`/`补课`/`试听` → 0；`调整` → 调用方传入的整数（为 0 或非整数抛 `INVALID_ADJUSTMENT`）。调用方可覆盖非「调整」类型的 delta，但覆盖值必须为 ≤ 0 的整数
- [ ] 余额守卫：净 `lessonsDelta < 0` 且 `COALESCE(remaining_lessons,0) + lessonsDelta < 0` 时抛 `INSUFFICIENT_LESSONS`；入参 `force: true` 放行，允许 `remaining_lessons` 变负
- [ ] 重复检测：存在同 `student_id` + `attend_date` + `COALESCE(class_name,'')` + `type` 的未撤销行时抛 `DUPLICATE_ATTENDANCE`；入参 `allowDuplicate: true` 放行
- [ ] `listRecords(query)`：支持按日期区间 / 学员关键字（姓名或 `phone_primary`）/ 类型筛选，按 `attend_date DESC, id DESC` 分页；每行 JOIN `students` 带出学员姓名与手机号（含已软删学员）；`deleted_at` 非空的行默认排除
- [ ] `listRosterCandidates({ danceType?, keyword? })`：返回未软删学员的 `id / name / phone_primary / remaining_lessons / card_expire_date / status`；`danceType` 对 `students.dance_types`(JSON 数组字符串) 做包含匹配，`keyword` 匹配姓名或手机号
- [ ] `src/ipc/channels.ts` 按 `域:动作` 风格新增 `attendanceList` / `attendanceQuickCheckIn` / `attendanceBatchCheckIn` / `attendanceRosterCandidates`；`src/ipc/register.ts` 经 `handle()` 包装注册，handler 跨边界不抛错，返回 `IpcResult<T>`
- [ ] `src/preload.ts` 重声明频道字面量并暴露 `window.studioShell.attendance.*`；`studioShell.d.ts` 补类型
- [ ] `tests/unit/attendance.repo.test.ts`：出勤扣 1、私教出勤扣 2、请假/缺勤不动余额、余额不足抛 `INSUFFICIENT_LESSONS`、`force` 放行且余额记负、重复检测抛 `DUPLICATE_ATTENDANCE`、`allowDuplicate` 放行、筛选与分页正确
- [ ] Typecheck / lint 通过

### US-003: 渲染外壳 + 考勤流水列表 + 首页接线
**Description:** 作为管理员，我打开「考勤管理」时看到一个和其它模块视觉一致的页面，默认展示可筛选的考勤流水。

**Acceptance Criteria:**
- [ ] 首页 `index.html`「考勤管理」卡片 `href` 由 `placeholder.html?app=attendance` 改为 `attendance.html`
- [ ] 新增 `attendance.html`（复制 `students.html` 外壳：`:root` 令牌回退 + `<head>` 引入 `colors_and_type.css`）与 `attendance.js`（手写 ES module，`#/hash` 路由、`el()` DOM 助手、`unwrap()` 解 `IpcResult`、`#toast`）
- [ ] `attendance.html` 与 `attendance.js` 加入 `electron-builder.yml` 的 `files`
- [ ] 默认视图渲染流水表格列：日期、时间、学员（姓名 + 手机号）、课程、老师、类型、课时增减、经办人、备注；无数据时显示空态文案
- [ ] 顶部筛选：日期区间、学员关键字、类型下拉；筛选即时生效，结果处显示「共 N 条」
- [ ] 提供分页或「加载更多」；已撤销记录默认不显示
- [ ] 页面主题色 `--cc-1`；样式无裸 hex，全部 `var(--token-name)`；`--accent` 每屏出现 ≤ 2 次；悬停行文字对比度不下降
- [ ] Typecheck / lint 通过
- [ ] 在 Electron 窗口中人工核对视觉与其它模块一致（可借助 `run` skill）

### US-004: 快速打卡（单个学员）
**Description:** 作为前台，我想搜一个学员名字就给他打一次卡。

**Acceptance Criteria:**
- [ ] 「快速打卡」入口：输入框按姓名或手机号实时搜索，候选列表显示姓名、手机号、剩余课时、卡到期日
- [ ] 选中学员后可填：日期（默认今天）、时间（可空）、课程名（自由文本，可空）、老师（可空）、类型（默认「出勤」）、课时增减（默认按类型规则，「出勤」显示 -1 且可手动改为 -2）、经办人、备注
- [ ] 提交调用 `attendance:quickCheckIn`；成功后 `#toast` 提示，流水列表顶部出现新行，所选学员剩余课时即时刷新
- [ ] 余额不足或重复打卡时弹确认对话框，写明原因，提供「仍然记录」（分别对应 `force` / `allowDuplicate`）与「取消」；取消则不产生任何记录
- [ ] 所选学员卡已过期，或（打卡后）剩余课时 ≤ 3 时，确认区显示 `--cc-1` 暖红提示文案（如「剩 2 节，请提醒续费」），不阻断提交
- [ ] Typecheck / lint 通过
- [ ] 在 Electron 窗口中人工核对（可借助 `run` skill）

### US-005: 批量点名（一节课的花名册）
**Description:** 作为老师，我上课前想对着这节课的名单，逐个勾「到 / 请假 / 缺勤」，一次提交。

**Acceptance Criteria:**
- [ ] 「批量点名」视图：先填这节课公共信息——日期（默认今天）、时间、课程名、老师、经办人
- [ ] 花名册筛选：舞种下拉 + 姓名/手机号关键字，调用 `attendance:rosterCandidates` 拉候选；结果为可勾选列表，每行显示姓名、手机号、剩余课时、卡到期
- [ ] 每个勾选的学员一组状态选择（出勤 / 请假 / 缺勤 / 补课 / 试听），默认「出勤」；提供「全部设为出勤」快捷操作
- [ ] 「出勤」行可把课时数改为 2（私教）；非「出勤」行课时数固定为 0 且不可编辑
- [ ] 「提交点名」调用 `attendance:batchCheckIn`：逐条按与快速打卡相同的规则写入；单条失败（余额不足未强制 / 重复未允许 / 学员不存在）**不回滚**其它条目
- [ ] 提交后展示结果小结：成功 N 条、跳过 M 条（逐条列出学员与原因）；成功条目对应学员剩余课时即时刷新
- [ ] 窄窗口下花名册单列排布，状态按钮组可点区域 ≥ 44px
- [ ] Typecheck / lint 通过
- [ ] 在 Electron 窗口中人工核对（可借助 `run` skill）

### US-006: 更正与撤销
**Description:** 作为管理员，打卡打错了，我要么撤销要么改，且学员课时要跟着精确回滚。

**Acceptance Criteria:**
- [ ] 流水列表每行有「更正」「撤销」两个操作
- [ ] 撤销：确认后调用 `attendance:void`，该行 `deleted_at` 置当前时间，同一事务内学员 `remaining_lessons` **反向回补**原 `lessons_delta`；重复撤销幂等、不二次回补；已撤销行从默认列表与导出中消失
- [ ] 更正：打开表单预填当前值，可改日期、时间、课程、老师、类型、课时增减、经办人、备注；提交调用 `attendance:correct`，同一事务内按「新 `lessons_delta` − 旧 `lessons_delta`」调整学员余额
- [ ] 更正若使余额变负，同样受 `INSUFFICIENT_LESSONS` 守卫，确认框提供「仍然保存」（`force`）
- [ ] `tests/unit`：撤销回补正确且幂等；更正 delta 由 -1 改 -2 时余额再 -1；由 -1 改 0（改判为请假）时余额 +1；更正已撤销记录返回 `ATTENDANCE_NOT_FOUND`
- [ ] Typecheck / lint 通过
- [ ] 在 Electron 窗口中人工核对（可借助 `run` skill）

### US-007: 手动调整课时
**Description:** 作为管理员，我要能给某个学员直接加/减课时（如补偿、纠错、赠送），并留下原因。

**Acceptance Criteria:**
- [ ] 「调整课时」入口：选学员、填增减数（正数加 / 负数减，必须为非零整数）、原因（必填）、经办人、备注、日期（默认今天）
- [ ] 提交写入一条 `type = '调整'` 的 `attendance_records`，`lessons_delta` = 输入值，同一事务改学员 `remaining_lessons`
- [ ] 增减数为 0 或非整数时返回 `INVALID_ADJUSTMENT`；负数调整会使余额 < 0 时受 `INSUFFICIENT_LESSONS` 守卫（可 `force`）；正数调整无上限
- [ ] 该记录在流水列表以「调整」类型显示，`reason` 在备注列可见
- [ ] `tests/unit`：+10 使余额 +10；delta = 0 抛 `INVALID_ADJUSTMENT`；-5 且余额为 3 时抛 `INSUFFICIENT_LESSONS`，`force` 后余额为 -2
- [ ] Typecheck / lint 通过
- [ ] 在 Electron 窗口中人工核对（可借助 `run` skill）

### US-008: Excel 导出（考勤明细 + 按月汇总）
**Description:** 作为管理员，我要把某段时间的考勤导成 Excel，既有逐条明细，也有每人每月的汇总。

**Acceptance Criteria:**
- [ ] 「导出」按钮调用 `attendance:export`，经 `pickSavePath` 选路径，文件名含 `ymdCompact` 日期
- [ ] 导出遵循当前列表筛选条件（日期区间 / 学员关键字 / 类型）
- [ ] 工作簿含两个 sheet：`考勤明细`（学员姓名、手机号、日期、时间、课程、老师、类型、课时增减、经办人、备注，逐条）与 `按月汇总`（学员姓名、手机号、月份 `YYYY-MM`、出勤次数、请假次数、缺勤次数、补课次数、试听次数、当月消耗课时合计、当前剩余课时）
- [ ] 汇总按 `substr(attend_date,1,7)` 分组；已撤销记录不计入；「当月消耗课时合计」= 该月 `lessons_delta < 0` 的绝对值之和
- [ ] 无数据时导出仍生成两个带表头的空 sheet，不报错
- [ ] `tests/unit`：给定 3 条跨两个月、含 1 条已撤销的记录，汇总行数与各类型计数、消耗合计均正确
- [ ] Typecheck / lint 通过
- [ ] 在 Electron 窗口中人工核对（可借助 `run` skill）

### US-009: Excel 导入（历史考勤补录）
**Description:** 作为管理员，我有一批历史点名记录在 Excel 里，要一次导进系统并同步扣课时。

**Acceptance Criteria:**
- [ ] 「下载模板」`attendance:downloadTemplate` 生成含表头 + 一行示例的 `.xlsx`：`学员姓名*`、`手机号*`、`日期*`、`时间`、`课程`、`老师`、`类型*`、`课时增减`、`经办人`、`备注`
- [ ] 「选择文件」`attendance:pickImportFile` + 「导入」`attendance:import`，经 `openFirstSheet` / `headerTexts` / `rowTexts` 解析；文件超过 `MAX_IMPORT_BYTES` 或行数超过 `MAX_IMPORT_ROWS` 直接报错
- [ ] 学员匹配：按「姓名 + 手机号」精确匹配未软删学员；0 条匹配 → 该行失败「学员不存在」；多条匹配 → 该行失败「匹配到多个学员」
- [ ] 校验：`日期` 须为合法 `YYYY-MM-DD`；`类型` 须在枚举内；`课时增减` 留空时按类型默认（出勤 -1、其它 0、`调整` 留空 → 失败「调整必须填写非零课时」），填了须为整数
- [ ] 每一有效行走与快速打卡相同的域层 `createRecord` 路径（插流水 + 改余额）；导入场景默认 `force = true`（补录历史允许余额记负），报告中提示「X 行导致余额为负」
- [ ] 去重：与已存在未撤销行同（学员 + 日期 + 课程 + 类型）→ 跳过并记「疑似重复」
- [ ] 返回 `AttendanceImportReport`：成功 N、跳过 M（重复）、失败 K（逐行行号 + 原因）；页面用 `#toast` + 明细区展示
- [ ] `tests/unit`：混合文件（正常行、重复行、学员不存在、非法类型、调整留空）各归类正确，且成功行确实改动了对应学员余额
- [ ] Typecheck / lint 通过
- [ ] 在 Electron 窗口中人工核对（可借助 `run` skill）

### US-010: 考勤全流程端到端测试
**Description:** 作为 QA 工程师，我需要一个覆盖「首页 → 打卡 → 扣课时 → 撤销回补 → 导出」完整链路的自动化 E2E 测试，以便跨整个栈捕获回归。

**Acceptance Criteria:**
- [ ] Playwright `_electron` 启动应用（`env.STUDIO_DB_PATH` 指向临时库），预置一名 `remaining_lessons = 2` 的学员
- [ ] Happy path：从首页进入考勤管理 → 用快速打卡给该学员记「出勤」→ 断言流水列表新增一行、该学员剩余课时变为 1
- [ ] 批量点名：筛选花名册，给该学员选「缺勤」并提交 → 断言新增一行且剩余课时仍为 1（缺勤不扣）
- [ ] 撤销：撤销那条「出勤」记录 → 断言该学员剩余课时回到 2
- [ ] 边界/失败路径：对 `remaining_lessons = 0` 的学员快速打卡「出勤」→ 断言出现余额不足确认框；点「取消」后无新记录、余额不变
- [ ] 导出：触发导出到临时路径 → 断言文件存在且含「考勤明细」与「按月汇总」两个 sheet
- [ ] 全程 `page` 无 `pageErrors`；测试自建、自清数据，独立可重复，在 CI 中通过

---

## 4. Functional Requirements / 功能需求

- FR-1: 系统必须新增迁移 v5，建 `attendance_records` 流水表，并保留 `students.remaining_lessons` 作为权威余额缓存
- FR-2: 系统必须把「记一条考勤」实现为单个数据库事务：插入一行流水，并按 `lessons_delta` 更新对应学员的 `remaining_lessons`
- FR-3: 「出勤」类型的默认 `lessons_delta` 必须为 -1，且系统必须允许调用方将其改为其它 ≤ 0 的整数
- FR-4: 「请假」「缺勤」「补课」「试听」类型的默认 `lessons_delta` 必须为 0
- FR-5: 当一条消耗记录会使学员余额低于 0 时，系统必须默认拒绝并返回 `INSUFFICIENT_LESSONS`
- FR-6: 当调用方显式传入强制标记时，系统必须允许学员余额记为负数
- FR-7: 当已存在同一学员、同一日期、同一课程名、同一类型的未撤销记录时，系统必须默认拒绝并返回 `DUPLICATE_ATTENDANCE`，调用方显式允许时放行
- FR-8: 系统必须提供快速打卡：按姓名或手机号搜索单个学员并为其录入一条考勤
- FR-9: 系统必须提供批量点名：按舞种与关键字从学员库筛出花名册，为多名学员一次性录入同一节课的考勤
- FR-10: 批量点名中单条失败不得回滚其它条目，系统必须逐条返回成功或跳过原因
- FR-11: 花名册候选、课程名、老师、上课时间必须来自学员库筛选与自由文本输入，系统不得依赖尚未实现的课程安排模块；流水表必须保留可空 `session_id` 供将来关联
- FR-12: 系统必须支持撤销一条考勤：将其标记为已撤销并反向回补该学员余额，重复撤销保持幂等
- FR-13: 系统必须支持更正一条考勤：按新旧 `lessons_delta` 差额调整学员余额
- FR-14: 系统必须提供「手动调整课时」：写入一条 `type='调整'` 记录，`lessons_delta` 为用户输入的非零整数，为 0 或非整数时返回 `INVALID_ADJUSTMENT`
- FR-15: 系统必须能把考勤记录导出为 `.xlsx`，包含「考勤明细」与「按月汇总」两个工作表，且遵循当前列表筛选条件
- FR-16: 「按月汇总」必须按月份分组，给出每名学员的出勤、请假、缺勤、补课、试听次数与当月消耗课时合计
- FR-17: 系统必须提供考勤导入模板下载
- FR-18: 系统必须支持从 `.xlsx` 导入历史考勤，按「姓名 + 手机号」精确匹配学员，匹配 0 条或多条的行判为失败
- FR-19: 每一条有效导入行必须走与单条打卡相同的域层写入路径（插流水 + 改余额）
- FR-20: 导入必须跳过与已存在未撤销记录重复（学员 + 日期 + 课程 + 类型）的行，并在报告中标记
- FR-21: 导入必须返回成功、跳过、失败三类计数，失败项附行号与原因
- FR-22: 导入必须校验文件大小与行数不超过 `xlsx-util.ts` 的 `MAX_IMPORT_BYTES` / `MAX_IMPORT_ROWS`
- FR-23: 快速打卡与批量点名在学员卡已过期或剩余课时 ≤ 3 时必须显示 `--cc-1` 暖红预警文案，且不得阻断提交
- FR-24: 首页「考勤管理」卡片必须指向 `attendance.html`，模块主题色为 `--cc-1`
- FR-25: 已撤销的考勤记录默认不得出现在列表与导出中
- FR-26: 所有考勤 IPC 必须返回 `IpcResult<T>`，handler 不得跨进程边界抛错

---

## 5. Non-Goals / 非目标（明确不做）

- 不建「课程 / 排课」表，不做真正的课程安排；花名册来自学员库筛选 + 自由文本课程名
- 不做请假审批流：请假只是一条考勤记录，没有「待批 / 已批 / 驳回」状态机
- 不做购课 / 续费 / 金额记录；课时增加仅限「手动调整课时」（US-007）。`type` 枚举不预留 `购课`/`赠送`，将来需要再走新迁移
- 不做二维码 / 人脸 / 刷卡等设备打卡，全部人工录入
- 不做出勤率图表与趋势分析（留给「数据报表」模块；本模块只产出可被聚合的流水与「按月汇总」导出）
- 不做多角色 / 登录 / 权限；「经办人」是自由文本，无账号体系
- 不做消息推送 / 自动续费提醒；预警只在打卡界面内提示
- 不做期初 / 期末课时快照；「按月汇总」只给当月消耗合计与当前实时剩余课时
- 不修改 `colors_and_type.css` 令牌与 `DESIGN.md`
- 不做定时任务 / 后台作业 / Electron 菜单栏

---

## 6. Design Considerations / 设计考量

- 首页第 3 张卡片「考勤管理」`placeholder.html?app=attendance` → `attendance.html`，模块标识色 `--cc-1`（活力珊瑚）
- **注意**：`--cc-1` 同时是全局「预警暖红」色（见 `DESIGN.md` 与项目架构约定）。本模块用它既作模块标识色、又作低余额 / 临期预警色，视觉自洽、不冲突；预警色不计入 `--accent` 每屏 ≤ 2 次的预算
- 复制 `students.html` 外壳（`:root` 令牌回退 + `colors_and_type.css`）；沿用 `#/hash` 路由、`el()`、`unwrap()`、`#toast`
- 三个主要视图用 hash 路由分开：`#/records`（流水列表，默认）、`#/quick`（快速打卡）、`#/roster`（批量点名）
- 状态选择、确认对话框复用库存模块「分配」交互的既有样式
- Mobile First：窄窗口下花名册与筛选区单列堆叠，状态按钮组、行操作按钮可点区 ≥ 44px，无横向滚动
- 新增 `attendance.html` / `attendance.js` 必须加入 `electron-builder.yml` 的 `files`

---

## 7. Technical Considerations / 技术考量

- **迁移认领 v5**：v3 = 学员 `class_name` 字段分支、v4 = 库存。DDL 全部 `IF NOT EXISTS`，依赖启动期的重复版本号守卫；合并顺序建议 v3 → v4 → v5 依次落 main
- `students.remaining_lessons` 当前可空：所有余额读写统一 `COALESCE(remaining_lessons, 0)`；首次强制写入会把它落成真实整数
- 日期一律 `'YYYY-MM-DD'` 字符串，字典序即时间序（与 `item_allocations.claimed_at` 一致）；按月汇总用 `substr(attend_date,1,7)`
- 与「课程安排」解耦：`session_id` 本期恒为 NULL，仅占位；将来该模块上线后另起迁移补外键或关联逻辑
- 域层 repo 抛 `AppError(code,msg,fields?)`，不碰 IPC / dialog；IPC 层 `handle()` 包装，跨边界不抛错，统一返回 `IpcResult<T> = {ok:true,data} | {ok:false,error:{code,message,fields?}}`
- `exceljs` 相关一律走 `src/io/xlsx-util.ts` 共享助手（`openFirstSheet` / `headerTexts` / `rowTexts` / `pickSavePath` / `pickOpenPath` / `ymdCompact` / `MAX_IMPORT_BYTES` / `MAX_IMPORT_ROWS`）
- 单元测试 `node:test` 于 `tests/unit/*.test.ts`（经 `tsconfig.test.json` 编到 `dist-test/`，由 `scripts/test-unit.js` 用 Electron 的 Node 跑）；E2E 用 Playwright `_electron` + `env.STUDIO_DB_PATH` 临时库
- 交付方式（沿用库存模块约定）：分支 `feat/attendance-management`，一个 issue 一个 commit（中文 commit body 列出各层改动），全部完成后开**一个** PR，PR body 以 `Closes #a, closes #b, …` 结尾

---

## 8. Success Metrics / 成功指标

- 老师用「批量点名」给一节 15 人的课点名并提交 ≤ 30 秒
- 提交一条「出勤」后，对应学员 `remaining_lessons` 立即 -1（私教 -2），流水列表、学员档案两处读数一致
- 撤销一条出勤后，学员课时精确回补，无漂移；重复点撤销不再变化
- 导出的「按月汇总」行数 = 当月有未撤销记录的学员数，各类型计数与「考勤明细」逐条统计完全一致
- `npm run typecheck && npm run lint && npm run test:unit` 全绿；`npm test`（含 E2E）在 CI 稳定通过
- 全程零 console 报错；每屏 `--accent` 出现 ≤ 2 次，无裸 hex

---

## 9. Open Questions / 待确认问题

- 「按月汇总」是否需要一并给出"缺勤率"列（缺勤 /（出勤 + 缺勤））？当前定为不做，留给数据报表模块
- 快速打卡 / 批量点名的"经办人"是否要做成可记忆的下拉（记住最近几次输入），还是纯文本框？当前定为纯文本框
- 舞种筛选的选项来源：从 `students.dance_types` 现有值去重动态生成，还是沿用学员模块的既有舞种字典？倾向前者，实现时确认
