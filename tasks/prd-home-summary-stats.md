# PRD: 首页概况卡接入真实数据

## Introduction / Overview

管理平台首页（`index.html`）顶部有一条「今日概况」卡片带（`.stats-bar`），目前四张卡全是写死的假数字：在籍学员 248、今日出勤 36、今日课程 8、本月收入 ¥5.2 万。平台没有财务模块，「本月收入」这张卡永远是假的，其它三张也从不更新。

本次把前三张卡接上真实数据，并把第四张「本月收入」换成「库存状态」（显示在库总件数 + 低库存提示）。数据由数据报表模块（`src/domain/reports.repo.ts`，纯只读）新增一个 `getHomeSummary()` 聚合查询提供，经一个新的 `reports:homeSummary` IPC 频道拉到首页。首页仍用现有的内联 `<script>`（不新增 .js 文件），在页面加载时和窗口重新获焦时各拉一次。

## Goals

- 在籍学员 / 今日出勤 / 今日课程三张卡显示实时真实数字
- 「本月收入」卡替换为「库存状态」卡，主数值为在库总件数
- 四张卡的副标题显示真实衍生信息，不再有「较上月 +N」这类假环比
- 首页进入时与从其它模块返回（window focus）时自动刷新这四个数字
- 纯只读：不新增表 / 迁移，复用 `reports.repo.ts`

## User Stories

### US-001: 首页概况卡接入真实数据（reports:homeSummary 端到端）
**Description:** As a 管理者, I want 首页顶部四张卡显示真实的在籍 / 今日出勤 / 今日课程 / 库存数字, so that 一进平台就掌握当下经营状况，而不是看一堆假数据。

**Acceptance Criteria:**
- [ ] `src/domain/reports.repo.ts` 新增 `getHomeSummary()`：纯 `SELECT`，无入参，返回 `HomeSummary`（见 FR-1 字段列表）
- [ ] `activeStudents` = `students` 中 `status='在读' AND deleted_at IS NULL` 计数
- [ ] `newStudentsLast30d` = `deleted_at IS NULL AND enroll_date IS NOT NULL AND enroll_date >= 今天-30`（本地时间算 cutoff，含当天）
- [ ] `todayCheckIns` = `attendance_records` 中 `deleted_at IS NULL AND type IN ('出勤','补课') AND attend_date = 今天`
- [ ] `todayAttendanceRate` = 今天 `出勤 ÷ (出勤 + 缺勤 + 请假)`；分母为 0 时为 `null`
- [ ] `todaySessions` = `class_sessions` 中 `deleted_at IS NULL AND status='正常' AND session_date = 今天`
- [ ] `todayRoomsInUse` = 今天正常课节里 `room` 非空去重计数
- [ ] `lowStockCount` / `itemKinds` / `totalQuantity` 取未软删 `inventory_items` 的低库存数、品类数、`SUM(quantity)`（`COALESCE` 兜空为 0）
- [ ] 「今天」在 repo 内用 JS 本地时间算，不在 SQL 用 `date('now')`
- [ ] 新增频道 `reports:homeSummary`（`CH` 常量 + `register.ts` `handle()` 包装，无入参，返回 `IpcResult<HomeSummary>`）+ `preload.ts` 暴露 `studioShell.reports.homeSummary()` + `studioShell.d.ts` 类型
- [ ] `index.html` 第 4 张卡：`.stat-label` 文本由「本月收入」改为「库存状态」，`data-od-id` 由 `stat-revenue` 改为 `stat-inventory`，主数值区显示在库总件数（如 `380 件`）
- [ ] `index.html` 四张卡的 `.stat-value` 与 `.stat-sub` 初始内容改为占位 `—`，由内联脚本按 `data-od-id` 定位后填充
- [ ] 副标题填充：在籍学员 → `近 30 天新增 N 人`；今日出勤 → `出勤率 XX%`（`todayAttendanceRate` 为 `null` 时显示 `暂无排课`）；今日课程 → `N 间教室使用中`；库存状态 → `共 N 品类 · M 项偏低`（`lowStockCount` 为 0 时显示 `共 N 品类 · 库存充足`）
- [ ] 库存偏低（`lowStockCount > 0`）时，库存状态卡副标题用 `var(--cc-1)`（暖红）
- [ ] 库存状态卡不可点击（与其它三张卡一致，`.stats-bar` 不加跳转）
- [ ] 内联脚本在页面加载时、以及 `window` `focus` 事件时各调用一次 `reports:homeSummary` 并刷新四张卡
- [ ] `window.studioShell` / `studioShell.reports.homeSummary` 不存在，或 IPC 返回 `ok:false`，或 `unwrap` 抛错时：四张卡保持 / 回落为 `—`，控制台不出现未捕获异常
- [ ] `tests/unit/reports-home.test.ts`（`node:test`）：临时库塞已知数据，断言 9 个字段口径与边界（软删不计、`enroll_date` 恰为 cutoff30 计入、`todayAttendanceRate` 分母 0 → `null`、`todayRoomsInUse` 去重且忽略空 `room`、空库 `totalQuantity` 为 0）
- [ ] `npm run typecheck && npm run lint && npm run test:unit` 通过
- [ ] 应用内验证（`run` skill）：首页四张卡显示真实数字；新建一个学员后切走再切回首页，「在籍学员」+1

