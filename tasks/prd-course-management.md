# PRD: 课程管理（班级 + 花名册 + 周期课程表 + 老师上课时间计划表）

> 生成日期：2026-08-30 ｜ 来源：用户需求 + 与「学员档案 / 库存管理 / 考勤管理」三个已上线模块对齐
> 目标：把首页第 3 张卡片「课程安排」（`placeholder.html?app=schedule`，主题色 `--cc-3` 晴空蓝）
> 从占位页做成完整模块。

---

## 1. Introduction / 概述

舞蹈教室每周的课是固定排的：周二 19:00「少儿中国舞 B 班」、周四 19:00 同一个班再上一节，
每个班有一份固定的学员名单。老师这个月具体哪几天来上课，基本就是这些固定课按日历铺开、
再扣掉放假、加上补课、换掉代课。现在这些全在老师脑子里和一张打印的课表上，新学员进班、
调课、代课都靠口头传达，考勤点名还要老师对着纸名单一个个念。

打个比方：

- **「课程表」像列车时刻表** —— 每周几、几点、哪个班、名单是谁，是一份**规则**。（学生 / 前台看这个）
- **「上课时间计划表」像某位乘务员这个月的值乘单** —— 时刻表按日历一铺，9 月张老师跟的就是
  3、5、10、12…这些具体日期；哪天放假划掉、哪天加一节补课写上、哪天她请假换李老师代 —— 是
  **规则落到当月、再逐日微调后的结果**。（老师看这个）

两者不是两套数据，是**同一份底层数据的两个视图**：底层建 5 张表 —— 老师字典 `teachers`、
班级 `classes`、班级花名册 `class_students`、周期规则 `class_schedules`、排课实例 `class_sessions`。
「课程表」= 读周期规则；「上课时间计划表」= 读排课实例（打开时按规则自动补生成当月缺的）。

本模块是本项目第 4 个带持久化的功能，**完全沿用前三个模块趟通的架构流水线**
（`better-sqlite3` + `PRAGMA user_version` 迁移 + 按操作粒度的 IPC + 单页免打包渲染器），
读者可参考 [tasks/spec-attendance-management.md](./spec-attendance-management.md) 与
[tasks/spec-inventory-management.md](./spec-inventory-management.md)。

考勤模块早已在 `attendance_records` 上留好可空的 `session_id` 列（无外键、恒 `NULL`），
本模块上线后，考勤「批量点名」新增「选择课节」，选中即回填 `session_id` 并自动带出花名册。

### 关键规则（本期已定）

- **老师表 `teachers` 走轻量版**：只有「姓名 + 状态」两个业务字段，够排课引用即可；
  不迁移 `students.main_teacher` 自由文本（两者并存，本期不动学员表）。
- **「上课时间计划表」是派生的**：不单独维护「老师可排班日历」。周期规则按月铺成排课实例，
  老师在实例上**逐日微调**：停课 / 改时间（同一天挪时间段）/ 换代课老师 / 手动加课（补课或额外一节）。
- **规则改了不追溯**：改周期规则只影响「下次生成」的实例；已生成的实例保持不动，要改就逐日改。
- **一个班可多个时段**：`class_schedules` 与 `classes` 一对多（周二一节、周四一节各一条规则）。
- **花名册是固定报名制**：`class_students` 是权威名单，点名时默认带出全班；进班 / 离班记日期，不物理删。
- **排课冲突只提示不拦截**：同一老师或同一教室在同一时段被排两次 —— 返回 `--cc-1` 暖红提示，
  照样能保存。
- **排课不碰课时**：`remaining_lessons` 的增减仍然只由考勤模块负责，本模块只管「什么时候、谁、上什么课」。
- **不做放假表**：放假靠逐日「停课」。**不做审批流 / 学员端自助报名 / 课酬统计。**

---

## 2. Goals / 目标

- 管理员可维护老师字典、班级档案（舞种 / 级别 / 主教 / 教室 / 容量 / 开班结班日期 / 状态）。
- 管理员可维护每个班的固定学员名单（加入 / 移出，各记日期），加人超过容量时给提示但不拦。
- 管理员可为一个班配置一条或多条「每周几 + 起止时间（+ 可覆盖的老师 / 教室）」周期规则。
- 学生 / 前台可看「课程表」：按星期几 × 时间段排布的周视图，点开某节看是哪个班、名单有谁。
- 老师可看「上课时间计划表」：选老师 + 选月份，看当月所有上课日期（打开时按规则自动补生成），
  并可逐日 停课 / 改时间 / 换代课老师 / 手动加课。
- 排课或建规则时，若与已有安排的老师 / 教室时段重叠，明确提示冲突明细（不阻断保存）。
- 考勤「批量点名」新增「选择课节」：选中后自动带出日期 / 时间 / 班级 / 老师 / 花名册，
  提交后 `attendance_records.session_id` 回填该课节。
- 全程遵循设计系统（`colors_and_type.css` 令牌、Mobile First、`--accent` 每屏至多两处）。

---

## 3. User Stories

> 编号 US-001 起，每个故事可在一个专注的 agent 会话内独立完成。最后一个是强制 E2E 故事。
> 阶段顺序参考前三个模块：DB 地基 → 域层+IPC（老师/班级/花名册）→ 渲染外壳+班级管理+首页接线 →
> 周期规则域层 → 课程表视图 → 排课实例域层+生成 → 上课时间计划表视图 → 接入考勤点名 → E2E。

