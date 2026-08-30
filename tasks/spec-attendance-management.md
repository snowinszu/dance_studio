# SPEC: 考勤管理（打卡流水 + 课时账本 + 批量点名 + Excel 导入导出）

> 技术规格，派生自 [tasks/prd-attendance-management.md](./prd-attendance-management.md)
> 生成日期：2026-08-30 ｜ 目标分支：`feat/attendance-management` ｜ 迁移版本：v5
> 架构蓝本：[tasks/spec-inventory-management.md](./spec-inventory-management.md)（「台账 + 领用流水」双账本 →
> 本模块「余额缓存 + 考勤流水」）

---

## 1. 摘要 / Summary

### 1.1 本 SPEC 覆盖范围

把首页第 3 张卡片「考勤管理」（`placeholder.html?app=attendance`，主题色 `--cc-1`）从占位页做成完整模块：
新增一张 `attendance_records` 流水表，把「打一次卡 = 插一行流水 + 按 `lessons_delta` 改
`students.remaining_lessons`」封装成单事务原语 `createRecord`；在此原语之上实现快速打卡、批量点名、
更正、撤销、手动调整课时、Excel 明细 + 按月汇总导出、历史考勤导入。完全沿用学员 / 库存两个模块
趟通的分层（`db` / `domain` / `io` / `ipc` / `preload` / 单页渲染器 / `node:test` + Playwright）。

### 1.2 PRD 对应

- 来源：[tasks/prd-attendance-management.md](./prd-attendance-management.md)
- User Stories：US-001 ~ US-010（全部）
- Functional Requirements：FR-1 ~ FR-26（全部）

### 1.3 设计决策一览

| 决策 | 选择 | 理由 |
|---|---|---|
| 流水表结构 | 单表 `attendance_records`，`type` 六值枚举（出勤/请假/缺勤/补课/试听/调整）+ 带符号 `lessons_delta` | 照搬 `item_allocations`；一张表覆盖考勤事件与课时调整，聚合简单 |
| 余额存储 | `students.remaining_lessons` 继续作权威缓存，不实时 SUM 流水 | 与 `inventory_items.quantity` 一致；列表 / 学员档案直接读它 |
| 核心原语 | `createRecord(values)` 单事务：改余额 + 插流水；快速打卡 / 批量每条 / 导入每行都走它 | FR-2 / FR-19；一条写入路径，行为一致 |
| 课时符号约定 | IPC 入参传**正整数** `lessons`（仅「出勤」有意义，默认 1、私教 2），domain 落库时翻负存 `lessons_delta = -lessons`；「调整」单独传带符号 `delta` | 渲染层不用关心负号；与「领取数量」正数入参风格一致 |
| 扣课时规则 | 仅 `出勤` 消耗（默认 -1）；`请假` / `缺勤` / `补课` / `试听` 落库 `lessons_delta = 0` | PRD 2B |
| 余额守卫 | 净 `lessons_delta < 0` 且 `COALESCE(remaining_lessons,0) + delta < 0` → `INSUFFICIENT_LESSONS`；入参 `force:true` 放行、允许记负 | PRD「欠课」是真实场景，故不像库存那样硬性 `WHERE quantity >= qty` |
| 守卫实现 | 事务内「先读余额判断，再 UPDATE」，不用原子 `WHERE` 条件 | better-sqlite3 同步 + 单进程单连接，无并发；`force` 分支本就要允许 UPDATE 把余额改负，原子条件反而碍事 |
| 重复检测 | 同 `student_id` + `attend_date` + `COALESCE(class_name,'')` + `type` 的未撤销行存在 → `DUPLICATE_ATTENDANCE`；入参 `allowDuplicate:true` 放行；`type='调整'` 不做此检测 | FR-7 |
| 批量点名事务粒度 | **每个学员一条独立事务**（各自 `createRecord`），单条失败只跳过该条并记原因，其余照常提交 | PRD 决策「每条独立事务」；FR-10 |
| 更正是否查重 | **不重跑**重复检测，仅受余额守卫（按新旧 `lessons_delta` 差额，可 `force`） | PRD 决策「不重跑」；改错字 / 改日期不该被自己旧记录挡住 |
| 更正学员归属 | 更正**不能改 `student_id`**；换人 = 撤销后重打 | 差额回补逻辑只需面对单个学员，简单可靠 |
| 撤销 | 软删（`deleted_at`）+ 反向回补原 `lessons_delta`；对已撤销行幂等、不二次回补 | FR-12 |
| 手动调整课时 | 写一条 `type='调整'` 记录，`lessons_delta = delta`（带符号非零整数），`reason` 必填；复用 `createRecord` | PRD 4B；`delta=0` / 非整数 → `INVALID_ADJUSTMENT` |
| 按月汇总 | 只在导出时由 `monthlySummary(query)` 用 SQL `GROUP BY substr(attend_date,1,7)` 现算，**不单独开 IPC / 无屏上视图** | PRD 无「屏上按月视图」故事，FR-16 只要求导出的第二个 sheet |
| 课程安排解耦 | `session_id` 列建好但无外键（目标表未存在），本期恒 `NULL`；课程名 / 老师 / 时间全自由文本 | FR-11 |
| 舞种筛选选项 | 渲染层拉一份学员列表，从 `students.dance_types`(JSON 数组字符串) 去重收集，客户端下拉 | 与库存「分类」下拉同法，无字典表 |
| 迁移版本 | 认领 **v5**，DDL 全 `IF NOT EXISTS`，依赖 `run()` 启动期重复版本号守卫 | v3 = 学员 `class_name`、v4 = 库存；合并顺序 v3→v4→v5 |

---

## 2. 架构 / Architecture

### 2.1 系统上下文

```
渲染进程 attendance.js  ──window.studioShell.attendance.*──▶  preload.ts
                                                                  │ ipcRenderer.invoke(CH.attendance*)
                                                                  ▼
                                              ipc/register.ts  handle(ch, fn) ──▶ IpcResult<T> 信封
                                                    │
                     ┌──────────────────────────────┼───────────────────────────────┐
                     ▼                              ▼                                ▼
        domain/attendance.validation.ts   domain/attendance.repo.ts        io/attendance-xlsx.ts
             （权威校验，出 errors）        （createRecord 等，抛 AppError）    （exceljs 明细 + 汇总 / 导入）
                                                    │                                │
                                                    ▼                                │
                                       db/connection.ts (better-sqlite3)  ◀──────────┘
                                       表 attendance_records + students
```

与库存模块的对应关系：`inventory_items.quantity` ↔ `students.remaining_lessons`（权威余额缓存），
`item_allocations` ↔ `attendance_records`（流水），`inventoryRepo.allocate` ↔ `attendanceRepo.createRecord`
（单事务改缓存 + 记流水），`inventoryRepo.deleteAllocation` ↔ `attendanceRepo.voidRecord`（回补 + 去除）。

### 2.2 组件职责

