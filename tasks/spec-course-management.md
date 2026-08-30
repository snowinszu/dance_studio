# SPEC: 课程管理（班级 + 花名册 + 周期课程表 + 老师上课时间计划表）

> 技术规格，派生自 [tasks/prd-course-management.md](./prd-course-management.md)
> 生成日期：2026-08-30 ｜ 目标分支：`feat/course-management` ｜ 迁移版本：v6
> 架构蓝本：[tasks/spec-attendance-management.md](./spec-attendance-management.md)（「流水原语 + 权威缓存」→
> 本模块「周期规则 → 按月物化排课实例」）

---

## 1. 摘要 / Summary

### 1.1 本 SPEC 覆盖范围

把首页第 3 张卡片「课程安排」（`placeholder.html?app=schedule`，主题色 `--cc-3`）从占位页做成完整模块：
新增 5 张表 `teachers` / `classes` / `class_students` / `class_schedules` / `class_sessions`，
把「周期规则」（每周几几点哪个班）与「排课实例」（某个真实日期的一节课）分开建模；
「课程表（学生向）」= 读周期规则的周网格视图，「上课时间计划表（老师向）」= 读排课实例的月视图，
后者在查询时按 `generateMonth` 幂等把规则物化到当月的真实日期。
再把考勤模块的「批量点名」接上「选择课节」，回填早已预留的 `attendance_records.session_id`（不改考勤表结构）。
完全沿用学员 / 库存 / 考勤三个模块趟通的分层（`db` / `domain` / `io` / `ipc` / `preload` / 单页渲染器 /
`node:test` + Playwright）。

### 1.2 PRD 对应

- 来源：[tasks/prd-course-management.md](./prd-course-management.md)
- User Stories：US-001 ~ US-009（全部）
- Functional Requirements：FR-1 ~ FR-50（全部）

### 1.3 设计决策一览

| 决策 | 选择 | 理由 |
|---|---|---|
| 表数量 | 单迁移 v6 建 5 张表，DDL 全 `IF NOT EXISTS` | 与 v4（库存 2 表）、v5（考勤 1 表）同风格；一次并入 |
| 规则 vs 实例 | `class_schedules`（周期规则，无日期）与 `class_sessions`（排课实例，真实日期）分表 | 「课程表」读前者、「上课时间计划表」读后者；逐日微调只动实例，规则不受影响 |
| 实例来源 | `generateMonth(year,month)` 按规则幂等物化到当月真实日期；`schedule_id` 指向来源规则 | 幂等靠 `(schedule_id, session_date) 存在性` 判断，不靠唯一索引冲突 |
| 自动生成落点 | `sessionsByMonth` 查询 IPC **内部**先 `generateMonth` 再读（读带写副作用） | PRD 决策 4B；渲染层一次调用即可，前端不用记得成对调 |
| 规则改了 | 只影响下次 `generateMonth`；已生成实例一律不追溯改 | PRD 决策；「过去 / 已排不可变，未来才跟规则走」 |
| 冗余列 | **不快照**班名 / 老师名；显示时 JOIN `classes` / `teachers` / `students`（含已软删行） | PRD 决策「纯 JOIN」；班改名后历史课节跟着变，可接受 |
| 课节老师列 | `class_sessions.teacher_id` 是「这一天谁上」的权威，生成时取生效老师、之后可改（代课） | 「上课时间计划表」按它过滤；代课 = 改这一列 |
| 老师表 | 轻量：仅 `name` + `status`；不迁移 `students.main_teacher` 自由文本 | PRD 决策 1B |
| 花名册 | `class_students`，部分唯一索引 `(class_id, student_id) WHERE left_at IS NULL`；移出 = 置 `left_at` | 固定报名制（PRD 决策）；离班留痕、可再入班 |
| 容量 | 超容量**不拦截**，返回值带 `overCapacity` 标记 | PRD 决策 6A |
| 冲突检测 | **同类相比**：规则↔规则（同 weekday + 时段重叠 + 生效区间相交 + 同生效老师/教室）；实例↔实例（同 `session_date` + 时段重叠 + 同老师/教室）。非阻断，放 `IpcResult.data.conflicts` | PRD 决策 3C + 本轮「同类相比」 |
| 删除 | 一律软删（`deleted_at`）；无 `ON DELETE CASCADE`；显示 JOIN 不加 `deleted_at` 过滤以保留历史 | 与学员 / 库存 / 考勤一致 |
| weekday 存法 | 整数 0–6，0 = 周日，对齐 JS `Date.getDay()` | 渲染层零偏移换算 |
| 考勤联动 | `attendance.repo.createRecord` 无需改（INSERT 已含 `session_id`）；只改 `attendance.validation.ts` 透传 + `BatchCheckInInput` 加 `sessionId?` + 渲染层加「选择课节」 | 早已预留列，最小改动 |
| 迁移版本 | 认领 **v6**，依赖 `run()` 启动期重复版本号守卫；合并顺序 v4→v5→v6 | v3 = 学员 `class_name`（未合并分支）；rebase 撞号则 renumber |

---

## 2. 架构 / Architecture

### 2.1 系统上下文

```
渲染进程 course.js  ──window.studioShell.course.*──▶  preload.ts
                                                        │ ipcRenderer.invoke(CH.course*)
                                                        ▼
                                    ipc/register.ts  handle(ch, fn) ──▶ IpcResult<T> 信封
                                          │
              ┌───────────────────────────┼────────────────────────────┐
              ▼                           ▼                            ▼
   domain/course.validation.ts   domain/course.repo.ts        （无 io/*：本模块不涉及 exceljs）
      （入参归一化 + 校验）        （所有 SQL 读写，抛 AppError）
                                          │
                                          ▼
                             db/connection.ts (better-sqlite3, foreign_keys=ON)
                    表 teachers / classes / class_students / class_schedules / class_sessions

考勤联动：
  attendance.js「批量点名」──shell.course.sessionsByDate / shell.course.rosterList──▶ course.repo
  attendance.js ──shell.attendance.batchCheckIn({ ..., sessionId })──▶ attendance.validation（透传）
                 ──▶ attendance.repo.createRecord（INSERT 已含 session_id，无需改）
```

与考勤模块的对应关系：考勤的 `createRecord` = 单事务「查重→守卫→改余额→插流水」；本模块的
`generateMonth` = 单事务「逐规则逐日 存在性判断→INSERT 缺失实例」，同样是「一条写入路径、幂等可重入」。

### 2.2 组件职责

| 组件 | 职责 | 不做 |
|---|---|---|
| `domain/course.repo.ts` | 所有 SQL 读写：`teacher*` / `class*` / `roster*` / `schedule*` / `session*` / `generateMonth` / `weeklyTimetable` / `checkScheduleConflicts` / `checkSessionConflicts`；抛 `AppError(code,msg,fields?)` | 不碰 `electron` / dialog / IPC / 文件系统 |
| `domain/course.validation.ts` | 入参归一化 + 校验，产出 `{ values, errors }`；本地复制 `todayYmd` / `isRealYmd`；`TIME_RE`；`overlaps(aStart,aEnd,bStart,bEnd)` 时段重叠助手；`rangeOverlaps` 日期区间相交助手 | 不查库（`class_id` / `student_id` / `teacher_id` 是否存在由 repo / 外键兜底）|
| `ipc/register.ts`（改） | 24 个 `handle()`；校验失败抛 `VALIDATION_FAILED`；`BatchCheckInInput.sessionId` 透传给考勤校验 | 不写业务逻辑 |
| `course.js`（新） | `#/hash` 路由四视图（`#/classes` 默认 / `#/timetable` / `#/teacher-plan` / `#/teachers`）+ 模态；`el()` / `unwrap()` / `toast()`；即时校验（非权威）| 不碰 Node |
| `attendance.js`（改） | 「批量点名」视图加「选择课节」控件，选中带出公共字段 + 花名册 | 不新增考勤频道 |

### 2.3 关键流程

**A. 生成本月排课（`generateMonth`，被 `sessionsByMonth` 内部调用）**