### US-001: 数据库地基（迁移 v6 + 共享类型）
**Description:** 作为开发者，我需要新增课程管理的 5 张表与类型定义，让班级、名单、课程表和排课能持久化。

**Acceptance Criteria:**
- [ ] `src/db/migrations.ts` 的 `MIGRATIONS` 数组末尾追加 `{ version: 6, up: v6 }`，不修改 v1/v2/v4/v5
- [ ] v6 建 `teachers` 表：`id`(PK AUTOINCREMENT) / `name`(TEXT NOT NULL) / `status`(TEXT NOT NULL DEFAULT `'在职'`) / `created_at` / `updated_at` / `deleted_at`(TEXT，可空)
- [ ] v6 建 `classes` 表：`id` / `name`(TEXT NOT NULL) / `dance_type`(TEXT NOT NULL) / `level`(TEXT，可空) / `teacher_id`(INTEGER，可空，REFERENCES teachers(id)，无级联) / `room`(TEXT，可空) / `capacity`(INTEGER，可空) / `start_date`(TEXT，可空，`'YYYY-MM-DD'`) / `end_date`(TEXT，可空) / `status`(TEXT NOT NULL DEFAULT `'在读'`) / `note`(TEXT，可空) / `created_at` / `updated_at` / `deleted_at`
- [ ] v6 建 `class_students` 表：`id` / `class_id`(INTEGER NOT NULL，REFERENCES classes(id)，无级联) / `student_id`(INTEGER NOT NULL，REFERENCES students(id)，无级联) / `joined_at`(TEXT NOT NULL，`'YYYY-MM-DD'`) / `left_at`(TEXT，可空) / `created_at` / `updated_at`
- [ ] `class_students` 建**部分唯一索引** `CREATE UNIQUE INDEX IF NOT EXISTS uniq_class_student_active ON class_students(class_id, student_id) WHERE left_at IS NULL`（同一学员在同一班同时只能有一条在册记录）
- [ ] v6 建 `class_schedules` 表：`id` / `class_id`(INTEGER NOT NULL，REFERENCES classes(id)，无级联) / `weekday`(INTEGER NOT NULL，0=周日…6=周六) / `start_time`(TEXT NOT NULL，`'HH:MM'`) / `end_time`(TEXT NOT NULL) / `teacher_id`(INTEGER，可空，覆盖班主教) / `room`(TEXT，可空，覆盖班教室) / `effective_from`(TEXT，可空) / `effective_to`(TEXT，可空) / `created_at` / `updated_at` / `deleted_at`
- [ ] v6 建 `class_sessions` 表：`id` / `class_id`(INTEGER NOT NULL，REFERENCES classes(id)，无级联) / `schedule_id`(INTEGER，可空，REFERENCES class_schedules(id)，手动加课时为 NULL) / `session_date`(TEXT NOT NULL，`'YYYY-MM-DD'`) / `start_time`(TEXT NOT NULL) / `end_time`(TEXT NOT NULL) / `teacher_id`(INTEGER，可空) / `room`(TEXT，可空) / `status`(TEXT NOT NULL DEFAULT `'正常'`，取值 `正常|停课`) / `origin`(TEXT NOT NULL，取值 `计划|手动`) / `note`(TEXT，可空) / `created_at` / `updated_at` / `deleted_at`
- [ ] `class_sessions` 建索引：`idx_sess_class(class_id)`、`idx_sess_date(session_date)`、`idx_sess_teacher(teacher_id)`、`idx_sess_deleted(deleted_at)`，以及部分唯一索引 `CREATE UNIQUE INDEX IF NOT EXISTS uniq_sess_slot ON class_sessions(class_id, session_date, start_time) WHERE deleted_at IS NULL`
- [ ] 其它索引：`idx_classes_status`、`idx_classes_dance(dance_type)`、`idx_cs_class(class_id)` 于 `class_students`、`idx_sch_class(class_id)` 于 `class_schedules`
- [ ] v6 的 DDL 全部 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`（沿用 v4/v5 抗重复触发写法）
- [ ] 不加 `CHECK(...)` 约束：`weekday` 范围、`end_time > start_time`、枚举取值均由域层校验保证（与现有表风格一致）
- [ ] `src/shared/types.ts` 新增：`Teacher`、`TeacherInput`、`CourseClass`、`CourseClassInput`、`CourseClassListItem`（含 `activeRosterCount` / `overCapacity`）、`CourseClassListQuery`、`RosterMember`、`RosterAddInput`、`RosterRemoveInput`、`ClassSchedule`、`ClassScheduleInput`、`WeeklyTimetableEntry`、`WeeklyTimetableQuery`、`ClassSession`、`ClassSessionInput`、`SessionUpdateInput`、`SessionMonthQuery`、`SessionDateQuery`、`ScheduleConflict`（`{ kind: '老师'|'教室', refType: '规则'|'课节', refId, label, weekdayOrDate, startTime, endTime }`）
- [ ] `IpcErrorCode` 联合类型新增 `TEACHER_NOT_FOUND`、`CLASS_NOT_FOUND`、`SCHEDULE_NOT_FOUND`、`SESSION_NOT_FOUND`、`STUDENT_ALREADY_IN_CLASS`、`INVALID_TIME_RANGE`、`INVALID_WEEKDAY`
- [ ] `tests/unit/migrations.test.ts` 断言：空库连续 `run` 到 v6、5 张表与全部索引齐全、重复 `run` 幂等、v6 `up` 中途抛错则回滚且 `user_version` 停在上一版、含 v5 的库能补到 v6
- [ ] Typecheck / lint 通过

### US-002: 老师 / 班级 / 花名册 域层 + 读写 IPC
**Description:** 作为开发者，我需要老师字典、班级档案、班级花名册的仓库层与 IPC，供渲染层增删改查。

**Acceptance Criteria:**
- [ ] 新增 `src/domain/course.repo.ts` + `src/domain/course.validation.ts`；repo 抛 `AppError(code,msg,fields?)`，绝不 import `electron` / dialog / IPC
- [ ] `teacherList({ includeInactive? })` / `teacherCreate({ name, status? })` / `teacherUpdate({ id, name?, status? })` / `teacherSoftDelete(id)`：`name` 必填且 ≤ 20 字；`status` ∈ {`在职`,`离职`}，默认 `在职`；软删老师后，其名下班级 / 规则 / 课节的 `teacher_id` 保持不变，后续查询 JOIN 仍带出其姓名
- [ ] `classCreate(input)` / `classUpdate({ id, ...input })`：`name` 必填 ≤ 40 字、`dance_type` 必填 ≤ 20 字；`level` / `room` ≤ 20 字可空；`capacity` 为空或正整数；`start_date` / `end_date` 为空或合法 `'YYYY-MM-DD'`（复制一份 `isRealYmd`，同库存/考勤做法）；`status` ∈ {`在读`,`停课`,`结课`}，默认 `在读`；`teacher_id` 为空或必须命中未软删/已软删的 `teachers.id`（不存在 → `TEACHER_NOT_FOUND`）
- [ ] `classSoftDelete(id)`：仅置 `classes.deleted_at`；不动 `class_students` / `class_schedules` / `class_sessions`；软删的班不出现在 `classList` 默认结果与课程表 / 计划表视图
- [ ] `classList(query)`：支持按 `status` / `dance_type` / `teacher_id` / `keyword`（班名子串）筛选，`ORDER BY name COLLATE NOCASE`；每行带 `activeRosterCount`（`class_students` 中 `left_at IS NULL` 计数）与 `overCapacity`（`capacity != null && activeRosterCount > capacity`）
- [ ] `classGet(id)`：返回班级字段 + 主教姓名 + `activeRosterCount` + `overCapacity`
- [ ] `rosterList(classId)`：返回在册成员（`left_at IS NULL`）的 `student_id` / 姓名 / `phone_primary` / `remaining_lessons` / `card_expire_date` / `joined_at`，`ORDER BY joined_at, 姓名`
- [ ] `rosterAdd({ classId, studentId, joinedAt? })`：`joinedAt` 默认今天；班或学员不存在（或已软删）→ `CLASS_NOT_FOUND` / `NOT_FOUND`；该学员在该班已有 `left_at IS NULL` 记录 → `STUDENT_ALREADY_IN_CLASS`；成功返回新的 `activeRosterCount` 与 `overCapacity`（超容量**不报错**，仅在返回值里标记）
- [ ] `rosterRemove({ classId, studentId, leftAt? })`：把该学员在该班 `left_at IS NULL` 的记录置 `left_at`（默认今天）；无在册记录 → `NOT_FOUND`
- [ ] `src/ipc/channels.ts` 按 `域:动作` 风格新增：`courseTeacherList` / `courseTeacherCreate` / `courseTeacherUpdate` / `courseTeacherDelete` / `courseClassList` / `courseClassGet` / `courseClassCreate` / `courseClassUpdate` / `courseClassDelete` / `courseRosterList` / `courseRosterAdd` / `courseRosterRemove`；经 `handle()` 注册，跨边界不抛错，返回 `IpcResult<T>`
- [ ] `src/preload.ts` 重声明频道字面量并暴露 `window.studioShell.course.*`；`studioShell.d.ts` 补类型
- [ ] `tests/unit/course-repo.test.ts`：老师增改软删、班级增改软删、软删班不进列表、`classList` 筛选与 `activeRosterCount` / `overCapacity` 正确、`rosterAdd` 重复报 `STUDENT_ALREADY_IN_CLASS`、超容量加人成功且 `overCapacity=true`、`rosterRemove` 置 `left_at`、离班后可再次加入
- [ ] Typecheck / lint 通过

### US-003: 渲染外壳 + 首页接线 + 班级管理 + 花名册 + 老师字典 UI
**Description:** 作为管理员，我打开「课程安排」时看到和其它模块视觉一致的页面，能管理老师、班级和每个班的学员名单。

**Acceptance Criteria:**
- [ ] 首页 `index.html`「课程安排」卡片 `href` 由 `placeholder.html?app=schedule` 改为 `course.html`
- [ ] 新增 `course.html`（复制 `students.html` 外壳：`:root` 令牌回退 + `<head>` 引入 `colors_and_type.css`）与 `course.js`（手写 ES module，`#/hash` 路由：`#/classes` 默认、`#/timetable`、`#/teacher-plan`、`#/teachers`；`el()` / `unwrap()` / `#toast`）
- [ ] `course.html` 与 `course.js` 加入 `electron-builder.yml` 的 `files`
- [ ] `#/teachers` 视图：老师列表（姓名、状态），可新增、改名、切换在职/离职；离职老师置灰但不消失
- [ ] `#/classes` 视图：班级卡片/表格列表，显示班名、舞种、级别、主教、教室、`在册 N / 容量 M`（超容量时 `N` 显示 `--cc-1` 暖红）、状态；顶部按状态 / 舞种 / 关键字筛选；无数据显示空态文案
- [ ] 「新建班级 / 编辑班级」表单：班名、舞种、级别、主教（下拉，选项来自在职老师）、教室、容量、开班日期、结课日期、状态、备注；即时校验必填项，提交调 `courseClassCreate` / `courseClassUpdate`
- [ ] 班级详情/抽屉内「花名册」区：在册学员列表（姓名、手机号、剩余课时、进班日期）；「加入学员」按姓名/手机号搜学员库并选择，`courseRosterAdd`；每行「移出」调 `courseRosterRemove`；超容量加入时 `#toast` 提示「已超容量（N/M）」但仍加入
- [ ] 页面主题色 `--cc-3`；样式无裸 hex，全部 `var(--token-name)`；`--accent` 每屏出现 ≤ 2 次；悬停行文字对比度不下降
- [ ] Typecheck / lint 通过
- [ ] 在 Electron 窗口中人工核对视觉与其它模块一致（可借助 `run` skill）