| 组件 | 职责 | 不做 |
|---|---|---|
| `domain/attendance.repo.ts` | 所有 SQL 读写；`createRecord` / `correctRecord` / `voidRecord` / `adjustLessons` / `listRecords` / `listRosterCandidates` / `monthlySummary` / `getRecord`；抛 `AppError(code,msg,fields?)` | 不碰 `electron` / dialog / IPC |
| `domain/attendance.validation.ts` | 入参归一化 + 校验，产出 `{ values, errors }`；课时符号翻转、日期 / 时间 / 字段长度校验；`deltaFor(type, lessons)` 助手 | 不查库（`student_id` 是否存在由 repo 的守卫 UPDATE 兜底）|
| `io/attendance-xlsx.ts` | `exportRecords`（两 sheet）/ `buildTemplate` / `readImportPreview` / `importRecords`；经 `xlsx-util.ts` 共享助手 | 不直接写 `students` 表——导入每行回调 `attendanceRepo.createRecord` |
| `ipc/register.ts`（改） | 11 个 `handle()`；校验失败抛 `VALIDATION_FAILED`，导出写盘失败抛 `IO_WRITE_FAILED` | 不写业务逻辑 |
| `attendance.js`（新） | `#/hash` 路由三视图 + 模态；`el()` / `unwrap()` / `toast()`；即时提示（非权威）| 不碰 Node |

### 2.3 关键流程

**A. 快速打卡（单人）**

```
attendance.js: 搜学员 → 选中 → 填表 → shell.attendance.quickCheckIn(input)
  register: validateQuickCheckIn(input) → errors? → VALIDATION_FAILED
           → attendanceRepo.createRecord(values)
  repo.createRecord  (db.transaction):
    1. type != '调整' 且 !allowDuplicate:
         SELECT 1 FROM attendance_records
          WHERE student_id=@sid AND attend_date=@date
            AND COALESCE(class_name,'')=COALESCE(@class,'')
            AND type=@type AND deleted_at IS NULL LIMIT 1
         命中 → throw DUPLICATE_ATTENDANCE
    2. lessonsDelta < 0 且 !force:
         bal := SELECT COALESCE(remaining_lessons,0) FROM students WHERE id=@sid
         bal + lessonsDelta < 0 → throw INSUFFICIENT_LESSONS('剩余课时不足')
    3. upd := UPDATE students
                 SET remaining_lessons = COALESCE(remaining_lessons,0) + @lessonsDelta,
                     updated_at = @now
               WHERE id=@sid AND deleted_at IS NULL
       upd.changes != 1 → throw NOT_FOUND('学员不存在，可能已被删除')
    4. ins := INSERT INTO attendance_records (...13 列...) VALUES (...)
    return ins.lastInsertRowid
  事务后：remaining := SELECT remaining_lessons FROM students WHERE id=@sid
  返回 { id, remainingLessons: remaining }
  register 包 ok() → { ok:true, data:{ id, remainingLessons } }
attendance.js: unwrap → toast「已记录 · 剩 N 节」；列表刷新；余额 ≤ 3 或卡过期 → --cc-1 暖红提示
```

**B. 批量点名（每条独立事务）**

```
attendance.js: 填公共信息(日期/时间/课程/老师/经办人) + 勾选学员并逐个选状态
             → shell.attendance.batchCheckIn({ ...common, force, allowDuplicate, entries:[{studentId,type,lessons?,note?}] })
  register: validateBatchCheckIn → 公共字段错误 → VALIDATION_FAILED（整体拒绝）
           entries 为空 → BAD_REQUEST
           对每个 entry 生成 RecordValues（共用公共字段）
           for v of values:
             try { r = attendanceRepo.createRecord(v); rows.push({studentId, ok:true, recordId:r.id, remainingLessons:r.remainingLessons}) }
             catch (e: AppError) { rows.push({studentId, ok:false, errorCode:e.code, reason:e.message}) }
           return { succeeded: rows.filter(ok).length, skipped: rows.length - succeeded, rows }
  ——注意：没有外层大事务；已成功的条目不因后续条目失败而回滚（FR-10）
attendance.js: 展示结果小结「成功 N · 跳过 M」+ 跳过明细（学员 + 原因）；成功行对应学员余额即时更新
```

**C. 撤销 / 更正**

```
撤销  shell.attendance.voidRecord(id)
  repo.voidRecord (db.transaction):
    row := SELECT student_id, lessons_delta, deleted_at FROM attendance_records WHERE id=@id
    !row → throw ATTENDANCE_NOT_FOUND
    row.deleted_at != NULL → 直接返回当前余额（幂等，不二次回补）
    UPDATE students SET remaining_lessons = COALESCE(remaining_lessons,0) - @oldDelta, updated_at=@now WHERE id=@sid
    UPDATE attendance_records SET deleted_at=@now, updated_at=@now WHERE id=@id
  返回 { id, studentId, remainingLessons }

更正  shell.attendance.correct({ id, type, attendDate, attendTime?, className?, teacher?, lessons?, operator?, note?, force? })
  register: validateCorrection → errors? → VALIDATION_FAILED
  repo.correctRecord (db.transaction):
    row := SELECT * FROM attendance_records WHERE id=@id AND deleted_at IS NULL
    !row → throw ATTENDANCE_NOT_FOUND
    row.type == '调整' → throw BAD_REQUEST('调整记录不支持更正，请撤销后重建')
    newDelta := deltaFor(type, lessons)            // ≤ 0
    diff := newDelta - row.lessons_delta
    diff < 0 且 !force:
        bal := SELECT COALESCE(remaining_lessons,0) FROM students WHERE id=row.student_id
        bal + diff < 0 → throw INSUFFICIENT_LESSONS
    UPDATE students SET remaining_lessons = COALESCE(remaining_lessons,0) + @diff, updated_at=@now WHERE id=@sid
    UPDATE attendance_records
       SET type=@type, attend_date=@date, attend_time=@time, class_name=@class,
           teacher=@teacher, lessons_delta=@newDelta, operator=@op, note=@note, updated_at=@now
     WHERE id=@id
  返回 { id, remainingLessons }
  ——不查重复（PRD 决策）；不改 student_id
```

**D. 导出（明细 + 按月汇总）**

```
shell.attendance.export(query)   query = 当前列表筛选 { dateFrom?, dateTo?, keyword?, type? }
  register: filePath := pickSavePath('导出考勤记录', `考勤记录-${ymdCompact()}.xlsx`)
           try { const r = await exportRecords(query, filePath); return { filePath, ...r } }
           catch → IO_WRITE_FAILED
  io.exportRecords:
    detailRows := attendanceRepo.listRecords({ ...query, limit: Number.MAX_SAFE_INTEGER, offset: 0 }).rows   // 已排除 deleted
    summaryRows := attendanceRepo.monthlySummary(query)                                                       // GROUP BY substr(attend_date,1,7)
    wb: sheet「考勤明细」(学员姓名/手机号/日期/时间/课程/老师/类型/课时增减/经办人/备注) 逐条
        sheet「按月汇总」(学员姓名/手机号/月份/出勤/请假/缺勤/补课/试听/当月消耗课时/当前剩余课时)
    无数据 → 两个 sheet 仅表头
  返回 { filePath, detail: detailRows.length, summary: summaryRows.length }
```

