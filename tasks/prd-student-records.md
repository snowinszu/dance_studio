# PRD: 学员档案（预设字段 + 管理者自定义字段）

## 1. 概述 / Introduction

「学员档案」是「晓·乐舞艺术空间」桌面应用首页 5 张卡片之一，目前是一块「敬请期待」占位页。本 PRD 把它做成一个**完整可用的档案模块**：录入 / 查看 / 编辑 / 删除学员，按分组展示信息，支持管理者自己增减字段，数据全部落地到本地 SQLite 数据库。

打个比方：这套东西像一本**活页笔记本**。封面上印死的栏目（姓名、电话、状态）是「预设字段」——所有档案都有、格式统一；中间是活页，管理者能自己加、自己抽，加之前先给活页贴一张「标签说明」（这页叫什么、填什么格式、必不必填），这张说明就是数据库里的「字段定义表」。少了它，本子越用越乱，以后想按某页内容查人根本查不了。

这也是本项目**第一个带持久化的功能**：需要先把数据库接进来。面向读者：初级开发或 AI agent 均可据此实现。

## 2. 目标 / Goals

- 主进程接入 better-sqlite3，建立带迁移机制的本地数据库，渲染进程只经 IPC 访问
- 交付一组**预设字段**，按「基本 / 联系 / 课程与会员 / 健康 / 运营」5 组组织，窄屏可折叠
- 管理者能在界面上**新增 / 编辑 / 归档自定义字段**，无需改代码，支持 9 种字段类型
- 删除自定义字段用「归档」实现，旧档案里填过的值不丢失
- 学员列表页支持搜索（姓名 / 电话）、按状态与标签筛选，Mobile First
- 支持标签系统，以及 Excel 批量导入 / 导出
- 全程遵循设计系统：只用 `var(--token)`，无裸 hex，`--accent` 每屏 ≤ 2 次

## 3. 用户故事 / User Stories

### US-001: 接入 SQLite 与数据库初始化
**Description:** 作为开发者，我需要在主进程接入本地数据库并建立结构迁移机制，以便后续功能有地方存数据。

**Acceptance Criteria:**
- [ ] 新增 `better-sqlite3` 依赖；`postinstall` 能对 Electron 完成原生模块 rebuild（用 `@electron/rebuild` 或 electron-builder 内置流程），`npm start` 后主进程无原生模块加载报错
- [ ] 数据库文件位于 `app.getPath('userData')/dance-studio.db`，首次启动自动创建
- [ ] 实现基于 `PRAGMA user_version` 的迁移器：启动时按顺序执行未应用的迁移，升级到当前版本号
- [ ] 迁移 v1 建表：`students`、`field_definitions`、`tags`、`student_tags`（字段见「附录 A / B」）
- [ ] 所有数据库访问代码只存在于主进程；渲染进程无 `require('better-sqlite3')`
- [ ] 数据库模块用 TypeScript strict 编译；SQL 用 better-sqlite3 预编译语句，不引入 ORM
- [ ] Typecheck / lint 通过

### US-002: 学员档案读写 IPC
**Description:** 作为开发者，我需要一组增删改查的 IPC 接口，以便渲染进程能安全地读写学员数据。

**Acceptance Criteria:**
- [ ] preload 通过 `contextBridge` 暴露 `studioShell.students`：`list(query)`、`get(id)`、`create(data)`、`update(id, data)`、`softDelete(id)`
- [ ] `create` / `update` 把预设字段写入 `students` 对应列，把自定义字段以 JSON 对象写入 `students.custom_fields` TEXT 列
- [ ] `softDelete` 只写 `deleted_at` 时间戳，不物理删除；`list` 默认过滤掉 `deleted_at IS NOT NULL`
- [ ] `create` / `update` 自动维护 `created_at` / `updated_at`
- [ ] 主进程侧对入参做基本类型校验，非法入参返回结构化错误而非抛未捕获异常
- [ ] `contextIsolation: true`、`nodeIntegration: false` 保持不变
- [ ] Typecheck / lint 通过

### US-003: 字段定义 IPC 与预设字段配置
**Description:** 作为开发者，我需要「自定义字段」的元数据接口，以及一份内置的预设字段配置，以便表单能动态渲染。