```
course.repo.generateMonth({ year, month })  (db.transaction):
  monthStart = `${year}-${pad2(month)}-01`
  monthEnd   = `${year}-${pad2(month)}-${lastDayOfMonth(year,month)}`
  rows = SELECT sch.id, sch.class_id, sch.weekday, sch.start_time, sch.end_time,
                sch.teacher_id AS schTeacher, sch.room AS schRoom,
                sch.effective_from, sch.effective_to,
                c.teacher_id AS classTeacher, c.room AS classRoom,
                c.start_date AS classStart, c.end_date AS classEnd
           FROM class_schedules sch
           JOIN classes c ON c.id = sch.class_id
          WHERE sch.deleted_at IS NULL AND c.deleted_at IS NULL AND c.status = '在读'
  created = 0
  for r of rows:
    lo = maxYmd(monthStart, r.effective_from ?? r.classStart ?? monthStart)
    hi = minYmd(monthEnd,   r.effective_to   ?? r.classEnd   ?? monthEnd)
    for d of eachYmd(lo, hi) where localDate(d).getDay() === r.weekday:
      exists = SELECT 1 FROM class_sessions
                WHERE schedule_id = @schId AND session_date = @d AND deleted_at IS NULL LIMIT 1
      if exists: continue
      INSERT INTO class_sessions
        (class_id, schedule_id, session_date, start_time, end_time, teacher_id, room,
         status, origin, note, created_at, updated_at)
      VALUES
        (@classId, @schId, @d, @start, @end,
         COALESCE(@schTeacher, @classTeacher), COALESCE(NULLIF(@schRoom,''), @classRoom),
         '正常', '计划', NULL, @now, @now)
      created++
  return { created }
```

- 日期迭代用 `new Date(y, m-1, d)`（本地构造）判 `getDay()`，避免 UTC 偏移；`eachYmd` 逐日 +1。
- `结课` / `停课` 状态的班、已软删的班 / 规则一律不生成。
- 幂等键是 `(schedule_id, session_date, deleted_at IS NULL)`：已被人工「改时间 / 换老师 / 停课」的实例
  `schedule_id` 不变，存在性命中 → 跳过，不覆盖；被软删的实例不算存在 → 会重新生成一条新的（符合预期：
  删掉是「这条不算数了、按规则重来」）。

**B. 上课时间计划表（`sessionsByMonth`，读带写）**

```
shell.course.sessionsByMonth({ teacherId?, year, month })
  register: 校验 year/month 为整数、month∈1..12 → 否则 BAD_REQUEST
           course.repo.sessionsByMonth(query):
             generateMonth({ year, month })          // 先物化当月
             return SELECT se.*, c.name AS className, c.dance_type AS danceType,
                           t.name AS teacherName
                      FROM class_sessions se
                      JOIN classes  c ON c.id = se.class_id
                      LEFT JOIN teachers t ON t.id = se.teacher_id
                     WHERE se.deleted_at IS NULL
                       AND se.session_date >= @monthStart AND se.session_date <= @monthEnd
                       {AND se.teacher_id = @teacherId}
                     ORDER BY se.session_date, se.start_time
```

- `teacherId` 过滤按 `class_sessions.teacher_id`（含代课后的值）；`teacher_id IS NULL` 的实例在
  「选了某老师」时不出现（文档化行为）。
- `status='停课'` 的实例照常返回，带标记；渲染层加删除线 + `--cc-1`。

**C. 逐日微调（`sessionUpdate`）**

```
shell.course.sessionUpdate({ id, action, startTime?, endTime?, teacherId?, note? })
  action ∈ { '停课', '恢复', '改时间', '换老师' }
  repo.sessionUpdate (db.transaction):
    row := SELECT * FROM class_sessions WHERE id=@id AND deleted_at IS NULL
    !row → throw SESSION_NOT_FOUND
    '停课': UPDATE ... SET status='停课', note=COALESCE(@note, note), updated_at=@now
    '恢复': UPDATE ... SET status='正常', updated_at=@now
    '改时间': TIME_RE(startTime,endTime) 且 endTime>startTime 否则 throw INVALID_TIME_RANGE
             UPDATE ... SET start_time=@startTime, end_time=@endTime, updated_at=@now   // 仍同一天
    '换老师': @teacherId 给出 → SELECT 1 FROM teachers WHERE id=@teacherId 否则 throw TEACHER_NOT_FOUND
             （@teacherId 传 null = 取消指派，允许）
             UPDATE ... SET teacher_id=@teacherId, updated_at=@now
  conflicts := (action ∈ {'改时间','换老师'}) ? checkSessionConflicts(rereadRow) : []
  return { session: rereadRow(JOIN 班名/老师名), conflicts }        // conflicts 非阻断
```

**D. 手动加课（`sessionCreate`）**

```
shell.course.sessionCreate({ classId, sessionDate, startTime, endTime, teacherId?, room?, note? })
  repo.sessionCreate (db.transaction):
    SELECT 1 FROM classes WHERE id=@classId AND deleted_at IS NULL 否则 throw CLASS_NOT_FOUND
    isRealYmd(sessionDate) 且 TIME_RE 且 endTime>startTime 否则 throw INVALID_TIME_RANGE
    @teacherId 给出 → 校验存在 否则 throw TEACHER_NOT_FOUND
    dup := SELECT 1 FROM class_sessions
            WHERE class_id=@classId AND session_date=@sessionDate
              AND start_time=@startTime AND deleted_at IS NULL LIMIT 1
    dup → throw DUPLICATE_SESSION('该班这个时间已有一节课')
    INSERT ... schedule_id=NULL, status='正常', origin='手动'
  conflicts := checkSessionConflicts(newRow)
  return { session, conflicts }
```

**E. 周期规则冲突检测（`checkScheduleConflicts`）**

```
入参 candidate = { excludeScheduleId?, weekday, startTime, endTime,
                   effectiveTeacherId, effectiveRoom, effectiveFrom?, effectiveTo? }
SELECT sch.id, sch.weekday, sch.start_time, sch.end_time, sch.effective_from, sch.effective_to,
       COALESCE(sch.teacher_id, c.teacher_id) AS effTeacher,
       COALESCE(NULLIF(sch.room,''), c.room)  AS effRoom,
       c.name AS className
  FROM class_schedules sch JOIN classes c ON c.id = sch.class_id
 WHERE sch.deleted_at IS NULL AND c.deleted_at IS NULL
   AND (@excludeScheduleId IS NULL OR sch.id != @excludeScheduleId)
   AND sch.weekday = @weekday
→ 在应用层过滤：overlaps(时段) 且 rangeOverlaps(生效区间) 且
   ( (effTeacher = @effectiveTeacherId 且非 null) → kind:'老师'
     或 (effRoom = @effectiveRoom 且非空)         → kind:'教室' )
→ 返回 ScheduleConflict[]（每条含 kind / refType:'规则' / refId / label=className / weekday / start / end）
```

`checkSessionConflicts(row)` 同理，但 `refType:'课节'`，扫描 `class_sessions` 同 `session_date`、
未软删、`status!='停课'`、`id != row.id`，按 `teacher_id` / `room` 比对。

**F. 考勤「选择课节」联动**

```
attendance.js「批量点名」:
  选日期（默认今天）→ shell.course.sessionsByDate({ date })
    → [{ id, classId, className, teacherName, startTime, endTime, status }]
  选中一节（status='停课' 置灰不可选）:
    公共字段自动填：attendDate=date, attendTime=startTime, className=className, teacher=teacherName
    → shell.course.rosterList(classId) → 花名册 [{ studentId, name, phone, remainingLessons }]
    → 渲染为可勾选列表，默认全体「出勤」
  提交 shell.attendance.batchCheckIn({ ...common, sessionId: 选中.id, entries:[...] })
    attendance.validation.validateBatchCheckIn 读 input.sessionId（正整数 → 带上，否则 null）
    每条 RecordValues.sessionId = 该值 → attendance.repo.createRecord 的 INSERT 落库 session_id
  不选课节：维持现状（rosterCandidates 按舞种/关键字筛学员库，sessionId=null）
```

### 2.4 文件结构

```
src/
├── db/migrations.ts                    [MODIFY]  MIGRATIONS 末尾 append { version: 6, up: v6 }
├── shared/types.ts                     [MODIFY]  + Course* 类型；IpcErrorCode + 8 值；BatchCheckInInput + sessionId?
├── domain/
│   ├── course.repo.ts                  [NEW]
│   └── course.validation.ts            [NEW]
├── domain/attendance.validation.ts     [MODIFY]  RecordValues.sessionId 真正透传；validateBatchCheckIn 读 input.sessionId
│   （domain/attendance.repo.ts          不改——createRecord 的 INSERT 已含 session_id）
├── ipc/
│   ├── channels.ts                     [MODIFY]  + 24 个 course* 常量
│   └── register.ts                     [MODIFY]  + 24 个 handle()
└── preload.ts                          [MODIFY]  + CH 字面量 24 条 + api.course.*

studioShell.d.ts                        [MODIFY]  + course 命名空间类型
electron-builder.yml                    [MODIFY]  files += course.html, course.js
index.html                              [MODIFY]  「课程安排」卡片 href → course.html
course.html                             [NEW]     复制 students.html 外壳，主题色 --cc-3
course.js                               [NEW]     单页 hash 路由渲染器

tests/unit/
├── course-migration.test.ts            [NEW]
├── course-repo.test.ts                 [NEW]  teacher / class / roster
├── course-schedule.test.ts             [NEW]  规则 CRUD + checkScheduleConflicts
├── course-session.test.ts              [NEW]  generateMonth 幂等 + 微调 + 手动加课 + 不追溯
├── course-validation.test.ts           [NEW]
└── attendance-repo.test.ts             [MODIFY]  + sessionId 透传用例
tests/e2e/course-flow.spec.ts           [NEW]
```

