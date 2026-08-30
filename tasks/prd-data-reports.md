# PRD: 数据报表模块

## Introduction / Overview

「晓·乐舞艺术空间」管理平台的第 5 个模块。前四个模块(学员档案、库存管理、考勤管理、课程安排)已经把数据一条条录进了本地 SQLite,但老板每天真正想要的是「一眼看清经营状况」:这个月上了多少节课、哪些学员快流失了、哪样物料要补货、哪个老师课时最满。

数据报表模块把这四个模块里**有价值的指标**重新「称重、排队、画趋势」,汇总到一个页面上;并提供一个**按班级分 sheet 的 Excel 出勤统计表**给老板存档 / 打印。

它是一个**纯只读模块**:不新增数据库表、不写任何迁移、不修改任何业务数据,只新增一批 `reports:*` 的聚合查询 IPC 和一个导出 IPC。

- 首页身份色:`--cc-8`(暗梅紫)
- 替换 `index.html` 中 `placeholder.html?app=reports` 的卡片链接为 `reports.html`
- 页面外壳:拷 `students.html`(同一套 `:root` token fallback + `colors_and_type.css`)

## Goals

- 一个页面聚合展示考勤 / 课程 / 学员 / 库存四个模块的关键指标,支持「本月 / 本年 / 自定义起止」时间范围切换
- 第一屏是**预警中心**:把「今天必须处理」的红点(低库存、课时不足、沉睡学员、空课)集中成清单
- 提供**出勤排名**(出勤次数 / 出勤率可切换)
- 提供 **Excel 出勤统计导出**:首 sheet「全校汇总」+ 之后每班一个 sheet,行=学员,列=1–12 月上课次数,缺勤率高标黄、全年未到课标红
- 全程只读:`npm run typecheck && npm run lint && npm run test:unit` 通过,不改 `migrations.ts`

## User Stories

### US-001: 报表模块页面外壳与首页接线
**Description:** As a 管理者, I want 从首页「数据报表」卡片进入一个真正的报表页, so that 后续指标区有地方挂载。

**Acceptance Criteria:**
- [ ] 新增 `reports.html`(拷 `students.html` 外壳,`<head>` link `colors_and_type.css`,身份色 `--cc-8`)+ `reports.js`(手写 ES module,复用 `el()` / `unwrap()` / `#toast` / `#/hash` 路由)
- [ ] `index.html` 的 `app-card-reports` 链接由 `placeholder.html?app=reports` 改为 `reports.html`,`--cc` 保持 `var(--cc-8)`
- [ ] `reports.html` / `reports.js` 加入 `electron-builder.yml` 的 `files`
- [ ] `src/preload.ts` 暴露 `window.studioShell.reports` 命名空间(本 US 可为空对象占位),`studioShell.d.ts` 加 `reports` 类型声明
- [ ] 页面顶部有返回首页入口;点击回到 `index.html`
- [ ] 页面有一个时间范围控件骨架:「本月 / 本年 / 自定义」三选一 + 自定义时两个日期输入(本 US 只需渲染,不需联动数据)
- [ ] Typecheck / lint 通过
- [ ] Verify in a browser(via the `run` skill):页面打开无 `pageErrors`,返回键可用

### US-002: SVG 图表工具函数
**Description:** As a 开发者, I want 一组不依赖任何图表库的纯函数生成柱状 / 折线 / 热力图, so that 各指标区能离线渲染可视化(Electron 无网络、项目无打包器,不能引 CDN)。

**Acceptance Criteria:**
- [ ] 新增 `reports.charts.js`(或 `reports.js` 内的独立段),导出 `barChart(series, opts)` / `lineChart(points, opts)` / `heatmap(matrix, opts)`,返回 SVG 字符串或 DOM 节点
- [ ] 三个函数均为纯函数:相同入参产出相同 SVG,不访问全局状态、不发 IPC
- [ ] 坐标 / 比例换算逻辑(如 `scaleY`、polyline `points` 串、bar `x/height`)拆成可单测的纯函数
- [ ] `tests/unit/reports-charts.test.ts`(`node:test`):对换算函数断言已知输入→输出;对空数组 / 单点 / 全 0 数据不抛错
- [ ] SVG 用 `var(--token)` 上色(柱 / 线用 `--cc-8`,预警用 `--cc-1`);不出现裸 hex
- [ ] 宽度自适应容器(`viewBox` + `preserveAspectRatio`),移动端单列不溢出
- [ ] Typecheck / lint / test:unit 通过