**Acceptance Criteria:**
- [ ] 代码内置 `PRESET_FIELDS` 常量：每项含 `key` / `label` / `type` / `group` / `order` /（select 类）`options`，覆盖「附录 A」全部预设字段
- [ ] preset 字段不可被管理者删除或改类型（不进 `field_definitions` 表，仅由该常量描述）
- [ ] preload 暴露 `studioShell.fieldDefs`：`list()`（默认只返回 `archived = 0`，可选包含已归档）、`create(def)`、`update(id, patch)`、`archive(id)`、`reorder(idArray)`
- [ ] `create` 依据 `label` 生成唯一 `field_key`（英文 slug + 冲突后缀），持久化 `type` / `options` / `required` / `group_key` / `sort_order` / `sensitive`(默认 0) / `archived`(默认 0) / `default_value`
- [ ] `update` 允许改 `label` / `options` / `required` / `sort_order` / `group_key`；**拒绝**修改已存在字段的 `type`，返回明确错误
- [ ] `archive` 置 `archived = 1`，不删除行、不动任何学员的 `custom_fields` 数据
- [ ] `type` 取值范围恰为：`text` `textarea` `number` `date` `select` `multiselect` `boolean` `phone` `money`
- [ ] Typecheck / lint 通过

### US-004: 学员列表页
**Description:** 作为管理员，我想在一个列表里快速找到某个学员并进入其档案。

**Acceptance Criteria:**
- [ ] 从首页「学员档案」卡片进入本页，可返回首页
- [ ] 每行/卡片展示：头像占位（姓名首字）、姓名、主联系电话、状态标签（在读/请假/停课/毕业/流失，配不同 token 颜色）
- [ ] 顶部搜索框：输入即时过滤，匹配 `姓名` 子串 **或** `主联系电话/备用电话` 子串
- [ ] 筛选控件：按「学员状态」多选 + 按「标签」多选，组合生效
- [ ] 无匹配结果时显示空状态文案（区分「还没有学员」与「没有符合筛选的学员」两种）
- [ ] 窄屏为单列卡片列表，宽屏可多列；触控目标 ≥ 44px
- [ ] 页面无裸 hex，`--accent` 出现 ≤ 2 次；hover 行时文字对比度不下降
- [ ] Typecheck / lint 通过
- [ ] 在 Electron 窗口中人工核对视觉（可借助 `run` skill）

### US-005: 学员详情页
**Description:** 作为管理员，我想查看一个学员的完整档案，信息按分组组织、一屏不至于太长。

**Acceptance Criteria:**
- [ ] 按 5 个分组展示：基本信息 / 联系方式 / 课程与会员 / 健康与安全 / 运营；窄屏折叠为手风琴或 Tab，宽屏可平铺
- [ ] 预设字段按「附录 A」顺序展示；未归档自定义字段按 `sort_order` 追加到对应分组
- [ ] 出生日期一行同时显示「年龄 X 岁」（按当前日期 2026-08-29 之后实时计算，不落库）
- [ ] `multiselect` 值渲染为多个标签；`boolean` 渲染为「是/否」；空值统一显示占位符（如「—」）
- [ ] 顶部展示该学员的标签
- [ ] 提供「编辑」入口与「删除」入口；删除需二次确认弹窗，确认后走软删除并返回列表
- [ ] 页面无裸 hex，`--accent` ≤ 2 次
- [ ] Typecheck / lint 通过
- [ ] 在 Electron 窗口中人工核对（可借助 `run` skill）

### US-006: 新建 / 编辑档案表单
**Description:** 作为管理员，我想用同一套表单录入新学员或修改已有学员，字段按类型给出合适的输入控件。