---

## 3. 数据模型 / Data Model

### 3.1 迁移 v6（`user_version` → 6）

```sql
-- src/db/migrations.ts 内 const v6 = (db) => db.exec(`...`)

CREATE TABLE IF NOT EXISTS teachers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT '在职',        -- 在职 | 离职（无 CHECK，校验层把关）
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT                                  -- 非空即已软删
);
CREATE INDEX IF NOT EXISTS idx_teachers_status  ON teachers(status);
CREATE INDEX IF NOT EXISTS idx_teachers_deleted ON teachers(deleted_at);

CREATE TABLE IF NOT EXISTS classes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  dance_type  TEXT NOT NULL,
  level       TEXT,
  teacher_id  INTEGER REFERENCES teachers(id),      -- 主教；可空；无级联
  room        TEXT,
  capacity    INTEGER,                              -- 可空；正整数（校验层）
  start_date  TEXT,                                 -- 'YYYY-MM-DD'，可空
  end_date    TEXT,
  status      TEXT NOT NULL DEFAULT '在读',          -- 在读 | 停课 | 结课
  note        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_classes_status  ON classes(status);
CREATE INDEX IF NOT EXISTS idx_classes_dance   ON classes(dance_type);
CREATE INDEX IF NOT EXISTS idx_classes_teacher ON classes(teacher_id);
CREATE INDEX IF NOT EXISTS idx_classes_deleted ON classes(deleted_at);

CREATE TABLE IF NOT EXISTS class_students (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id    INTEGER NOT NULL REFERENCES classes(id),
  student_id  INTEGER NOT NULL REFERENCES students(id),
  joined_at   TEXT NOT NULL,                        -- 'YYYY-MM-DD'
  left_at     TEXT,                                 -- 非空即已离班
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cs_class   ON class_students(class_id);
CREATE INDEX IF NOT EXISTS idx_cs_student ON class_students(student_id);
-- 同一学员在同一班「同时」只能有一条在册记录；离班后（left_at 非空）可再入班
CREATE UNIQUE INDEX IF NOT EXISTS uniq_class_student_active
  ON class_students(class_id, student_id) WHERE left_at IS NULL;

CREATE TABLE IF NOT EXISTS class_schedules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id       INTEGER NOT NULL REFERENCES classes(id),
  weekday        INTEGER NOT NULL,                  -- 0=周日 … 6=周六（对齐 Date.getDay()）
  start_time     TEXT NOT NULL,                     -- 'HH:MM'
  end_time       TEXT NOT NULL,                     -- 'HH:MM'，> start_time（校验层）
  teacher_id     INTEGER REFERENCES teachers(id),   -- 覆盖班主教；可空
  room           TEXT,                              -- 覆盖班教室；可空
  effective_from TEXT,                              -- 'YYYY-MM-DD'，可空；本期 UI 不暴露
  effective_to   TEXT,                              -- 可空；本期 UI 不暴露
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sch_class    ON class_schedules(class_id);
CREATE INDEX IF NOT EXISTS idx_sch_weekday  ON class_schedules(weekday);
CREATE INDEX IF NOT EXISTS idx_sch_deleted  ON class_schedules(deleted_at);

CREATE TABLE IF NOT EXISTS class_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id     INTEGER NOT NULL REFERENCES classes(id),
  schedule_id  INTEGER REFERENCES class_schedules(id),   -- 计划实例指向来源规则；手动加课为 NULL
  session_date TEXT NOT NULL,                             -- 'YYYY-MM-DD'
  start_time   TEXT NOT NULL,                             -- 'HH:MM'
  end_time     TEXT NOT NULL,
  teacher_id   INTEGER REFERENCES teachers(id),           -- 这一天谁上（生成时取生效老师，之后可改=代课）
  room         TEXT,
  status       TEXT NOT NULL DEFAULT '正常',              -- 正常 | 停课
  origin       TEXT NOT NULL,                             -- 计划 | 手动
  note         TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_sess_class   ON class_sessions(class_id);
CREATE INDEX IF NOT EXISTS idx_sess_date    ON class_sessions(session_date);
CREATE INDEX IF NOT EXISTS idx_sess_teacher ON class_sessions(teacher_id);
CREATE INDEX IF NOT EXISTS idx_sess_deleted ON class_sessions(deleted_at);
-- 同一班同一天同一开始时间只允许一节未软删课
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sess_slot
  ON class_sessions(class_id, session_date, start_time) WHERE deleted_at IS NULL;
```

- 不加 `CHECK(weekday BETWEEN 0 AND 6)` / `CHECK(status IN (...))` / `CHECK(end_time > start_time)`：
  枚举与范围由 `course.validation.ts` 把关，和 `students.status` / `attendance_records.type` 无 CHECK 的现状一致。
- `PRAGMA foreign_keys = ON`（`connection.ts` 已设）：`REFERENCES` 仅保证「插入时被引用行必须存在」；
  全部软删、无 `ON DELETE CASCADE`。
- `MIGRATIONS` 数组变为 `[{v1},{v2},{v4},{v5},{v6}]`；`LATEST_VERSION` 自动算得 6。

### 3.2 实体定义（追加到 `src/shared/types.ts`）

```ts
// ========================= 课程管理模块 =========================

export type TeacherStatus = '在职' | '离职';
export type ClassStatus   = '在读' | '停课' | '结课';
export type SessionStatus = '正常' | '停课';
export type SessionOrigin = '计划' | '手动';
export type SessionUpdateAction = '停课' | '恢复' | '改时间' | '换老师';

export interface Teacher {
  id: number;
  name: string;
  status: TeacherStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
export interface TeacherInput {
  name: string;
  status?: TeacherStatus;           // 省略 → '在职'
}

export interface CourseClass {
  id: number;
  name: string;
  danceType: string;
  level: string | null;
  teacherId: number | null;
  teacherName: string | null;       // JOIN teachers（含已软删）
  room: string | null;
  capacity: number | null;
  startDate: string | null;
  endDate: string | null;
  status: ClassStatus;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
export interface CourseClassInput {
  name: string;
  danceType: string;
  level?: string | null;
  teacherId?: number | null;
  room?: string | null;
  capacity?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  status?: ClassStatus;             // 省略 → '在读'
  note?: string | null;
}
export interface CourseClassListItem extends CourseClass {
  activeRosterCount: number;
  overCapacity: boolean;            // capacity != null && activeRosterCount > capacity
}
export interface CourseClassListQuery {
  status?: ClassStatus;
  danceType?: string;
  teacherId?: number;
  keyword?: string;                 // 班名子串
}

export interface RosterMember {
  studentId: number;
  name: string;
  phone: string;
  remainingLessons: number | null;
  cardExpireDate: string | null;
  joinedAt: string;
}
export interface RosterAddInput {
  classId: number;
  studentId: number;
  joinedAt?: string;               // 省略 → 今天
}
export interface RosterRemoveInput {
  classId: number;
  studentId: number;
  leftAt?: string;                 // 省略 → 今天
}
export interface RosterMutationResult {
  classId: number;
  activeRosterCount: number;
  overCapacity: boolean;
}

export interface ClassSchedule {
  id: number;
  classId: number;
  weekday: number;                 // 0–6
  startTime: string;              // 'HH:MM'
  endTime: string;
  teacherId: number | null;       // 覆盖值
  room: string | null;            // 覆盖值
  effectiveFrom: string | null;
  effectiveTo: string | null;
  effectiveTeacherId: number | null;   // COALESCE(schedule.teacherId, class.teacherId)
  effectiveTeacherName: string | null;
  effectiveRoom: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
export interface ClassScheduleInput {
  classId: number;
  weekday: number;
  startTime: string;
  endTime: string;
  teacherId?: number | null;
  room?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}
export interface ScheduleConflict {
  kind: '老师' | '教室';
  refType: '规则' | '课节';
  refId: number;
  label: string;                  // 冲突对象的班名
  weekdayOrDate: string;          // 规则 → String(weekday)；课节 → 'YYYY-MM-DD'
  startTime: string;
  endTime: string;
}
export interface ScheduleMutationResult {
  schedule: ClassSchedule;
  conflicts: ScheduleConflict[];  // 非阻断
}

export interface WeeklyTimetableQuery {
  danceType?: string;
  teacherId?: number;
}
export interface WeeklyTimetableEntry {
  scheduleId: number;
  classId: number;
  className: string;
  danceType: string;
  level: string | null;
  weekday: number;
  startTime: string;
  endTime: string;
  teacherId: number | null;
  teacherName: string | null;     // 生效老师
  room: string | null;            // 生效教室
  activeRosterCount: number;
}

export interface ClassSession {
  id: number;
  classId: number;
  scheduleId: number | null;
  sessionDate: string;            // 'YYYY-MM-DD'
  startTime: string;
  endTime: string;
  teacherId: number | null;
  room: string | null;
  status: SessionStatus;
  origin: SessionOrigin;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}
export interface ClassSessionListItem extends ClassSession {
  className: string;
  danceType: string;
  teacherName: string | null;
}
export interface SessionMonthQuery {
  teacherId?: number;
  year: number;
  month: number;                  // 1–12
}
export interface SessionDateItem {
  id: number;
  classId: number;
  className: string;
  teacherId: number | null;
  teacherName: string | null;
  startTime: string;
  endTime: string;
  status: SessionStatus;
  activeRosterCount: number;
}
export interface ClassSessionInput {          // 手动加课
  classId: number;
  sessionDate: string;
  startTime: string;
  endTime: string;
  teacherId?: number | null;
  room?: string | null;
  note?: string | null;
}
export interface SessionUpdateInput {
  id: number;
  action: SessionUpdateAction;
  startTime?: string;             // action='改时间' 必填
  endTime?: string;              // action='改时间' 必填
  teacherId?: number | null;      // action='换老师'：给出 → 指派；null → 取消指派
  note?: string | null;           // action='停课' 可带
}
export interface SessionMutationResult {
  session: ClassSessionListItem;
  conflicts: ScheduleConflict[];  // 非阻断；action ∈ {改时间,换老师} 或手动加课时才可能非空
}
export interface GenerateMonthResult {
  created: number;
}
```