### US-002: 首页概况 E2E 测试
**Description:** As a QA engineer, I want 一个覆盖首页概况卡完整链路的自动化端到端测试, so that 这条「数据库 → IPC → 首页渲染 → 获焦刷新」的链路回归能被捕获。

**Acceptance Criteria:**
- [ ] 在 `tests/e2e/home-flow.spec.ts` 新增用例（Playwright `_electron`，独立临时 `STUDIO_DB_PATH`，自建自清）
- [ ] happy path：经 `window.studioShell` 播种（≥1 在读学员、≥1 当天正常课节且带 `room`、≥1 当天 `出勤` 记录、≥1 低库存物件）→ 打开首页 → 断言 `[data-od-id="stat-students"] .stat-value` 显示已播种的在读人数、`[data-od-id="stat-attendance"]` 显示当天出勤人次与出勤率副标题、`[data-od-id="stat-classes"]` 显示当天课节数与「N 间教室使用中」、`[data-od-id="stat-inventory"] .stat-label` 文本为「库存状态」且主数值为在库总件数
- [ ] 获焦刷新：再经 `window.studioShell` 新建一个在读学员 → 触发 `window` `focus`（`page.evaluate(() => window.dispatchEvent(new Event('focus')))`）→ 断言「在籍学员」数值 +1
- [ ] 边界：空数据库打开首页 → 四张卡显示 `0`（或 `—`）且不抛错；断言无 `pageErrors`
- [ ] 测试在 CI 通过，独立可重复

## Functional Requirements