### US-003: 概览 KPI 卡片行 + 时间范围联动
**Description:** As a 管理者, I want 页面顶部一行概览卡片随时间范围切换刷新, so that 我进页面第一眼就知道核心数字。

**Acceptance Criteria:**
- [ ] `src/domain/reports.repo.ts` 新增 `getOverview({ from, to })`:纯 SELECT,返回 `{ activeStudents, checkInsInRange, sessionsInRange, newStudentsLast30d, lowBalanceCount, lowStockCount }`
- [ ] `activeStudents` = `students.status='在读' AND deleted_at IS NULL` 计数
- [ ] `checkInsInRange` = `attendance_records` 中 `type IN ('出勤','补课') AND deleted_at IS NULL AND attend_date BETWEEN from AND to` 计数
- [ ] `sessionsInRange` = `class_sessions` 中 `status='正常' AND deleted_at IS NULL AND session_date BETWEEN from AND to` 计数
- [ ] `lowBalanceCount` = `students.status='在读' AND deleted_at IS NULL AND remaining_lessons <= 3` 计数
- [ ] `lowStockCount` = `inventory_items.deleted_at IS NULL AND quantity <= low_stock_threshold` 计数
- [ ] 新增 IPC channel `reports:overview`(`CH` 常量 + `register.ts` `handle()` 包装,返回 `IpcResult`)+ `preload.ts` 暴露 `studioShell.reports.overview` + `studioShell.d.ts` 类型
- [ ] 时间范围控件切「本月 / 本年 / 自定义」后重新调用 `reports.overview`,卡片数字刷新;「本月」= 当月 1 号到今天,「本年」= 1 月 1 号到今天
- [ ] `tests/unit/reports-repo.test.ts`:临时库塞已知数据,断言六个字段口径正确(含边界:软删记录不计、范围外不计)
- [ ] Typecheck / lint / test:unit 通过
- [ ] Verify in a browser(via the `run` skill):切换时间范围数字变化

### US-004: 预警中心
**Description:** As a 管理者, I want 一个汇总清单列出所有需要立刻处理的异常, so that 我不用逐个模块翻。

**Acceptance Criteria:**
- [ ] `reports.repo.ts` 新增 `getAlerts()`:返回四组清单
  - `lowStock`: `inventory_items` 中 `quantity <= low_stock_threshold`,含 `name / quantity / threshold`
  - `lowBalance`: 在读学员 `remaining_lessons <= 3`,含 `name / remaining_lessons`
  - `dormant`: `status='在读' AND deleted_at IS NULL` 且近 60 天无 `type='出勤'` 记录的学员,含 `name / lastAttendDate`
  - `emptySessions`: 近 30 天内 `session_date <= 今天` 的 `正常` 课节,关联出勤(`session_id` 匹配、`type IN ('出勤','补课')`)人数为 0 的,含 `className / sessionDate / startTime`
- [ ] 新增 IPC `reports:alerts` + preload + d.ts
- [ ] 渲染为报表页第一屏:四张分组卡,每组显示计数徽标 + 明细行;空组显示「暂无」
- [ ] 预警红点用 `--cc-1`(暖红,不计入 `--accent` 预算);`--accent` 全页 ≤ 2 次
- [ ] `reports-repo.test.ts` 覆盖四组口径,含边界(恰好等于阈值算预警、第 60 天算沉睡与否明确)
- [ ] Typecheck / lint / test:unit 通过
- [ ] Verify in a browser(via the `run` skill)

### US-005: 考勤指标区
**Description:** As a 管理者, I want 看到考勤维度的趋势和排名, so that 我知道生意冷热、谁靠谱、谁要流失。

**Acceptance Criteria:**
- [ ] `reports.repo.ts` 新增 `getAttendanceStats({ from, to })`,返回:
  - `sessionsThisMonth` / `sessionsThisYear`(课节数,口径同 US-003)
  - `monthlyCheckIns`: 所选范围按自然月分组的出勤人次(`type IN ('出勤','补课')`),数组长度对齐范围内月份数
  - `ranking`: 每个学员的 `出勤次数` 与 `出勤率`(出勤率 = 出勤 /(出勤+缺勤+请假),分母为 0 时为 `null`),按当前排序键降序
  - `absenceTop`: 近 30 天 `缺勤 + 请假` 次数最多的前 10 名学员
  - `byTeacher` / `byDanceType`: 按 `attendance_records.teacher` / `class_name` 分组的出勤人次
  - `hourHeatmap`: 按星期(0–6)× 时段桶(如 2 小时一桶)分组的出勤人次矩阵,`attend_time` 为空的归入「未知」并单列