### US-004: 周期规则（class_schedules）域层 + IPC + 冲突检测
**Description:** 作为开发者，我需要班级周期规则的仓库层与冲突检测助手，让一个班能配置「每周几几点」的固定课。

**Acceptance Criteria:**
- [ ] `scheduleList(classId)`：返回该班未软删规则，`ORDER BY weekday, start_time`；每条带「生效老师」（`schedule.teacher_id ?? class.teacher_id`）与生效老师姓名、「生效教室」（`schedule.room ?? class.room`）
- [ ] `scheduleCreate({ classId, weekday, startTime, endTime, teacherId?, room?, effectiveFrom?, effectiveTo? })`：`weekday` 非 0–6 整数 → `INVALID_WEEKDAY`；`startTime` / `endTime` 不匹配 `/^([01]\d|2[0-3]):[0-5]\d$/` 或 `endTime <= startTime` → `INVALID_TIME_RANGE`；`classId` 不存在或已软删 → `CLASS_NOT_FOUND`；`teacherId` 给出但不存在 → `TEACHER_NOT_FOUND`
- [ ] `scheduleUpdate({ id, ...同上可选 })` / `scheduleSoftDelete(id)`：规则不存在 → `SCHEDULE_NOT_FOUND`
- [ ] `checkScheduleConflicts({ excludeScheduleId?, weekday, startTime, endTime, effectiveTeacherId, effectiveRoom, effectiveFrom?, effectiveTo? })` 助手：扫描所有未软删规则（跨班），返回 `ScheduleConflict[]` —— 同 `weekday` 且时间段重叠（判据 `a.start < b.end && b.start < a.end`）且（生效老师相同 `kind:'老师'` 或 生效教室相同且非空 `kind:'教室'`），生效区间不相交的排除
- [ ] `scheduleCreate` / `scheduleUpdate` 成功返回值内附带 `conflicts: ScheduleConflict[]`（**非阻断**，冲突照样落库）
- [ ] `src/ipc/channels.ts` 新增 `courseScheduleList` / `courseScheduleCreate` / `courseScheduleUpdate` / `courseScheduleDelete`；`register.ts` / `preload.ts` / `studioShell.d.ts` 同步
- [ ] `tests/unit/course-schedule.test.ts`：`weekday=7` → `INVALID_WEEKDAY`；`endTime <= startTime` → `INVALID_TIME_RANGE`；一个班可加多条规则；同老师同周几时间重叠 → `conflicts` 含一条 `kind:'老师'`；同教室重叠 → 含 `kind:'教室'`；生效区间不相交 → 无冲突；软删规则不参与冲突扫描
- [ ] Typecheck / lint 通过

