# SPEC: 数据报表模块

> Technical specification derived from: `tasks/prd-data-reports.md`
> Generated: 2026-08-30 | Target branch: `feat/reports` | Base commit: `8a9da5f`

## 1. Summary

### 1.1 What This SPEC Covers

「晓·乐舞艺术空间」管理平台第 5 个模块「数据报表」的技术实现契约。模块**纯只读**:
不新增数据库表、不写迁移、不改任何业务数据,只新增

- `src/domain/reports.repo.ts` —— 一组只读聚合查询(每个报表区一个函数)
- `src/io/reports-xlsx.ts` —— 按班级分 sheet 的 Excel 出勤统计导出
- `src/ipc/channels.ts` / `src/ipc/register.ts` —— 7 个 `reports:*` 频道
- `src/preload.ts` / `studioShell.d.ts` —— `window.studioShell.reports.*` 窄接口
- `reports.html` / `reports.js` / `reports.charts.js` —— 渲染层(拷 `students.html` 外壳)
- `src/shared/types.ts` —— 追加 `reports` 相关出入参类型 + 1 个错误码 `REPORT_EMPTY`

### 1.2 PRD Reference

- Source: `tasks/prd-data-reports.md`
- User Stories: US-001 … US-010(全部)
- Functional Requirements: FR-1 … FR-19(全部)

### 1.3 Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| 数据层形态 | 新增 `reports.repo.ts`,只含 `SELECT`,无 validation 层 | 无写操作;与 PRD「纯只读」硬约束一致(FR-3) |
| 是否加迁移 / 索引 | 都不加 | 加列 / 加索引都是 DDL = 迁移,违反只读约束;研究规模(学员 ≤ 千级、考勤 ≤ 万级)全表扫描可接受 |
| 报表区拆分 | 每区一个 repo 函数 + 一个 IPC 频道(不做单个 fat dashboard 接口) | 与四个已有模块「一动作一频道」一致;渲染层 `Promise.all` 并发拉取 |
| 时间范围契约 | 渲染层把「本月 / 本年 / 自定义」换算成显式 `{from,to}`(`'YYYY-MM-DD'`)传入;主进程只认日期串,不认 preset 枚举 | 主进程无「今天」歧义;`from`/`to` 可直接进 SQL `BETWEEN`,与 `attendance-xlsx` 现有做法一致 |
| 「近 N 天」基准 | cutoff 日期在 repo 内用 JS **本地时间**算好,作为绑定参数传入 SQL | SQLite `date('now')` 是 UTC,与库里本地 `'YYYY-MM-DD'` 会有时区错位 |
| 图表 | 手写 SVG 字符串构造器,独立 `reports.charts.js`(纯 ESM,无 DOM / 无 `src/` 依赖) | Electron 离线 + 无打包器,不能引图表库 / CDN(FR-12);纯函数可单测(US-002) |
| 图表单测 | `tsconfig.test.json` 开 `allowJs` 并 include `reports.charts.js`,编译到 `dist-test/` 后由测试导入 | 渲染层文件不进 `tsc` 主构建;这是 config 改动,非迁移 |
| 错误码 | 新增 `REPORT_EMPTY`(无任何可导出数据);其余复用 `BAD_REQUEST` / `IO_CANCELLED` / `IO_WRITE_FAILED` | 与现有 `IpcErrorCode`「一码一因」风格一致 |
| Excel 库 | `exceljs`(已在 `dependencies`),复用 `xlsx-util` 的 `pickSavePath` / `ymdCompact` | 与 `inventory-xlsx` / `attendance-xlsx` 完全一致 |
| 空导出防护 | `canExportAttendance(year)` 便宜探测**在弹保存框之前**;为空则抛 `REPORT_EMPTY`,不弹框 | FR-16 |
| 舞种分布 | SQLite `json_each(dance_types)` + `WHERE json_valid(dance_types)` 兜底 | `dance_types` 是 JSON 数组字符串列 |

---

## 2. Architecture

### 2.1 System Context

```
渲染层 reports.html + reports.js ──(window.studioShell.reports.*)──▶ preload.ts
                                                                        │ ipcRenderer.invoke
                                                                        ▼
主进程 register.ts  handle('reports:*')  ─────────────────────────────────
    │                                        │
    ├── reports.repo.ts  ── getDb() ──▶ SQLite（只读 SELECT）
    └── reports-xlsx.ts  ── reports.repo.ts + exceljs ──▶ 用户选定的 .xlsx 路径
```

报表模块**不**回调其它模块的 repo(`students.repo` / `inventory.repo` 等),直接对同一个
SQLite 连接发聚合 `SELECT`——避免 N+1、避免绕开分页限制。唯一例外:无。

### 2.2 Component Design

| 组件 | 职责 | 边界 |
|------|------|------|
| `reports.repo.ts` | 6 个只读聚合函数 + 1 个 `canExportAttendance` + 1 个 `getClassAttendanceMatrix`;所有 SQL 预编译 + 命名参数 | 不抛 `AppError` 之外的异常;不碰 IPC / dialog / exceljs;不写库 |
| `reports-xlsx.ts` | 把 `getClassAttendanceMatrix` 的结果誊成多 sheet 工作簿,套黄 / 红填充 | 不直接查库(经 repo);`pickSavePath` 由 `register.ts` 调,本文件只收 `filePath` |
| `reports.charts.js` | `barChartSVG` / `lineChartSVG` / `heatmapSVG` + 可单测的几何纯函数 | 返回 SVG **字符串**;不引用 `document` / `window`;不发 IPC |
| `reports.js` | 时间范围控件、区块渲染与折叠、导出按钮、`Promise.all` 拉数、`#toast` 错误提示 | 只做展示;不做业务校验 |

### 2.3 Module Interactions

**进入页面 / 切换时间范围:**

```
reports.js: 读 preset → 算 {from,to}
  → Promise.all([
      shell.reports.overview({from,to}),
      shell.reports.alerts(),
      shell.reports.attendanceStats({from,to}),
      shell.reports.courseStats({from,to}),
      shell.reports.studentStats({from,to}),
      shell.reports.inventoryStats({from,to}),
    ])
  → 每个结果 unwrap() → 渲染对应区块（图表用 reports.charts.js 生成 SVG 字符串塞进容器）
```

**导出 Excel:**

```
reports.js: 用户选年份 → shell.reports.exportAttendanceByClass(year)
  → register.ts: 校验 year → reportsRepo.canExportAttendance(year)
       false → throw AppError('REPORT_EMPTY', …)   // 不弹保存框
       true  → pickSavePath('导出出勤统计', '出勤统计-<year>-<yyyymmdd>.xlsx')
             → exportAttendanceByClass(year, filePath)
                  → reportsRepo.getClassAttendanceMatrix({year})
                  → 组 workbook（全校汇总 sheet 在最前，其后每班一个）→ writeFile
             → 返回 { sheetCount, classCount }
  → reports.js: 成功 toast 路径；REPORT_EMPTY → toast 文案；IO_CANCELLED → 静默
```

### 2.4 File Structure

```
（新增）
src/domain/reports.repo.ts
src/io/reports-xlsx.ts
reports.html
reports.js
reports.charts.js
tests/unit/reports-repo.test.ts
tests/unit/reports-charts.test.ts
tests/unit/reports-xlsx.test.ts
tests/e2e/reports.spec.ts

（修改）
src/ipc/channels.ts          ── + 7 个 reports:* 常量
src/ipc/register.ts          ── + import reportsRepo / exportAttendanceByClass；+ 7 个 handle()；+ checkedRange 辅助
src/preload.ts               ── + 7 个 CH 字面量；+ reports 命名空间
studioShell.d.ts             ── + reports 命名空间类型 + 各结果 interface
src/shared/types.ts          ── + reports 出入参 interface；IpcErrorCode 追加 'REPORT_EMPTY'
tsconfig.test.json           ── + "allowJs": true；include 追加 "reports.charts.js"
electron-builder.yml         ── files 追加 reports.html / reports.js / reports.charts.js
index.html                   ── app-card-reports 链接 placeholder.html?app=reports → reports.html
```

