# PRD: 数据报表 KPI 卡片悬停明细

## 1. Introduction/Overview

「数据报表」页面（`reports.html`）顶部「概览」区有六张 KPI 卡片，其中「近 30 天新增学员」「课时余额预警」「低库存预警」三张目前只显示一个数字（比如「课时余额预警：7」），用户想知道这 7 个人是谁，必须去别的页面手动查。

打个比方：现在这三张卡片像是仪表盘上只有一个警示灯，亮了但不告诉你哪里出的问题——要排查还得下车打开引擎盖。这次要做的，是让鼠标悬停在灯上时，直接弹出一张小纸条，写清楚具体是谁、缺多少。

代码里其实已经有一套「预警中心」的清单渲染逻辑（`renderAlerts`/`alertGroup`），只是被开关 `SHOW_ALERTS = false` 关掉了、从未上线。这次不重新启用那个整块清单区域，而是把同样的底层数据（课时余额不足名单、低库存名单），改用「悬停在 KPI 卡片上弹出小提示框（tooltip）」的形式呈现，交互更轻。「近 30 天新增学员」目前后端只有计数、没有名单，需要新增一个查询。

## 2. Goals

- 三张 KPI 卡片悬停时都能直接看到明细名单，无需跳转或点击。
- 「近 30 天新增学员」悬停明细展示具体学员姓名 + 入学日期。
- 「课时余额预警」「低库存预警」悬停明细复用已有的 `lowBalance`/`lowStock` 查询数据，不新建数据源。
- 悬停提示的视觉风格与现有设计系统（`colors_and_type.css` token、`DESIGN.md` 规则）保持一致。
- 明细条目较多时（如 8～10 条以上）在提示框内可滚动查看全部，不需要分页或跳转。

## 3. User Stories

### US-001: 新增「近 30 天新增学员」名单查询
**Description:** As a developer, I need a repo-layer query that returns the actual list of students enrolled in the last 30 days, so the frontend has data to show on hover (today only a `COUNT(*)` exists).

**Acceptance Criteria:**
- [ ] `src/domain/reports.repo.ts` 新增函数（如 `getNewStudentsList`），返回 `{ id, name, enrollDate }[]`，条件为 `enroll_date >= 今天-30天`（本地时区，沿用文件里现有的 `daysAgoLocal` 口径），按 `enrollDate` 降序排列
- [ ] 返回列表数量与现有 `newStudentsLast30d` 计数保持一致（同一 cutoff 逻辑）
- [ ] 新类型加入 `src/shared/types.ts`（如扩展 `ReportOverview` 或新增 `ReportAlerts` 字段）
- [ ] IPC channel（`src/ipc/channels.ts` + `src/ipc/register.ts`）与 preload 桥（`src/preload.ts`）按现有 `reports:*` 模式接入
- [ ] 单元测试覆盖：边界日期（第 30 天当天算不算新增）、空列表情况
- [ ] Typecheck/lint 通过

### US-002: 通用 KPI 卡片悬停提示组件
**Description:** As a developer, I want a reusable hover-tooltip UI building block for KPI cards, so all three cards can share the same interaction and visual pattern instead of three one-off implementations.

**Acceptance Criteria:**
- [ ] 新增一个可复用的 tooltip/popover 渲染函数（`reports.js` 内，风格参考现有 `kpiCard`/`section` 等小函数的写法）
- [ ] 纯 hover 触发：鼠标移入卡片短暂延迟后出现，移出卡片区域即消失，不需要点击关闭
- [ ] 提示框使用 `colors_and_type.css` 中已有的 `--surface`/`--border`/`--shadow-card` 等 token，不出现任何裸 hex 值
- [ ] 提示框内容区最大高度封顶，超出时内部可滚动（`overflow-y: auto`），显示完整名单而不截断
- [ ] hover 态本身不能降低文字对比度（遵循 `DESIGN.md` 反模式规则）
- [ ] 提示框定位在视口内自适应（不因卡片靠近页面边缘而被裁切出屏幕）
- [ ] Typecheck/lint 通过
- [ ] Verify in a browser（`run` skill）