### US-005: 学生向「课程表」周视图
**Description:** 作为前台/学生，我想看一张按星期几和时间排布的周课表，点开某节能看到是哪个班、名单有谁。

**Acceptance Criteria:**
- [ ] `weeklyTimetable(query)` 仓库方法 + `courseWeeklyTimetable` 频道：返回所有未软删班级的未软删规则，JOIN 出班名、舞种、级别、生效老师姓名、生效教室、在册人数（`WeeklyTimetableEntry[]`），可选按 `danceType` / `teacherId` 筛选
- [ ] `#/timetable` 视图：
  - [ ] 桌面（视口 ≥ 900px）：7 列（周日→周六）网格，纵向按时间排布，每节课是一个色块显示 `班名 · 起-止 · 老师 · 在册N`
  - [ ] 移动端（< 900px）：按星期几竖向分组的列表，当天分组置顶并高亮；每节课一行
- [ ] 点击任意一节 → 弹出该班详情：班级信息 + 当前在册花名册（姓名、手机号、剩余课时）
- [ ] 详情内可「编辑规则」（改周几/时间/覆盖老师/覆盖教室）与「删除规则」，以及「新增规则」入口；保存时若 `conflicts` 非空，在提交区显示 `--cc-1` 暖红冲突明细（老师/教室、与哪个班哪个时段冲突），仍可确认保存
- [ ] 无任何规则时显示空态与「去某个班添加固定课」引导
- [ ] 样式令牌合规；`--accent` ≤ 2 次/屏；悬停对比度不下降
- [ ] Typecheck / lint 通过
- [ ] 在 Electron 窗口中人工核对（可借助 `run` skill）

### US-006: 排课实例（class_sessions）域层 + 按月生成 + IPC
**Description:** 作为开发者，我需要「把周期规则按月铺成具体日期的排课实例」的逻辑，以及在实例上停课/改时间/换老师/加课的仓库方法。