---

## 3. Data Model

### 3.1 Schema Changes

**无。** 模块不新增表、列、索引,不写迁移。`src/db/migrations.ts` 零改动。

### 3.2 读取涉及的既有表(只读)

| 表 | 用到的列 | 备注 |
|----|---------|------|
| `students` | `id, name, status, deleted_at, remaining_lessons, enroll_date, referrer, current_level, dance_types` | `dance_types` 为 JSON 数组串;`status='在读'` 无 CHECK 约束但由校验层保证 |
| `attendance_records` | `id, student_id, session_id, class_name, teacher, attend_date, attend_time, type, deleted_at` | `type ∈ 出勤/请假/缺勤/补课/试听/调整`;`deleted_at` 非空即撤销 |
| `class_sessions` | `id, class_id, session_date, start_time, end_time, teacher_id, status, deleted_at` | `status ∈ 正常/停课` |
| `classes` | `id, name, capacity, status, deleted_at` | `status ∈ 在读/停课/结课` |
| `class_students` | `class_id, student_id, left_at` | 部分唯一索引仅约束 `left_at IS NULL` 的活跃行;同一学员可「离班后再入班」→ 可能多行 |
| `teachers` | `id, name` | LEFT JOIN 取名;课节 `teacher_id` 可空 |
| `inventory_items` | `id, name, quantity, low_stock_threshold, deleted_at` | |
| `item_allocations` | `item_id, student_id, quantity, claimed_at` | 无软删;`claimed_at` 为 `'YYYY-MM-DD'` |

### 3.3 Entity Definitions（`src/shared/types.ts` 追加）

```ts
/** 报表时间范围;两端闭区间,'YYYY-MM-DD'。渲染层负责把 preset 换算成它。 */
export interface ReportRange { from: string; to: string; }

export interface ReportOverview {
  activeStudents: number;         // students: deleted_at IS NULL AND status='在读'
  checkInsInRange: number;        // attendance: type IN ('出勤','补课') AND 未撤销 AND attend_date ∈ [from,to]
  sessionsInRange: number;        // class_sessions: status='正常' AND 未软删 AND session_date ∈ [from,to]
  newStudentsLast30d: number;     // students: 未软删 AND enroll_date >= cutoff30（含当天）
  lowBalanceCount: number;        // students: 在读 AND remaining_lessons IS NOT NULL AND <= 3
  lowStockCount: number;          // inventory_items: 未软删 AND quantity <= low_stock_threshold
  unlinkedCheckInsThisYear: number; // attendance: 未撤销 AND type IN ('出勤','补课') AND session_id IS NULL AND attend_date ∈ [YEAR(to)-01-01, YEAR(to)-12-31]
}

export interface ReportAlerts {
  lowStock:  { id: number; name: string; quantity: number; threshold: number }[];
  lowBalance:{ id: number; name: string; remainingLessons: number }[];
  dormant:   { id: number; name: string; lastAttendDate: string | null }[];
  emptySessions: { sessionId: number; className: string; sessionDate: string; startTime: string }[];
}

export interface ReportAttendanceStats {
  sessionsThisMonth: number;      // 由 to 推:该月 1 号 → to
  sessionsThisYear: number;       // 由 to 推:该年 1/1 → to
  monthlyCheckIns: { month: string; count: number }[];   // 'YYYY-MM';repo 补齐 [from,to] 覆盖的每个自然月,无数据补 0
  ranking: {
    studentId: number; name: string;
    attendCount: number;   // 出勤 + 补课（「按次数」列）
    attendOnly: number;    // 出勤
    scheduled: number;     // 出勤 + 缺勤 + 请假
    rate: number | null;   // scheduled>0 ? attendOnly/scheduled : null（「按出勤率」列）
  }[];
  absenceTop: { studentId: number; name: string; absentPlusLeave: number }[];  // 近30天,前10
  byTeacher:  { teacher: string; checkIns: number }[];    // attendance_records.teacher,空→'未记录'
  byDanceType:{ danceType: string; checkIns: number }[];  // attendance_records.class_name,空→'未记录'
  hourHeatmap:{ weekday: number; bucket: number; count: number }[]; // weekday 0-6(周日=0),bucket 0-11(2小时/桶),时段未知 bucket=-1
}

export interface ReportCourseStats {
  teacherLoad: { teacherId: number | null; teacherName: string; sessionCount: number; minutes: number }[];
  cancelRate:  { normal: number; cancelled: number; rate: number | null };
  classFillRate: { classId: number; className: string; enrolled: number; capacity: number | null; rate: number | null }[];
  emptySessions: { sessionId: number; className: string; sessionDate: string; startTime: string }[];
}

export interface ReportStudentStats {
  statusDist:   { status: string; count: number }[];
  danceTypeDist:{ danceType: string; count: number }[];
  levelDist:    { level: string; count: number }[];       // 空 current_level → '未分级'
  monthlyNew:   { month: string; count: number }[];       // 补齐月份
  referrerTop:  { referrer: string; count: number }[];    // 前10,空值不计
  lowBalance:   { id: number; name: string; remainingLessons: number }[];
  dormant:      { id: number; name: string; lastAttendDate: string | null }[];
}

export interface ReportInventoryStats {
  lowStock: { id: number; name: string; quantity: number; threshold: number }[];
  totals:   { itemKinds: number; totalQuantity: number };
  monthlyAllocations: { month: string; quantity: number }[]; // 补齐月份
  topItems:    { itemId: number; name: string; quantity: number }[];   // 前10
  topStudents: { studentId: number; name: string; quantity: number }[];// 前10
  staleItems:  { id: number; name: string; quantity: number; lastClaimedAt: string | null }[]; // 90天无领用且在库>0
}

/** getClassAttendanceMatrix 的返回;供 reports-xlsx 组表。 */
export interface ClassMatrixRow {
  studentId: number;
  studentName: string;        // 不含「（已离班）」后缀,后缀在 io 层拼
  left: boolean;              // 班级 sheet 用;全校汇总恒 false
  monthly: number[];          // 长度 12,出勤+补课
  yearTotal: number;          // monthly 之和
  monthlyScheduled: number[]; // 长度 12,出勤+缺勤+请假（标黄分母）
  monthlyAbsent: number[];    // 长度 12,缺勤（标黄分子）
}
export interface ClassMatrixBlock {
  classId: number | null;     // null = 全校汇总
  className: string;          // 全校汇总固定 '全校汇总'
  rows: ClassMatrixRow[];
}
export interface ClassAttendanceMatrix {
  year: number;
  schoolWide: ClassMatrixBlock;
  classes: ClassMatrixBlock[]; // 当年有未软删 class_sessions 的班级,按 className COLLATE NOCASE 升序
}
```

### 3.4 Migration Plan

不适用(无 schema 变更)。回滚 = 删除新增文件 + 还原被修改文件的追加片段。

---

## 4. API Design（IPC）

### 4.1 频道

| 频道常量 | 字符串 | 入参 | 出参(`IpcResult<T>` 的 `T`) |
|----------|--------|------|------|
| `reportsOverview` | `reports:overview` | `ReportRange` | `ReportOverview` |
| `reportsAlerts` | `reports:alerts` | 无 | `ReportAlerts` |
| `reportsAttendanceStats` | `reports:attendanceStats` | `ReportRange` | `ReportAttendanceStats` |
| `reportsCourseStats` | `reports:courseStats` | `ReportRange` | `ReportCourseStats` |
| `reportsStudentStats` | `reports:studentStats` | `ReportRange` | `ReportStudentStats` |
| `reportsInventoryStats` | `reports:inventoryStats` | `ReportRange` | `ReportInventoryStats` |
| `reportsExportAttendanceByClass` | `reports:exportAttendanceByClass` | `{ year: number }` | `{ sheetCount: number; classCount: number }` |

