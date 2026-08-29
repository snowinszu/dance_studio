# PRD: 管理平台首页与应用外壳

## 1. 概述 / Introduction

「晓·乐舞艺术空间」综合管理平台是一个 **Electron 桌面应用**。本次交付目标是把设计稿 `ui_kits/app/index.html` 落地成应用的**首页**，并搭出能双击运行的 Electron 外壳。

打个比方：这一步只装修「大堂」——进门看到的欢迎语、今日概况、以及通往各个功能科室的「门牌」。科室里面（学员档案、课程安排、考勤管理、库存管理、数据报表）本次**只挂一块「敬请期待」的牌子**，具体业务后续单独排期。

面向读者：初级开发或 AI agent 均可据此实现。

## 2. 目标 / Goals

- 项目根目录产出 `index.html`，作为 Electron 应用启动后加载的首页，视觉 100% 对齐 `ui_kits/app/index.html`
- 搭建最小 Electron 外壳（主进程 + 窗口 + preload），`npm start` 即可打开桌面窗口
- 首页应用网格**只保留 5 张卡片**：学员档案、课程安排、考勤管理、库存管理、数据报表
- 从首页移除「收支记账、通知公告、教室预约」3 张卡片，并同步「N 个应用」计数
- 5 张卡片均可点击进入统一的「敬请期待」占位页，并能返回首页
- 全程遵循设计系统：只用 `var(--token)`，不出现裸 hex

## 3. 用户故事 / User Stories

### US-001: 搭建 Electron 应用外壳
**Description:** 作为开发者，我需要一个最小可运行的 Electron 外壳，以便把首页作为桌面窗口打开。

**Acceptance Criteria:**
- [ ] 新增 `package.json`，含 `start` 脚本（`electron .`）与 Electron 依赖（[Assumption] Electron 31+）
- [ ] 主进程入口在应用 ready 后创建**单个** `BrowserWindow`，默认尺寸 1200×800、最小 720×600
- [ ] 窗口 `webPreferences` 设置 `contextIsolation: true`、`nodeIntegration: false`，并加载 `preload`
- [ ] 窗口通过 `loadFile` 加载项目根目录 `index.html`
- [ ] 主进程 / preload 使用 TypeScript strict 编译（沿用全局 Node 规范）
- [ ] `npm start` 后出现应用窗口，主进程与渲染进程控制台均无报错
- [ ] Typecheck / lint 通过

### US-002: 首页 HTML 落地（基于 UI kit 模板）
**Description:** 作为管理员，我打开应用后希望看到与设计稿一致的首页。

**Acceptance Criteria:**
- [ ] 项目根目录存在 `index.html`，由 `ui_kits/app/index.html` 迁移而来
- [ ] `<head>` 中以正确相对路径引入 `colors_and_type.css`
- [ ] 页面渲染出：问候区（徽章 + 标题「晓·乐舞艺术空间」+ 问候语）、快速统计条、日期卡片、管理工具网格、页脚
- [ ] 页面样式中**无裸 hex**，颜色全部为 `var(--token-name)`
- [ ] `--accent` 强调色在首页出现不超过 2 次（收敛模板现状：徽章、`.red` 标题、日期星期、统计单位等需取舍到 ≤2 处）
- [ ] 悬停卡片时文字对比度不下降
- [ ] Typecheck / lint 通过
- [ ] 在 Electron 窗口中人工核对视觉与设计稿一致（可借助 `run` skill）

### US-003: 应用网格裁剪为 5 张卡片
**Description:** 作为管理员，首页只应展示本期上线的 5 个应用，避免误点未开放功能。

**Acceptance Criteria:**
- [ ] 应用网格恰好包含 5 张 `.app-card`：学员档案、课程安排、考勤管理、库存管理、数据报表
- [ ] 页面中不再出现「收支记账」「通知公告」「教室预约」任何文案或卡片节点
- [ ] 「管理工具」标题右侧计数显示「5 个应用」
- [ ] 5 张卡片在桌面宽度下呈 1 行（≤920px 时为 2 列），无空位错排
- [ ] Typecheck / lint 通过
- [ ] 在 Electron 窗口中人工核对（可借助 `run` skill）

### US-004: 卡片跳转到占位页
**Description:** 作为管理员，点击某个应用卡片时，应进入该应用对应的页面。

