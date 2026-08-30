/**
 * 数据库结构迁移。
 *
 * 整体类比：房子装修图纸的「版本号」。每次要改户型（加表、加列），
 * 就往 MIGRATIONS 数组末尾追加一版，写清「这一版要动的墙」。
 * 应用每次启动时，run() 看当前房子装到第几版，把后面几版按顺序补上，
 * 全程在一个事务里——要么整版改完，要么一点不改，绝不留半拆的墙。
 *
 * 版本号存在 SQLite 自带的 `PRAGMA user_version`（一个整数），不需要额外的表。
 */
import type { Database } from 'better-sqlite3';

export interface Migration {
  /** 从 1 开始递增，且与数组顺序一致 */
  version: number;
  /** 该版要执行的结构变更；只做 DDL，不塞业务数据 */
  up: (db: Database) => void;
}

/**
 * v1：学员档案模块的初始表结构。
 * 预设字段落在 students 的真实列上；自定义字段的值塞进 students.custom_fields(JSON)，
 * 其「字段说明」存在 field_definitions 表。标签用 tags + student_tags 多对多。
 */
const v1 = (db: Database): void => {
  db.exec(`
    CREATE TABLE students (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      -- 基本信息
      name                    TEXT NOT NULL,
      nickname                TEXT,
      gender                  TEXT,
      birth_date              TEXT,               -- 'YYYY-MM-DD'，年龄前端算、不落库
      id_card_type            TEXT,
      id_card_no              TEXT,
      -- 联系方式
      guardian_name           TEXT,
      guardian_relation       TEXT,
      phone_primary           TEXT NOT NULL,
      phone_secondary         TEXT,
      wechat                  TEXT,
      address                 TEXT,
      emergency_contact_name  TEXT,
      emergency_contact_phone TEXT,
      -- 课程与会员
      dance_types             TEXT NOT NULL DEFAULT '[]',   -- JSON 数组字符串
      current_level           TEXT,
      enroll_date             TEXT,
      main_teacher            TEXT,
      class_schedule          TEXT,
      card_type               TEXT,
      remaining_lessons       INTEGER,
      card_expire_date        TEXT,
      status                  TEXT NOT NULL DEFAULT '在读',
      -- 健康与安全
      health_allergy          TEXT,
      health_history          TEXT,
      health_notes            TEXT,
      -- 运营
      source_channel          TEXT,
      referrer                TEXT,
      remark                  TEXT,
      -- 自定义字段：{ "<field_key>": <value> }
      custom_fields           TEXT NOT NULL DEFAULT '{}',
      -- 元数据
      created_at              TEXT NOT NULL,
      updated_at              TEXT NOT NULL,
      deleted_at              TEXT               -- 非空即已软删除
    );

    CREATE INDEX idx_students_name    ON students(name);
    CREATE INDEX idx_students_phone   ON students(phone_primary);
    CREATE INDEX idx_students_status  ON students(status);
    CREATE INDEX idx_students_deleted ON students(deleted_at);

    -- 「活页的标签说明」：只描述管理者自定义的字段，不含预设字段
    CREATE TABLE field_definitions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      field_key     TEXT NOT NULL UNIQUE,         -- 英文 slug，存储 / 读取用
      label         TEXT NOT NULL,
      type          TEXT NOT NULL,                -- text|textarea|number|date|select|multiselect|boolean|phone|money
      options       TEXT NOT NULL DEFAULT '[]',   -- JSON 数组，仅 select/multiselect 用
      required      INTEGER NOT NULL DEFAULT 0,
      group_key     TEXT NOT NULL,                -- basic|contact|course|health|ops
      sort_order    INTEGER NOT NULL DEFAULT 0,
      sensitive     INTEGER NOT NULL DEFAULT 0,   -- 保留，本版不强制脱敏
      archived      INTEGER NOT NULL DEFAULT 0,   -- 软删除：字段消失，数据保留
      default_value TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE tags (
      id    INTEGER PRIMARY KEY AUTOINCREMENT,
      name  TEXT NOT NULL UNIQUE,
      color TEXT                                  -- 令牌名，如 'cc-3'
    );

    -- 学员 ↔ 标签 多对多；删任一侧自动清关联（需连接级 PRAGMA foreign_keys=ON）
    CREATE TABLE student_tags (
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      tag_id     INTEGER NOT NULL REFERENCES tags(id)     ON DELETE CASCADE,
      PRIMARY KEY (student_id, tag_id)
    );
  `);
};

/**
 * v2：移除「证件类型 / 证件号」两列（产品决定不采集）。
 * SQLite 3.35+ 支持 DROP COLUMN；better-sqlite3 内置的 SQLite 版本满足。
 */