### 4.2 register.ts 契约

```ts
// 复用现有 handle() 包裹器（异常永不跨边界,统一 IpcResult 信封）

/** 校验并规整时间范围;非法 → BAD_REQUEST。 */
function checkedRange(q?: { from?: string; to?: string }): ReportRange {
  const from = (typeof q?.from === 'string' ? q.from : '').trim();
  const to   = (typeof q?.to   === 'string' ? q.to   : '').trim();
  const ymd = /^\d{4}-\d{2}-\d{2}$/;
  if (!ymd.test(from) || !ymd.test(to)) throw new AppError('BAD_REQUEST', '缺少合法的起止日期');
  if (from > to) throw new AppError('BAD_REQUEST', '起始日期不能晚于结束日期');
  return { from, to };
}

handle(CH.reportsOverview,         (q?) => reportsRepo.getOverview(checkedRange(q)));
handle(CH.reportsAlerts,           ()   => reportsRepo.getAlerts());
handle(CH.reportsAttendanceStats,  (q?) => reportsRepo.getAttendanceStats(checkedRange(q)));
handle(CH.reportsCourseStats,      (q?) => reportsRepo.getCourseStats(checkedRange(q)));
handle(CH.reportsStudentStats,     (q?) => reportsRepo.getStudentStats(checkedRange(q)));
handle(CH.reportsInventoryStats,   (q?) => reportsRepo.getInventoryStats(checkedRange(q)));

handle(CH.reportsExportAttendanceByClass, async (args?) => {
  const year = Number(args?.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new AppError('BAD_REQUEST', '缺少合法年份');
  }
  // 先探测,后弹框（FR-16:无数据不弹保存对话框）
  if (!reportsRepo.canExportAttendance(year)) {
    throw new AppError('REPORT_EMPTY', '所选年份没有排课班级,也没有学员考勤记录,无法导出');
  }
  const filePath = await pickSavePath('导出出勤统计', `出勤统计-${year}-${ymdCompact()}.xlsx`);
  try {
    return await exportAttendanceByClass(year, filePath);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('IO_WRITE_FAILED',
      `写入失败:${err instanceof Error ? err.message : String(err)}`);
  }
});
```

### 4.3 preload.ts 契约

```ts
// CH 字面量块追加 7 个（与 channels.ts 保持字面一致）
reports: {
  overview:        (range) => invoke(CH.reportsOverview, range),
  alerts:          ()      => invoke(CH.reportsAlerts),
  attendanceStats: (range) => invoke(CH.reportsAttendanceStats, range),
  courseStats:     (range) => invoke(CH.reportsCourseStats, range),
  studentStats:    (range) => invoke(CH.reportsStudentStats, range),
  inventoryStats:  (range) => invoke(CH.reportsInventoryStats, range),
  exportAttendanceByClass: (year) => invoke(CH.reportsExportAttendanceByClass, { year }),
},
```

`studioShell.d.ts` 同步声明 `reports` 命名空间,返回 `Promise<IpcResult<…>>`,复用 §3.3 的 interface。

### 4.4 Error Responses

| code | 触发 | 渲染层处理 |
|------|------|-----------|
| `BAD_REQUEST` | 日期 / 年份非法、`from > to` | `#toast` 提示,不常见(渲染层已先算好) |
| `IO_CANCELLED` | 用户在保存框点取消 | 静默 |
| `REPORT_EMPTY` | 该年无排课班级且无任何考勤记录 | `#toast('所选年份没有…')`,不弹保存框 |
| `IO_WRITE_FAILED` | exceljs 写盘失败 | `#toast` 提示失败原因 |
| `DB_ERROR` | 未归类异常(如 `json_each` 遇脏数据) | `#toast('数据读取失败')` |

### 4.5 Breaking Changes

无。纯新增频道 + `IpcErrorCode` 联合类型追加一个成员(向后兼容)。

---

## 5. Business Logic

> 约定:以下 SQL 为**结构草图**,实现时用 better-sqlite3 预编译语句 + 命名参数(`@from` 等)。
> 所有查询默认排除软删(`deleted_at IS NULL`),下文只在容易忽略处显式标注。
> `cutoffN` = 实现时用 JS 本地时间算出的 `'YYYY-MM-DD'`(今天减 N 天),作为绑定参数。

### 5.1 核心查询

#### 5.1.1 `getOverview({from,to})`

六个独立标量 `SELECT` + 一个「当年未关联课节数」。逐条:

```sql
-- activeStudents
SELECT COUNT(*) FROM students WHERE deleted_at IS NULL AND status = '在读';
-- checkInsInRange
SELECT COUNT(*) FROM attendance_records
 WHERE deleted_at IS NULL AND type IN ('出勤','补课') AND attend_date BETWEEN @from AND @to;
-- sessionsInRange
SELECT COUNT(*) FROM class_sessions
 WHERE deleted_at IS NULL AND status = '正常' AND session_date BETWEEN @from AND @to;
-- newStudentsLast30d   （cutoff30 = 今天-30天,含当天）
SELECT COUNT(*) FROM students
 WHERE deleted_at IS NULL AND enroll_date IS NOT NULL AND enroll_date >= @cutoff30;
-- lowBalanceCount
SELECT COUNT(*) FROM students
 WHERE deleted_at IS NULL AND status = '在读'
   AND remaining_lessons IS NOT NULL AND remaining_lessons <= 3;
-- lowStockCount
SELECT COUNT(*) FROM inventory_items
 WHERE deleted_at IS NULL AND quantity <= low_stock_threshold;
-- unlinkedCheckInsThisYear   （yr = to 的年份）
SELECT COUNT(*) FROM attendance_records
 WHERE deleted_at IS NULL AND type IN ('出勤','补课') AND session_id IS NULL
   AND attend_date BETWEEN @yrStart AND @yrEnd;   -- 'yyyy-01-01' … 'yyyy-12-31'
```

#### 5.1.2 `getAlerts()`(不受时间范围约束,窗口为固定值)

```sql
-- lowStock（LIMIT 200,按 quantity-threshold 升序 = 最紧缺在前）
SELECT id, name, quantity, low_stock_threshold AS threshold
  FROM inventory_items
 WHERE deleted_at IS NULL AND quantity <= low_stock_threshold
 ORDER BY (quantity - low_stock_threshold) ASC, name COLLATE NOCASE LIMIT 200;

-- lowBalance（LIMIT 200）
SELECT id, name, remaining_lessons AS remainingLessons
  FROM students
 WHERE deleted_at IS NULL AND status='在读'
   AND remaining_lessons IS NOT NULL AND remaining_lessons <= 3
 ORDER BY remaining_lessons ASC, name COLLATE NOCASE LIMIT 200;

-- dormant:在读、未软删、近 60 天无「出勤」记录（cutoff60 含当天算「未沉睡」）
SELECT s.id, s.name,
       (SELECT MAX(a.attend_date) FROM attendance_records a
         WHERE a.student_id = s.id AND a.deleted_at IS NULL AND a.type='出勤') AS lastAttendDate
  FROM students s
 WHERE s.deleted_at IS NULL AND s.status='在读'
   AND NOT EXISTS (
     SELECT 1 FROM attendance_records a
      WHERE a.student_id = s.id AND a.deleted_at IS NULL
        AND a.type='出勤' AND a.attend_date >= @cutoff60)
 ORDER BY lastAttendDate ASC NULLS FIRST, s.name COLLATE NOCASE LIMIT 200;

-- emptySessions:近 30 天内、已发生、正常、0 到课人次
SELECT s.id AS sessionId, c.name AS className, s.session_date AS sessionDate, s.start_time AS startTime
  FROM class_sessions s JOIN classes c ON c.id = s.class_id
 WHERE s.deleted_at IS NULL AND s.status='正常'
   AND s.session_date BETWEEN @cutoff30 AND @today
   AND NOT EXISTS (
     SELECT 1 FROM attendance_records a
      WHERE a.session_id = s.id AND a.deleted_at IS NULL AND a.type IN ('出勤','补课'))
 ORDER BY s.session_date DESC, s.start_time DESC LIMIT 200;
```