**Acceptance Criteria:**
- [ ] `generateMonth({ year, month })`：在单个 `db.transaction` 内，对每条未软删规则、每个落在该自然月内且满足 `weekday` 的日期，若该日期在规则 `effective_from`/`effective_to`（含端点，空视为不限）内，且**不存在** `schedule_id = 规则.id AND session_date = 该日期 AND deleted_at IS NULL` 的实例，则插入一条 `class_sessions`：`start_time`/`end_time` 取自规则、`teacher_id` 取生效老师、`room` 取生效教室、`status='正常'`、`origin='计划'`、`schedule_id=规则.id`；返回 `{ created: N }`
- [ ] `generateMonth` 幂等：同月重复调用不新增、不修改任何已存在实例（含已被人工改过时间/老师/停课的实例）
- [ ] `sessionsByMonth({ teacherId?, year, month })`：**先内部调用 `generateMonth` 补齐当月**，再返回该月实例（JOIN 班名、生效老师姓名、舞种），`teacherId` 给出时按 `class_sessions.teacher_id` 过滤，`ORDER BY session_date, start_time`；`status='停课'` 的实例也返回（带标记）
- [ ] `sessionsByDate({ date })`：返回该日期未软删实例，JOIN 班级信息与在册花名册计数，供考勤「选择课节」用
- [ ] `sessionUpdate({ id, action, ... })`：`action='停课'`（置 `status='停课'` + 记 `note`）/ `action='改时间'`（改 `start_time`/`end_time`，仍是同一天，`endTime<=startTime` → `INVALID_TIME_RANGE`）/ `action='换老师'`（改 `teacher_id`，不存在 → `TEACHER_NOT_FOUND`）/ `action='恢复'`（`status` 回 `正常`）；实例不存在 → `SESSION_NOT_FOUND`；**不修改对应 `class_schedules` 规则**
- [ ] `sessionCreate({ classId, sessionDate, startTime, endTime, teacherId?, room?, note? })`：手动加课，`schedule_id=NULL`、`origin='手动'`、`status='正常'`；同 `(class_id, session_date, start_time)` 已有未软删实例 → 复用唯一索引报冲突（`AppError` `DUPLICATE`）
- [ ] `sessionSoftDelete(id)`：置 `deleted_at`；不影响已写入的考勤记录（考勤 `session_id` 保留指向，无外键约束）
- [ ] `sessionUpdate`（换老师/改时间）与 `sessionCreate` 返回值附带 `conflicts`（复用冲突判据，按**同一天**的其它未软删实例扫描老师/教室重叠，非阻断）
- [ ] 改周期规则**不追溯**已生成实例：`scheduleUpdate` 不触碰 `class_sessions`（由 US-004 保证 + 本故事测试补一条断言）
- [ ] `src/ipc/channels.ts` 新增 `courseGenerateMonth` / `courseSessionsByMonth` / `courseSessionsByDate` / `courseSessionCreate` / `courseSessionUpdate` / `courseSessionDelete`；`register.ts` / `preload.ts` / `studioShell.d.ts` 同步
- [ ] `tests/unit/course-session.test.ts`：一条「每周三」规则对 2026-09 生成 5 条；重复 `generateMonth` 不增不改；人工「停课」后再 `generateMonth` 该实例不被复活/覆盖；`改时间` / `换老师` 生效且规则不变；`sessionCreate` 手动加课 `origin='手动'`；同槽位重复 → 冲突；软删规则后该月不再生成其实例
- [ ] Typecheck / lint 通过

### US-007: 老师向「上课时间计划表」月视图
**Description:** 作为老师，我选自己名字和一个月份，就能看到这个月要上课的所有日期，并能逐日停课、改时间、换代课、加课。

**Acceptance Criteria:**
- [ ] `#/teacher-plan` 视图：顶部「老师下拉（在职优先）+ 月份选择（默认当月，可前后翻）」；切换即调 `courseSessionsByMonth`（内部已自动补生成当月）
- [ ] 桌面：整月日历网格（原生 CSS grid，不引日历库），每个有课的日期格内列出 `起-止 · 班名`；`停课` 的条目显示删除线 + `--cc-1` 标记
- [ ] 移动端（< 900px）：按日期升序的列表，只列有课的日期；每个日期下若干课节行；触控目标 ≥ 44px
- [ ] 点某个课节 → 操作菜单：`停课` / `恢复` / `改时间`（时间选择，限同一天）/ `换代课老师`（下拉）/ `查看花名册`；对应 `courseSessionUpdate`
- [ ] 「+ 手动加课」入口：选班级、日期（默认当前查看月的某天）、起止时间、老师（默认该班主教）、备注 → `courseSessionCreate`
- [ ] 换老师 / 改时间 / 加课若返回 `conflicts`，提交区显示 `--cc-1` 暖红冲突明细，仍可确认
- [ ] 选中月份无任何课节时显示空态（如「本月张老师暂无排课」）
- [ ] 样式令牌合规；`--accent` ≤ 2 次/屏；悬停对比度不下降
- [ ] Typecheck / lint 通过
- [ ] 在 Electron 窗口中人工核对（可借助 `run` skill）

### US-008: 接入考勤「批量点名」——选择课节 + 回填 session_id
**Description:** 作为老师，我在考勤批量点名时想直接选「今天 19:00 少儿中国舞 B 班」，让日期、班级、老师和花名册自动带出来。