**E. 导入（历史补录，每行走 createRecord）**

```
shell.attendance.pickImportFile()  → readImportPreview → { filePath, headers, sample }  （含 MAX_IMPORT_ROWS 校验）
shell.attendance.import({ filePath, mapping })
  io.importRecords:
    mapping 缺「学员姓名」「手机号」「日期」「类型」→ BAD_REQUEST
    ws := openFirstSheet(filePath)   // 含 MAX_IMPORT_BYTES 校验
    findStudent := SELECT id FROM students WHERE name=@name AND phone_primary=@phone AND deleted_at IS NULL
    for r in 数据行:
      cells 全空 → skip
      parse & 校验（日期合法 / 类型枚举 / 课时列）→ 失败 → failures.push({row, reason}); failed++; continue
      matches := findStudent.all(...)
      matches.length == 0 → failures.push({row, '学员不存在'}); failed++; continue
      matches.length  > 1 → failures.push({row, '匹配到多个学员'}); failed++; continue
      dup := SELECT 1 FROM attendance_records
              WHERE student_id=@sid AND attend_date=@date AND COALESCE(class_name,'')=@class
                AND type=@type AND deleted_at IS NULL LIMIT 1
      dup 且 type != '调整' → skipped++; continue          // 疑似重复
      try {
        res := attendanceRepo.createRecord({ ...RecordValues, force:true, allowDuplicate:true })
        succeeded++;  if (res.remainingLessons < 0) negativeBalance++
      } catch (e: AppError) { failed++; failures.push({row, reason:e.message}) }
    返回 { succeeded, skipped, failed, negativeBalance, failures }
  ——导入默认 force:true（补录历史允许欠课），allowDuplicate:true（自己已跳过疑似重复）
```

### 2.4 文件结构

```
src/
├── db/migrations.ts                    [MODIFY]  MIGRATIONS 末尾 append { version: 5, up: v5 }
├── shared/types.ts                     [MODIFY]  + Attendance* 类型；IpcErrorCode + 4 值
├── domain/
│   ├── attendance.repo.ts              [NEW]
│   └── attendance.validation.ts        [NEW]
├── io/attendance-xlsx.ts               [NEW]
├── ipc/
│   ├── channels.ts                     [MODIFY]  + 11 个 attendance* 常量
│   └── register.ts                     [MODIFY]  + 11 个 handle()
└── preload.ts                          [MODIFY]  + CH 字面量 11 条 + api.attendance.*

studioShell.d.ts                        [MODIFY]  + attendance 命名空间类型
electron-builder.yml                    [MODIFY]  files += attendance.html, attendance.js
index.html                              [MODIFY]  「考勤管理」卡片 href → attendance.html
attendance.html                         [NEW]     复制 students.html 外壳，主题色 --cc-1
attendance.js                           [NEW]     单页 hash 路由渲染器

tests/unit/
├── attendance-migration.test.ts        [NEW]
├── attendance-repo.test.ts             [NEW]
├── attendance-correct-void.test.ts     [NEW]
├── attendance-adjust.test.ts           [NEW]
├── attendance-list-query.test.ts       [NEW]
├── attendance-validation.test.ts       [NEW]
├── attendance-export.test.ts           [NEW]
└── attendance-import.test.ts           [NEW]
tests/e2e/attendance-flow.spec.ts       [NEW]
```

---

## 3. 数据模型 / Data Model

### 3.1 迁移 v5（`user_version` → 5）

```sql
-- src/db/migrations.ts 内 const v5 = (db) => db.exec(`...`)
CREATE TABLE IF NOT EXISTS attendance_records (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id    INTEGER NOT NULL REFERENCES students(id),   -- 不写 ON DELETE CASCADE：学员软删，历史流水要留
  session_id    INTEGER,                                     -- 预留关联「课程安排」，本期恒 NULL，无外键
  class_name    TEXT,                                        -- 自由文本课程名（快速打卡可空）
  teacher       TEXT,                                        -- 自由文本授课老师
  attend_date   TEXT NOT NULL,                               -- 'YYYY-MM-DD'，字典序即时间序
  attend_time   TEXT,                                        -- 'HH:MM'，可空
  type          TEXT NOT NULL,                               -- 出勤|请假|缺勤|补课|试听|调整
  lessons_delta INTEGER NOT NULL DEFAULT 0,                  -- 对 students.remaining_lessons 的增量：消耗为负、增加为正、不影响为 0
  reason        TEXT,                                         -- type='调整' 必填；其它可空
  operator      TEXT,                                         -- 经办人自由文本（无账号体系）
  note          TEXT,                                         -- 可放事假/病假细分
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT                                          -- 非空即已撤销
);
CREATE INDEX IF NOT EXISTS idx_att_student ON attendance_records(student_id);
CREATE INDEX IF NOT EXISTS idx_att_date    ON attendance_records(attend_date);
CREATE INDEX IF NOT EXISTS idx_att_type    ON attendance_records(type);
CREATE INDEX IF NOT EXISTS idx_att_deleted ON attendance_records(deleted_at);
```

- 不加 `CHECK(lessons_delta ...)`：正负零都合法；非负由 `createRecord` 守卫保证（与 `inventory_items.quantity` 同理）。
- 不加 `CHECK(type IN (...))`：枚举由 validation 层把关，和现有表风格一致（`students.status` 也无 CHECK）。
- `MIGRATIONS` 数组变为 `[{v1},{v2},{v4},{v5}]`；`LATEST_VERSION` 自动算得 5。

### 3.2 实体定义（追加到 `src/shared/types.ts`）