#### 5.1.3 `getAttendanceStats({from,to})`

- `sessionsThisMonth` / `sessionsThisYear`:同 5.1.1 的 `sessionsInRange` 口径,范围分别取
  `[firstDayOfMonth(to), to]` 和 `[jan1(to), to]`(与传入 range 无关,US-005 要求恒定展示)。
- `monthlyCheckIns`:
  ```sql
  SELECT substr(attend_date,1,7) AS ym, COUNT(*) AS n
    FROM attendance_records
   WHERE deleted_at IS NULL AND type IN ('出勤','补课') AND attend_date BETWEEN @from AND @to
   GROUP BY ym;
  ```
  repo 生成 `from`→`to` 覆盖的完整月份序列,缺失月补 `count:0`。
- `ranking`:
  ```sql
  SELECT a.student_id AS studentId, s.name AS name,
         SUM(a.type IN ('出勤','补课')) AS attendCount,
         SUM(a.type = '出勤')          AS attendOnly,
         SUM(a.type IN ('出勤','缺勤','请假')) AS scheduled
    FROM attendance_records a JOIN students s ON s.id = a.student_id
   WHERE a.deleted_at IS NULL AND a.attend_date BETWEEN @from AND @to
   GROUP BY a.student_id;
  ```
  `rate = scheduled > 0 ? attendOnly / scheduled : null`。JOIN `students` 不加 `deleted_at`
  过滤——已离校学员的历史仍显示。默认排序由渲染层做(默认 `attendCount` 降序,可切 `rate` 降序、
  `null` 沉底)。
- `absenceTop`:
  ```sql
  SELECT a.student_id AS studentId, s.name, COUNT(*) AS absentPlusLeave
    FROM attendance_records a JOIN students s ON s.id = a.student_id
   WHERE a.deleted_at IS NULL AND a.type IN ('缺勤','请假') AND a.attend_date >= @cutoff30
   GROUP BY a.student_id ORDER BY absentPlusLeave DESC, s.name COLLATE NOCASE LIMIT 10;
  ```
- `byTeacher` / `byDanceType`:
  ```sql
  SELECT COALESCE(NULLIF(TRIM(teacher),''),'未记录') AS teacher, COUNT(*) AS n
    FROM attendance_records
   WHERE deleted_at IS NULL AND type IN ('出勤','补课') AND attend_date BETWEEN @from AND @to
   GROUP BY teacher ORDER BY n DESC;
  -- byDanceType 同理,分组列换 class_name
  ```
- `hourHeatmap`:
  ```sql
  SELECT CAST(strftime('%w', attend_date) AS INTEGER) AS weekday,
         CASE WHEN attend_time IS NULL OR attend_time=''
              THEN -1 ELSE CAST(substr(attend_time,1,2) AS INTEGER)/2 END AS bucket,
         COUNT(*) AS n
    FROM attendance_records
   WHERE deleted_at IS NULL AND type IN ('出勤','补课') AND attend_date BETWEEN @from AND @to
   GROUP BY weekday, bucket;
  ```
  渲染层拼成 7 行 ×(12 桶 + 未知)矩阵。

#### 5.1.4 `getCourseStats({from,to})`

- `teacherLoad`:
  ```sql
  SELECT s.teacher_id AS teacherId,
         COALESCE(t.name,'未指定') AS teacherName,
         COUNT(*) AS sessionCount,
         SUM( (CAST(substr(s.end_time,1,2) AS INTEGER)*60 + CAST(substr(s.end_time,4,2) AS INTEGER))
            - (CAST(substr(s.start_time,1,2) AS INTEGER)*60 + CAST(substr(s.start_time,4,2) AS INTEGER)) ) AS minutes
    FROM class_sessions s LEFT JOIN teachers t ON t.id = s.teacher_id
   WHERE s.deleted_at IS NULL AND s.status='正常' AND s.session_date BETWEEN @from AND @to
   GROUP BY s.teacher_id ORDER BY minutes DESC;
  ```
- `cancelRate`:范围内未软删课节,`normal = SUM(status='正常')`,`cancelled = SUM(status='停课')`,
  `rate = (normal+cancelled) > 0 ? cancelled/(normal+cancelled) : null`。
- `classFillRate`(与时间范围无关):
  ```sql
  SELECT c.id AS classId, c.name AS className, c.capacity AS capacity,
         (SELECT COUNT(*) FROM class_students cs
           WHERE cs.class_id = c.id AND cs.left_at IS NULL) AS enrolled
    FROM classes c
   WHERE c.deleted_at IS NULL AND c.status <> '结课'
   ORDER BY c.name COLLATE NOCASE;
  ```
  `rate = (capacity IS NOT NULL AND capacity > 0) ? enrolled/capacity : null`。
- `emptySessions`:同 5.1.2 的 emptySessions,但窗口换成 `session_date BETWEEN @from AND @to`
  且 `session_date <= @today`。

#### 5.1.5 `getStudentStats({from,to})`

```sql
-- statusDist
SELECT status, COUNT(*) AS n FROM students WHERE deleted_at IS NULL GROUP BY status ORDER BY n DESC;

-- danceTypeDist（json_each 展开;json_valid 兜底脏数据）
SELECT je.value AS danceType, COUNT(*) AS n
  FROM students s, json_each(s.dance_types) je
 WHERE s.deleted_at IS NULL AND json_valid(s.dance_types)
 GROUP BY je.value ORDER BY n DESC;

-- levelDist
SELECT COALESCE(NULLIF(TRIM(current_level),''),'未分级') AS level, COUNT(*) AS n
  FROM students WHERE deleted_at IS NULL GROUP BY level ORDER BY n DESC;

-- monthlyNew（repo 补齐月份）
SELECT substr(enroll_date,1,7) AS ym, COUNT(*) AS n
  FROM students
 WHERE deleted_at IS NULL AND enroll_date BETWEEN @from AND @to
 GROUP BY ym;

-- referrerTop
SELECT TRIM(referrer) AS referrer, COUNT(*) AS n
  FROM students
 WHERE deleted_at IS NULL AND referrer IS NOT NULL AND TRIM(referrer) <> ''
 GROUP BY referrer ORDER BY n DESC, referrer LIMIT 10;
```

`lowBalance` / `dormant`:与 5.1.2 同口径(抽一个 repo 内部私有函数复用)。

#### 5.1.6 `getInventoryStats({from,to})`