`IpcErrorCode` 追加：

```ts
  // —— 课程管理 ——
  | 'TEACHER_NOT_FOUND'        // teacher_id 不存在
  | 'CLASS_NOT_FOUND'          // class_id 不存在或已软删
  | 'SCHEDULE_NOT_FOUND'      // 周期规则不存在或已软删
  | 'SESSION_NOT_FOUND'       // 排课实例不存在或已软删
  | 'STUDENT_ALREADY_IN_CLASS' // 该学员在该班已有在册记录
  | 'DUPLICATE_SESSION'       // 同班同日同开始时间已有未软删课节
  | 'INVALID_TIME_RANGE'      // 时间格式非法或 end_time <= start_time
  | 'INVALID_WEEKDAY'         // weekday 非 0–6 整数
```

`BatchCheckInInput` 追加：

```ts
  /** 课程管理上线后：批量点名关联的课节 id；给出则每条流水回填 session_id */
  sessionId?: number | null;
```

### 3.3 关系

- `classes.teacher_id → teachers.id`（多对一，可空，无级联；JOIN 取主教姓名，含已软删老师）。
- `class_students.class_id → classes.id`、`class_students.student_id → students.id`（无级联；
  在册成员 JOIN `students` 取姓名 / 手机号 / 剩余课时，含已软删学员）。
- `class_schedules.class_id → classes.id`；`class_schedules.teacher_id → teachers.id`（覆盖值，可空）。
- `class_sessions.class_id → classes.id`；`class_sessions.schedule_id → class_schedules.id`（可空，手动加课为 NULL）；
  `class_sessions.teacher_id → teachers.id`（可空）。
- `attendance_records.session_id → class_sessions.id`：**逻辑关联，仍无外键、无 DDL 变更**；
  容忍指向已软删课节。

### 3.4 迁移计划

- 前向单向，无 `down`（沿用现状）。空库从 v2 直接跳到 v6；跑过 v4 / v5 的库按序补到 v6。
- 全部 `CREATE ... IF NOT EXISTS`；`run()` 启动期已有「重复版本号即抛错」守卫。
- 回滚策略：`v6.up` 抛错则该版事务回滚，`user_version` 停在上一版，下次启动重试。
- 合并顺序：`feat/inventory-management`(v4) → `feat/attendance-management`(v5) → `feat/course-management`(v6)
  依次并入 main；若 rebase 时 v6 被占，renumber 为下一个空号并在 commit body 注明。
- `feat/class-name-field`(v3，`students` 加 `class_name` 列) 与本模块无耦合：本模块用 `class_students` 表管花名册，
  不依赖 `students.class_name`。

---

## 4. 接口设计 / IPC Surface

### 4.1 频道清单（全部 `ipcMain.handle` / `ipcRenderer.invoke`，返回 `IpcResult<T>`）

| CH 常量 | 频道字符串 | 入参 | 成功 data | 主要错误 |
|---|---|---|---|---|
| `courseTeacherList` | `course:teacherList` | `{ includeInactive?: boolean }?` | `Teacher[]` | — |
| `courseTeacherCreate` | `course:teacherCreate` | `TeacherInput` | `Teacher` | `VALIDATION_FAILED` |
| `courseTeacherUpdate` | `course:teacherUpdate` | `(id: number, TeacherInput)` | `Teacher` | `VALIDATION_FAILED` / `TEACHER_NOT_FOUND` |
| `courseTeacherDelete` | `course:teacherDelete` | `id: number` | `{ id }` | `TEACHER_NOT_FOUND` / `BAD_REQUEST` |
| `courseClassList` | `course:classList` | `CourseClassListQuery?` | `CourseClassListItem[]` | — |
| `courseClassGet` | `course:classGet` | `id: number` | `CourseClassListItem` | `CLASS_NOT_FOUND` |
| `courseClassCreate` | `course:classCreate` | `CourseClassInput` | `CourseClass` | `VALIDATION_FAILED` / `TEACHER_NOT_FOUND` |
| `courseClassUpdate` | `course:classUpdate` | `(id: number, CourseClassInput)` | `CourseClass` | `VALIDATION_FAILED` / `CLASS_NOT_FOUND` / `TEACHER_NOT_FOUND` |
| `courseClassDelete` | `course:classDelete` | `id: number` | `{ id }` | `CLASS_NOT_FOUND` / `BAD_REQUEST` |
| `courseRosterList` | `course:rosterList` | `classId: number` | `RosterMember[]` | `CLASS_NOT_FOUND` |
| `courseRosterAdd` | `course:rosterAdd` | `RosterAddInput` | `RosterMutationResult` | `VALIDATION_FAILED` / `CLASS_NOT_FOUND` / `NOT_FOUND` / `STUDENT_ALREADY_IN_CLASS` |
| `courseRosterRemove` | `course:rosterRemove` | `RosterRemoveInput` | `RosterMutationResult` | `VALIDATION_FAILED` / `NOT_FOUND` |
| `courseScheduleList` | `course:scheduleList` | `classId: number` | `ClassSchedule[]` | `CLASS_NOT_FOUND` |
| `courseScheduleCreate` | `course:scheduleCreate` | `ClassScheduleInput` | `ScheduleMutationResult` | `VALIDATION_FAILED` / `INVALID_WEEKDAY` / `INVALID_TIME_RANGE` / `CLASS_NOT_FOUND` / `TEACHER_NOT_FOUND` |
| `courseScheduleUpdate` | `course:scheduleUpdate` | `(id: number, ClassScheduleInput)` | `ScheduleMutationResult` | 同上 + `SCHEDULE_NOT_FOUND` |
| `courseScheduleDelete` | `course:scheduleDelete` | `id: number` | `{ id }` | `SCHEDULE_NOT_FOUND` / `BAD_REQUEST` |
| `courseWeeklyTimetable` | `course:weeklyTimetable` | `WeeklyTimetableQuery?` | `WeeklyTimetableEntry[]` | — |
| `courseGenerateMonth` | `course:generateMonth` | `{ year: number, month: number }` | `GenerateMonthResult` | `BAD_REQUEST` |
| `courseSessionsByMonth` | `course:sessionsByMonth` | `SessionMonthQuery` | `ClassSessionListItem[]` | `BAD_REQUEST` |
| `courseSessionsByDate` | `course:sessionsByDate` | `{ date: string }` | `SessionDateItem[]` | `BAD_REQUEST` |
| `courseSessionCreate` | `course:sessionCreate` | `ClassSessionInput` | `SessionMutationResult` | `VALIDATION_FAILED` / `INVALID_TIME_RANGE` / `CLASS_NOT_FOUND` / `TEACHER_NOT_FOUND` / `DUPLICATE_SESSION` |
| `courseSessionUpdate` | `course:sessionUpdate` | `SessionUpdateInput` | `SessionMutationResult` | `VALIDATION_FAILED` / `SESSION_NOT_FOUND` / `INVALID_TIME_RANGE` / `TEACHER_NOT_FOUND` |
| `courseSessionDelete` | `course:sessionDelete` | `id: number` | `{ id }` | `SESSION_NOT_FOUND` / `BAD_REQUEST` |