**Acceptance Criteria:**
- [ ] `src/domain/attendance.repo.ts` 的 `createRecord(input)` 接受可选 `sessionId`（整数），写入 `attendance_records.session_id`；不传时保持 `NULL`；**不新增外键、不改表结构**
- [ ] `BatchCheckInInput` 增加可选 `sessionId`；批量点名时若给出，所有成功写入的行都带该 `session_id`
- [ ] `attendance.validation.ts`：`sessionId` 为空或正整数，非法 → `VALIDATION_FAILED`（不校验其是否存在，缺失容忍）
- [ ] 考勤「批量点名」视图（`attendance.js`）新增「选择课节」控件：默认取今天，调用 `window.studioShell.course.sessionsByDate({ date })` 列出当天课节（`起-止 · 班名 · 老师`，`停课` 的置灰不可选）
- [ ] 选中课节后：自动填入日期、时间（该课节 `start_time`）、课程名（= 班名）、老师（= 课节生效老师）；花名册从该班在册 `class_students` 一次性带出为可勾选列表（复用现有勾选 + 状态选择 UI），默认全体「出勤」
- [ ] 不选课节时，考勤批量点名维持现状（按舞种/关键字从学员库筛花名册，`session_id` 为 `NULL`）——两条路径并存
- [ ] 提交后被写入的 `attendance_records` 行 `session_id` 等于所选课节 id（单测断言）
- [ ] `tests/unit/attendance-repo.test.ts` 增补：`createRecord({..., sessionId})` 落库该值；批量点名带 `sessionId` 时每行都带；不传时为 `NULL`
- [ ] Typecheck / lint 通过
- [ ] 在 Electron 窗口中人工核对：选课节 → 花名册自动出现 → 提交 → 考勤流水新增（可借助 `run` skill）

### US-009: 端到端测试（课程管理完整链路）
**Description:** 作为 QA 工程师，我需要一条自动化 E2E 测试覆盖课程管理的完整旅程，以便在整条栈上捕捉回归。

**Acceptance Criteria:**
- [ ] `tests/e2e/course-flow.spec.ts`（Playwright `_electron`，`env.STUDIO_DB_PATH` → 临时文件，测试自建自清数据）
- [ ] happy path：首页点「课程安排」卡 → 断言进入 `course.html` 且默认 `#/classes` 可见 → 新建一位老师 → 新建一个班（选该老师、容量 2）→ 从学员库加入 2 名学员到花名册 → 为该班加一条「每周三 19:00–20:00」规则 → 切到 `#/timetable` 断言周三列/分组出现该班色块、点开显示 2 名学员 → 切到 `#/teacher-plan` 选该老师 + 含下一个周三的月份 → 断言该周三出现一节课
- [ ] 微调路径：在 `#/teacher-plan` 对该节课「改时间」为 20:00–21:00 → 断言列表显示新时间；再「停课」→ 断言该节显示停课标记
- [ ] 冲突提示路径：给同一位老师、同一周三、19:30–20:30 再建一条规则（不同班）→ 断言提交区出现 `--cc-1` 冲突提示且规则仍保存成功
- [ ] 考勤联动路径：切到考勤「批量点名」选「该周三 · 该班」课节 → 断言日期/班名/老师自动带出、花名册 2 人自动列出 → 全体「出勤」提交 → 断言考勤流水新增 2 行
- [ ] 边界/失败路径：容量为 2 的班加入第 3 名学员 → 断言出现「已超容量」提示但学员确实被加入（在册 3 人）
- [ ] 全程收集 `page.on('pageerror')` 为空
- [ ] `npm test` 全绿（`test:unit` + `test:e2e`）

---

## 4. Functional Requirements

**数据模型**
- FR-1: 系统必须在 `src/db/migrations.ts` 追加迁移 `v6`，创建 `teachers` / `classes` / `class_students` / `class_schedules` / `class_sessions` 五张表，不修改既有 v1/v2/v4/v5。
- FR-2: 迁移 v6 的所有 DDL 必须使用 `CREATE TABLE IF NOT EXISTS` 与 `CREATE INDEX IF NOT EXISTS`。
- FR-3: `class_students` 必须有部分唯一索引 `(class_id, student_id) WHERE left_at IS NULL`，保证同一学员在同一班同时只有一条在册记录。
- FR-4: `class_sessions` 必须有部分唯一索引 `(class_id, session_date, start_time) WHERE deleted_at IS NULL`。
- FR-5: 所有跨表引用列（`teacher_id` / `class_id` / `student_id` / `schedule_id`）必须声明 `REFERENCES` 但**不带** `ON DELETE CASCADE`。
- FR-6: `weekday` 必须以整数 0–6 存储，0 = 周日，对齐 JS `Date.getDay()`。
- FR-7: 所有日期列以 `'YYYY-MM-DD'` 文本存储，所有时间列以 `'HH:MM'` 文本存储。
- FR-8: `src/shared/types.ts` 必须新增第 3 节 US-001 列出的全部类型；`IpcErrorCode` 必须新增 7 个课程相关错误码。

**老师字典**
- FR-9: 系统必须支持创建老师（`name` 必填 ≤ 20 字，`status` 默认 `在职`）。
- FR-10: 系统必须支持修改老师姓名与在职/离职状态。
- FR-11: 系统必须支持软删老师；软删后其名下班级/规则/课节的 `teacher_id` 不变，查询 JOIN 仍带出其姓名。
- FR-12: 老师列表默认只返回在职老师，可选参数返回全部。