```sql
-- lowStock（同 alerts.lowStock,LIMIT 200）
-- totals
SELECT COUNT(*) AS itemKinds, COALESCE(SUM(quantity),0) AS totalQuantity
  FROM inventory_items WHERE deleted_at IS NULL;

-- monthlyAllocations（repo 补齐月份）
SELECT substr(claimed_at,1,7) AS ym, COALESCE(SUM(quantity),0) AS q
  FROM item_allocations WHERE claimed_at BETWEEN @from AND @to GROUP BY ym;

-- topItems
SELECT a.item_id AS itemId, i.name, SUM(a.quantity) AS q
  FROM item_allocations a JOIN inventory_items i ON i.id = a.item_id
 WHERE a.claimed_at BETWEEN @from AND @to
 GROUP BY a.item_id ORDER BY q DESC, i.name COLLATE NOCASE LIMIT 10;

-- topStudents（JOIN students,同上）

-- staleItems:未软删、在库>0、近 90 天无领用
SELECT i.id, i.name, i.quantity,
       (SELECT MAX(a.claimed_at) FROM item_allocations a WHERE a.item_id = i.id) AS lastClaimedAt
  FROM inventory_items i
 WHERE i.deleted_at IS NULL AND i.quantity > 0
   AND NOT EXISTS (SELECT 1 FROM item_allocations a
                    WHERE a.item_id = i.id AND a.claimed_at >= @cutoff90)
 ORDER BY lastClaimedAt ASC NULLS FIRST, i.name COLLATE NOCASE LIMIT 200;
```

#### 5.1.7 `canExportAttendance(year): boolean`

一个便宜的存在性探测,给 `register.ts` 在弹保存框前用:

```sql
SELECT
  EXISTS(SELECT 1 FROM class_sessions
          WHERE deleted_at IS NULL AND session_date BETWEEN @ys AND @ye) AS hasClassSessions,
  EXISTS(SELECT 1 FROM students WHERE deleted_at IS NULL AND status='在读') AS hasActiveStudents,
  EXISTS(SELECT 1 FROM attendance_records
          WHERE deleted_at IS NULL AND attend_date BETWEEN @ys AND @ye) AS hasAttendance;
```

任一为真即返回 `true`。

#### 5.1.8 `getClassAttendanceMatrix({year})`

`ys = 'yyyy-01-01'`,`ye = 'yyyy-12-31'`。

**Step 1 —— 合格班级列表**(FR-13:当年有过课节的班级;班级即使软删也算):

```sql
SELECT DISTINCT c.id, c.name
  FROM classes c JOIN class_sessions s ON s.class_id = c.id
 WHERE s.deleted_at IS NULL AND s.session_date BETWEEN @ys AND @ye
 ORDER BY c.name COLLATE NOCASE;
```

**Step 2 —— 每个班级 block:**

花名册(去重:一名学员在同一班可能有「已离班」+「再入班」两行,只要存在活跃行就按未离班处理):

```sql
SELECT cs.student_id AS studentId, st.name AS studentName,
       MIN(CASE WHEN cs.left_at IS NULL THEN 0 ELSE 1 END) AS left
  FROM class_students cs JOIN students st ON st.id = cs.student_id
 WHERE cs.class_id = @cid
 GROUP BY cs.student_id;
```

该班每人每月计数(一条分组查询,JS 侧摊进 12 个桶):

```sql
SELECT a.student_id AS studentId,
       CAST(substr(a.attend_date,6,2) AS INTEGER) AS mon,   -- 1..12
       SUM(a.type IN ('出勤','补课'))          AS present,
       SUM(a.type = '缺勤')                    AS absent,
       SUM(a.type IN ('出勤','缺勤','请假'))    AS scheduled
  FROM attendance_records a
  JOIN class_sessions s ON s.id = a.session_id
   AND s.class_id = @cid AND s.deleted_at IS NULL
 WHERE a.deleted_at IS NULL AND a.attend_date BETWEEN @ys AND @ye
 GROUP BY a.student_id, mon;
```

repo 把上面结果 LEFT JOIN 到花名册(在 JS 里):花名册里但当年无记录的学员 → 全 0 行。
`monthly[m-1]=present`、`monthlyAbsent[m-1]=absent`、`monthlyScheduled[m-1]=scheduled`、
`yearTotal = Σ monthly`。行排序:`left ASC`,再 `studentName COLLATE NOCASE`(在 JS 里用
`localeCompare('zh')`)。

**Step 3 —— 全校汇总 block**(`classId=null`,`className='全校汇总'`):

学员集合 = 当年在读 ∪ 当年有考勤记录:

```sql
SELECT id, name FROM students WHERE deleted_at IS NULL AND status='在读'
UNION
SELECT s.id, s.name FROM students s
  JOIN attendance_records a ON a.student_id = s.id
 WHERE a.deleted_at IS NULL AND a.attend_date BETWEEN @ys AND @ye;
```

每人每月计数(**不**按 `session_id` 过滤,含 `session_id IS NULL`):

```sql
SELECT a.student_id AS studentId,
       CAST(substr(a.attend_date,6,2) AS INTEGER) AS mon,
       SUM(a.type IN ('出勤','补课')) AS present,
       SUM(a.type = '缺勤')          AS absent,
       SUM(a.type IN ('出勤','缺勤','请假')) AS scheduled
  FROM attendance_records a
 WHERE a.deleted_at IS NULL AND a.attend_date BETWEEN @ys AND @ye
 GROUP BY a.student_id, mon;
```

`left` 恒 `false`。行按 `name` 排序。

> **口径必然结果**:全校汇总某学员的 `yearTotal` ≥ 其在各班 sheet 的 `yearTotal` 之和
> (未关联课节的出勤只进全校汇总)。`reports-xlsx.test.ts` 会断言这一点。

### 5.2 Excel 组表逻辑(`reports-xlsx.ts`)

```
exportAttendanceByClass(year, filePath):
  m = reportsRepo.getClassAttendanceMatrix({ year })
  if m.schoolWide.rows.length === 0 AND m.classes.length === 0:
      throw AppError('REPORT_EMPTY', '所选年份没有可导出的数据')   // 双保险,register 已先探测
  wb = new ExcelJS.Workbook()
  usedSheetNames = Set()
  for block in [m.schoolWide, ...m.classes]:
      buildSheet(wb, block, year, usedSheetNames)
  await wb.xlsx.writeFile(filePath)
  return { sheetCount: 1 + m.classes.length, classCount: m.classes.length }

buildSheet(wb, block, year, used):
  name = sanitizeSheetName(block.className)          // 去 : \ / ? * [ ] ,trim,截断 31
  if used.has(name): name = truncate31(name + '#' + block.classId)
  used.add(name)
  ws = wb.addWorksheet(name)
  ws.columns = [{width:20}, ...Array(12).fill({width:6}), {width:10}]   // 不设 header,自己写
  // Row 1 标题（合并 A1:N1）
  ws.mergeCells(1,1,1,14); ws.getCell(1,1).value = `${block.className} · ${year}年 出勤统计`
  ws.getCell(1,1).font = { bold:true, size:13 }
  // Row 2 图例（合并 A2:N2）
  ws.mergeCells(2,1,2,14)
  ws.getCell(2,1).value = '图例：黄底=当月缺勤率≥50%　红底=全年未到课（出勤+补课=0）'
  ws.getCell(2,1).font = { italic:true, size:10 }
  // Row 3 表头
  ws.getRow(3).values = ['学员姓名', ...MONTH_LABELS /* '1月'..'12月' */, '全年合计']
  ws.getRow(3).font = { bold:true }
  // Row 4..N 数据
  r = 4
  for row in block.rows:
      nameText = row.studentName + (block.classId !== null && row.left ? '（已离班）' : '')
      cells = [nameText, ...row.monthly, row.yearTotal]
      ws.getRow(r).values = cells
      // 标黄:某月 scheduled>0 且 absent/scheduled >= 0.5
      for i in 0..11:
          if row.monthlyScheduled[i] > 0 && row.monthlyAbsent[i] / row.monthlyScheduled[i] >= 0.5:
              ws.getCell(r, 2 + i).fill = SOLID('FFFFF2CC')   // 浅黄
      // 标红:全年合计 0 → 姓名格
      if row.yearTotal === 0:
          ws.getCell(r, 1).fill = SOLID('FFF8CBAD')           // 浅红
      r++
  ws.views = [{ state:'frozen', xSplit:1, ySplit:3 }]         // 冻结姓名列 + 前三行

SOLID(argb) = { type:'pattern', pattern:'solid', fgColor:{ argb } }
```