考勤联动**不新增频道**：`attendance:batchCheckIn` 入参多一个可选 `sessionId`。

### 4.2 `channels.ts` 常量（追加到 `CH`）

```ts
  // 课程管理
  courseTeacherList: 'course:teacherList',
  courseTeacherCreate: 'course:teacherCreate',
  courseTeacherUpdate: 'course:teacherUpdate',
  courseTeacherDelete: 'course:teacherDelete',
  courseClassList: 'course:classList',
  courseClassGet: 'course:classGet',
  courseClassCreate: 'course:classCreate',
  courseClassUpdate: 'course:classUpdate',
  courseClassDelete: 'course:classDelete',
  courseRosterList: 'course:rosterList',
  courseRosterAdd: 'course:rosterAdd',
  courseRosterRemove: 'course:rosterRemove',
  courseScheduleList: 'course:scheduleList',
  courseScheduleCreate: 'course:scheduleCreate',
  courseScheduleUpdate: 'course:scheduleUpdate',
  courseScheduleDelete: 'course:scheduleDelete',
  courseWeeklyTimetable: 'course:weeklyTimetable',
  courseGenerateMonth: 'course:generateMonth',
  courseSessionsByMonth: 'course:sessionsByMonth',
  courseSessionsByDate: 'course:sessionsByDate',
  courseSessionCreate: 'course:sessionCreate',
  courseSessionUpdate: 'course:sessionUpdate',
  courseSessionDelete: 'course:sessionDelete',
```

### 4.3 `preload.ts` 追加

同一份 `CH` 字面量补 24 条；`api` 增加：

```ts
  course: {
    teacherList: (opts?: unknown) => invoke(CH.courseTeacherList, opts),
    teacherCreate: (input: unknown) => invoke(CH.courseTeacherCreate, input),
    teacherUpdate: (id: number, input: unknown) => invoke(CH.courseTeacherUpdate, id, input),
    teacherDelete: (id: number) => invoke(CH.courseTeacherDelete, id),
    classList: (query?: unknown) => invoke(CH.courseClassList, query),
    classGet: (id: number) => invoke(CH.courseClassGet, id),
    classCreate: (input: unknown) => invoke(CH.courseClassCreate, input),
    classUpdate: (id: number, input: unknown) => invoke(CH.courseClassUpdate, id, input),
    classDelete: (id: number) => invoke(CH.courseClassDelete, id),
    rosterList: (classId: number) => invoke(CH.courseRosterList, classId),
    rosterAdd: (input: unknown) => invoke(CH.courseRosterAdd, input),
    rosterRemove: (input: unknown) => invoke(CH.courseRosterRemove, input),
    scheduleList: (classId: number) => invoke(CH.courseScheduleList, classId),
    scheduleCreate: (input: unknown) => invoke(CH.courseScheduleCreate, input),
    scheduleUpdate: (id: number, input: unknown) => invoke(CH.courseScheduleUpdate, id, input),
    scheduleDelete: (id: number) => invoke(CH.courseScheduleDelete, id),
    weeklyTimetable: (query?: unknown) => invoke(CH.courseWeeklyTimetable, query),
    generateMonth: (args: unknown) => invoke(CH.courseGenerateMonth, args),
    sessionsByMonth: (query: unknown) => invoke(CH.courseSessionsByMonth, query),
    sessionsByDate: (args: unknown) => invoke(CH.courseSessionsByDate, args),
    sessionCreate: (input: unknown) => invoke(CH.courseSessionCreate, input),
    sessionUpdate: (input: unknown) => invoke(CH.courseSessionUpdate, input),
    sessionDelete: (id: number) => invoke(CH.courseSessionDelete, id),
  },
```

`studioShell.d.ts` 增补 `course` 命名空间的具类型签名（编辑器提示用，不进 tsconfig include）；
`attendance.batchCheckIn` 的入参类型换成含 `sessionId?` 的 `BatchCheckInInput`。

### 4.4 错误响应

统一 `IpcResult`：`{ ok:false, error:{ code, message, fields? } }`。`fields` 仅 `VALIDATION_FAILED` 时带
（字段 key → 中文提示）。冲突检测**不是错误**：`scheduleCreate/Update`、`sessionCreate/Update` 成功时
`data.conflicts` 为数组（可能为空）。

### 4.5 破坏性变更

无。纯新增频道 + `BatchCheckInInput` 多一个可选字段（既有调用不传即 `null`，行为不变）+
`attendance.validation.ts` 把原本「恒 null」的 `sessionId` 改为按入参透传（不影响不传的调用）。

---

## 5. 业务逻辑 / Business Logic

### 5.1 核心算法

见 §2.3 A–F。补充要点：

- **`weeklyTimetable(query)`**：
  ```sql
  SELECT sch.id AS scheduleId, sch.class_id AS classId, c.name AS className,
         c.dance_type AS danceType, c.level, sch.weekday, sch.start_time AS startTime,
         sch.end_time AS endTime,
         COALESCE(sch.teacher_id, c.teacher_id) AS teacherId,
         t.name AS teacherName,
         COALESCE(NULLIF(sch.room,''), c.room) AS room,
         (SELECT COUNT(*) FROM class_students cs
           WHERE cs.class_id = c.id AND cs.left_at IS NULL) AS activeRosterCount
    FROM class_schedules sch
    JOIN classes c ON c.id = sch.class_id
    LEFT JOIN teachers t ON t.id = COALESCE(sch.teacher_id, c.teacher_id)
   WHERE sch.deleted_at IS NULL AND c.deleted_at IS NULL AND c.status != '结课'
     {AND c.dance_type = @danceType}
     {AND COALESCE(sch.teacher_id, c.teacher_id) = @teacherId}
   ORDER BY sch.weekday, sch.start_time, c.name COLLATE NOCASE
  ```
- **`classList(query)`**：JOIN `teachers` 取主教名；`activeRosterCount` 子查询；`overCapacity` 应用层算；
  默认 `WHERE c.deleted_at IS NULL`，可选 `status` / `dance_type` / `teacher_id` / `keyword`（`name LIKE`，`escapeLike` + `ESCAPE '\'`）；
  `ORDER BY c.name COLLATE NOCASE`。
- **`rosterAdd`**（`db.transaction`）：
  ```
  SELECT 1 FROM classes  WHERE id=@classId  AND deleted_at IS NULL   否则 throw CLASS_NOT_FOUND
  SELECT 1 FROM students WHERE id=@studentId AND deleted_at IS NULL   否则 throw NOT_FOUND
  SELECT 1 FROM class_students
    WHERE class_id=@classId AND student_id=@studentId AND left_at IS NULL   命中 → throw STUDENT_ALREADY_IN_CLASS
  INSERT INTO class_students (class_id, student_id, joined_at, created_at, updated_at)
    VALUES (@classId, @studentId, @joinedAt, @now, @now)
  → 重算 activeRosterCount / overCapacity 返回（超容量不报错）
  ```
  并发不设防：better-sqlite3 同步单连接，事务内无第二写者；部分唯一索引是最后一道兜底
  （命中则抛 `DB_ERROR`，实际走不到）。
- **`rosterRemove`**：`UPDATE class_students SET left_at=@leftAt, updated_at=@now
  WHERE class_id=@classId AND student_id=@studentId AND left_at IS NULL`；`changes=0` → throw `NOT_FOUND`。
- **`sessionsByDate({ date })`**：`isRealYmd(date)` 否则 `BAD_REQUEST`；返回该日期未软删实例 JOIN 班名 /
  生效老师名 + `activeRosterCount` 子查询；`ORDER BY start_time, className`。

### 5.2 校验规则（`course.validation.ts`）