### US-003: 「近 30 天新增学员」卡片接入悬停明细
**Description:** As a studio staff member, I want to hover over the "近 30 天新增学员" KPI card and immediately see who those new students are, so I don't have to navigate to the student list and filter manually.

**Acceptance Criteria:**
- [ ] 悬停「近 30 天新增学员」卡片时，提示框展示每位新增学员的姓名与入学日期（如「张三 · 2026-08-15」）
- [ ] 列表按入学日期降序排列（最新的在最上面）
- [ ] 数量为 0 时提示框显示「暂无」而不是空白
- [ ] 页面加载 KPI 概览时一并预取该名单数据（与 `shell.reports.overview()` 并行请求），悬停时无明显加载延迟
- [ ] Typecheck/lint 通过
- [ ] Verify in a browser（`run` skill）

### US-004: 「课时余额预警」卡片接入悬停明细
**Description:** As a studio staff member, I want to hover over the "课时余额预警" KPI card and see exactly which students are running low on lessons, so I can follow up on renewals without opening a separate report.

**Acceptance Criteria:**
- [ ] 悬停该卡片时，提示框展示每位余额不足学员的姓名与剩余课时（复用现有 `shell.reports.alerts()` 返回的 `lowBalance` 数据，格式如现有 `alertGroup` 里的 `${it.name} · 剩 ${it.remainingLessons} 课时`）
- [ ] 数量为 0 时提示框显示「暂无」
- [ ] 页面加载时预取 `shell.reports.alerts()`（当前仅在 `SHOW_ALERTS` 为真时才调用，需要改为始终预取，与 `SHOW_ALERTS` 整块清单区域的显示与否解耦）
- [ ] `SHOW_ALERTS` 整块「预警中心」区域保持关闭状态不受影响（仍为 `false`）
- [ ] Typecheck/lint 通过
- [ ] Verify in a browser（`run` skill）

### US-005: 「低库存预警」卡片接入悬停明细
**Description:** As a studio staff member, I want to hover over the "低库存预警" KPI card and see which items are low and by how much, so I know what to restock without a separate lookup.

**Acceptance Criteria:**
- [ ] 悬停该卡片时，提示框展示每个低库存商品的名称、当前库存与阈值（复用 `lowStock` 数据，格式如 `${it.name} · 剩 ${it.quantity}（阈值 ${it.threshold}）`）
- [ ] 数量为 0 时提示框显示「暂无」
- [ ] 与 US-004 共用同一次 `shell.reports.alerts()` 预取，不重复请求
- [ ] Typecheck/lint 通过
- [ ] Verify in a browser（`run` skill）

### US-006: 端到端测试：三张 KPI 卡片悬停明细
**Description:** As a QA engineer, I want an automated end-to-end test covering the full hover-detail flow for all three KPI cards so that we catch regressions across the entire stack.

**Acceptance Criteria:**
- [ ] E2E 测试打开数据报表页，依次悬停「近 30 天新增学员」「课时余额预警」「低库存预警」三张卡片，断言各自的提示框出现且内容包含预期的姓名/数值
- [ ] 覆盖边界场景：某一预警类别在测试数据中为 0 条时，提示框显示「暂无」而非报错或空白
- [ ] 断言鼠标移出卡片后提示框消失
- [ ] 测试在 CI 中运行并通过
- [ ] 测试自行准备与清理所需的测试数据（学员、库存记录）

## 4. Functional Requirements

- FR-1: 系统必须新增一个仓库层查询，返回近 30 天内入学学员的姓名与入学日期列表，口径与现有 `newStudentsLast30d` 计数一致。
- FR-2: 系统必须通过新的 IPC channel 与 preload 桥暴露该学员名单查询，供渲染进程调用。
- FR-3: 系统必须在数据报表页概览区加载时，并行预取「新增学员名单」与「预警名单（`shell.reports.alerts()`）」，不等悬停时才发请求。
- FR-4: 当鼠标悬停在「近 30 天新增学员」卡片上时，系统必须显示一个提示框，列出每位学员的姓名与入学日期，按入学日期降序排列。
- FR-5: 当鼠标悬停在「课时余额预警」卡片上时，系统必须显示一个提示框，列出每位学员的姓名与剩余课时数。
- FR-6: 当鼠标悬停在「低库存预警」卡片上时，系统必须显示一个提示框，列出每个商品的名称、当前库存与预警阈值。
- FR-7: 当对应名单为空时，系统必须在提示框内显示「暂无」文案，而不是空白或报错。
- FR-8: 当鼠标移出卡片区域时，系统必须自动隐藏提示框，不需要用户点击关闭。
- FR-9: 当提示框内容超过可视高度时，系统必须允许提示框内部垂直滚动，展示完整名单。
- FR-10: 提示框的视觉样式必须使用 `colors_and_type.css` 中已定义的 design token，不得出现裸 hex 颜色值。