`MONTH_LABELS = ['1月',…,'12月']`。`sanitizeSheetName` 还需把空名兜底为 `'未命名班级'`。

### 5.3 图表纯函数(`reports.charts.js`)

导出(全部返回 **SVG 字符串**,无副作用):

| 函数 | 签名(要点) |
|------|-----------|
| `scaleLinear(d0,d1,r0,r1)` | 返回 `(v)=>number`;`d0===d1` 时恒返回 `r0` |
| `niceMax(v)` | 把最大值上取整到「好看」刻度(1/2/5×10ⁿ);`v<=0` → `1` |
| `barGeometry(values, w, h, pad)` | → `{x,y,width,height}[]`;纯几何,供单测 |
| `linePoints(values, w, h, pad)` | → `"x1,y1 x2,y2 …"` 字符串 |
| `barChartSVG({data,width,height,...})` | 用上面拼完整 `<svg …><rect …>…`;`fill="var(--cc-8)"` |
| `lineChartSVG({points,width,height,...})` | `<polyline points="…" stroke="var(--cc-8)" fill="none">` |
| `heatmapSVG({matrix,rowLabels,colLabels,...})` | `<rect>` 网格,`fill-opacity` 按值归一;底色 `var(--cc-8)`,0 值给极浅 |

- `viewBox="0 0 width height"` + `preserveAspectRatio="xMidYMid meet"`,外层容器控制真实宽度(响应式)。
- 不出现裸 hex;文字用 `fill="var(--fg)"` 一类既有 token(实现时对齐 `colors_and_type.css`)。
- 空数组 / 单点 / 全 0:必须产出合法 SVG(空网格或一条底线),不抛错。

### 5.4 渲染层(`reports.js`)

- 单视图(不需要 hash 子路由);顶部:标题 + 返回首页 + 时间范围控件 + 年份下拉(导出用) + 导出按钮。
- 时间范围控件:`本月 | 本年 | 自定义`。换算(本地时间):
  - 本月:`from = yyyy-mm-01`,`to = 今天`
  - 本年:`from = yyyy-01-01`,`to = 今天`
  - 自定义:两个 `<input type="date">`,`from<=to` 前端即时校验
- 变更 → `void load()`:`Promise.all` 6 个接口 → 各自 `unwrap()` → 渲染 6 个区块。
  某个接口失败:该区块显示错误占位 + `#toast`,不影响其它区块。
- 区块顺序(FR / DESIGN):预警中心 → 概览 KPI → 考勤 → 课程 → 学员 → 库存。每块 `<details>` 可折叠,预警与概览默认展开。
- 「未关联课节」提示:`overview.unlinkedCheckInsThisYear > 0` 时,在导出按钮旁显示
  `本年 N 条出勤未关联课节，未纳入班级统计`。
- 导出:点击 → `shell.reports.exportAttendanceByClass(Number(yearSelect.value))` → `unwrap`
  → 成功 `#toast('已导出到 ' + data...)`(注:返回体不含路径,文案改为 `已导出 ${sheetCount} 张工作表`);
  `REPORT_EMPTY` → `#toast(error.message)`;`IO_CANCELLED` → 静默。
- 出勤排名表:表头「出勤次数 / 出勤率」两个可点排序键,纯前端对 `ranking` 数组排序;
  出勤率列 `rate===null` 显示 `—`,否则 `(rate*100).toFixed(0) + '%'`。
- 颜色预算(DESIGN):`--cc-8` 为模块身份色;`--accent` 全页 ≤ 2 次;预警红点 `--cc-1`。

### 5.5 Validation Rules

| 输入 | 规则 | 失败 |
|------|------|------|
| `range.from` / `range.to` | 匹配 `^\d{4}-\d{2}-\d{2}$` 且 `from <= to` | `BAD_REQUEST` |
| `year` | 整数,`2000 ≤ year ≤ 2100` | `BAD_REQUEST` |
| (渲染层)自定义范围 | `from <= to`,否则禁用「应用」按钮 | 前端拦截,不发 IPC |

### 5.6 Edge Cases

| 场景 | 处理 |
|------|------|
| 空库 / 范围内无任何数据 | 各接口返回空数组 / 0;渲染层每区显示「暂无数据」占位,不报错 |
| `ranking` 某学员 `scheduled=0`(全是补课/试听/调整) | `rate=null` → 表格显示 `—`;仍按 `attendCount` 参与「按次数」排名 |
| 学员多舞种 | `json_each` 每个值各计一次(一名学员计入多个 `danceType`) |
| `dance_types` 脏数据(非 JSON) | `WHERE json_valid(...)` 跳过该行,不 `DB_ERROR` |
| 课节 `end_time < start_time`(历史脏数据) | `minutes` 可能为负;不特殊处理,`teacherLoad` 汇总时如实反映(校验层本应已拦) |
| `class_students` 同学员「离班+再入班」两行 | 花名册 `GROUP BY student_id` + `MIN(left flag)` → 视为在册 |
| 某班当年有课节但花名册为空 | 该班 sheet 仅标题/图例/表头,无数据行(仍生成) |
| sheet 名含非法字符 / 超 31 字 / 重名 | `sanitizeSheetName` 清洗+截断;重名追加 `#<classId>` 再截断 |
| 全年合计为 0 且当月有排课 | 姓名格标红 + 相应月份格标黄(两者不互斥) |
| 无合格班级但有全校数据 | 仍导出,只含「全校汇总」sheet;`classCount=0`(SPEC 决策,见 §11.1) |
| 范围跨多年(自定义) | `monthlyCheckIns` / `monthlyNew` / `monthlyAllocations` 的 `month` 为 `'YYYY-MM'`,按实际月数展开 |
| `strftime('%w', attend_date)` 遇非法日期串 | 已被 `attend_date BETWEEN` 过滤;极端脏数据产出的桶归入渲染层「其它」,不崩 |

---

## 6. Error Handling

### 6.1 Error Taxonomy

| Error Code | 条件 | 用户消息(渲染层) |
|------------|------|------------------|
| `BAD_REQUEST` | 日期 / 年份非法 | 「参数有误,请重试」 |
| `REPORT_EMPTY` | `canExportAttendance` 为假 | 「所选年份没有排课班级,也没有学员考勤记录,无法导出」 |
| `IO_CANCELLED` | 保存框取消 | (静默) |
| `IO_WRITE_FAILED` | exceljs 写盘异常 | 「导出失败:<原因>」 |
| `DB_ERROR` | 未归类异常(`toIpcError` 兜底) | 「数据读取失败,请重试」 |

`IpcErrorCode` 联合类型在 `src/shared/types.ts` 追加 `| 'REPORT_EMPTY'`(注释:「报表无可导出数据」)。

### 6.2 Retry Strategy

只读 + 幂等,无自动重试。渲染层每次时间范围变更即整页重拉;导出失败由用户再次点击。

### 6.3 Failure Modes

- 单个 `reports:*` 接口失败 → 只该区块降级为错误占位,其余五区正常(渲染层 `Promise.allSettled` 或逐个 `catch`)。
- `getDb()` 抛错(库文件损坏)→ `toIpcError` 归 `DB_ERROR`,全页错误态。
- exceljs 写盘失败(磁盘满 / 无权限)→ `IO_WRITE_FAILED`,已选路径可能留下半截文件(与现有三个导出模块行为一致,不做清理)。

---

## 7. Security

### 7.1 Authentication & Authorization

沿用平台现状:桌面单机应用,无账号 / 角色体系。报表为只读,不引入新的权限面。

### 7.2 Input Validation

