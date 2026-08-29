/**
 * 预设字段真源（single source of truth）。
 *
 * 整体类比：这是档案本子「封面上印死的栏目」。所有档案都有、格式统一，
 * 管理者不能删、不能改类型。中间的「活页」（自定义字段）由 field_definitions 表管。
 *
 * 消费方：validation.buildSchema()、io/export-xlsx、io/import-xlsx（模板表头）、
 * 以及 fieldDefs:schema 这个 IPC 处理器。
 *
 * 硬约束：每个 PRESET_FIELDS[*].key 必须与 students 表的列名逐一对应，
 * 由单元测试 preset-schema.test.ts 守着。
 */
import type { GroupMeta, PresetFieldDef } from './types';

/** 5 个分组，顺序即渲染顺序（对应 PRD 附录 A）。 */
export const GROUPS: readonly GroupMeta[] = [
  { key: 'basic', label: '基本信息', order: 1 },
  { key: 'contact', label: '联系方式', order: 2 },
  { key: 'course', label: '课程与会员', order: 3 },
  { key: 'health', label: '健康与安全', order: 4 },
  { key: 'ops', label: '运营', order: 5 },
] as const;

/** 学员状态枚举：预设 select 字段 status 的候选项，缺省取第一个「在读」。 */
export const STUDENT_STATUSES = ['在读', '请假', '停课', '毕业', '流失'] as const;

export const DEFAULT_STUDENT_STATUS: string = STUDENT_STATUSES[0];

/**
 * 预设字段清单。order 在「组内」从 1 递增。
 * key 用下划线风格 == students 列名；渲染层收到的 FieldDescriptor.key 保持一致，
 * 由 repo 层负责下划线列 ↔ 驼峰属性的转换。
 */
export const PRESET_FIELDS: readonly PresetFieldDef[] = [
  // —— 基本信息 ——
  { key: 'name', label: '姓名', type: 'text', group: 'basic', order: 1, required: true },
  { key: 'nickname', label: '小名 / 昵称', type: 'text', group: 'basic', order: 2 },
  {
    key: 'gender',
    label: '性别',
    type: 'select',
    group: 'basic',
    order: 3,
    options: ['男', '女', '其他'],
  },
  { key: 'birth_date', label: '出生日期', type: 'date', group: 'basic', order: 4 },

  // —— 联系方式 ——
  { key: 'guardian_name', label: '家长 / 监护人姓名', type: 'text', group: 'contact', order: 1 },
  {
    key: 'guardian_relation',
    label: '与学员关系',
    type: 'select',
    group: 'contact',
    order: 2,
    options: ['父', '母', '祖辈', '其他监护人', '本人'],
  },
  {
    key: 'phone_primary',
    label: '主联系电话',
    type: 'phone',
    group: 'contact',
    order: 3,
    required: true,
  },
  { key: 'phone_secondary', label: '备用电话', type: 'phone', group: 'contact', order: 4 },
  { key: 'wechat', label: '微信号', type: 'text', group: 'contact', order: 5 },
  { key: 'address', label: '家庭住址', type: 'text', group: 'contact', order: 6 },
  {
    key: 'emergency_contact_name',
    label: '紧急联系人',
    type: 'text',
    group: 'contact',
    order: 7,
  },
  {
    key: 'emergency_contact_phone',
    label: '紧急联系电话',
    type: 'phone',
    group: 'contact',
    order: 8,
  },

  // —— 课程与会员 ——
  {
    key: 'dance_types',
    label: '报读舞种 / 班级',
    type: 'multiselect',
    group: 'course',
    order: 1,
    options: ['中国舞', '芭蕾', '拉丁', '街舞', '爵士', '民族舞', '其他'],
  },
  { key: 'current_level', label: '当前级别 / 考级进度', type: 'text', group: 'course', order: 2 },
  { key: 'enroll_date', label: '入学日期', type: 'date', group: 'course', order: 3 },
  { key: 'main_teacher', label: '主教老师', type: 'text', group: 'course', order: 4 },
  { key: 'class_schedule', label: '固定上课时段', type: 'text', group: 'course', order: 5 },
  { key: 'card_type', label: '卡种 / 课时包', type: 'text', group: 'course', order: 6 },
  { key: 'remaining_lessons', label: '剩余课时', type: 'number', group: 'course', order: 7 },
  { key: 'card_expire_date', label: '有效期至', type: 'date', group: 'course', order: 8 },
  {
    key: 'status',
    label: '学员状态',
    type: 'select',
    group: 'course',
    order: 9,
    options: STUDENT_STATUSES,
    required: true,
  },

  // —— 健康与安全 ——
  { key: 'health_allergy', label: '过敏史', type: 'textarea', group: 'health', order: 1 },
  {
    key: 'health_history',
    label: '既往病史 / 受伤史',
    type: 'textarea',
    group: 'health',
    order: 2,
  },
  { key: 'health_notes', label: '特殊注意事项', type: 'textarea', group: 'health', order: 3 },

  // —— 运营 ——
  {
    key: 'source_channel',
    label: '来源渠道',
    type: 'select',
    group: 'ops',
    order: 1,
    options: ['转介绍', '朋友圈', '地推', '大众点评', '抖音', '其他'],
  },
  { key: 'referrer', label: '转介绍人', type: 'text', group: 'ops', order: 2 },
  { key: 'remark', label: '备注', type: 'textarea', group: 'ops', order: 3 },
] as const;

/**
 * students 表里、由预设字段直接映射的列名清单（下划线风格）。
 * 不含 id / custom_fields / created_at / updated_at / deleted_at 这些元数据列。
 * preset-schema.test.ts 会拿它和迁移建出来的实际列做对比。
 */
export const PRESET_COLUMN_NAMES: readonly string[] = PRESET_FIELDS.map((f) => f.key);