**班级**
- FR-13: 系统必须支持创建班级，`name` 与 `dance_type` 必填，其余字段可空。
- FR-14: 系统必须支持修改班级的全部业务字段。
- FR-15: 系统必须支持软删班级，且不删除其花名册、规则、排课实例；软删班级不出现在班级列表、课程表、计划表中。
- FR-16: 班级列表必须支持按状态、舞种、主教、班名关键字筛选。
- FR-17: 班级列表每行必须返回在册人数（`class_students.left_at IS NULL` 计数）与是否超容量标记。

**花名册**
- FR-18: 系统必须支持把学员加入某班，`joined_at` 默认当天。
- FR-19: 当该学员在该班已有在册记录时，加入操作必须返回 `STUDENT_ALREADY_IN_CLASS`。
- FR-20: 系统必须支持把学员移出某班，实现为置 `left_at`（默认当天），不物理删除。
- FR-21: 花名册查询必须只返回在册成员，并带出姓名、手机号、剩余课时、进班日期。
- FR-22: 当加入后在册人数超过 `capacity` 时，加入操作必须成功，但返回值须带 `overCapacity: true`（不报错、不拦截）。

**周期规则（课程表）**
- FR-23: 系统必须支持为一个班创建周期规则：`weekday` + `start_time` + `end_time`，可选覆盖老师、覆盖教室、生效起止日期。
- FR-24: `weekday` 非 0–6 整数必须返回 `INVALID_WEEKDAY`；`end_time <= start_time` 或时间格式非法必须返回 `INVALID_TIME_RANGE`。
- FR-25: 一个班必须允许配置多条周期规则。
- FR-26: 系统必须支持修改与软删周期规则。
- FR-27: 创建/修改周期规则时，系统必须扫描所有未软删规则，返回与之「同 weekday + 时间段重叠 + 生效老师相同或生效教室相同」且生效区间相交的冲突明细，作为**非阻断**返回值；冲突存在时规则仍必须落库。
- FR-28: 「课程表」查询必须返回所有未软删班级的未软删规则，JOIN 出班名、舞种、级别、生效老师姓名、生效教室、在册人数，按 `weekday, start_time` 排序。

**排课实例（上课时间计划表）**
- FR-29: `generateMonth(year, month)` 必须对每条未软删规则，在该自然月内每个匹配 `weekday` 且落在规则生效区间内的日期，插入一条排课实例——当且仅当不存在 `schedule_id` 相同且 `session_date` 相同的未软删实例。
- FR-30: 生成的实例必须取规则的时间、生效老师、生效教室，`status='正常'`、`origin='计划'`、`schedule_id` 指向来源规则。
- FR-31: `generateMonth` 必须幂等：对同一月份重复调用不新增、不修改任何已存在实例（包括已被人工改时间/换老师/停课的实例）。
- FR-32: `sessionsByMonth({teacherId?, year, month})` 必须先内部补生成当月，再返回该月实例（含停课实例，带标记），可按老师过滤，按日期+时间排序。
- FR-33: 系统必须支持对单个排课实例执行：停课、恢复、改时间（限同一天）、换老师。
- FR-34: 对排课实例的上述操作**不得**修改其来源周期规则。
- FR-35: 系统必须支持手动加课：指定班级、日期、起止时间、老师、备注，生成 `origin='手动'`、`schedule_id=NULL` 的实例。
- FR-36: 系统必须支持软删排课实例；软删不得影响已写入的考勤记录。
- FR-37: 换老师、改时间、手动加课时，系统必须按同一天的其它未软删实例扫描老师/教室时段重叠，作为非阻断返回值。
- FR-38: 修改周期规则**不得**追溯修改任何已生成的排课实例。
- FR-39: `sessionsByDate({date})` 必须返回该日期的未软删实例，JOIN 出班级信息与在册花名册，供考勤模块使用。

**考勤联动**
- FR-40: `attendance.repo.createRecord` 必须接受可选 `sessionId` 并写入 `attendance_records.session_id`；不传时为 `NULL`；不得新增外键或改表结构。
- FR-41: 考勤「批量点名」入参必须支持可选 `sessionId`，给出时所有成功写入的考勤行都带该值。
- FR-42: 考勤「批量点名」界面必须新增「选择课节」控件，按日期列出 `course.sessionsByDate` 的结果，停课实例置灰不可选。
- FR-43: 选中课节后，界面必须自动带出日期、时间、课程名（=班名）、老师（=课节生效老师），并从该班在册花名册加载可勾选学员列表。
- FR-44: 不选课节时，考勤批量点名必须维持现有「按舞种/关键字筛学员库」路径，`session_id` 为 `NULL`。

**渲染与设计系统**
- FR-45: 首页 `index.html`「课程安排」卡片 `href` 必须改为 `course.html`。
- FR-46: 新增 `course.html`（复制 `students.html` 外壳）与 `course.js`（`#/hash` 路由，视图 `#/classes` `#/timetable` `#/teacher-plan` `#/teachers`），并加入 `electron-builder.yml` 的 `files`。
- FR-47: 页面主题色必须为 `--cc-3`；样式不得出现裸 hex，一律 `var(--token-name)`；`--accent` 每屏至多出现两次；悬停态不得降低文字对比度。
- FR-48: 「课程表」周视图必须在视口 ≥ 900px 时为 7 列网格，< 900px 时为按星期几竖向分组的列表（当天置顶）。
- FR-49: 「上课时间计划表」月视图必须在桌面为月历网格，在移动端为有课日期的列表；可交互元素触控目标 ≥ 44px。
- FR-50: 冲突提示必须使用 `--cc-1` 暖红呈现，且不计入 `--accent` 预算（与考勤模块一致）。

---

## 5. Non-Goals（Out of Scope）