- 所有 SQL 走 better-sqlite3 预编译语句 + 命名参数;**不**把 `from` / `to` / `year` 拼进 SQL 字符串。
- sheet 名清洗防止 exceljs 抛错 / 生成非法 xlsx。
- 无文件导入路径(本模块只导出),不涉及 `MAX_IMPORT_BYTES` 一类防护。

### 7.3 Data Protection

- 导出的 Excel 含学员姓名 + 出勤数据,落到用户本机选定路径;与现有「学员档案 / 考勤 / 库存」导出同级别,无额外脱敏要求。
- 不新增日志;`toIpcError` 对未归类异常仍 `console.error` 原始栈(现状)。

---

## 8. Performance

### 8.1 Expected Load

单机、单用户、手动触发。数据量级:学员 10²–10³、考勤记录 10³–10⁴/年、课节 10³/年、领用 10²–10³/年。

### 8.2 Optimization Strategy

- 每次时间范围切换 = 6 次 IPC,渲染层 `Promise.all` 并发;单次目标 < 300ms(§ Success Metrics 的「3 秒内」有充裕余量)。
- 所有「明细清单」类结果 `LIMIT 200`;排行 `LIMIT 10`。趋势 / 分布用 `GROUP BY` 聚合,不回传明细行。
- `getClassAttendanceMatrix` 每个 block 用「一条分组查询 + JS 摊桶」,避免「每学员一次查询」的 N+1。

### 8.3 Database Considerations

- **不新增索引**(= DDL = 迁移,违反只读约束)。依赖既有索引:
  `idx_att_date(attend_date)`、`idx_att_student`、`idx_sess_date(session_date)`、
  `idx_alloc_date(claimed_at)`、`idx_students_status`、`idx_items_deleted` 等已覆盖主要过滤列。
- 无既有索引的分组(`attendance_records.teacher` / `class_name`、`students.referrer`、`json_each`)走全表扫描——在上述量级下单次 < 数十毫秒,可接受。
- 若未来数据量上一个数量级,再单独起「报表索引」迁移分支(超出本 SPEC)。

---

## 9. Testing Strategy

### 9.1 Unit Tests

**`tests/unit/reports-repo.test.ts`** —— `node:test`,`STUDIO_DB_PATH` 指临时文件,先跑
`migrations.run()`,插夹具,断言每个函数口径:

- `getOverview`:六字段 + `unlinkedCheckInsThisYear`;边界:软删记录不计、范围外不计、`remaining_lessons` 恰为 3 计入、`enroll_date` 恰为 cutoff30 计入。
- `getAlerts`:四组;`dormant` 第 60 天边界(cutoff60 当天有出勤 → 不沉睡);`emptySessions` 有停课 / 未来课节不计。
- `getAttendanceStats`:`monthlyCheckIns` 月份补齐(跨月缺口补 0);`ranking` 的 `attendCount` vs `attendOnly` vs `rate`(`scheduled=0` → `null`);`hourHeatmap` 的 `bucket=-1`(空 `attend_time`)。
- `getCourseStats`:`teacherLoad.minutes` 换算(跨整点如 `09:30`→`11:00` = 90);`cancelRate` 分母 0 → `null`;`classFillRate` `capacity` 为 `NULL` → `rate=null`,`结课`班级不出现。
- `getStudentStats`:`danceTypeDist` 一名多舞种学员计多次;`json_valid` 跳过脏行;`levelDist` 空值归「未分级」;`monthlyNew` 补齐。
- `getInventoryStats`:`staleItems` 90 天边界 + 从未领用(`lastClaimedAt=null` 排最前);`monthlyAllocations` 补齐;`totals` 空库 → `{0,0}`。
- `canExportAttendance`:三种「任一为真」组合 + 全假。

**`tests/unit/reports-charts.test.ts`** —— 导入编译后的 `reports.charts.js`(`tsconfig.test.json`
开 `allowJs` + include 该文件):

- `scaleLinear`:常规映射;`d0===d1` 恒返回 `r0`。
- `niceMax`:`7→10`、`23→25`、`0→1`、`-5→1`。
- `barGeometry` / `linePoints`:已知输入 → 精确坐标串;空数组 → `[]` / `""`,不抛。
- `barChartSVG` / `lineChartSVG` / `heatmapSVG`:返回以 `<svg` 开头、含 `viewBox` 的字符串;传空数据不抛。

**`tests/unit/reports-xlsx.test.ts`** —— 生成到临时文件,`exceljs` 读回:

- `worksheets[0].name === '全校汇总'`;`worksheets.length === 1 + classCount`。
- 某已知 `(学员, 月份)` 单元格数值正确。
- 一个预期「当月缺勤率≥50%」的月份格 `fill.fgColor.argb === 'FFFFF2CC'`。
- 一个「全年合计 0」学员的姓名格 `fill.fgColor.argb === 'FFF8CBAD'`。
- 已离班学员姓名以 `（已离班）` 结尾;全校汇总 sheet 里同名不带后缀。
- 跨班学员:全校汇总 `yearTotal` ≥ 其各班 sheet `yearTotal` 之和。
- sheet 名清洗:班级名含 `/` → 生成名无 `/`;构造两个清洗后同名班级 → 第二个带 `#<id>`。

### 9.2 Integration Tests

无独立服务层;`reports.repo.ts` 直接打真实 SQLite,§9.1 的 repo 测试即集成级(真库 + 真迁移)。
`register.ts` 的 `checkedRange` / `year` 校验分支由 §9.1 覆盖不到的部分放进 `reports-repo.test.ts` 的
「参数」describe(直接调 `checkedRange` 需 export;或在 e2e 覆盖)。

### 9.3 Edge Case Tests

对应 §5.6:空库、`rate=null`、多舞种、脏 `dance_types`、离班+再入班、空花名册班级、sheet 名冲突、无班级但有全校数据、跨年范围。

### 9.4 Acceptance Criteria Mapping

| US / FR | Test | Type | 说明 |
|---------|------|------|------|
| US-001 / FR-1,2 | `reports.spec.ts` | e2e | 首页卡片 → `reports.html` 加载无 `pageErrors`,返回可用 |
| US-002 / FR-12 | `reports-charts.test.ts` | unit | 几何函数 + SVG 字符串 + 空数据 |
| US-003 / FR-4,5 | `reports-repo.test.ts::getOverview` | unit | 六字段口径 + 边界 |
| US-003 | `reports.spec.ts` | e2e | 切「本年」概览数字变化 |
| US-004 / FR-6 | `reports-repo.test.ts::getAlerts` | unit | 四组 + 60/30 天边界 |
| US-005 / FR-7,8 | `reports-repo.test.ts::getAttendanceStats` | unit | ranking / 月度补齐 / heatmap |
| US-005 | `reports.spec.ts` | e2e | 排名表首行 + 切「按出勤率」顺序变化 |
| US-006 / FR-9 | `reports-repo.test.ts::getCourseStats` | unit | 时长换算 / 停课率 / 满员率 null |
| US-007 / FR-10 | `reports-repo.test.ts::getStudentStats` | unit | json_each / 补齐 / 空值归类 |
| US-008 / FR-11 | `reports-repo.test.ts::getInventoryStats` | unit | stale 90 天 / 补齐 / totals |
| US-009 / FR-13,14,15,16,17 | `reports-xlsx.test.ts` | unit | sheet 顺序 / 数值 / 黄红填充 / 后缀 / 清洗 / 汇总≥分班 |
| US-009 | `reports.spec.ts` | e2e | 点导出 → mock 保存路径 → 读回校验 |
| US-010 | `reports.spec.ts` | e2e | 完整链路 + 空库边界 + 无 `pageErrors` |
| FR-3,19 | `reports-repo.test.ts` | unit | 断言不存在 `INSERT/UPDATE/DELETE`(可加一个源码扫描断言);无迁移改动 |
| FR-18 | 复用现有 `handle()` | — | 所有 handler 经 `handle()` 包裹 |