**Acceptance Criteria:**
- [ ] 新建与编辑复用同一表单组件；表单按 5 分组渲染，字段顺序同详情页
- [ ] 按字段类型渲染控件：`text`→单行、`textarea`→多行、`number`/`money`→数字输入、`date`→日期选择、`select`→下拉、`multiselect`→多选、`boolean`→开关、`phone`→带手机号格式提示的输入
- [ ] 保存前校验：必填字段非空（预设必填=姓名、主联系电话）、`number`/`money` 为数值、`date` 为合法日期、`phone` 匹配中国大陆手机号、`select`/`multiselect` 值在选项内；校验失败在对应字段下显示红色提示且不提交
- [ ] 新建时 `status` 默认「在读」；`create` 成功后跳转到该学员详情页
- [ ] 编辑时表单预填当前值；`multiselect`/`select` 选项中已被归档移除的历史值仍显示且可保留，标注「已停用」
- [ ] 缺失某个「必填自定义字段」值的旧档案可正常打开编辑，该字段标「待补充」，仅在点保存时提示（不阻塞打开）
- [ ] 页面无裸 hex，`--accent` ≤ 2 次；hover 态不降低文字对比度
- [ ] Typecheck / lint 通过
- [ ] 在 Electron 窗口中人工核对（可借助 `run` skill）

### US-007: 自定义字段管理界面
**Description:** 作为管理者，我想在界面上自己增减档案字段，不用找开发改代码。

**Acceptance Criteria:**
- [ ] 从档案模块进入「字段管理」页，列出全部预设字段（只读、标「预设」）与自定义字段
- [ ] 自定义字段列表可拖拽调整顺序，保存后详情页/表单顺序同步变化
- [ ] 「新增字段」表单：显示名称、类型（9 选 1）、所属分组（5 选 1）、是否必填；类型为 `select`/`multiselect` 时可增删选项
- [ ] 新增后立即在档案表单对应分组出现该字段
- [ ] 每个自定义字段可「编辑」（名称/选项/必填/分组）与「归档」；类型字段在编辑态置灰不可改
- [ ] 「归档」需二次确认，提示「归档后新档案不再显示此字段，已填写的历史数据会保留」；归档后该字段从表单/详情消失，但导出仍包含
- [ ] 已归档字段单独分区展示，可「恢复」
- [ ] 页面无裸 hex，`--accent` ≤ 2 次
- [ ] Typecheck / lint 通过
- [ ] 在 Electron 窗口中人工核对（可借助 `run` skill）

### US-008: 标签系统
**Description:** 作为管理员，我想给学员打自由标签（如「参赛苗子」「已欠费」），并能按标签筛选。

**Acceptance Criteria:**
- [ ] 「标签管理」界面：新增/重命名/删除标签，每个标签可选一个 token 颜色
- [ ] 删除标签需二次确认，删除后自动解除与所有学员的关联（`student_tags` 行一并删除）
- [ ] 学员详情页可给该学员添加/移除标签（多对多，写 `student_tags`）
- [ ] 列表页「按标签筛选」下拉列出全部标签，选中后只显示含该标签的学员（多选为「任一命中」）
- [ ] 页面无裸 hex，`--accent` ≤ 2 次
- [ ] Typecheck / lint 通过
- [ ] 在 Electron 窗口中人工核对（可借助 `run` skill）

### US-009: 导出档案为 Excel
**Description:** 作为管理员，我想把当前列表导出成 Excel 存档或给别人看。

**Acceptance Criteria:**
- [ ] 引入 Excel 生成库（`xlsx` / SheetJS 或 `exceljs`，记为 [Assumption]）
- [ ] 列表页「导出」按钮：把**当前搜索/筛选后的结果集**导出为 `.xlsx`
- [ ] 列顺序：预设字段（按附录 A）→ 未归档自定义字段 → 有值的已归档自定义字段（表头标「(已归档)」）→ 标签（一列，逗号分隔）
- [ ] `multiselect` 值在单元格内以逗号分隔；`date` 输出 `YYYY-MM-DD`；`boolean` 输出「是/否」
- [ ] 通过主进程写文件并弹系统「保存」对话框，渲染进程不直接触碰文件系统
- [ ] 导出不包含已软删除的学员
- [ ] Typecheck / lint 通过
- [ ] 在 Electron 窗口中人工核对（可借助 `run` skill）

### US-010: 从 Excel 批量导入档案
**Description:** 作为管理员，我想把历史客户名单从 Excel 一次性导进系统。

