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

/** v3：课程与会员组新增「班级」字段。 */
const v3 = (db: Database): void => {
  db.exec(`ALTER TABLE students ADD COLUMN class_name TEXT;`);
};

/** 全部迁移，按 version 升序。新增结构变更时往末尾追加。 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, up: v1 },
  { version: 2, up: v2 },
  { version: 3, up: v3 },
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