**`tests/e2e/reports.spec.ts`**(Playwright `_electron`,临时 `STUDIO_DB_PATH`):

1. 启动 → 页面 `page.evaluate` 经 `window.studioShell` 直接调各模块 create 接口,播种:老师×2、班级×2、花名册、周期规则、`generateMonth`、考勤(含 `出勤/缺勤/请假/补课`、含一条 `session_id` 为空)、库存物件 + 领用。
2. 从 `index.html` 点「数据报表」卡片 → 断言 `reports.html`,概览某 KPI = 预期值。
3. 切「本年」→ 断言该 KPI 变化。
4. 断言出勤排名表首行学员 = 出勤最多者;点「按出勤率」表头 → 断言首行变化。
5. `app.evaluate(({dialog}, p) => { dialog.showSaveDialog = async () => ({canceled:false, filePath:p}); })`
   → 选年份 → 点导出 → 用 `exceljs`(在 Node 测试进程里)打开 `p`:首 sheet `全校汇总`、班级 sheet 数、一个已知单元格值、一个黄格、一个红姓名格。
6. 边界:另起一个空库上下文打开报表页 → 各区「暂无数据」,`pageErrors` 为空;点导出 → toast 命中 `REPORT_EMPTY` 文案(保存框未被调用)。

---

## 10. Implementation Plan

### 10.1 Phases

1. **骨架先行**(US-001):`reports.html` / `reports.js` 空壳 + 路由 + 首页接线 + `electron-builder.yml` + preload 空 `reports` 命名空间 + `studioShell.d.ts` 占位。让页面可打开。
2. **图表底座**(US-002):`reports.charts.js` + `tsconfig.test.json` 调整 + `reports-charts.test.ts`。后续区块直接消费。
3. **数据区块**(US-003…US-008):每个 issue 一个 `reports.repo.ts` 函数 + `channels.ts`/`register.ts`/`preload.ts`/`studioShell.d.ts` 四处接线 + 渲染 + `reports-repo.test.ts` 对应 describe。顺序:概览 → 预警 → 考勤 → 课程 → 学员 → 库存(与页面区块顺序一致,预警虽在页面第一屏,但依赖面最小,可紧随概览)。
4. **导出**(US-009):`REPORT_EMPTY` 入 `IpcErrorCode` + `getClassAttendanceMatrix` + `canExportAttendance` + `reports-xlsx.ts` + IPC 接线 + 渲染层按钮/年份选择 + `reports-xlsx.test.ts`。
5. **E2E 收口**(US-010):`reports.spec.ts`。

### 10.2 Issue Mapping

| Issue | SPEC Sections | 优先级 | Depends On |
|-------|--------------|--------|-----------|
| US-001 页面外壳 + 接线 | 2.4, 4.3(空), 5.4(骨架) | high | — |
| US-002 SVG 图表工具 | 5.3, 1.3(allowJs), 9.1 | high | US-001 |
| US-003 概览 KPI + 时间范围 | 3.3, 4.1, 4.2, 5.1.1, 5.4, 5.5 | high | US-001 |
| US-004 预警中心 | 3.3, 4.1, 5.1.2 | high | US-003 |
| US-005 考勤区 | 3.3, 4.1, 5.1.3, 5.3 | high | US-002, US-003 |
| US-006 课程区 | 3.3, 4.1, 5.1.4, 5.3 | medium | US-003 |
| US-007 学员区 | 3.3, 4.1, 5.1.5, 5.3 | medium | US-003 |
| US-008 库存区 | 3.3, 4.1, 5.1.6, 5.3 | medium | US-003 |
| US-009 Excel 导出 | 3.3, 5.1.7, 5.1.8, 5.2, 6.1 | high | US-003 |
| US-010 E2E | 9.4 | high | US-001…US-009 |

### 10.3 Incremental Delivery

单分支 `feat/reports`,一 issue 一 commit(中文 commit body 列各层改动),最后一个 PR
(`Closes #…`)。无 feature flag —— 卡片链接切换即上线;切换放在 US-001 的 commit 里,
在后续区块合入前,页面已可打开但内容逐步充实(可接受,分支未发版)。
每 commit 前:`npm run typecheck && npm run lint && npm run test:unit`;PR 前:`npm test`。

---

## 11. Open Questions & Risks

### 11.1 Unresolved Questions

- **PRD FR-16 vs 本 SPEC §5.6**:PRD 原文「无合格班级时不弹保存框」。本 SPEC 放宽为
  「无合格班级**但有全校汇总数据**时,仍导出(仅含全校汇总 sheet)」;仅当班级与全校数据
  **都为空**才 `REPORT_EMPTY`。若产品坚持原文,把 `canExportAttendance` 收紧为只看
  `hasClassSessions`。
- 出勤率、缺勤率的分母是否要计入 `补课`?当前:**不计**(分母 = 出勤+缺勤+请假),
  与 PRD 已确认口径一致,此处仅复述以防实现走样。
- 时段热力桶粒度固定 2 小时(bucket 0–11);是否需要 1 小时?当前按 2 小时实现。
- 沉睡 60 天 / 呆滞 90 天 / 空课 30 天窗口是否要做成页面可调?当前硬编码在 `reports.repo.ts` 顶部常量。

### 11.2 Technical Risks

| Risk | Impact | Mitigation |
|------|--------|-----------|
| `json_each` 遇非 JSON 的 `dance_types` 抛错 | `getStudentStats` 变 `DB_ERROR` | `WHERE json_valid(dance_types)` 兜底;单测覆盖脏行 |
| SQLite `date('now')` UTC 与库内本地日期错位 | 「近 N 天」多算 / 少算一天 | 所有 cutoff 在 repo 内用 JS 本地时间算,绑定参数传入,不在 SQL 里用 `date('now')` |
| `reports.charts.js` 不进 `tsc` 主构建,单测导入路径脆 | US-002 测试跑不起来 | `tsconfig.test.json` 显式 `allowJs` + include;文件保持纯 ESM、零 `document`/`src` 依赖 |
| `class_students` 离班+再入班产生重复行 | 花名册重复、计数翻倍 | `GROUP BY student_id` + `MIN(left flag)` |
| 中文班级名清洗后超 31 字或撞名 | exceljs `addWorksheet` 抛错 | `sanitizeSheetName` 截断 + `#<classId>` 去重 + 空名兜底 |
| 渲染层一次 6 个 IPC,其中一个慢/错拖累整页 | 白屏 | 逐个 `catch` / `allSettled`,区块级降级 |
| preload 与 channels 两处频道字面量漂移 | 频道对不上、静默失败 | 与现有 4 模块同款风险;US-001 一次性加齐 7 个,评审对照 |

### 11.3 Assumptions

- 研究规模下无索引的全表扫描(teacher / class_name / referrer / json_each 分组)延迟可接受,不加「报表索引」迁移。
- `attendance_records.attend_date` / `class_sessions.session_date` / `item_allocations.claimed_at` 均为规范 `'YYYY-MM-DD'`(由各模块校验层保证),字典序即时间序。
- `students.status` 的「在读」为精确字符串(无 CHECK,但四个模块一致使用)。
- 渲染层文件以 `<script type="module">` 加载(与 `inventory.html` / `attendance.html` 一致),`reports.js` 可 `import './reports.charts.js'`。
- e2e 里对 `dialog.showSaveDialog` 的 mock 方式与 `students-flow.spec.ts` / `inventory-flow.spec.ts` 现有写法一致。
- 「全校汇总」学员集合定义为「当年在读 ∪ 当年有考勤记录」;长期离校且当年无记录的学员不进表。