```ts
// ========================= 考勤管理模块 =========================

export type AttendanceType = '出勤' | '请假' | '缺勤' | '补课' | '试听' | '调整';

/** 一条考勤流水。studentName / studentPhone 由 JOIN students 得到（含已软删学员）。 */
export interface AttendanceRecord {
  id: number;
  studentId: number;
  studentName: string;
  studentPhone: string;
  sessionId: number | null;        // 预留，本期恒 null
  className: string | null;
  teacher: string | null;
  attendDate: string;              // 'YYYY-MM-DD'
  attendTime: string | null;       // 'HH:MM'
  type: AttendanceType;
  lessonsDelta: number;            // 落库真值：消耗为负、增加为正、不影响为 0
  reason: string | null;
  operator: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** 单条快速打卡入参（不含「调整」，调整走 LessonAdjustmentInput）。 */
export interface QuickCheckInInput {
  studentId: number;
  type: Exclude<AttendanceType, '调整'>;
  attendDate?: string;             // 省略 → 今天
  attendTime?: string | null;
  className?: string | null;
  teacher?: string | null;
  lessons?: number;                // 仅「出勤」有意义：正整数，省略 → 1
  operator?: string | null;
  note?: string | null;
  force?: boolean;                 // 余额不足放行、余额记负
  allowDuplicate?: boolean;        // 重复打卡放行
}

export interface CheckInResult {
  id: number;
  remainingLessons: number;        // 该学员写入后的剩余课时（force 时可能为负）
}

export interface BatchCheckInEntry {
  studentId: number;
  type: Exclude<AttendanceType, '调整'>;
  lessons?: number;                // 仅「出勤」：正整数，省略 → 1
  note?: string | null;
}

export interface BatchCheckInInput {
  attendDate?: string;
  attendTime?: string | null;
  className?: string | null;
  teacher?: string | null;
  operator?: string | null;
  force?: boolean;
  allowDuplicate?: boolean;
  entries: BatchCheckInEntry[];
}

export interface BatchCheckInRowResult {
  studentId: number;
  ok: boolean;
  recordId?: number;
  remainingLessons?: number;
  errorCode?: IpcErrorCode;        // ok=false 时给
  reason?: string;
}

export interface BatchCheckInResult {
  succeeded: number;
  skipped: number;
  rows: BatchCheckInRowResult[];
}

export interface AttendanceCorrectionInput {
  id: number;
  type: Exclude<AttendanceType, '调整'>;
  attendDate: string;
  attendTime?: string | null;
  className?: string | null;
  teacher?: string | null;
  lessons?: number;                // 仅「出勤」
  operator?: string | null;
  note?: string | null;
  force?: boolean;                 // 差额使余额变负时放行
}

export interface LessonAdjustmentInput {
  studentId: number;
  delta: number;                   // 带符号非零整数：正=加、负=减
  reason: string;                  // 必填
  attendDate?: string;             // 省略 → 今天
  operator?: string | null;
  note?: string | null;
  force?: boolean;                 // delta<0 且会使余额变负时放行
}

export interface AttendanceListQuery {
  dateFrom?: string;               // attend_date >= dateFrom
  dateTo?: string;                 // attend_date <= dateTo
  keyword?: string;                // 匹配学员姓名或手机号子串
  type?: AttendanceType;
  limit?: number;                  // 默认 100
  offset?: number;                 // 默认 0
}

export interface AttendanceListResult {
  rows: AttendanceRecord[];
  total: number;
}

export interface RosterCandidateQuery {
  danceType?: string;              // students.dance_types(JSON 数组) 包含匹配
  keyword?: string;                // 姓名或手机号子串
}

export interface RosterCandidate {
  id: number;
  name: string;
  phone: string;
  remainingLessons: number | null;
  cardExpireDate: string | null;
  status: string;
}

export interface MonthlySummaryRow {
  studentId: number;
  studentName: string;
  studentPhone: string;
  month: string;                   // 'YYYY-MM'
  attendCount: number;
  leaveCount: number;
  absentCount: number;
  makeupCount: number;
  trialCount: number;
  lessonsConsumed: number;         // 当月 lessons_delta<0 的绝对值之和
  remainingLessons: number | null; // 当前实时余额
}

export interface AttendanceImportReport {
  succeeded: number;
  skipped: number;                 // 疑似重复被跳过
  failed: number;
  negativeBalance: number;         // 成功但导致余额为负的行数（提示用）
  failures: { row: number; reason: string }[];  // row = xlsx 行号（含表头，从 2 起）
}
```

`IpcErrorCode` 追加：

```ts
  // —— 考勤管理 ——
  | 'INSUFFICIENT_LESSONS'   // 剩余课时不足且未强制
  | 'ATTENDANCE_NOT_FOUND'   // 考勤记录不存在或已撤销
  | 'DUPLICATE_ATTENDANCE'   // 同学员+日期+课程+类型已有未撤销记录
  | 'INVALID_ADJUSTMENT'     // 手动调整课时 delta 为 0 或非整数
```

### 3.3 关系

- `attendance_records.student_id → students.id`（多对一，无级联；JOIN 取姓名 / 手机号，学员软删后照样带出）。
- `attendance_records.session_id`：预留，本期不关联任何表。
- 无 `attendance_records ↔ inventory` 关系。

### 3.4 迁移计划

- 前向单向，无 `down`（沿用现状）。空库从 v2 直接跳到 v5；跑过 v3 / v4 的库按序补到 v5。
- 全部 `CREATE ... IF NOT EXISTS`；`run()` 启动期已有「重复版本号即抛错」守卫。
- 回滚策略：`v5.up` 抛错则该版事务回滚，`user_version` 停在上一版，下次启动重试。
- 合并顺序：`feat/class-name-field`(v3) → `feat/inventory-management`(v4) → `feat/attendance-management`(v5) 依次并入 main；若 rebase 时 v5 被占，renumber 为下一个空号。

---

## 4. 接口设计 / IPC Surface

### 4.1 频道清单（全部 `ipcMain.handle` / `ipcRenderer.invoke`，返回 `IpcResult<T>`）

| CH 常量 | 频道字符串 | 入参 | 成功 data | 主要错误 |
|---|---|---|---|---|
| `attendanceList` | `attendance:list` | `AttendanceListQuery?` | `AttendanceListResult` | — |
| `attendanceQuickCheckIn` | `attendance:quickCheckIn` | `QuickCheckInInput` | `CheckInResult` | `VALIDATION_FAILED` / `INSUFFICIENT_LESSONS` / `DUPLICATE_ATTENDANCE` / `NOT_FOUND` |
| `attendanceBatchCheckIn` | `attendance:batchCheckIn` | `BatchCheckInInput` | `BatchCheckInResult` | `VALIDATION_FAILED`（公共字段/entries 空）；单条错误在 `rows[].errorCode` |
| `attendanceCorrect` | `attendance:correct` | `AttendanceCorrectionInput` | `CheckInResult` | `VALIDATION_FAILED` / `ATTENDANCE_NOT_FOUND` / `INSUFFICIENT_LESSONS` / `BAD_REQUEST`(调整记录) |
| `attendanceVoid` | `attendance:void` | `id: number` | `{ id, studentId, remainingLessons }` | `ATTENDANCE_NOT_FOUND` / `BAD_REQUEST`(缺 id) |
| `attendanceAdjustLessons` | `attendance:adjustLessons` | `LessonAdjustmentInput` | `CheckInResult` | `VALIDATION_FAILED` / `INVALID_ADJUSTMENT` / `INSUFFICIENT_LESSONS` / `NOT_FOUND` |
| `attendanceRosterCandidates` | `attendance:rosterCandidates` | `RosterCandidateQuery?` | `RosterCandidate[]` | — |
| `attendanceExport` | `attendance:export` | `AttendanceListQuery?` | `{ filePath, detail, summary }` | `IO_CANCELLED` / `IO_WRITE_FAILED` |
| `attendanceDownloadTemplate` | `attendance:downloadTemplate` | — | `{ filePath }` | `IO_CANCELLED` / `IO_WRITE_FAILED` |
| `attendancePickImportFile` | `attendance:pickImportFile` | — | `{ filePath, headers, sample }` | `IO_CANCELLED` / `IMPORT_FILE_INVALID` / `IMPORT_TOO_LARGE` |
| `attendanceImport` | `attendance:import` | `{ filePath, mapping }` | `AttendanceImportReport` | `BAD_REQUEST` / `IMPORT_FILE_INVALID` / `IMPORT_TOO_LARGE` |