| 字段 | 规则 | 失败 |
|---|---|---|
| `teacher.name` | 非空，`trim` 后 ≤ 20 字 | `VALIDATION_FAILED` `{ name }` |
| `teacher.status` | 空 → `在职`；否则 ∈ {`在职`,`离职`} | `VALIDATION_FAILED` `{ status }` |
| `class.name` | 非空，≤ 40 字 | `{ name }` |
| `class.danceType` | 非空，≤ 20 字 | `{ danceType }` |
| `class.level` / `room` | 空 → null；≤ 20 字 | `{ level }` / `{ room }` |
| `class.capacity` | 空 → null；否则 `Number.isInteger` 且 ≥ 1 | `{ capacity }` |
| `class.startDate` / `endDate` | 空 → null；否则 `isRealYmd`；两者都给时 `endDate >= startDate` | `{ startDate }` / `{ endDate }` |
| `class.status` | 空 → `在读`；否则 ∈ {`在读`,`停课`,`结课`} | `{ status }` |
| `class.note` | 空 → null；≤ 200 字 | `{ note }` |
| `schedule.weekday` | `Number.isInteger` 且 0 ≤ w ≤ 6 | **`INVALID_WEEKDAY`**（register 层据此抛，非 `VALIDATION_FAILED`）|
| `schedule.startTime` / `endTime` | 匹配 `/^([01]\d|2[0-3]):[0-5]\d$/` 且 `endTime > startTime`（字符串比较即可）| **`INVALID_TIME_RANGE`** |
| `schedule.effectiveFrom` / `effectiveTo` | 空 → null；否则 `isRealYmd`；都给时 `to >= from` | `VALIDATION_FAILED` |
| `roster.joinedAt` / `leftAt` | 空 → 今天；否则 `isRealYmd` | `VALIDATION_FAILED` |
| `session.sessionDate`（手动加课）| 非空且 `isRealYmd` | `VALIDATION_FAILED` `{ sessionDate }` |
| `session` 时间（手动加课 / 改时间）| 同 `schedule` 时间规则 | **`INVALID_TIME_RANGE`** |
| `sessionUpdate.action` | ∈ {`停课`,`恢复`,`改时间`,`换老师`}；`改时间` 必带 `startTime`+`endTime` | `VALIDATION_FAILED` / `BAD_REQUEST` |
| `SessionMonthQuery.year` / `month` | `year` 整数 2000–2100；`month` 整数 1–12 | `BAD_REQUEST` |
| `BatchCheckInInput.sessionId` | 空 → null；否则正整数（不校验存在性）| `VALIDATION_FAILED` |

即时校验（渲染层）只为体验；能否写入以上表为准（与学员 / 库存 / 考勤一致）。
`todayYmd` / `isRealYmd` 在 `course.validation.ts` 内**复制一份**（库存 / 考勤即如此），不抽公共模块。

### 5.3 状态与生命周期

- **`teachers.status`**：`在职` ↔ `离职`（自由切换）。软删（`deleted_at`）后仍被历史 JOIN 带出姓名。
- **`classes.status`**：`在读`（`generateMonth` 会为其铺课）/ `停课`（保留但不铺新课）/ `结课`（不铺、不进课程表）。软删同上。
- **`class_students`**：`在册`（`left_at IS NULL`）↔ `已离班`（`left_at` 非空）。同班同人可多段（离班后再入班 = 新一行）。
- **`class_schedules`**：`有效`（`deleted_at IS NULL`）↔ `已删`。删规则不动已生成实例（不追溯）。
- **`class_sessions`**：`正常` ↔ `停课`（可逆，`恢复`）；软删不可逆（要恢复 = 下次 `generateMonth` 重铺，或手动加课）。
  改时间 / 换老师是字段编辑，不改 `status`、不改 `schedule_id`、不改 `origin`。

### 5.4 边界情况

| 场景 | 处理 |
|---|---|
| 一条「每周三」规则对 2026-09（有 5 个周三）`generateMonth` | 生成 5 条实例；重复调用 `created=0`，不改任何已存在实例 |
| 某实例被「停课」后再次 `generateMonth` 当月 | `(schedule_id, session_date)` 命中 → 跳过，停课状态保留 |
| 某实例被软删后再次 `generateMonth` 当月 | 存在性判断只看未软删 → 重新 INSERT 一条新 `正常` 实例 |
| 改周期规则的时间（19:00→20:00）后看本月计划表 | 已生成实例仍是 19:00；只有「下个月」或「本月里该规则尚未生成的日期」用新时间 |
| 规则 `effective_from` 在本月中旬 | 只为 ≥ `effective_from` 的周 X 生成 |
| 班 `status='结课'` | `generateMonth` 跳过；`weeklyTimetable` 不返回；`classList` 需显式 `status='结课'` 才列出 |
| 班主教为空、规则也没填老师 | 生成的实例 `teacher_id=NULL`；「上课时间计划表」选任一老师都不显示它；「全部老师」视图可见 |
| 换代课老师到一个 `离职` 老师 | 允许（`离职` 只是标记，不禁止指派）；下拉默认只列在职，但接口不拦 |
| 同一老师同一周三 19:00–20:00 与 19:30–20:30 两条规则（不同班）| `checkScheduleConflicts` 返回一条 `kind:'老师'`；两条规则都能保存 |
| 手动加课到已有同班同日同开始时间的槽位 | `DUPLICATE_SESSION` |
| 容量 2 的班加入第 3 人 | 加入成功，`RosterMutationResult.overCapacity=true`，渲染层 `#toast` 提示 |
| 学员已离班后再次加入同班 | 允许，新增一行 `class_students`，`joined_at` 为新日期 |
| 删除班级 | 软删；`class_students` / `class_schedules` / `class_sessions` 全留；`weeklyTimetable` / 计划表不再显示 |
| 考勤「选择课节」后该课节被停课 | 停课实例在 `sessionsByDate` 里带 `status='停课'`，渲染层置灰不可选；已提交的考勤流水不受影响 |
| `attendance_records.session_id` 指向的课节后来被软删 | 无外键，考勤记录照常存在、照常显示（`session_id` 变成悬空引用，本期不做清理）|
| `sessionsByMonth` 传未来 / 过去的月份 | 照常 `generateMonth` 那个月并返回；不限制月份范围 |

---

## 6. 错误处理 / Error Handling

### 6.1 错误分类

| Error Code | 触发条件 | 用户消息（示例）|
|---|---|---|
| `VALIDATION_FAILED` | 字段校验不过 | 请检查表单填写（附 `fields`）|
| `INVALID_WEEKDAY` | `weekday` 非 0–6 整数 | 星期取值应为 0（周日）到 6（周六）|
| `INVALID_TIME_RANGE` | 时间格式非法 / 结束 ≤ 开始 | 结束时间必须晚于开始时间 |
| `TEACHER_NOT_FOUND` | `teacher_id` 不存在 | 老师不存在，可能已被删除 |
| `CLASS_NOT_FOUND` | `class_id` 不存在或已软删 | 班级不存在，可能已被删除 |
| `SCHEDULE_NOT_FOUND` | 规则不存在或已软删 | 该周期规则不存在 |
| `SESSION_NOT_FOUND` | 实例不存在或已软删 | 该课节不存在，可能已被删除 |
| `STUDENT_ALREADY_IN_CLASS` | 该学员在该班已有在册记录 | 该学员已在此班在册 |
| `DUPLICATE_SESSION` | 同班同日同开始时间已有未软删课节 | 该班这个时间已有一节课 |
| `NOT_FOUND` | `student_id` 不存在 / `rosterRemove` 无在册记录 | 学员不存在 / 该学员不在此班在册 |
| `BAD_REQUEST` | 缺 id / `year`·`month` 非法 / `action` 缺参 | （具体文案）|
| `DB_ERROR` | 未归类异常（`toIpcError` 兜底）| （原始 message）|

### 6.2 重试策略

无自动重试。写操作均幂等或可逆：`generateMonth` 幂等可重入；`sessionUpdate` 的「停课/恢复」可反复切；
`rosterAdd/Remove` 失败即整事务回滚（无残留）。冲突检测非阻断，用户看提示后自行决定是否改。

### 6.3 失败模式

- DB 文件锁 / 磁盘满：`better-sqlite3` 抛异常 → `handle()` 兜底为 `DB_ERROR`，事务已回滚，页面 `toast` 报错。
- `generateMonth` 中途抛错（极少见）：整个事务回滚，当月一条不生成，下次进入计划表重试。
- 外键冲突（如 `rosterAdd` 传了不存在的 `student_id` 且绕过前置 SELECT）：`SQLITE_CONSTRAINT` → `DB_ERROR`。

---

## 7. 安全 / Security

- 单机桌面单用户，无认证 / 授权（与学员、库存、考勤模块一致）。
- 所有 SQL 走 better-sqlite3 预编译语句 + 命名参数；`LIKE` 的 `% _ \` 用 `escapeLike` 转义 + `ESCAPE '\'`。
- `contextIsolation: true` / `nodeIntegration: false` 不变；渲染层只经 `window.studioShell.course.*` /
  `window.studioShell.attendance.*`。