- [ ] 新增 IPC `reports:attendanceStats` + preload + d.ts
- [ ] 渲染:课节数卡 + 月度出勤人次折线(`lineChart`)+ 出勤排名表(表头可点切「按次数 / 按出勤率」)+ 缺勤 TOP 表 + 老师 / 舞种柱状(`barChart`)+ 时段热力(`heatmap`)
- [ ] 排名表出勤率显示为百分比;`null` 显示「—」
- [ ] `reports-repo.test.ts` 覆盖 `ranking` 排序与出勤率计算、`monthlyCheckIns` 月份对齐、软删不计
- [ ] Typecheck / lint / test:unit 通过
- [ ] Verify in a browser(via the `run` skill)

### US-006: 课程指标区
**Description:** As a 管理者, I want 看到排课和老师负荷情况, so that 我能安排代课、发现空课、评估满员率。

**Acceptance Criteria:**
- [ ] `reports.repo.ts` 新增 `getCourseStats({ from, to })`,返回:
  - `teacherLoad`: 按 `class_sessions.teacher_id` 分组的课节数与总时长(分钟),时长 = `end_time` 分钟数 − `start_time` 分钟数(`'HH:MM'` 在 SQL 内换算),join `teachers.name`,排除软删 / 停课课节
  - `cancelRate`: `停课` 课节数 ÷ 全部未软删课节数(范围内),分母 0 时为 `null`
  - `classFillRate`: 每个未结课班级的 `在册人数(class_students.left_at IS NULL) ÷ classes.capacity`;`capacity` 为空时该班返回 `null` 占比
  - `emptySessions`: 范围内 `session_date <= 今天` 且出勤人数为 0 的正常课节列表(同 US-004 口径,此处受时间范围约束)
- [ ] 新增 IPC `reports:courseStats` + preload + d.ts
- [ ] 渲染:老师课时负荷柱状 + 停课率数字 + 班级满员率列表(进度条,`capacity` 缺失显示「未设容量」)+ 空课清单
- [ ] `reports-repo.test.ts` 覆盖时长换算(跨整点、含分钟)、满员率 null 分支、停课率
- [ ] Typecheck / lint / test:unit 通过
- [ ] Verify in a browser(via the `run` skill)

### US-007: 学员指标区
**Description:** As a 管理者, I want 看到学员结构和增长趋势, so that 我了解客群构成、获客节奏、需要跟进的续费与流失。

**Acceptance Criteria:**
- [ ] `reports.repo.ts` 新增 `getStudentStats({ from, to })`,返回:
  - `statusDist`: 按 `students.status` 分组计数(排除软删)
  - `danceTypeDist`: 按舞种分组计数;`dance_types` 是 JSON 数组字符串,用 SQLite `json_each` 展开
  - `levelDist`: 按 `current_level` 分组计数(空值归「未分级」)
  - `monthlyNew`: 所选范围按 `enroll_date` 自然月分组的新增学员数
  - `referrerTop`: 按 `referrer` 分组计数前 10(空值不计)
  - `lowBalance`: 在读且 `remaining_lessons <= 3` 的学员(含 `name / remaining_lessons`)
  - `dormant`: 同 US-004 沉睡口径
- [ ] 新增 IPC `reports:studentStats` + preload + d.ts
- [ ] 渲染:状态 / 舞种 / 等级分布(柱状或占比条)+ 月度新增折线 + 转介绍排行表 + 课时余额预警表 + 沉睡学员表
- [ ] `reports-repo.test.ts` 覆盖 `json_each` 舞种展开(一个学员多舞种计多次)、`monthlyNew` 月份对齐、空值归类
- [ ] Typecheck / lint / test:unit 通过
- [ ] Verify in a browser(via the `run` skill)

### US-008: 库存指标区
**Description:** As a 管理者, I want 看到库存和领用情况, so that 我知道该补什么货、哪些物料在闲置。