const v2 = (db: Database): void => {
  db.exec(`
    ALTER TABLE students DROP COLUMN id_card_type;
    ALTER TABLE students DROP COLUMN id_card_no;
  `);
};

/**
 * v4：库存管理模块的初始表结构。
 *
 * 版本号说明：本迁移原为 v3，但并行开发的「学员班级字段」分支（feat/class-name-field）
 * 也占用了 v3（ALTER TABLE students ADD COLUMN class_name）。两个 v3 语义不同，谁先
 * 在某台机器上跑过，user_version 就先到 3，另一个便被 run() 静默跳过。为消除冲突，
 * 库存迁移改用 v4——对已在 v3 的库（跑过班级分支）会补建下面这两张表；对停在 v2 的库
 * 会直接从 v2 跳到 v4（run() 只看 version > current，允许版本号有空档）。
 * DDL 一律 IF NOT EXISTS：即使因历史原因重复触发也不炸。
 *
 * 合并顺序建议：feat/class-name-field（v3）应先并入 main，再并本分支（v4）。
 *
 * 两本「账」：
 * - inventory_items：物件台账。quantity 是「当前在库数」的权威值，
 *   列表 / 详情 / 分配下拉 / 低库存预警都直接读它，不靠汇总流水实时算。
 * - item_allocations：领用流水，一行 = 某学员某天领走某物件几件。
 *
 * 两张表都不写 ON DELETE CASCADE：物件用软删除（deleted_at），学员本就是软删除，
 * 删了也要能在流水 / 导出里查到历史。连接级 PRAGMA foreign_keys=ON（见 connection.ts）
 * 下，这里的外键只保证「插入时 item_id / student_id 必须存在」。
 */
const v4 = (db: Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_items (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      name                 TEXT    NOT NULL,
      category             TEXT,
      unit                 TEXT    NOT NULL DEFAULT '件',
      -- 当前在库数。不设 CHECK(quantity >= 0)：不为负由 allocate 的守卫 UPDATE 保证，
      -- 加 CHECK 会让「删除领用记录回补库存」等场景更脆。
      quantity             INTEGER NOT NULL DEFAULT 0,
      -- 低于等于此值时，列表标「库存偏低」；0 表示「没货了才算偏低」
      low_stock_threshold  INTEGER NOT NULL DEFAULT 0,
      note                 TEXT,
      created_at           TEXT    NOT NULL,
      updated_at           TEXT    NOT NULL,
      deleted_at           TEXT               -- 非空即已软删除
    );

    CREATE INDEX IF NOT EXISTS idx_items_name     ON inventory_items(name);
    CREATE INDEX IF NOT EXISTS idx_items_category ON inventory_items(category);
    CREATE INDEX IF NOT EXISTS idx_items_deleted  ON inventory_items(deleted_at);

    CREATE TABLE IF NOT EXISTS item_allocations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id     INTEGER NOT NULL REFERENCES inventory_items(id),
      student_id  INTEGER NOT NULL REFERENCES students(id),
      quantity    INTEGER NOT NULL DEFAULT 1,
      claimed_at  TEXT    NOT NULL,          -- 领取日期 'YYYY-MM-DD'，字典序即时间序
      note        TEXT,
      created_at  TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_alloc_item    ON item_allocations(item_id);
    CREATE INDEX IF NOT EXISTS idx_alloc_student ON item_allocations(student_id);
    CREATE INDEX IF NOT EXISTS idx_alloc_date    ON item_allocations(claimed_at);
  `);
};

/**
 * v5：考勤管理模块的初始表结构。
 *
 * 版本号说明：v3 被并行的「学员班级字段」分支占用、v4 是库存两张表，考勤认领下一个空号 v5。
 * 对停在 v2（只跑过学员）或 v4（跑过库存）的库，run() 只看 version > current，会把缺的版本
 * 按序补齐——允许版本号有空档。DDL 一律 IF NOT EXISTS：历史原因重复触发也不炸。
 * 合并顺序建议：feat/class-name-field(v3) → feat/inventory-management(v4) → 本分支(v5)。
 *
 * 一张表 attendance_records = 考勤流水账。一行 = 一次考勤事件（出勤/请假/缺勤/补课/试听）
 * 或一次课时调整（type='调整'）。lessons_delta 是这一行对 students.remaining_lessons 的增量：
 * 消耗为负、增加为正、不影响为 0。students.remaining_lessons 仍是「剩余课时」的权威缓存
 * （列表 / 学员档案直接读它），不靠汇总流水实时算——与 inventory_items.quantity 同一套路。
 *
 * 不写 ON DELETE CASCADE：学员是软删除，删了也要能在流水 / 导出里查到历史。
 * 连接级 PRAGMA foreign_keys=ON（见 connection.ts）下，这里的外键只保证「插入时 student_id 必须存在」。
 * session_id 预留给将来的「课程安排」模块关联，本期恒为 NULL、不建外键（目标表尚不存在）。
 *
 * 不加 CHECK：
 * - lessons_delta 正负零都合法；不为负由 domain 层 createRecord 的余额守卫保证（force 时故意允许欠课记负）。
 * - type 的六个取值由 domain 校验层把关，和 students.status 无 CHECK 的现状一致。
 */
const v5 = (db: Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS attendance_records (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id    INTEGER NOT NULL REFERENCES students(id),
      session_id    INTEGER,                          -- 预留关联「课程安排」，本期恒 NULL、无外键
      class_name    TEXT,                             -- 自由文本课程名（快速打卡可空）
      teacher       TEXT,                             -- 自由文本授课老师
      attend_date   TEXT    NOT NULL,                 -- 'YYYY-MM-DD'，字典序即时间序
      attend_time   TEXT,                             -- 'HH:MM'，可空
      type          TEXT    NOT NULL,                 -- 出勤 | 请假 | 缺勤 | 补课 | 试听 | 调整
      lessons_delta INTEGER NOT NULL DEFAULT 0,       -- 对 students.remaining_lessons 的增量
      reason        TEXT,                             -- type='调整' 必填；其它可空
      operator      TEXT,                             -- 经办人自由文本（无账号体系）
      note          TEXT,
      created_at    TEXT    NOT NULL,
      updated_at    TEXT    NOT NULL,
      deleted_at    TEXT                              -- 非空即已撤销
    );

    CREATE INDEX IF NOT EXISTS idx_att_student ON attendance_records(student_id);
    CREATE INDEX IF NOT EXISTS idx_att_date    ON attendance_records(attend_date);
    CREATE INDEX IF NOT EXISTS idx_att_type    ON attendance_records(type);
    CREATE INDEX IF NOT EXISTS idx_att_deleted ON attendance_records(deleted_at);
  `);
};