### 4.2 `channels.ts` 常量（追加到 `CH`）

```ts
  // 考勤管理
  attendanceList: 'attendance:list',
  attendanceQuickCheckIn: 'attendance:quickCheckIn',
  attendanceBatchCheckIn: 'attendance:batchCheckIn',
  attendanceCorrect: 'attendance:correct',
  attendanceVoid: 'attendance:void',
  attendanceAdjustLessons: 'attendance:adjustLessons',
  attendanceRosterCandidates: 'attendance:rosterCandidates',
  attendanceExport: 'attendance:export',
  attendanceDownloadTemplate: 'attendance:downloadTemplate',
  attendancePickImportFile: 'attendance:pickImportFile',
  attendanceImport: 'attendance:import',
```

### 4.3 `preload.ts` 追加

同一份 `CH` 字面量补 11 条；`api` 增加：

```ts
  attendance: {
    list: (query?: unknown) => invoke(CH.attendanceList, query),
    quickCheckIn: (input: unknown) => invoke(CH.attendanceQuickCheckIn, input),
    batchCheckIn: (input: unknown) => invoke(CH.attendanceBatchCheckIn, input),
    correct: (input: unknown) => invoke(CH.attendanceCorrect, input),
    voidRecord: (id: number) => invoke(CH.attendanceVoid, id),
    adjustLessons: (input: unknown) => invoke(CH.attendanceAdjustLessons, input),
    rosterCandidates: (query?: unknown) => invoke(CH.attendanceRosterCandidates, query),
    export: (query?: unknown) => invoke(CH.attendanceExport, query),
    downloadTemplate: () => invoke(CH.attendanceDownloadTemplate),
    pickImportFile: () => invoke(CH.attendancePickImportFile),
    import: (args: unknown) => invoke(CH.attendanceImport, args),
  },
```

`studioShell.d.ts` 增补对应 `attendance` 命名空间的具类型签名（编辑器提示用，不进 tsconfig include）。

### 4.4 错误响应

统一 `IpcResult`：`{ ok:false, error:{ code, message, fields? } }`。`fields` 仅 `VALIDATION_FAILED` 时带
（字段 key → 中文提示，如 `{ delta: '请填写非零整数' }`）。批量点名整体 `ok:true`，逐条成败在 `data.rows`。

### 4.5 破坏性变更

无。纯新增频道 + `students` 表既有列 `remaining_lessons` 的写入方多了一处（考勤）。学员模块表单仍可直接改
该列——两条写入路径并存，可接受（与 PRD 非目标一致，本期不做「课时只能由考勤流水驱动」的收敛）。

---

## 5. 业务逻辑 / Business Logic

### 5.1 核心算法

**`deltaFor(type, lessons)` → number（validation 层）**

```
type === '出勤':
   n := (lessons 空) ? 1 : Number(lessons)
   Number.isInteger(n) 且 n >= 1  否则  errors.lessons = '课时数必须是不小于 1 的整数'
   return -n
type ∈ {请假, 缺勤, 补课, 试听}:  return 0
（'调整' 不经此函数，delta 由 LessonAdjustmentInput.delta 直接给）
```

**`createRecord(values)`** — 见 §2.3-A。要点：

- 单 `db.transaction`；步骤序 = 查重 → 余额守卫 → 改余额（守卫 `WHERE deleted_at IS NULL` 兜住「学员不存在/已软删」）→ 插流水。
- `type='调整'` 跳过查重步骤。
- `force` 跳过余额守卫步骤（允许 `remaining_lessons` 变负）。
- 事务提交后再 `SELECT remaining_lessons` 返回，保证读到的是最终值。

**`monthlySummary(query)`** — 导出用，SQL 现算：

```sql
SELECT s.id AS studentId, s.name AS studentName, s.phone_primary AS studentPhone,
       substr(a.attend_date, 1, 7) AS month,
       SUM(a.type = '出勤') AS attendCount,
       SUM(a.type = '请假') AS leaveCount,
       SUM(a.type = '缺勤') AS absentCount,
       SUM(a.type = '补课') AS makeupCount,
       SUM(a.type = '试听') AS trialCount,
       COALESCE(SUM(CASE WHEN a.lessons_delta < 0 THEN -a.lessons_delta ELSE 0 END), 0) AS lessonsConsumed,
       s.remaining_lessons AS remainingLessons
  FROM attendance_records a
  JOIN students s ON s.id = a.student_id
 WHERE a.deleted_at IS NULL
   {AND a.attend_date >= @dateFrom} {AND a.attend_date <= @dateTo} {AND a.type = @type}
   {AND (s.name LIKE @kw ESCAPE '\' OR s.phone_primary LIKE @kw ESCAPE '\')}
 GROUP BY s.id, month
 ORDER BY month DESC, s.name COLLATE NOCASE
```

**`listRecords(query)`** — JOIN students，`WHERE a.deleted_at IS NULL` + 可选筛选，
`ORDER BY a.attend_date DESC, a.id DESC`，`LIMIT/OFFSET`（默认 100 / 0）。`keyword` 用 `escapeLike` + `LIKE ... ESCAPE '\'`
匹配 `s.name` 或 `s.phone_primary`。返回 `{ rows, total }`。

**`listRosterCandidates(query)`** — `FROM students WHERE deleted_at IS NULL`
+ `danceType` → `dance_types LIKE @dt`（`@dt = '%"' + escapeLike(danceType) + '"%'`，匹配 JSON 数组元素）
+ `keyword` → 姓名 / 手机号 LIKE。`ORDER BY name COLLATE NOCASE`，上限 500 行。

### 5.2 校验规则

| 字段 | 规则 | 失败提示 |
|---|---|---|
| `studentId` | 正整数 | 请选择学员 |
| `type`（快速/批量/更正）| ∈ {出勤,请假,缺勤,补课,试听}（不含「调整」）| 考勤类型不合法 |
| `attendDate` | 省略 → `todayYmd()`；给出须 `isRealYmd`（含 2026-02-30 拦截）| 日期格式应为 YYYY-MM-DD 且真实存在 |
| `attendTime` | 空或 `/^([01]\d|2[0-3]):[0-5]\d$/` | 时间格式应为 HH:MM |
| `lessons` | 仅 type=出勤 读取；正整数，默认 1 | 课时数必须是不小于 1 的整数 |
| `className` | ≤ 40 字，空 → null | 课程名不超过 40 字 |
| `teacher` | ≤ 20 字，空 → null | 老师不超过 20 字 |
| `operator` | ≤ 20 字，空 → null | 经办人不超过 20 字 |
| `note` | ≤ 200 字，空 → null | 备注不超过 200 字 |
| `delta`（调整）| `Number.isInteger` 且 `!= 0` → 否则 `INVALID_ADJUSTMENT` | 请填写非零整数 |
| `reason`（调整）| 非空，≤ 200 字 | 请填写调整原因 |
| `entries`（批量）| 数组非空 | 请至少勾选一名学员 |