**Acceptance Criteria:**
- [ ] `reports.repo.ts` 新增 `getInventoryStats({ from, to })`,返回:
  - `lowStock`: `quantity <= low_stock_threshold` 的物件(含 `name / quantity / threshold`)
  - `totals`: `{ itemKinds, totalQuantity }`(未软删物件的品类数与件数合计)
  - `monthlyAllocations`: 所选范围按 `item_allocations.claimed_at` 自然月分组的领用件数
  - `topItems` / `topStudents`: 范围内按物件 / 按学员分组的领用件数前 10
  - `staleItems`: 距今 90 天以上无任何领用记录、且 `quantity > 0` 的未软删物件
- [ ] 新增 IPC `reports:inventoryStats` + preload + d.ts
- [ ] 渲染:低库存预警表 + 合计卡 + 领用月度折线 + 领用 TOP 物件 / 学员表 + 呆滞物料表
- [ ] `reports-repo.test.ts` 覆盖 `staleItems` 的 90 天边界与「从未领用」情形、`monthlyAllocations` 月份对齐
- [ ] Typecheck / lint / test:unit 通过
- [ ] Verify in a browser(via the `run` skill)

### US-009: 按班级分 sheet 的 Excel 出勤统计导出
**Description:** As a 管理者, I want 导出一份每个班级一个 sheet、行是学员、列是 1–12 月上课次数的 Excel, so that 我能存档、打印、发给家长看。

**Acceptance Criteria:**
- [ ] `src/io/reports-xlsx.ts` 新增 `exportAttendanceByClass({ year })`,用 `exceljs`,复用 `src/io/xlsx-util.ts` 的 `pickSavePath` / `ymdCompact`
- [ ] `reports.repo.ts` 新增只读查询 `getClassAttendanceMatrix({ year })` 供导出用:返回每个班级的 `{ classId, className, rows: [{ studentName, left, monthly: number[12], yearTotal, monthlyAbsenceRate: (number|null)[12] }] }`,外加一个 `schoolWide` 汇总块(结构同上,`rows` 为全校学员)
- [ ] **首个 sheet 为「全校汇总」**:行 = 本年 `status='在读'` 或本年有考勤记录的全部未软删学员(按姓名排序);单元格数值 = 该学员该月**全校**(不限班级、含 `session_id IS NULL`)的 `type IN ('出勤','补课')` 计数;因此全校汇总的合计可能大于各班 sheet 之和(未关联课节的出勤只进这里)
- [ ] 全校汇总 sheet 的标黄口径 = 该学员该月全校「已排(出勤+缺勤+请假)> 0 且缺勤占比 ≥ 50%」;标红口径 = 全年全校合计(出勤+补课)= 0
- [ ] **出班级 sheet 的班级**:所选年份内有过 `class_sessions`(`deleted_at IS NULL`)的班级,每班一个 sheet,排在「全校汇总」之后
- [ ] **sheet 名**:班级名,清洗掉 `: \ / ? * [ ]` 并截断到 31 字符;重名追加 `#<classId>`
- [ ] **行**:该班 `class_students` 花名册全部学员;`left_at` 非空的学员姓名追加「(已离班)」;排序 = 在册在前(按姓名)、已离班在后(按姓名)
- [ ] **列**:A=学员姓名,B–M=1 月…12 月,N=全年合计
- [ ] **单元格数值** = 该学员该月在**本班课节**(`attendance_records.session_id ∈ 本班 class_sessions`)的 `type IN ('出勤','补课') AND deleted_at IS NULL` 计数;全年合计 = 12 个月之和
- [ ] **标黄**:某月单元格,当该月「本班已排」(出勤+缺勤+请假)> 0 且 `缺勤 ÷ 已排 ≥ 0.5`,填充浅黄底
- [ ] **标红**:学员姓名单元格,当全年合计(出勤+补课)= 0,填充浅红底;红与黄互不排斥
- [ ] sheet 顶部有标题行(班级名 + 年份)与图例行(「黄=当月缺勤率≥50% 红=全年未到课」);冻结表头行与姓名列
- [ ] 无合格班级时:返回可读错误 → 页面 `#toast` 提示「所选年份无排课班级,无法导出」,不弹保存框
- [ ] 未关联课节(`session_id IS NULL`)的出勤不进班级统计;报表页显示提示「本年 N 条出勤未关联课节,未纳入班级统计」(计数来自 `reports.repo.ts`)
- [ ] 新增 IPC `reports:exportAttendanceByClass` + preload + d.ts;导出成功后 `#toast` 显示保存路径
- [ ] `tests/unit/reports-xlsx.test.ts`:生成到临时文件后用 `exceljs` 读回,断言首 sheet 为「全校汇总」、班级 sheet 数、某已知单元格数值、一个标黄单元格 fill、一个标红姓名 fill、已离班后缀、全校汇总合计 ≥ 对应学员各班 sheet 之和
- [ ] Typecheck / lint / test:unit 通过
- [ ] Verify in a browser(via the `run` skill):点击导出走保存框、生成文件