**Acceptance Criteria:**
- [ ] 提供「下载导入模板」：表头为全部预设字段 + 未归档自定义字段，附一行示例
- [ ] 选择文件后进入「列映射」界面：左侧模板字段，右侧下拉选择对应的表格列，姓名/主联系电话为必映射
- [ ] 逐行校验（同 US-006 的类型/必填/选项规则），生成报告：成功 N 行、失败 M 行，失败行列出行号与原因
- [ ] 失败行不中断导入，其余行正常入库；导入为「新建」（本版不做「按手机号去重更新」，见开放问题）
- [ ] 导入在主进程完成，渲染进程通过 IPC 传文件路径 / 内容
- [ ] 导入完成后列表页出现新学员
- [ ] Typecheck / lint 通过
- [ ] 在 Electron 窗口中人工核对（可借助 `run` skill）

### US-011: 学员档案流程的端到端测试
**Description:** 作为 QA 工程师，我想要一套自动化端到端测试覆盖学员档案的完整链路，以便在整条技术栈上捕获回归。

**Acceptance Criteria:**
- [ ] E2E 测试模拟完整 happy path：首页进入档案 → 新建学员（填姓名+电话+若干预设字段）→ 保存 → 列表出现该学员 → 进详情核对 → 编辑一个字段并保存 → 详情反映改动
- [ ] 覆盖自定义字段链路：在字段管理页新增一个 `select` 类型字段 → 回到档案表单该字段出现 → 录入并保存 → 详情显示；再归档该字段 → 表单/详情不再显示 → 导出的 xlsx 仍含该列与历史值
- [ ] 覆盖至少一条边界/失败路径：新建时留空姓名或填非法手机号 → 显示字段级校验错误且未写库
- [ ] 覆盖筛选：按状态 + 标签筛选后，仅匹配学员可见；筛选无结果显示空状态文案
- [ ] 测试用 Playwright 运行（沿用 `playwright.config.ts`），在 CI 通过
- [ ] 测试自建自清数据：使用独立的临时数据库文件（通过 env 指定 userData 路径），运行前后不污染真实库

## 4. 功能需求 / Functional Requirements

- FR-1: 系统必须在 Electron 主进程内通过 better-sqlite3 打开位于 `userData` 目录的 SQLite 文件，渲染进程不得直接访问数据库。
- FR-2: 系统必须提供基于 `PRAGMA user_version` 的迁移机制，应用启动时自动把数据库结构升级到当前版本。
- FR-3: 系统必须创建 `students` 表，包含「基本 / 联系 / 课程与会员 / 健康 / 运营」五组预设列（见附录 A），`name` 与 `phone_primary` 非空。
- FR-4: 系统必须以 `birth_date`（出生日期）存储生日，年龄在界面按当前日期实时计算，不落库。
- FR-5: 系统必须在 `students` 表提供 `custom_fields` TEXT 列，以 JSON 对象存储自定义字段的值，键为字段定义的 `field_key`。
- FR-6: 系统必须创建 `field_definitions` 表，字段含 `field_key`(唯一)、`label`、`type`、`options`、`required`、`group_key`、`sort_order`、`sensitive`、`archived`、`default_value`。
- FR-7: 自定义字段 `type` 必须且仅支持：`text`、`textarea`、`number`、`date`、`select`、`multiselect`、`boolean`、`phone`、`money`。
- FR-8: 系统必须内置一份预设字段配置（标签、类型、所属分组、顺序、选项），供档案表单渲染预设区域使用；预设字段不可被管理者删除或改类型。
- FR-9: 系统必须允许管理者新增自定义字段：填写显示名称、选择类型、（select/multiselect）配置选项、指定所属分组与是否必填；`field_key` 由系统生成且唯一。
- FR-10: 系统必须允许管理者编辑自定义字段的显示名称、选项、必填、排序、分组，但不得允许修改已有字段的 `type`。
- FR-11: 系统必须以「归档」(`archived = 1`) 实现自定义字段的删除：归档后档案表单不再展示该字段，但 `custom_fields` 中的历史值保留，导出时仍包含。
- FR-12: 新增 `required = 1` 的自定义字段时，系统不得阻止已有档案的读取与打开编辑；缺该字段值的档案标记为「待补充」，仅在保存时提示。
- FR-13: 系统必须提供学员档案的新增、查看、编辑、软删除（写 `deleted_at`）IPC 接口，软删除的档案默认不出现在列表。
- FR-14: 系统必须在保存档案时按字段定义校验：必填非空、`number`/`money` 为数值、`date` 为合法日期、`phone` 符合中国大陆手机号格式、`select`/`multiselect` 值在选项内。
- FR-15: 列表页必须展示头像占位（姓名首字）、姓名、主联系电话、状态标签，点击进入详情。
- FR-16: 列表页必须支持按 `姓名` 子串或 `电话` 子串即时搜索。
- FR-17: 列表页必须支持按「学员状态」与「标签」组合筛选，并在无匹配时显示空状态文案。
- FR-18: 系统必须提供标签的增删改（名称 + 颜色），标签与学员为多对多关系，用 `student_tags` 关联表实现。
- FR-19: 系统必须支持给单个学员添加 / 移除标签。
- FR-20: 系统必须支持将当前筛选结果导出为 `.xlsx`，列含全部预设字段 + 未归档自定义字段 + 有值的已归档自定义字段 + 标签列。
- FR-21: 系统必须提供导入模板下载；导入时展示列映射界面，逐行校验并生成成功 / 失败报告，失败行不中断其余导入。
- FR-22: 全流程必须遵循设计系统：仅用 `var(--token)`，无裸 hex，`--accent` 每屏 ≤ 2 次，hover 态不降低文字对比度。
- FR-23: 界面必须遵循 Mobile First：预设分组在窄屏折叠为手风琴 / Tab，触控目标 ≥ 44px，从移动端向上扩展布局。
- FR-24: 所有文件系统读写（导入 / 导出）必须在主进程完成，渲染进程仅通过 IPC 传递数据或路径。