**Acceptance Criteria:**
- [ ] 每张卡片 `href` 指向 `placeholder.html?app=<key>`，`key` 分别为 `students / schedule / attendance / inventory / reports`（[Assumption] 单一占位页 + 查询参数）
- [ ] 点击卡片后窗口导航到占位页（无新开窗口、无外部浏览器）
- [ ] 键盘 `Tab` 可聚焦卡片，`Enter` 可触发跳转，聚焦有可见 outline
- [ ] Typecheck / lint 通过
- [ ] 在 Electron 窗口中人工核对 5 张卡片逐一跳转正确（可借助 `run` skill）

### US-005: 「敬请期待」占位页
**Description:** 作为管理员，进入尚未开放的应用时，应看到清晰的「敬请期待」提示并能返回首页。

**Acceptance Criteria:**
- [ ] 存在 `placeholder.html`，引入 `colors_and_type.css`
- [ ] 根据 `?app=` 参数显示对应中文应用名（如「学员档案」）作为标题
- [ ] 页面主体显示「敬请期待」文案与一句说明（如「该功能正在开发中」）
- [ ] 顶部导航复用首页样式，含品牌标识与「返回首页」入口，点击回到 `index.html`
- [ ] 参数缺失或非法时，标题回退为「敬请期待」，不报错
- [ ] 样式无裸 hex；`--accent` 每屏出现不超过 2 次
- [ ] Typecheck / lint 通过
- [ ] 在 Electron 窗口中人工核对（可借助 `run` skill）

### US-006: 首页问候语与日期卡片动态渲染
**Description:** 作为管理员，我希望首页的问候语和日期随当前时间自动更新。

**Acceptance Criteria:**
- [ ] 模板内联脚本在渲染进程正常执行（`contextIsolation` 下无需 Node API）
- [ ] 问候语按当前小时显示：<12 早上好 / <18 下午好 / 否则晚上好
- [ ] 日期卡片显示当前「星期 / 日 / 年 月」，数值与系统时间一致
- [ ] 跨过整分钟后文本自动刷新（`setInterval` 生效）
- [ ] 控制台无 `undefined` / null 引用报错
- [ ] Typecheck / lint 通过
- [ ] 在 Electron 窗口中人工核对（可借助 `run` skill）

### US-007: 窗口尺寸与响应式布局
**Description:** 作为管理员，我调整窗口大小时，首页布局应保持可用不错乱。

**Acceptance Criteria:**
- [ ] 窗口宽度 >920px：统计条 4 列、应用网格 4 列
- [ ] 窗口宽度 ≤920px：统计条 2 列、应用网格 2 列、日期卡片隐藏（沿用模板断点）
- [ ] 缩到最小尺寸（720×600）时无横向滚动条，内容不溢出
- [ ] 顶栏在滚动时保持吸顶
- [ ] Typecheck / lint 通过
- [ ] 在 Electron 窗口中拖拽改变尺寸人工核对（可借助 `run` skill）

### US-008: 首页与占位页流程的端到端测试
**Description:** 作为 QA 工程师，我需要一个覆盖「启动 → 首页 → 进入占位页 → 返回」完整链路的自动化 E2E 测试，以便跨整个外壳捕获回归。

**Acceptance Criteria:**
- [ ] E2E 测试（Playwright `_electron`）启动应用并等待首页窗口出现
- [ ] 断言首页恰好渲染 5 张 `.app-card`，且页面文本不含「收支记账 / 通知公告 / 教室预约」
- [ ] 模拟点击「学员档案」卡片，断言窗口导航到占位页且页面同时含「学员档案」与「敬请期待」
- [ ] 覆盖返回路径：点击占位页「返回首页」，断言回到首页（再次出现 5 张卡片）
- [ ] 覆盖边界：直接打开 `placeholder.html`（无 `?app=` 参数），断言标题回退为「敬请期待」且无报错
- [ ] 测试在 CI 中运行并通过
- [ ] 测试自启动、自关闭应用，独立可重复

## 4. 功能需求 / Functional Requirements