### US-010: 数据报表全流程 E2E 测试
**Description:** As a QA engineer, I want 一个覆盖报表页完整链路的自动化端到端测试, so that 跨整个栈的回归能被捕获。

**Acceptance Criteria:**
- [ ] `tests/e2e/reports.spec.ts`,Playwright `_electron`,`env.STUDIO_DB_PATH` → 临时文件,自建自清数据(学员 / 老师 / 班级 / 花名册 / 周期规则 / 课节 / 考勤 / 库存 / 领用)
- [ ] 走完整 happy path:从 `index.html` 点「数据报表」卡片 → 报表页加载 → 断言概览 KPI 某个已知数字 → 切「本年」→ 断言数字随之变化 → 断言出勤排名表首行是预期学员 → 切「按出勤率」排序表头 → 断言顺序变化
- [ ] 触发 Excel 导出(保存路径用测试注入 / mock),用 `exceljs` 打开产物,断言:首 sheet 为「全校汇总」、其后按班级拆分、一个已知月份单元格数值正确、一个标黄单元格、一个标红姓名
- [ ] 覆盖至少一条边界:空数据库时报表页各区显示空态且不抛错;或所选年份无排课班级时导出走 toast 分支
- [ ] 全程断言无 `pageErrors`
- [ ] 测试在 CI 通过,独立可重复

## Functional Requirements

- FR-1: 系统必须新增 `reports.html` / `reports.js`,外壳拷 `students.html`,链接 `colors_and_type.css`,身份色使用 `--cc-8`
- FR-2: 系统必须把 `index.html` 的报表卡片链接从 `placeholder.html?app=reports` 改为 `reports.html`,并把两个新 renderer 文件加入 `electron-builder.yml` 的 `files`
- FR-3: 系统不得新增数据库表或迁移;`reports.repo.ts` 只允许 `SELECT`
- FR-4: 系统必须提供「本月 / 本年 / 自定义起止」时间范围控件,所有随范围变化的指标必须在切换后重新查询刷新
- FR-5: 系统必须提供概览 KPI 行:在读学员数、范围内出勤人次、范围内课节数、近 30 天新增学员、课时余额预警数、低库存预警数
- FR-6: 系统必须提供预警中心,汇总低库存、课时余额 ≤ 3、近 60 天无出勤的在读学员、近 30 天 0 出勤的正常课节四组清单
- FR-7: 系统必须提供出勤排名,默认按「出勤次数」降序,可切换为「按出勤率」;出勤率 = 出勤 /(出勤 + 缺勤 + 请假),分母为 0 显示「—」
- FR-8: 系统必须提供月度出勤人次、月度新增学员、月度领用件数三条趋势,按所选范围的自然月对齐
- FR-9: 系统必须提供老师课时负荷(课节数 + 总时长分钟)、停课率、班级满员率、空课清单
- FR-10: 系统必须提供学员状态 / 舞种 / 等级分布、转介绍排行、课时余额预警、沉睡学员清单
- FR-11: 系统必须提供低库存清单、库存合计、领用 TOP 物件 / 学员、呆滞物料(90 天无领用且在库 > 0)清单
- FR-12: 可视化必须用手写 SVG(柱状 / 折线 / 热力),不得引入任何图表库或 CDN 资源;SVG 一律用 `var(--token)` 上色
- FR-13: 系统必须提供「导出 Excel 出勤统计」:首个 sheet 为「全校汇总」(行=本年在读或有考勤记录的全部学员,数值=当月全校出勤+补课计数),其后每班一个 sheet(行为花名册学员,已离班者姓名加「(已离班)」后缀);所有 sheet 列均为 1–12 月上课次数(出勤 + 补课)加全年合计
- FR-14: 导出时,某月单元格当「本班当月已排(出勤+缺勤+请假)> 0 且缺勤占比 ≥ 50%」必须标浅黄;学员姓名单元格当「全年合计 = 0」必须标浅红
- FR-15: 导出的 sheet 名必须清洗非法字符并截断到 31 字符,重名追加 `#<classId>`;必须冻结表头行与姓名列,并含标题行与图例行
- FR-16: 所选年份无合格班级时,系统不得弹出保存框,必须通过 `#toast` 给出可读提示
- FR-17: `session_id` 为空的考勤记录不得计入各班级 sheet(但计入「全校汇总」sheet);报表页必须显示当年未关联课节的出勤条数提示
- FR-18: 所有 `reports:*` IPC 必须经 `register.ts` 的 `handle()` 包装,跨边界只返回 `IpcResult`,不抛异常
- FR-19: 所有聚合必须在 SQL 内完成(better-sqlite3 同步),不得把整表拉进 JS 再循环统计