## 5. 非目标 / Non-Goals (Out of Scope)

- 学员照片 / 头像上传（仅做姓名首字占位）
- 敏感字段按角色权限控制：`field_definitions.sensitive` 列**保留**并可在 UI 标「敏感」标签，但本版不做按角色隐藏 / 脱敏，也不引入登录与角色体系
- 完整审计日志 / 变更历史（除 `created_at` / `updated_at` 外，不记录「谁在何时把某字段从 X 改成 Y」）
- 家庭 / 多联系人建模（一个学员一组联系人字段，不做联系人独立表与多对多）
- 多设备同步、云端备份、数据加密
- 与考勤 / 排课 / 财务 / 报表模块的联动（本 PRD 只做档案本身）
- 附件上传（体检报告、考级证书扫描件）
- 自定义「分组」（分组固定为 5 组，管理者只能把字段归到其中之一）
- 导入时按手机号去重并更新已有档案（本版一律新建）

## 6. 设计考量 / Design Considerations

- 起点模板：`ui_kits/app/index.html`；`<head>` 引入 `colors_and_type.css`；组件规则与反模式遵循 `DESIGN.md`
- 沿用首页「大圆角卡片 + 八色卡顶」语言；状态标签颜色从既有 token 取，不新造 hex
- Mobile First：详情 / 编辑页在窄屏用手风琴折叠 5 个分组，默认展开「基本信息」；宽屏（≥ 960px，参考 DESIGN.md 桌面区间）可两列平铺
- 列表页窄屏单列卡片，每卡片信息控制在 4 行内（头像 + 姓名 + 电话 + 状态）
- `--accent` 每屏最多 2 处，优先给「新建学员」主按钮与当前选中态
- 复用首页已有的返回 / 导航外壳，保持「首页 → 子应用 → 返回」一致

## 7. 技术考量 / Technical Considerations