/**
 * v6：课程管理模块的初始表结构（5 张表）。
 *
 * 版本号说明：v3 被并行的「学员班级字段」分支占用、v4 是库存、v5 是考勤，课程认领下一个空号 v6。
 * 对停在 v2 / v4 / v5 的库，run() 只看 version > current，会把缺的版本按序补齐——允许版本号有空档。
 * DDL 一律 IF NOT EXISTS：历史原因重复触发也不炸。
 * 合并顺序建议：feat/inventory-management(v4) → feat/attendance-management(v5) → 本分支(v6)。
 *
 * 「规则」与「实例」分开建模，是本模块的核心：
 * - class_schedules 是**周期规则**（每周几、几点、哪个班），不带具体日期，无限重复——「课程表」读它。
 * - class_sessions 是**排课实例**（某个真实日期的一节课），由 generateMonth 按规则幂等物化到当月，
 *   之后可逐日微调（停课 / 改时间 / 换代课老师）——「上课时间计划表」读它。
 *   改规则不追溯已生成的实例。
 *
 * 其余约定沿用前三个模块：
 * - 一律软删（deleted_at），不写 ON DELETE CASCADE：老师 / 学员 / 班级删了也要能在历史里查到。
 *   连接级 PRAGMA foreign_keys=ON（见 connection.ts）下，这里的外键只保证「插入时被引用行必须存在」。
 * - 日期存 'YYYY-MM-DD'、时间存 'HH:MM'，字典序即时间序。
 * - weekday 存整数 0–6（0=周日），对齐 JS Date.getDay()，渲染层零偏移换算。
 * - 不加 CHECK：weekday 范围、end_time > start_time、各枚举取值由 domain 校验层把关，
 *   和 students.status / attendance_records.type 无 CHECK 的现状一致。
 *
 * class_students 的部分唯一索引 (class_id, student_id) WHERE left_at IS NULL：
 *   同一学员在同一班「同时」只能有一条在册记录；离班后（left_at 非空）可再入班。
 * class_sessions 的部分唯一索引 (class_id, session_date, start_time) WHERE deleted_at IS NULL：
 *   同班同日同开始时间只允许一节未软删课。generateMonth 的幂等靠「先 SELECT 存在性再 INSERT」，
 *   不靠捕获这个索引冲突（better-sqlite3 同步 + 单连接，事务内无并发写者）。
 */