## Non-Goals (Out of Scope)

- 不做会员卡到期预警
- 不做生源渠道(`source_channel`)分析
- 不做代课次数统计
- 不做试听人数 / 试听转化率
- 不做收支 / 财务类指标(属未来「收支」模块 `--cc-5`)
- 不做自定义报表构建器 / 用户自选维度
- 不做定时导出、邮件推送、PDF 导出、打印排版优化
- 不做跨年对比、同比环比
- 不写数据库迁移,不改任何业务数据
- 不做数据钻取(点图表跳到明细页)

## Design Considerations

- 外壳、token fallback、`el()` / `unwrap()` / `#toast` / `#/hash` 路由全部沿用 `students.html` / `students.js` 既有写法
- 身份色 `--cc-8`;`--accent` 全页出现 ≤ 2 次;预警红点用 `--cc-1`(暖红,不计入 `--accent` 预算)
- Mobile First:移动端单列纵向堆叠,SVG 图表 `viewBox` 自适应容器宽度,横向不溢出;桌面端向上扩展为网格
- 页面信息层级:预警中心(第一屏)→ 概览 KPI 行 → 考勤区 → 课程区 → 学员区 → 库存区 → 导出按钮;各区可折叠
- Excel 填充色:浅黄 / 浅红用 `exceljs` 的 ARGB 常量(xlsx 内不涉及设计 token)

## Technical Considerations

- 只读模块:`src/domain/reports.repo.ts`(+ 无 validation 层,无写操作)、`src/io/reports-xlsx.ts`、`src/ipc/channels.ts` 追加 `reports:*` 常量、`src/ipc/register.ts` 追加 `handle()`、`src/preload.ts` 追加命名空间、`studioShell.d.ts` 追加类型
- 舞种分布依赖 SQLite `json_each`(better-sqlite3 内置 SQLite 支持)
- `'HH:MM'` 时长换算在 SQL 内:`(substr(t,1,2)*60 + substr(t,4,2))`
- 日期范围一律 `'YYYY-MM-DD'` 字典序比较;「近 N 天」用 `date('now', '-N day')`
- 沉睡学员 / 空课 / 呆滞物料均为 `NOT EXISTS` / `LEFT JOIN ... HAVING COUNT(...)=0` 形态,注意排除软删记录
- 单测沿用 `node:test` + `tsconfig.test.json` → `dist-test/`,经 `scripts/test-unit.js` 跑;E2E 沿用 Playwright `_electron` + 临时 `STUDIO_DB_PATH`
- 交付方式(见团队约定):单分支 `feat/reports`,一 issue 一 commit(中文 commit body 列出各层改动),最后一个 PR,PR body 以 `Closes #a, closes #b, …` 结尾;每次 commit 前跑 `npm run typecheck && npm run lint && npm run test:unit`,PR 前跑 `npm test`

## Success Metrics

- 管理者进入报表页 3 秒内看到预警中心与概览数字(本地 SQLite,千级数据量)
- 时间范围切换后所有相关指标一次刷新到位,无残留旧值
- 导出的 Excel 用 Excel / WPS 打开,sheet 按班级分开,标黄标红符合规则,可直接打印
- `npm test` 全绿;`migrations.ts` 零改动

## Open Questions

- 预警中心「近 60 天无出勤」的 60 天、呆滞物料 90 天、空课「近 30 天」这些窗口是否需要做成页面可调?当前定为固定值 [Assumption]
- 时段热力的时段桶粒度(2 小时 / 1 小时)未定,建议实现时取 2 小时
- 「上课次数」列的标红:已离班学员若离班前有出勤、离班后全年合计仍可能为 0(因班级 sheet 只统计在班课节),是否仍标红?当前口径:按最终全年合计判断,会标红 [Assumption]