- **better-sqlite3 是原生模块**：需对 Electron ABI 做 rebuild；在 `postinstall` 或构建脚本里接 `@electron/rebuild`，并验证 `dist:win` 打包后仍可用（US-001 覆盖冒烟）
- 数据库文件路径：`app.getPath('userData')/dance-studio.db`；E2E 通过 env 覆写 userData 指向临时目录
- 迁移器用 `PRAGMA user_version` 记录版本，迁移脚本为有序数组，启动时在一个事务内逐个应用
- JSON 字段（`custom_fields`、`field_definitions.options`）以 TEXT 存储，在主进程序列化 / 反序列化，向渲染层暴露的是已解析对象
- 不引入 ORM：用 better-sqlite3 预编译语句手写 SQL，保持依赖精简、符合全局 Node 规范
- 全部 DB / 文件访问在主进程；preload 用 `contextBridge` 暴露窄接口；`contextIsolation` / `nodeIntegration` 配置不变
- Excel 库二选一（`xlsx` 体积小、`exceljs` API 友好），在 SPEC 阶段定；导入解析放主进程避免渲染层拿 fs
- TypeScript strict；typecheck / lint / Playwright E2E 全绿是每个 US 的门槛
- 电话号校验用中国大陆手机号正则（`/^1[3-9]\d{9}$/`），作为 `phone` 类型的统一规则

## 8. 成功指标 / Success Metrics

- 录入一个只含预设字段的新学员档案 ≤ 90 秒
- 管理者新增一个自定义字段 ≤ 3 步操作，且无需改动代码或重启应用
- 列表页在 1000 条学员数据下，搜索 / 筛选结果刷新 < 200ms
- 归档一个自定义字段后，导出的 xlsx 中该列历史值 100% 保留
- typecheck / lint / E2E 在 CI 全部通过，打包产物冒烟通过

## 9. 开放问题 / Open Questions

- 搜索是否要支持「拼音首字母」？会引入 `pinyin-pro` 之类依赖，暂放 v2。
- 剩余课时（`remaining_lessons`）涉及钱，是否至少对这一个字段留变更痕迹？
- 自定义字段的「分组」未来是否也要让管理者自定义，而非固定 5 组？
- `select`/`multiselect` 选项被删除后，已选中该项的学员：本 PRD 定为「显示并标『已停用』、可保留」，是否符合预期？
- 导入时若表格内手机号与库中已有学员重复，是否要提示 / 合并，还是就按新建处理（当前定为新建）？
- 数据库文件是否需要「导出整库备份 / 恢复」入口（区别于 Excel 导出）？

## 附录 A：预设字段清单

> 类型取值同自定义字段。`必填` 仅标注预设强制项。

### 基本信息 `basic`
| key | 显示名 | 类型 | 备注 |
|---|---|---|---|
| name | 姓名 | text | 必填 |
| nickname | 小名 / 昵称 | text | 老师课上叫的名字 |
| gender | 性别 | select | 男 / 女 / 其他 |
| birth_date | 出生日期 | date | 界面另显示「年龄 X 岁」 |
| id_card_type | 证件类型 | select | 身份证 / 护照 / 户口本 / 其他 |
| id_card_no | 证件号 | text | `sensitive` 标记保留（本版不强制脱敏） |

### 联系方式 `contact`
| key | 显示名 | 类型 | 备注 |
|---|---|---|---|
| guardian_name | 家长 / 监护人姓名 | text | |
| guardian_relation | 与学员关系 | select | 父 / 母 / 祖辈 / 其他监护人 / 本人 |
| phone_primary | 主联系电话 | phone | 必填 |
| phone_secondary | 备用电话 | phone | 紧急情况用 |
| wechat | 微信号 | text | |
| address | 家庭住址 | text | 判断接送范围 |
| emergency_contact_name | 紧急联系人 | text | 可能与家长不是同一人 |
| emergency_contact_phone | 紧急联系电话 | phone | |

### 课程与会员 `course`
| key | 显示名 | 类型 | 备注 |
|---|---|---|---|
| dance_types | 报读舞种 / 班级 | multiselect | 中国舞 / 芭蕾 / 拉丁 / 街舞 / 爵士 / 民族舞 / 其他 |
| current_level | 当前级别 / 考级进度 | text | |
| enroll_date | 入学日期 | date | |
| main_teacher | 主教老师 | text | |
| class_schedule | 固定上课时段 | text | |
| card_type | 卡种 / 课时包 | text | |
| remaining_lessons | 剩余课时 | number | |
| card_expire_date | 有效期至 | date | |
| status | 学员状态 | select | 在读 / 请假 / 停课 / 毕业 / 流失（默认「在读」） |