const v6 = (db: Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS teachers (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT '在职',      -- 在职 | 离职（校验层把关）
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      deleted_at  TEXT                                -- 非空即已软删
    );
    CREATE INDEX IF NOT EXISTS idx_teachers_status  ON teachers(status);
    CREATE INDEX IF NOT EXISTS idx_teachers_deleted ON teachers(deleted_at);

    CREATE TABLE IF NOT EXISTS classes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      dance_type  TEXT NOT NULL,
      level       TEXT,
      teacher_id  INTEGER REFERENCES teachers(id),   -- 主教；可空；无级联
      room        TEXT,
      capacity    INTEGER,                            -- 可空；正整数（校验层）
      start_date  TEXT,                               -- 'YYYY-MM-DD'，可空
      end_date    TEXT,
      status      TEXT NOT NULL DEFAULT '在读',        -- 在读 | 停课 | 结课
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
      joined_at   TEXT NOT NULL,                      -- 'YYYY-MM-DD'
      left_at     TEXT,                               -- 非空即已离班
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cs_class   ON class_students(class_id);
    CREATE INDEX IF NOT EXISTS idx_cs_student ON class_students(student_id);
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_class_student_active
      ON class_students(class_id, student_id) WHERE left_at IS NULL;

    CREATE TABLE IF NOT EXISTS class_schedules (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id       INTEGER NOT NULL REFERENCES classes(id),
      weekday        INTEGER NOT NULL,                -- 0=周日 … 6=周六（对齐 Date.getDay()）
      start_time     TEXT NOT NULL,                   -- 'HH:MM'
      end_time       TEXT NOT NULL,                   -- 'HH:MM'，> start_time（校验层）
      teacher_id     INTEGER REFERENCES teachers(id), -- 覆盖班主教；可空
      room           TEXT,                            -- 覆盖班教室；可空
      effective_from TEXT,                            -- 'YYYY-MM-DD'，可空；本期 UI 不暴露
      effective_to   TEXT,                            -- 可空；本期 UI 不暴露
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL,
      deleted_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sch_class   ON class_schedules(class_id);
    CREATE INDEX IF NOT EXISTS idx_sch_weekday ON class_schedules(weekday);
    CREATE INDEX IF NOT EXISTS idx_sch_deleted ON class_schedules(deleted_at);

    CREATE TABLE IF NOT EXISTS class_sessions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      class_id     INTEGER NOT NULL REFERENCES classes(id),
      schedule_id  INTEGER REFERENCES class_schedules(id),  -- 计划实例指向来源规则；手动加课为 NULL
      session_date TEXT NOT NULL,                            -- 'YYYY-MM-DD'
      start_time   TEXT NOT NULL,                            -- 'HH:MM'
      end_time     TEXT NOT NULL,
      teacher_id   INTEGER REFERENCES teachers(id),          -- 这一天谁上（生成时取生效老师，之后可改=代课）
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
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_sess_slot
      ON class_sessions(class_id, session_date, start_time) WHERE deleted_at IS NULL;
  `);
};

/**
 * 全部迁移，按 version 升序。新增结构变更时往末尾追加。
 * 版本号必须严格递增且唯一，但允许有空档（如这里 2 → 4 → 5 → 6，见各版注释）。
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, up: v1 },
  { version: 2, up: v2 },
  { version: 4, up: v4 },
  { version: 5, up: v5 },
  { version: 6, up: v6 },
];

/** 当前代码期望的最高版本号。 */
export const LATEST_VERSION = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);

/**
 * 把数据库结构升级到最新版。
 *
 * - 读 `user_version`，只执行 version 更大的迁移，按序执行
 * - 每一版单独包在一个事务里：某版 up 抛错 → 该版回滚、user_version 不前进，
 *   下次启动会重试同一版（forward-only，不提供 down）
 * - 已是最新时是空操作，可反复调用
 *
 * @param migrations 默认用内置 MIGRATIONS；单元测试可传入自定义列表来验证回滚等行为
 */
export function run(db: Database, migrations: readonly Migration[] = MIGRATIONS): void {
  // 版本号重复会让「后一个」被 user_version 静默跳过（正是库存 v3→v4 事故的成因）。
  // 这里在启动时就把重复版本号炸出来，逼开发期解决，而不是等用户点开某个模块才报错。
  const seen = new Set<number>();
  for (const m of migrations) {
    if (seen.has(m.version)) {
      throw new Error(`迁移版本号重复：v${m.version}（版本号必须唯一）`);
    }
    seen.add(m.version);
  }

  const current = db.pragma('user_version', { simple: true }) as number;

  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (migration.version <= current) continue;

    const apply = db.transaction(() => {
      migration.up(db);
      // pragma 不接受占位符参数，version 来自代码常量、非用户输入，直接拼接安全
      db.pragma(`user_version = ${migration.version}`);
    });
    apply();
  }
}