- 无敏感数据加密需求（本模块不新增 PII；学员姓名 / 手机号沿用既有表，仅在花名册 JOIN 时读取）。
- 本模块无文件读写（无 `io/*`、无 dialog）。

---

## 8. 性能 / Performance

### 8.1 预期负载

单机；老师 ~10、班级 ~50、每班规则 1–3 条、在册学员每班 ~15。排课实例量级：50 班 × 平均 2 节/周 ×
4.3 周/月 ≈ 430 条/月 ≈ 5000 条/年。全部本地 SQLite。

### 8.2 优化策略

- `generateMonth`：单事务内批量 `INSERT`；每规则每月循环 ≤ ~5 个匹配日期，存在性 SELECT 走 `idx_sess_date` +
  应用层过滤，规模小（数百次），亚秒完成。首次进入某月有一次性写入成本，之后进入命中「已存在」全跳过。
- `sessionsByMonth`：先 `generateMonth`（多数情况下 `created=0`）再一条 JOIN 查询，命中 `idx_sess_date`。
- `weeklyTimetable`：一条 JOIN + 子查询计数，规则总量 ≤ ~150 行，无分页。
- `classList` / `rosterList`：规模小，无分页；`activeRosterCount` 用相关子查询（数据量下可接受）。
- 冲突检测：`checkScheduleConflicts` 先按 `weekday` 过滤（`idx_sch_weekday`）再应用层比对；
  `checkSessionConflicts` 按 `session_date` 过滤（`idx_sess_date`）。候选集都是个位到十几行。

### 8.3 数据库考量

- 索引：`class_sessions` 四个单列索引（`class_id` / `session_date` / `teacher_id` / `deleted_at`）覆盖
  月视图、日视图、老师过滤、生成时的存在性判断；部分唯一索引 `uniq_sess_slot` 兜底重复槽位。
- `class_students` 部分唯一索引 `uniq_class_student_active` 保证「同时只在册一条」，且离班后不挡再入班。
- `generateMonth` 的幂等靠「事务内先 SELECT 存在性、再 INSERT」，不靠捕获唯一索引冲突（better-sqlite3
  同步 + 单连接，事务内无并发写者）。
- N+1：所有列表 / 视图为单条 JOIN（含相关子查询计数），无逐行回查。

---

## 9. 测试策略 / Testing Strategy

### 9.1 单元测试（`node:test`，`tests/unit/*.test.ts`，经 `tsconfig.test.json` → `dist-test/`）

| 文件 | 覆盖 |
|---|---|
| `course-migration.test.ts` | 空库 `run` 到 v6：5 表 + 全部索引（含两个部分唯一索引）齐全；重复 `run` 幂等；`v6.up` 中途抛错 → 回滚、`user_version` 不前进；含 v5 的库能补到 v6；`MIGRATIONS` 版本号唯一（`run` 的守卫）|
| `course-repo.test.ts` | 老师增改软删、软删后 JOIN 仍带出名；班级增改软删、软删班不进 `classList`/`weeklyTimetable`；`classList` 按 `status`/`danceType`/`teacherId`/`keyword` 筛选；`activeRosterCount`/`overCapacity` 正确；`rosterAdd` 重复 → `STUDENT_ALREADY_IN_CLASS`；超容量加人成功且 `overCapacity=true`；`rosterRemove` 置 `left_at`、无在册 → `NOT_FOUND`；离班后可再加入 |
| `course-schedule.test.ts` | `weekday=7` → `INVALID_WEEKDAY`；`endTime<=startTime` → `INVALID_TIME_RANGE`；一个班多条规则；同生效老师同 weekday 时段重叠 → `conflicts` 含 `kind:'老师'`；同生效教室重叠 → 含 `kind:'教室'`；生效区间不相交 → 无冲突；`excludeScheduleId` 生效（改自己不自撞）；软删规则不参与扫描；`scheduleUpdate` 不触碰 `class_sessions` |
| `course-session.test.ts` | 「每周三」规则对某月生成正确条数；重复 `generateMonth` `created=0` 且不改已存在实例；人工「停课」后再 `generateMonth` 不复活；软删实例后 `generateMonth` 重铺一条；`改时间`/`换老师` 生效且 `schedule_id` 不变；`换老师` 到不存在 id → `TEACHER_NOT_FOUND`；`sessionCreate` 手动加课 `origin='手动'`/`schedule_id=NULL`；同槽位 → `DUPLICATE_SESSION`；`结课` 班不生成；规则 `effective_from` 裁剪生效；`sessionsByMonth` 按 `teacherId` 过滤且排除 `teacher_id IS NULL` |
| `course-validation.test.ts` | `isRealYmd` 拦 2026-02-30；`TIME_RE`；各字段长度上限；`capacity` 非正整数报错；`class.endDate < startDate` 报错；`SessionMonthQuery` 的 `month=13` → `BAD_REQUEST`；`sessionUpdate` `action='改时间'` 缺 `endTime` 报错 |
| `attendance-repo.test.ts`（增补）| `createRecord({..., sessionId: N})` 落库 `session_id=N`；`batchCreate` 每条带同一 `sessionId`；不传 → `session_id IS NULL`；`voidRecord` / `correctRecord` 不受 `session_id` 影响 |

测试用内存 / 临时库：`new Database(':memory:')` 或 `STUDIO_DB_PATH` 临时文件 + `migrations.run(db)`，
预置若干 `students`（含 `remaining_lessons` 分别为 `null` / `0` / `10`）与 `teachers`。

### 9.2 集成测试

并入 §9.1 各 repo 测试（直接调 `course.repo` + `attendance.repo`，不经 Electron），与前三个模块一致，
不新建 `tests/integration/`。

### 9.3 边界用例测试（对应 §5.4）

在 `course-session.test.ts` / `course-repo.test.ts` 内逐条覆盖 §5.4：幂等生成、停课后不复活、软删后重铺、
规则改时间不追溯、`effective_from` 裁剪、结课班不生成、空老师实例的过滤、超容量加人、离班再入班、
手动加课撞槽位。

### 9.4 E2E（Playwright `_electron`，`tests/e2e/course-flow.spec.ts`）

`env.STUDIO_DB_PATH` → 临时文件；每个用例自起自关 Electron，自建自清数据（预置 2 名学员）。用例：

1. 首页点「课程安排」卡 → 断言进入 `course.html`，默认 `#/classes` 可见。
2. `#/teachers` 新建老师「张老师」→ 列表出现。
3. `#/classes` 新建班「少儿中国舞B」（选张老师、容量 2）→ 花名册加入 2 名学员 → 断言在册 2/2。
4. 花名册加入第 3 名学员 → 断言 `#toast` 出现「已超容量」且在册显示 3。
5. 为该班加规则「每周三 19:00–20:00」→ 切 `#/timetable`：断言周三分组/列出现该班色块，点开显示 3 名在册学员。
6. `#/teacher-plan` 选张老师 + 含下一个周三的月份 → 断言该周三出现一节课。
7. 对该课节「改时间」为 20:00–21:00 → 断言显示新时间；再「停课」→ 断言删除线 / 停课标记。
8. 再建一条张老师同周三 19:30–20:30（挂到另一个新建的班）→ 断言提交区出现 `--cc-1` 冲突提示，且规则仍保存成功。
9. 切换到考勤「批量点名」→「选择课节」选「该周三 · 少儿中国舞B」（改期后为 20:00）→ 断言日期/班名/老师自动带出、花名册 3 人自动列出 → 全体「出勤」提交 → 断言考勤流水新增 3 行。
10. 全程收集 `page.on('pageerror')` 为空。

> 注：步骤 7 先「改时间」再让步骤 9 选到它——确保 `sessionsByDate` 返回的是改后时间。若停课发生在选课节之前，
> 该课节应在选择列表里置灰。E2E 可把「停课」放在步骤 9 之后单独断言，避免顺序耦合。

### 9.5 验收标准映射