即时校验（渲染层）只为体验；能否写入以上表为准（与库存一致）。

### 5.3 状态与生命周期

一条 `attendance_records` 只有两态：**有效**（`deleted_at IS NULL`）↔ **已撤销**（`deleted_at` 非空）。
撤销不可逆（无「恢复」）；要恢复 = 重新打一条。更正只在「有效」态可做，且不改变态。

`students.remaining_lessons` 生命周期：可能初始为 `NULL`（学员未购卡）。任一 `createRecord` /
`adjustLessons` / `correctRecord` / `voidRecord` 都用 `COALESCE(remaining_lessons,0) + Δ` 写入，
首次写入即把它落成真实整数（可能是负数，若 `force`）。

### 5.4 边界情况

| 场景 | 处理 |
|---|---|
| 学员 `remaining_lessons IS NULL` + 出勤 + 非 force | 守卫算 `0 + (-1) < 0` → `INSUFFICIENT_LESSONS`；用户可 force（余额变 -1）|
| 出勤私教填 `lessons=2`，余额 1，非 force | `1 + (-2) < 0` → `INSUFFICIENT_LESSONS` |
| 同一学员同一天同课程先记「请假」再记「出勤」 | 类型不同 → 不算重复，两条都留（请假 delta 0、出勤 delta -1）|
| 批量点名 20 人，第 7 人余额不足且未 force | 第 7 人 `rows[6].ok=false, errorCode=INSUFFICIENT_LESSONS`，其余 19 人正常写入；`succeeded=19, skipped=1` |
| 撤销一条已撤销记录 | 幂等：不再回补，返回当前余额 |
| 更正把「出勤」改判「请假」（delta -1 → 0）| `diff = +1`，余额 +1 |
| 更正把「请假」改判「出勤」（delta 0 → -1）| `diff = -1`，若余额不足且未 force → `INSUFFICIENT_LESSONS` |
| 更正目标是 `type='调整'` 记录 | `BAD_REQUEST('调整记录不支持更正，请撤销后重建')` |
| 导入行匹配到 2 个同名同号学员 | 该行 `failed`，原因「匹配到多个学员」（现实中 `phone_primary` 基本唯一，双保险）|
| 导入行是「调整」类型但「课时增减」留空 | 该行 `failed`，原因「调整必须填写非零课时」 |
| 导入 300 行，其中 5 行使对应学员余额变负 | 全部 `succeeded`，`negativeBalance=5`，报告顶部提示 |
| 导出时筛选结果为空 | 生成两个只有表头的 sheet，`detail=0, summary=0`，不报错 |
| 学员被软删后，其历史考勤 | 仍出现在列表 / 导出（JOIN 不加 `s.deleted_at IS NULL`）；但不再出现在花名册候选 |
| `attend_date` 晚于今天（未来日期）| 允许（补录 / 预排场景），不校验上界 |

---

## 6. 错误处理 / Error Handling

### 6.1 错误分类

| Error Code | 触发条件 | 用户消息（示例）|
|---|---|---|
| `VALIDATION_FAILED` | 字段校验不过 | 请检查表单填写（附 `fields`）|
| `INSUFFICIENT_LESSONS` | 净消耗使余额 < 0 且未 `force` | 剩余课时不足，可勾选「仍然记录」按欠课处理 |
| `DUPLICATE_ATTENDANCE` | 同 学员+日期+课程+类型 已有未撤销记录且未 `allowDuplicate` | 该学员今天这节课已有记录 |
| `INVALID_ADJUSTMENT` | 调整 `delta` 为 0 / 非整数 | 请填写非零整数 |
| `ATTENDANCE_NOT_FOUND` | 更正 / 撤销的记录不存在或已撤销 | 记录不存在，可能已被撤销 |
| `NOT_FOUND` | `student_id` 不存在或已软删 | 学员不存在，可能已被删除 |
| `BAD_REQUEST` | 缺 id / entries 空 / 更正调整记录 / 导入缺必需列映射 | （具体文案）|
| `IMPORT_FILE_INVALID` / `IMPORT_TOO_LARGE` | 坏文件 / 超 10MB / 超 5000 行 | （复用 `xlsx-util` 文案）|
| `IO_CANCELLED` / `IO_WRITE_FAILED` | 用户取消对话框 / 写盘异常 | 已取消 / 写入失败：… |
| `DB_ERROR` | 未归类异常（`toIpcError` 兜底）| （原始 message）|

### 6.2 重试策略

无自动重试。写操作全部幂等或可逆：`createRecord` 失败即整事务回滚（无残留）；`voidRecord` 幂等；
导入按行独立，失败行不影响已成功行，用户修正后可重跑（重复行会被「疑似重复」跳过）。

### 6.3 失败模式

- DB 文件锁 / 磁盘满：`better-sqlite3` 抛异常 → `handle()` 兜底为 `DB_ERROR`，事务已回滚，页面 toast 报错。
- 导出写盘中途失败：`exportRecords` 内 `wb.xlsx.writeFile` 抛错 → `IO_WRITE_FAILED`；可能留下半截文件，
  提示用户重试（与库存导出同一处理）。
- 导入文件读到一半格式错：`openFirstSheet` 抛 `IMPORT_FILE_INVALID`，未写入任何行。

---

## 7. 安全 / Security

- 单机桌面单用户，无认证 / 授权（与学员、库存模块一致）；「经办人」是自由文本，非账号。
- 所有 SQL 走 better-sqlite3 预编译语句 + 命名参数；`LIKE` 的 `% _ \` 用 `escapeLike` 转义 + `ESCAPE '\'`。
- 导入：`MAX_IMPORT_BYTES`（10MB）、`MAX_IMPORT_ROWS`（5000）硬上限；单元格一律按文本读取再校验，不 eval。
- `contextIsolation: true` / `nodeIntegration: false` 不变；渲染层只经 `window.studioShell.attendance.*`。
- 无敏感数据加密需求（本模块不新增 PII；学员姓名 / 手机号沿用既有表）。

---

## 8. 性能 / Performance

### 8.1 预期负载

单机；学员数百，考勤记录量级：单教室 ~20 节课/天 × ~10 人 ≈ 200 条/天 ≈ 6 万条/年。全部本地 SQLite。

### 8.2 优化策略

- 列表分页（默认 100），`ORDER BY attend_date DESC, id DESC` 命中 `idx_att_date`。
- 花名册候选上限 500 行、一次拉取；舞种下拉候选客户端去重（同库存分类做法）。
- 批量点名 = N 条独立小事务；better-sqlite3 同步、每条亚毫秒，N≤50 时 < 50ms，无需批处理优化。
- 导出 / 导入用 `limit: Number.MAX_SAFE_INTEGER` 全量取；受 5000 行导入上限与年数据量约束，可接受。

### 8.3 数据库考量