## 5. Non-Goals (Out of Scope)

- 不重新启用整块「预警中心」清单区域（`SHOW_ALERTS` 保持 `false`），本次只做 KPI 卡片上的悬停提示。
- 不涉及「沉睡学员」「空课」这两组预警数据（`renderAlerts` 里已有但本次不接入悬停）。
- 悬停明细不提供点击跳转到学员详情页/商品详情页的能力，仅展示只读信息。
- 不为触摸屏/移动端适配单独的点按交互——本应用是鼠标操作为主的 Electron 桌面应用。
- 不改变现有 KPI 卡片的数值展示逻辑、颜色预警规则（`is-warn` 样式）。
- 「近 30 天新增学员」悬停明细不含入学来源、课程等额外字段，仅姓名 + 入学日期。

## 6. Design Considerations

- 严格遵循项目 `DESIGN.md` 与 `colors_and_type.css`：颜色一律用 `var(--token-name)`，禁止裸 hex；hover 态不得降低文字对比度；`--accent` 每屏最多出现两次。
- 复用 `reports.html`/`reports.js` 现有的卡片阴影、圆角等 token（`--shadow-card`、`--shadow-card-hover`、`--radius`），提示框应看起来是同一套卡片语言的延伸，而不是突兀的新组件。
- 提示框内文字层级：加粗/主色用于姓名，次要文字（次要色/`--muted`）用于日期或数值，与 `distList`/`twoColTable` 里已有的次要信息处理方式保持一致。
- 三张卡片的提示框布局可以复用同一个渲染函数，仅传入不同的行渲染逻辑（参考现有 `alertGroup(title, items, renderRow)` 的写法）。

## 7. Technical Considerations

- 遵循本项目固定的分层结构：DB → `src/domain/reports.repo.ts` → `src/ipc/channels.ts` + `register.ts` → `src/preload.ts` → `reports.js`（渲染层）。
- `lowBalance`/`lowStock` 查询在仓库层已各自限制最多 200 条（`limit 200`），作为悬停提示可滚动展示的数据上限已经足够，无需额外分页。
- 「新增学员名单」查询应复用文件里已有的 `daysAgoLocal(30)` 工具函数，保持与 `newStudentsLast30d` 计数完全同源，避免两个数字对不上。
- `shell.reports.alerts()` 目前只在 `SHOW_ALERTS` 为真时才被调用（`reports.js:775`），需要改为无条件预取，但仍只在 `SHOW_ALERTS` 为真时渲染整块清单区域——两者解耦。
- 新的 tooltip 组件应是纯前端状态（悬停 hover/焦点管理），不引入新的第三方依赖。

## 8. Success Metrics

- 三张 KPI 卡片悬停后均能在 1 秒内展示完整明细（依赖 US-003 的预取，避免悬停时才发起数据库查询）。
- 用户无需离开数据报表页即可获知「新增学员是谁」「课时预警是谁」「低库存是什么」，减少跳转到学员/库存列表页手动筛选的操作次数。
- 三张卡片的悬停提示视觉一致、无颜色/对比度类走查问题（人工走查 + `DESIGN.md` 反模式检查）。

## 9. Open Questions

- 「近 30 天新增学员」的悬停延迟时间（如 150ms/300ms）具体取值，交给实现阶段按现有交互习惯确定，无强制要求。
- 如果未来需要在移动端/触屏场景使用本应用，悬停交互需要重新设计为点按交互——本次不处理，留待后续迭代。