| US / FR | 测试 | 类型 | 说明 |
|---|---|---|---|
| US-001 / FR-1~8 | `course-migration.test.ts` | unit | v6 五表 + 索引 + 回滚 + 类型/错误码 |
| US-002 / FR-9~22 | `course-repo.test.ts` + `course-validation.test.ts` | unit | 老师/班级/花名册 CRUD + 容量标记 |
| US-003 / FR-45~47 | `course-flow.spec.ts` #1~#4 | e2e | 首页接线 + 外壳 + 班级/花名册/老师 UI |
| US-004 / FR-23~27 | `course-schedule.test.ts` | unit | 规则 CRUD + 冲突（同类相比）|
| US-005 / FR-28,FR-48,FR-50 | `course-repo.test.ts`(weeklyTimetable) + flow #5 | unit+e2e | 周网格 + 点开花名册 + 编辑规则冲突提示 |
| US-006 / FR-29~39 | `course-session.test.ts` | unit | 生成幂等 + 微调 + 手动加课 + 不追溯 |
| US-007 / FR-32,FR-33,FR-49 | `course-session.test.ts` + flow #6~#8 | unit+e2e | 月视图 + 逐日操作 + 冲突提示 |
| US-008 / FR-40~44 | `attendance-repo.test.ts`(增补) + flow #9 | unit+e2e | createRecord 透传 + 选课节带出花名册 + 回填 session_id |
| US-009 | `course-flow.spec.ts` | e2e | 全链路 + 边界（超容量）|
| FR-36,FR-38（不追溯）| `course-session.test.ts` / `course-schedule.test.ts` | unit | 改规则不动已生成实例 |

---

## 10. 实施计划 / Implementation Plan

### 10.1 阶段与顺序（线性阻塞链，单分支 `feat/course-management`，一 issue 一 commit，最后一个 PR）

1. **US-001 DB 地基** — `migrations.ts` v6（5 表）；`types.ts` 追加 `Course*` 类型 + 8 个 `IpcErrorCode` +
   `BatchCheckInInput.sessionId?`；`course-migration.test.ts`。
2. **US-002 老师/班级/花名册 域层 + IPC** — `course.repo.ts`（teacher* / class* / roster*）+
   `course.validation.ts`；`channels.ts` / `register.ts` / `preload.ts` / `studioShell.d.ts` 接 12 个频道；
   `course-repo.test.ts` / `course-validation.test.ts`。
3. **US-003 渲染外壳 + 首页接线 + 班级/花名册/老师 UI** — `course.html` / `course.js`（`#/classes` 默认、
   `#/teachers`）；`index.html` 卡片 `href`；`electron-builder.yml` `files`。
4. **US-004 周期规则 + 冲突检测** — `course.repo.ts` 加 `schedule*` + `checkScheduleConflicts`；4 个频道；
   `course-schedule.test.ts`。
5. **US-005 学生向课程表周视图** — `weeklyTimetable` + `courseWeeklyTimetable` 频道；`course.js` `#/timetable`
   周网格（桌面 7 列 / 移动端竖列表）+ 规则增删改弹窗（冲突提示）。
6. **US-006 排课实例 + 按月生成 + IPC** — `course.repo.ts` 加 `generateMonth` / `sessionsByMonth` /
   `sessionsByDate` / `sessionCreate` / `sessionUpdate` / `sessionSoftDelete` / `checkSessionConflicts`；6 个频道；
   `course-session.test.ts`。
7. **US-007 老师向上课时间计划表月视图** — `course.js` `#/teacher-plan`（老师下拉 + 月份选择 + 月历/移动端日期列表
   + 逐日操作菜单 + 手动加课入口）。
8. **US-008 接入考勤批量点名** — `attendance.validation.ts` 透传 `sessionId`；`attendance.js`「批量点名」加
   「选择课节」控件（调 `course.sessionsByDate` + `course.rosterList`）；`attendance-repo.test.ts` 增补。
9. **US-009 E2E** — `tests/e2e/course-flow.spec.ts`；`npm test` 全绿后开 PR。

每个 issue 提交前跑 `npm run typecheck && npm run lint && npm run test:unit`；PR 前跑 `npm test`。

### 10.2 Issue 映射

| Issue | SPEC 章节 | 优先级 | 依赖 |
|---|---|---|---|
| US-001 | 3.1, 3.2, 3.4 | high | — |
| US-002 | 2.2, 4.1(teacher/class/roster), 5.1, 5.2 | high | US-001 |
| US-003 | 2.4, 4.3 | high | US-002 |
| US-004 | 2.3-E, 4.1(schedule*), 5.2 | high | US-002 |
| US-005 | 2.3, 5.1(weeklyTimetable) | high | US-004 |
| US-006 | 2.3-A~E, 4.1(session*), 5.1, 5.4 | high | US-004 |
| US-007 | 2.3-B~D, 4.1(sessionsByMonth), 5.3 | medium | US-006 |
| US-008 | 2.3-F, 4.5, 5.2 | medium | US-006 |
| US-009 | 9.4 | high | 以上全部 |

### 10.3 增量交付

无 feature flag（桌面单机、单分支单 PR）。合并前 `feat/inventory-management`(v4) 与
`feat/attendance-management`(v5) 应已在 main；若未，`v6.up` 的 `IF NOT EXISTS` 与 `run()` 的空档跳版能力
保证仍可正确升级。US-001~US-003 合并后「班级 + 花名册 + 老师」即可独立使用（课程表 / 计划表 / 考勤联动
后续 issue 渐次点亮），但按交付偏好仍是最后一次性开一个 PR。

---

## 11. 开放问题与风险 / Open Questions & Risks

### 11.1 待明确（不阻塞实施，取默认）

- **老师「离职」后名下在读班 / 未来课节**：默认不强制改派，仅在下拉与列表灰化标注。
- **周期规则 `effective_from` / `effective_to`**：本期 UI 不暴露，域层字段建好；`generateMonth` 的生效窗口
  用 `schedule.effective_* ?? class.start_date/end_date` 兜底。
- **跨午夜的课（23:30–00:30）**：本期假设所有课在同一自然日内；`endTime > startTime` 字符串比较即拦掉跨夜。
- **首页「今日课程」统计卡**：本期不接 `sessionsByDate(today)`，留作后续小改。
- **`class_sessions` 长期增长（~5000/年）无归档**：本期不处理。
- **`attendance_records.session_id` 悬空引用**（指向的课节被软删）：本期不清理、不报警。

### 11.2 技术风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 迁移版本号 v6 与其它并行分支撞号 | `run()` 启动抛错 | DDL 全 `IF NOT EXISTS` + `run()` 重复版本号守卫；rebase 时认领下一个空号并在 commit body 注明 |
| `sessionsByMonth` 读带写副作用 | 「读」接口产生 INSERT，测试 / 心智负担 | SPEC 明确标注；`generateMonth` 幂等，多数调用 `created=0`；另留独立 `courseGenerateMonth` 频道供显式调用与测试 |
| 日期迭代的时区陷阱 | `getDay()` 在 UTC 解析下偏移一天 → 生成到错误星期 | 一律 `new Date(y, m-1, d)` 本地构造；`course-session.test.ts` 对跨月/月末/闰年 2 月各加断言 |
| 规则改了但用户以为本月立刻生效 | 用户困惑「为什么周三还是旧时间」 | 计划表对被改过的实例显示「已调整」小标记；规则编辑弹窗提示「仅影响下月及未生成日期」|
| 冲突检测「同类相比」漏掉 规则↔已改实例 的冲突 | 新规则与本月某个人工改过的课节实际撞车，不提示 | 本期接受（PRD 决策）；`checkSessionConflicts` 在生成/改实例时仍会兜住同日实例互撞 |
| `class_students` 相关子查询计数随班级数增长变慢 | `classList` 变慢 | 数据规模（≤ ~50 班）下可忽略；将来可加触发器维护 `classes.roster_count` 缓存列 |
| better-sqlite3 `foreign_keys=ON` 下插入引用不存在的行抛 `SQLITE_CONSTRAINT` | 前端拿到笼统 `DB_ERROR` 而非具名错误 | repo 在写入前显式 SELECT 校验 `class_id`/`student_id`/`teacher_id`，抛具名 `*_NOT_FOUND` |

### 11.3 假设（实施前校验）

- `students` 表有 `remaining_lessons`（可空 INTEGER）、`card_expire_date`、`phone_primary`、`name`、`deleted_at` 列（v1 确认）。
- `connection.ts` 的 `getDb()` 已开 `PRAGMA foreign_keys = ON`（已确认）。
- `attendance.repo.createRecord` 的 INSERT 已包含 `session_id` 列、值取自 `RecordValues.sessionId`（已确认，仅需
  `attendance.validation.ts` 把它从「恒 null」改为按入参透传）。
- `course.html` 复制 `students.html` 外壳后，`el()` / `unwrap()` / `toast()` / `todayYmd()` 等工具与其它渲染器一致，可整体照搬。
- `students.html` 外壳的 `:root` 令牌回退 + `colors_and_type.css` 引入方式可直接复用；`--cc-3` 已在 `index.html`/令牌文件中定义。
- E2E 中 Electron 启动、`STUDIO_DB_PATH` 注入、预置学员的方式与 `attendance-flow.spec.ts` 现有做法一致。
- `node:test` 单测经 `scripts/test-unit.js`（Electron 的 Node）跑，`better-sqlite3` 可用。