- 索引：`student_id` / `attend_date` / `type` / `deleted_at` 四个单列索引覆盖列表筛选与汇总的主要过滤。
- 重复检测查询 `(student_id, attend_date, class_name, type)` 走 `idx_att_student` 起步再过滤，量小无需复合索引。
- 余额守卫用「事务内先 SELECT 再 UPDATE」：better-sqlite3 同步执行、应用单进程单连接，事务内不会有第二个写者
  插入；不采用库存的原子 `WHERE remaining_lessons >= x`，因为 `force` 分支需要允许 UPDATE 把余额改负。
- N+1：列表 / 汇总均单条 JOIN 查询，无逐行回查。

---

## 9. 测试策略 / Testing Strategy

### 9.1 单元测试（`node:test`，`tests/unit/*.test.ts`，经 `tsconfig.test.json` → `dist-test/`）

| 文件 | 覆盖 |
|---|---|
| `attendance-migration.test.ts` | 空库 `run` 到 v5：表 + 4 索引齐全；重复 `run` 幂等；`v5.up` 中途抛错 → 回滚、`user_version` 不前进；含 v3/v4 的库能补到 v5 |
| `attendance-repo.test.ts` | 出勤扣 1；私教 `lessons=2` 扣 2；请假/缺勤/补课/试听余额不变；余额不足 → `INSUFFICIENT_LESSONS`；`force` 放行且余额记负；重复 → `DUPLICATE_ATTENDANCE`；`allowDuplicate` 放行；学员不存在/已软删 → `NOT_FOUND`；事务后返回的 `remainingLessons` 与库中一致 |
| `attendance-correct-void.test.ts` | 撤销回补（出勤 -1 → 撤销后 +1）且二次撤销幂等；更正 delta -1→-2 余额再 -1；-1→0 余额 +1；0→-1 余额不足 → `INSUFFICIENT_LESSONS`，`force` 放行；更正已撤销记录 → `ATTENDANCE_NOT_FOUND`；更正 `type='调整'` 记录 → `BAD_REQUEST` |
| `attendance-adjust.test.ts` | `delta=+10` 余额 +10；`delta=0` → `INVALID_ADJUSTMENT`；`delta=-5` 且余额 3 → `INSUFFICIENT_LESSONS`，`force` 后余额 -2；`reason` 空 → `VALIDATION_FAILED`；落库 `type='调整'` |
| `attendance-list-query.test.ts` | 日期区间边界含端点；`keyword` 命中姓名 / 手机号；`type` 精确筛选；分页 `total` 与 `rows.length`；已撤销行不出现；`ORDER BY` 为日期倒序 |
| `attendance-validation.test.ts` | `deltaFor` 各类型；`isRealYmd` 拦 2026-02-30；`attendTime` 正则；字段长度上限；`lessons` 非正整数报错 |
| `attendance-export.test.ts` | 生成 2 个 sheet；给定跨两月 + 1 条已撤销的数据，`按月汇总` 行数与各类型计数、`lessonsConsumed`、`remainingLessons` 正确；空筛选 → 仅表头 |
| `attendance-import.test.ts` | 混合文件（正常 / 疑似重复 / 学员不存在 / 多学员命中 / 非法类型 / 调整留空）各归类正确；成功行确实改动对应学员余额；`negativeBalance` 计数；超 `MAX_IMPORT_ROWS` → `IMPORT_TOO_LARGE` |

测试用内存 / 临时库：`new Database(':memory:')` 或 `STUDIO_DB_PATH` 临时文件 + `migrations.run(db)`，
预置若干 `students`（含 `remaining_lessons` 分别为 `null` / `0` / `2` / `50`）。

### 9.2 集成测试

并入 §9.1 各 repo/io 测试（直接调 `attendanceRepo` + `attendance-xlsx`，不经 Electron），与库存模块一致，
不新建 `tests/integration/`。

### 9.3 边界用例测试（对应 §5.4）

在 `attendance-repo.test.ts` / `attendance-correct-void.test.ts` 内逐条覆盖 §5.4 表格：NULL 余额出勤、
私教超额、请假+出勤同日不算重复、批量中段失败不回滚、幂等撤销、改判方向、未来日期放行。

### 9.4 E2E（Playwright `_electron`，`tests/e2e/attendance-flow.spec.ts`）

`env.STUDIO_DB_PATH` → 临时文件；测试前经一个 setup 脚本或首个用例插入两名学员
（A：`remaining_lessons=2`；B：`remaining_lessons=0`）。用例：

1. 首页点「考勤管理」卡 → 断言进入 `attendance.html`，默认 `#/records` 列表可见。
2. `#/quick` 搜学员 A → 记「出勤」提交 → 断言列表新增一行、A 剩余课时显示 1。
3. `#/roster` 按舞种筛出含 A 的花名册 → A 选「缺勤」提交 → 断言结果小结「成功 1」、新增一行、A 仍为 1。
4. 在列表撤销那条「出勤」→ 断言 A 剩余课时回到 2。
5. `#/quick` 对学员 B 记「出勤」→ 断言弹出余额不足确认框；点「取消」→ 断言无新记录、B 仍为 0。
6. 点「导出」→ 传入临时保存路径（stub `showSaveDialog`）→ 断言文件存在且工作簿含「考勤明细」「按月汇总」两个 sheet。
7. 全程收集 `page.on('pageerror')` 为空。

### 9.5 验收标准映射

| US / FR | 测试 | 类型 | 说明 |
|---|---|---|---|
| US-001 / FR-1 | `attendance-migration.test.ts` | unit | v5 表 + 索引 + 回滚 |
| US-002 / FR-2,FR-3,FR-4 | `attendance-repo.test.ts` | unit | `createRecord` 扣课时规则 |
| US-002 / FR-5,FR-6 | `attendance-repo.test.ts` | unit | 余额守卫 + `force` |
| US-002 / FR-7 | `attendance-repo.test.ts` | unit | 重复检测 + `allowDuplicate` |
| US-003 / FR-24,FR-25 | `attendance-flow.spec.ts` #1,#4 | e2e | 首页接线 + 已撤销不显示 |
| US-004 / FR-8,FR-23 | `attendance-flow.spec.ts` #2,#5 | e2e | 快速打卡 + 余额不足确认框 |
| US-005 / FR-9,FR-10 | `attendance-repo.test.ts` + flow #3 | unit+e2e | 批量逐条独立、单条失败不回滚 |
| US-006 / FR-12,FR-13 | `attendance-correct-void.test.ts` + flow #4 | unit+e2e | 撤销回补 / 更正差额 |
| US-007 / FR-14 | `attendance-adjust.test.ts` | unit | 手动调整 + `INVALID_ADJUSTMENT` |
| US-008 / FR-15,FR-16,FR-25 | `attendance-export.test.ts` + flow #6 | unit+e2e | 两 sheet + 按月汇总 + 排除撤销 |
| US-009 / FR-17~FR-22 | `attendance-import.test.ts` | unit | 匹配 / 去重 / 同一 domain 路径 / 报告 / 上限 |
| US-010 | `attendance-flow.spec.ts` | e2e | 全链路 + 边界 |
| FR-11 | `attendance-repo.test.ts`（`session_id` 恒 null）+ `attendance-list-query.test.ts` | unit | 不依赖课程安排 |
| FR-26 | `handle()` 包裹（复用现有机制，无新测试）| — | 已由 `register.ts` 保证 |