- FR-1: 系统必须提供 Electron 主进程入口，应用 ready 后创建单个应用窗口
- FR-2: 应用窗口必须以 `loadFile` 加载项目根目录 `index.html` 作为首页
- FR-3: 窗口必须启用 `contextIsolation` 并禁用 `nodeIntegration`
- FR-4: 首页 `<head>` 必须引入 `colors_and_type.css` 设计令牌文件
- FR-5: 首页与占位页样式必须只使用 `var(--token-name)`，不得出现裸十六进制色值
- FR-6: 首页应用网格必须只显示 5 张卡片：学员档案、课程安排、考勤管理、库存管理、数据报表
- FR-7: 系统必须从首页移除「收支记账」卡片
- FR-8: 系统必须从首页移除「通知公告」卡片
- FR-9: 系统必须从首页移除「教室预约」卡片
- FR-10: 「管理工具」标题右侧的应用计数必须显示「5 个应用」
- FR-11: 点击任一应用卡片时，窗口必须在当前窗口内导航到 `placeholder.html` 并带上对应 `app` 查询参数
- FR-12: 占位页必须依据 `app` 查询参数显示对应中文应用名作为标题
- FR-13: 占位页必须显示「敬请期待」提示文案
- FR-14: 占位页必须提供「返回首页」导航入口，点击后加载 `index.html`
- FR-15: 占位页在 `app` 参数缺失或非法时必须将标题回退为「敬请期待」且不抛错
- FR-16: 首页问候语必须根据当前小时显示早/午/晚三种文案之一
- FR-17: 首页日期卡片必须显示当前星期、日、年月
- FR-18: 首页在窗口宽度 ≤920px 时必须切换为统计条 2 列、应用网格 2 列并隐藏日期卡片
- FR-19: 应用卡片必须可通过键盘聚焦并以 `Enter` 触发跳转，聚焦态有可见 outline
- FR-20: 首页 `--accent` 强调色的可见使用次数不得超过 2 次（对模板现状做收敛）

## 5. 非目标 / Non-Goals (Out of Scope)

- 不实现任何子应用的实际业务功能（列表、详情、增删改查、报表图表等）
- 不接入后端、数据库或任何数据持久化（含 localStorage）
- 不做用户登录、权限或多角色
- 不做应用打包分发（.dmg / .exe 安装包）与自动更新
- 不修改 `colors_and_type.css` 令牌与 `DESIGN.md`
- 快速统计条数字沿用模板示例值（248 人 / 36 人 / 8 节 / ¥5.2 万），不做数据联动，也不预留数据接口占位
- 不恢复被移除的 3 张卡片，也不为其建占位页
- 占位页不含「预计上线时间」文案位
- 不做 Electron 应用菜单栏（Menu）与自定义快捷键

## 6. 设计考量 / Design Considerations

- 以 `ui_kits/app/index.html` 为首页起点，尽量少改结构
- 占位页复用首页顶栏样式（品牌标识 + 标题），保证视觉连续
- Electron 目标为桌面端，窗口默认 1200×800、最小 720×600；模板内容 `max-width: 1120px` 居中
- 遵循 `DESIGN.md` 组件规则与反模式；`--accent` 每屏至多出现 2 次
- 全局「Mobile First」在此转化为「窗口可缩到窄栏仍完全可用、无横向滚动」

## 7. 技术考量 / Technical Considerations

- Electron 稳定版（[Assumption] 31+）；主进程 / preload 用 TypeScript strict（已确认），渲染层沿用模板纯 HTML/CSS/JS
- 页面间跳转走 `file://` 相对路径（渲染层 `window.location.href` 或 `<a href>`）
- 卡片 → 占位页采用单一 `placeholder.html?app=<key>`（[Assumption]），避免 5 份重复文件
- 模板内联脚本（时钟 / 问候）在 `contextIsolation` 渲染进程可直接运行，无需 Node API
- E2E 采用 Playwright 的 Electron 支持（`_electron.launch`）

## 8. 成功指标 / Success Metrics

- `npm start` 后 2 秒内出现首页窗口
- 首页仅 5 张卡片，5 张均可进入占位页并返回，全程零 console 报错
- Typecheck / lint 通过
- E2E 测试在 CI 稳定通过

## 9. 已决策 / Resolved Decisions

- **`--accent` 使用次数**：收敛到每屏至多 2 次（见 FR-20 / US-002）
- **主进程 / preload 语言**：TypeScript strict
- **占位页「预计上线时间」文案位**：不需要
- **Electron 菜单栏与快捷键**：不需要
- **统计条数据接口占位**：不需要，本期沿用模板示例值

## 10. 待确认问题 / Open Questions

- 无（初始待确认问题均已在第 9 节决策）