- FR-1: 系统必须新增只读 `getHomeSummary()`，返回 `HomeSummary`：`activeStudents` / `newStudentsLast30d` / `todayCheckIns` / `todayAttendanceRate`(number\|null) / `todaySessions` / `todayRoomsInUse` / `lowStockCount` / `itemKinds` / `totalQuantity`
- FR-2: `activeStudents` 必须为 `status='在读' AND deleted_at IS NULL` 的学员计数
- FR-3: `newStudentsLast30d` 必须为 `deleted_at IS NULL AND enroll_date >= 今天-30`（本地时间，含当天）的学员计数
- FR-4: `todayCheckIns` 必须为 `deleted_at IS NULL AND type IN ('出勤','补课') AND attend_date = 今天` 的考勤记录计数
- FR-5: `todayAttendanceRate` 必须为今天 `出勤 ÷ (出勤 + 缺勤 + 请假)`；分母为 0 时必须为 `null`
- FR-6: `todaySessions` 必须为 `deleted_at IS NULL AND status='正常' AND session_date = 今天` 的课节计数
- FR-7: `todayRoomsInUse` 必须为今天正常课节中 `room` 非空且不重复的取值个数
- FR-8: `lowStockCount` / `itemKinds` / `totalQuantity` 必须只统计 `deleted_at IS NULL` 的 `inventory_items`；`totalQuantity` 空表时必须为 0
- FR-9: 「今天」的日期必须在 repo 内用 JS 本地时间计算并作为参数绑定，不得在 SQL 内使用 `date('now')`
- FR-10: 系统必须新增 `reports:homeSummary` IPC 频道（无入参），经 `handle()` 包装返回 `IpcResult<HomeSummary>`，并在 `preload.ts` 与 `studioShell.d.ts` 暴露
- FR-11: `index.html` 第 4 张卡的 `.stat-label` 必须改为「库存状态」，`data-od-id` 必须改为 `stat-inventory`，主数值区必须显示在库总件数
- FR-12: `index.html` 四张卡的 `.stat-value` 与 `.stat-sub` 初始文本必须为 `—`
- FR-13: 内联脚本必须在填充时把四张卡的主数值与副标题设置为真实数据；副标题文案按 US-001 的规则
- FR-14: 库存偏低（`lowStockCount > 0`）时，库存状态卡副标题文字颜色必须为 `var(--cc-1)`
- FR-15: 内联脚本必须在页面加载时调用一次 `reports:homeSummary`，并在 `window` `focus` 事件时再次调用
- FR-16: 当 `window.studioShell.reports.homeSummary` 不可用或调用失败时，四张卡必须回落为 `—`，且不得产生未捕获异常
- FR-17: 库存状态卡不得可点击

## Non-Goals (Out of Scope)

- 不做「较上月 / 环比」——平台没有历史快照
- 不做任何收入 / 财务指标
- 不改首页的时钟、日期卡、问候语、模块卡片网格等其它元素
- 不为首页新增独立 `.js` 文件，沿用现有内联 `<script>` [Assumption]
- 不做除 `focus` 之外的自动轮询刷新
- 不做四张卡的点击跳转
- 不新增数据库表 / 迁移 / 索引

## Design Considerations

- 复用 `.stats-bar` / `.stat-chip` / `.stat-value` / `.stat-sub` / `.unit` / `.stat-accent` 现有样式
- 库存偏低副标题用 `--cc-1`（暖红，按 DESIGN 不计入 `--accent` 预算）
- 内联脚本沿用现有 `var` / `function` 风格（非 ES module），通过 `document.querySelector('[data-od-id="stat-xxx"] .stat-value')` 定位
- `window.studioShell` 在首页可用（preload 已注入，`home-flow.spec.ts` 既有用例已依赖），但脚本仍需对其缺失做防御

## Technical Considerations

- 纯只读，全部落在 `src/domain/reports.repo.ts`；「今天」用与模块既有 cutoff 一致的本地时间算法（`reports.repo.ts` 已有 `todayLocal()` / `daysAgoLocal()` 私有函数可复用）
- `getHomeSummary` 内多条标量 `SELECT` + 一条今日课节的 `room` 去重计数；数据量级下单次 < 数十毫秒
- 新频道无入参，`register.ts` 直接 `handle(CH.reportsHomeSummary, () => reportsRepo.getHomeSummary())`
- 交付：单分支 `feat/home-summary`，一 issue 一 commit，最后一个 PR；每次 commit 前 `npm run typecheck && npm run lint && npm run test:unit`，PR 前 `npm test`

## Success Metrics

- 首页四张卡进入 1 秒内显示真实数字（本地 SQLite）
- 新建 / 删除学员、点名、排课、领用后回到首页（获焦），对应数字随之变化
- `npm test` 全绿；`migrations.ts` 零改动
- 首页不再出现任何写死的经营数字

## Open Questions

- 副标题「N 间教室使用中」当 `todayRoomsInUse` 为 0（今天有课但都没填教室）时，是否显示「未记录教室」而非「0 间教室使用中」？当前按 `0 间教室使用中` 处理 [Assumption]
- 是否要在 `focus` 刷新之外，也在既有 60 秒 `updateAll` 定时器里带上概况刷新？当前不带 [Assumption]