### 健康与安全 `health`
| key | 显示名 | 类型 | 备注 |
|---|---|---|---|
| health_allergy | 过敏史 | textarea | |
| health_history | 既往病史 / 受伤史 | textarea | 舞蹈是身体活动，务必留意 |
| health_notes | 特殊注意事项 | textarea | 心脏 / 哮喘 / 骨骼发育等 |

### 运营 `ops`
| key | 显示名 | 类型 | 备注 |
|---|---|---|---|
| source_channel | 来源渠道 | select | 转介绍 / 朋友圈 / 地推 / 大众点评 / 抖音 / 其他 |
| referrer | 转介绍人 | text | |
| remark | 备注 | textarea | |

> 标签不是 `students` 的列，由 `tags` / `student_tags` 单独承载（见附录 B），在详情页顶部展示。

## 附录 B：数据库结构（迁移 v1）

```sql
-- 学员主表：预设字段用真实列，自定义字段塞进 custom_fields JSON
CREATE TABLE students (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 基本信息
  name                   TEXT NOT NULL,
  nickname               TEXT,
  gender                 TEXT,               -- '男' | '女' | '其他'
  birth_date             TEXT,               -- 'YYYY-MM-DD'，年龄前端算，不落库
  id_card_type           TEXT,
  id_card_no             TEXT,
  -- 联系方式
  guardian_name          TEXT,
  guardian_relation      TEXT,
  phone_primary          TEXT NOT NULL,
  phone_secondary        TEXT,
  wechat                 TEXT,
  address                TEXT,
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  -- 课程与会员
  dance_types            TEXT,               -- JSON 数组字符串
  current_level          TEXT,
  enroll_date            TEXT,
  main_teacher           TEXT,
  class_schedule         TEXT,
  card_type              TEXT,
  remaining_lessons      INTEGER,
  card_expire_date       TEXT,
  status                 TEXT NOT NULL DEFAULT '在读',
  -- 健康与安全
  health_allergy         TEXT,
  health_history         TEXT,
  health_notes           TEXT,
  -- 运营
  source_channel         TEXT,
  referrer               TEXT,
  remark                 TEXT,
  -- 自定义字段：{ "<field_key>": <value> }
  custom_fields          TEXT NOT NULL DEFAULT '{}',
  -- 元数据
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  deleted_at             TEXT                -- 非空即已软删除
);
CREATE INDEX idx_students_name   ON students(name);
CREATE INDEX idx_students_phone  ON students(phone_primary);
CREATE INDEX idx_students_status ON students(status);
CREATE INDEX idx_students_deleted ON students(deleted_at);

-- 「活页的标签说明」：只描述管理者自定义的字段，不含预设字段
CREATE TABLE field_definitions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  field_key     TEXT NOT NULL UNIQUE,        -- 英文 slug，存储 / 读取用
  label         TEXT NOT NULL,               -- 显示名
  type          TEXT NOT NULL,               -- text|textarea|number|date|select|multiselect|boolean|phone|money
  options       TEXT NOT NULL DEFAULT '[]',  -- JSON 数组，仅 select/multiselect 用
  required      INTEGER NOT NULL DEFAULT 0,
  group_key     TEXT NOT NULL,               -- basic|contact|course|health|ops
  sort_order    INTEGER NOT NULL DEFAULT 0,
  sensitive     INTEGER NOT NULL DEFAULT 0,  -- 保留，本版不强制脱敏
  archived      INTEGER NOT NULL DEFAULT 0,  -- 软删除：字段消失，数据保留
  default_value TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- 标签
CREATE TABLE tags (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  name  TEXT NOT NULL UNIQUE,
  color TEXT                                 -- token 名，如 'cc-3'
);

-- 学员 ↔ 标签 多对多
CREATE TABLE student_tags (
  student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id)     ON DELETE CASCADE,
  PRIMARY KEY (student_id, tag_id)
);
```