- **不做请假 / 调课 / 代课的审批流**：老师直接改，改完即生效。
- **不做学员端自助选课 / 报名**：花名册只能由管理员维护。
- **不做课时与排课联动**：排课、点名之外不自动增减 `remaining_lessons`；扣课时仍只由考勤模块。
- **不做老师课酬 / 排课工时统计**：留给未来「数据报表」模块。
- **不做教室资源管理**：`room` 是自由文本，不建教室字典、不做教室占用看板。
- **不做放假日历表**：放假通过逐日「停课」处理。
- **不做冲突硬拦截**：老师/教室时段冲突一律「提示 + 可保存」。
- **不迁移 `students.main_teacher` / `students.class_schedule` 自由文本字段**：与新表并存，本期不动学员表。
- **不做课程表 / 计划表的 Excel 导入导出**：本期不涉及 `exceljs`。
- **不做复杂重复规则**：只支持「每周几」；不支持隔周、每月第 N 周、单次例外规则（例外用实例层的停课/加课表达）。
- **不改 `attendance_records` 表结构、不加外键**：只是开始写入既有的 `session_id` 列。
- **不做跨日改期**：「改时间」限同一天；跨天 = 停课 + 手动加课。
- **不接首页「今日课程」统计小组件**：可作为后续小改，不在本 PRD。

---

## 6. Design Considerations

- 复用 `students.html` 外壳与 `students.js` 里的 `el()` / `unwrap()` / `#toast` 工具（与库存、考勤渲染器一致，整体照搬）。
- 周视图参考常见课程表：桌面 7 列时间网格；移动端优先竖向单列，避免 7 列在窄屏挤压。
- 月历用原生 CSS `grid`（7 列 × 5–6 行），不引第三方日历库。
- 老师 / 班级下拉复用现有 `select` 令牌样式；花名册「加入学员」的搜索选择器复用考勤「快速打卡」学员搜索的交互。
- 冲突提示、超容量提示统一用 `--cc-1` 暖红（不占 `--accent` 预算）。
- 「停课」的课节在两个视图里都用「删除线 + 灰化 + `--cc-1` 小标记」，不隐藏。

---

## 7. Technical Considerations

- **迁移号**：本模块认领 **v6**。main 现为 v1/v2/v4/v5，v3（`class_name` 列）仍在未合并分支。DDL 全 `IF NOT EXISTS` + `run()` 的重复版本号守卫兜底；rebase 时若 v6 被占用，renumber 为下一个空号并在 commit body 注明。
- **weekday 约定**：存 0–6 对齐 `Date.getDay()`，渲染层不做偏移换算。
- **日期/时间**：`'YYYY-MM-DD'` / `'HH:MM'` 文本，字典序即时间序（同学员/库存/考勤）。`isRealYmd` / `todayYmd` 两个 ~6 行助手在 `course.validation.ts` 内复制一份，不抽公共模块。
- **无级联删除**：一律软删；列表/视图查询默认过滤 `deleted_at IS NULL`；JOIN 老师/学员姓名时**不加** `deleted_at` 过滤，以保留历史显示。
- **时间段重叠判据**：`a.start < b.end && b.start < a.end`；规则层按同 `weekday` 且生效区间相交比较，实例层按同 `session_date` 比较。
- **`generateMonth` 幂等**：靠 `(schedule_id, session_date)` 存在性检查，不靠唯一索引冲突捕获；整月生成在单个 `db.transaction` 内批量 `INSERT`。better-sqlite3 同步单连接，无并发写者。
- **冲突检测非阻断**：结果放在 `IpcResult.data.conflicts`，不走 `AppError`。
- **考勤集成**：只扩 `attendance.repo.createRecord` 的入参签名（加可选 `sessionId`）与 `BatchCheckInInput`；不动 `attendance_records` DDL；`session_id` 无外键，容忍指向已软删课节。
- **渲染器免打包**：新增 `course.html` / `course.js` 必须加入 `electron-builder.yml` 的 `files`。
- **测试**：`node:test` 单测（`tsconfig.test.json` → `dist-test/`，经 `scripts/test-unit.js` 跑）；Playwright `_electron` E2E，`env.STUDIO_DB_PATH` → 临时文件。

---

## 8. Success Metrics

- 查一位老师某月的上课日期 ≤ 2 步操作（选老师 → 选月份），页面自动补生成当月排课。
- 新建一个班 + 排好每周两节固定课 ≤ 5 分钟。
- 考勤批量点名选中课节后，花名册**零手工输入**自动带出，`session_id` 100% 回填。
- `generateMonth` 对任意月份重复触发不产生重复实例、不覆盖人工微调（单测断言）。
- `npm run typecheck && npm run lint && npm run test:unit` 每次提交前全绿；PR 前 `npm test`（含 E2E）全绿。

---

## 9. Open Questions

- 老师置「离职」后，其名下在读班级 / 未来课节是否需要提示强制改派？本期默认不强制，仅在列表标注灰化。
- 周期规则的 `effective_from` / `effective_to` 是否需要在 UI 暴露，还是本期只用班级的 `start_date` / `end_date` 兜底、规则层字段留给将来？倾向后者（UI 先不暴露，域层字段先建好）。
- 「课程表」周视图是否需要显示跨越午夜的课（如 23:30–00:30）？本期假设所有课都在同一自然日内。
- `class_sessions` 长期增长（单教室约数千条/年）是否需要归档策略？本期不处理，按需分页。
- 首页「今日课程」统计卡是否顺带接上 `sessionsByDate(today)`？暂列为后续小改。