---

## 10. 实施计划 / Implementation Plan

### 10.1 阶段与顺序（线性阻塞链，单分支 `feat/attendance-management`，一 issue 一 commit，最后一个 PR）

1. **US-001 DB 地基** — `migrations.ts` v5；`types.ts` 追加类型 + 4 个 `IpcErrorCode`；`attendance-migration.test.ts`。
2. **US-002 域层 + 读写 IPC** — `attendance.repo.ts`（`createRecord` / `listRecords` / `listRosterCandidates`）
   + `attendance.validation.ts`；`channels.ts` / `register.ts` / `preload.ts` / `studioShell.d.ts` 接 4 个读写频道
   （list / quickCheckIn / batchCheckIn / rosterCandidates）；`attendance-repo.test.ts` / `attendance-validation.test.ts` /
   `attendance-list-query.test.ts`。
3. **US-003 渲染外壳 + 列表 + 首页接线** — `attendance.html` / `attendance.js`（`#/records`）；`index.html` 卡片
   `href`；`electron-builder.yml` `files`。
4. **US-004 快速打卡** — `#/quick` 视图 + 确认对话框（余额不足 / 重复 / 预警）；接 `quickCheckIn`。
5. **US-005 批量点名** — `#/roster` 视图 + 花名册筛选 + 状态选择；接 `batchCheckIn`；结果小结。
6. **US-006 更正 / 撤销** — `repo.correctRecord` / `repo.voidRecord`；`attendanceCorrect` / `attendanceVoid` 频道；
   列表行操作 + 更正表单；`attendance-correct-void.test.ts`。
7. **US-007 手动调整课时** — `repo.adjustLessons`（委托 `createRecord`）；`attendanceAdjustLessons` 频道；调整入口；
   `attendance-adjust.test.ts`。
8. **US-008 导出** — `attendance-xlsx.ts` 的 `exportRecords` + `repo.monthlySummary`；`attendanceExport` 频道；
   `attendance-export.test.ts`。
9. **US-009 导入** — `attendance-xlsx.ts` 的 `buildTemplate` / `readImportPreview` / `importRecords`；
   `attendanceDownloadTemplate` / `attendancePickImportFile` / `attendanceImport` 频道；列映射 UI；`attendance-import.test.ts`。
10. **US-010 E2E** — `tests/e2e/attendance-flow.spec.ts`；`npm test` 全绿后开 PR。

每个 issue 提交前跑 `npm run typecheck && npm run lint && npm run test:unit`；PR 前跑 `npm test`。

### 10.2 Issue 映射

| Issue | SPEC 章节 | 优先级 | 依赖 |
|---|---|---|---|
| US-001 | 3.1, 3.2, 3.4 | high | — |
| US-002 | 2.2, 4.1(list/quick/batch/roster), 5.1, 5.2 | high | US-001 |
| US-003 | 2.4, 4.3 | high | US-002 |
| US-004 | 2.3-A, 5.4 | high | US-003 |
| US-005 | 2.3-B, 5.4 | high | US-003 |
| US-006 | 2.3-C, 4.1(correct/void), 5.3 | medium | US-004 |
| US-007 | 2.3(adjust), 4.1(adjustLessons), 5.2 | medium | US-004 |
| US-008 | 2.3-D, 5.1(monthlySummary) | medium | US-005, US-006 |
| US-009 | 2.3-E, 5.4 | medium | US-008 |
| US-010 | 9.4 | high | 以上全部 |

### 10.3 增量交付

无 feature flag（桌面单机、单分支单 PR）。合并前 `feat/class-name-field`(v3) 与 `feat/inventory-management`(v4)
应已在 main；若未，`v5.up` 的 `IF NOT EXISTS` 与 `run()` 的空档跳版能力保证仍可正确升级。

---

## 11. 开放问题与风险 / Open Questions & Risks

### 11.1 待明确（不阻塞实施，取默认）

- **舞种下拉选项来源**：默认「从 `students.dance_types` 现有值去重动态生成」（同库存分类）。若后续学员模块引入
  舞种字典表，再切换。
- **经办人是否可记忆**：默认纯文本框，不做「最近使用」下拉。
- **按月汇总是否加缺勤率列**：默认不加，留给「数据报表」模块。
- **`class_name` 为空的重复口径**：`COALESCE(class_name,'') = ''` 视为同一「无课程名」组参与重复判断。

### 11.2 技术风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 迁移版本号 v5 与其它并行分支再次撞号 | `run()` 静默跳版或启动抛错 | DDL 全 `IF NOT EXISTS` + `run()` 重复版本号守卫；rebase 时认领下一个空号并在 commit body 注明 |
| 大量学员 `remaining_lessons` 为 `NULL` | 首次出勤即被余额守卫拦截，前台困惑 | 确认框文案明确「该学员无剩余课时，勾选『仍然记录』将按欠课处理」；学员模块可先补录课时 |
| 「课时增减」在导入 Excel 里被填成小数 / 文本 | 行失败 | `parseImportRow` 校验整数，失败计入 `failures` 附行号 |
| 两条写入路径（考勤流水 vs 学员表单直接改 `remaining_lessons`）导致对账困难 | 余额与流水 SUM 不一致 | 本期接受（PRD 非目标）；SPEC 已把 `type` 设计为可容纳 `购课` 等正 delta，将来收敛为「余额=SUM(流水)」不需改表 |
| better-sqlite3 事务内「先读后写」余额守卫 | 理论上非原子 | 单进程单连接同步执行，事务内无并发写者；已在 §8.3 说明，测试覆盖 `force` / 非 `force` 两路 |
| 批量点名一次勾选过多（如 200 人）| 200 条小事务，UI 卡顿 | 花名册候选上限 500；提交按钮 loading 态；实测 200 条 < 300ms，可接受 |

### 11.3 假设（实施前校验）

- `todayYmd()` / `isRealYmd()` 两个 ~6 行日期助手在 `attendance.validation.ts` 内**复制一份**（库存模块即如此），
  不抽公共模块。
- `students` 表有 `dance_types`（JSON 数组字符串）、`remaining_lessons`（可空 INTEGER）、`card_expire_date`、
  `status`、`phone_primary`、`deleted_at` 列（已在 v1 确认）。
- `xlsx-util.ts` 的 `openFirstSheet` / `headerTexts` / `rowTexts` / `pickSavePath` / `pickOpenPath` / `ymdCompact` /
  `MAX_IMPORT_BYTES` / `MAX_IMPORT_ROWS` 可直接复用，无需扩展。
- `attendance.js` 复制 `students.html` 外壳后，`#toast` / `el()` / `unwrap()` 等工具函数与库存渲染器一致，
  可整体照搬。
- E2E 中对 `dialog.showSaveDialog` 的打桩方式与 `inventory-flow.spec.ts` 现有做法一致。
