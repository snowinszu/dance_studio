/**
 * validateStudent / buildSchema 单测。
 *
 * 这些函数是纯逻辑（只读 preset-fields 常量，不碰数据库），
 * 但仍在 Electron 的 Node 运行时下跑，与其它单测一致。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSchema, validateStudent } from '../../src/domain/validation';
import type { FieldDescriptor, StudentInput } from '../../src/shared/types';

const baseSchema = buildSchema();

/** 只填必填项的合法输入。 */
function minimalInput(over: Partial<StudentInput> = {}): StudentInput {
  return { name: '张三', phonePrimary: '13800138000', ...over };
}

test('合法的最小输入：无错误，状态缺省为「在读」', () => {
  const { values, errors } = validateStudent(minimalInput(), baseSchema);
  assert.deepEqual(errors, {});
  assert.equal(values['name'], '张三');
  assert.equal(values['phonePrimary'], '13800138000');
  assert.equal(values['status'], '在读');
});

test('缺姓名 / 缺主电话 → 各自报必填', () => {
  const r1 = validateStudent({ name: '', phonePrimary: '13800138000' }, baseSchema);
  assert.equal(r1.errors['name'], '此项为必填');

  const r2 = validateStudent({ name: '李四', phonePrimary: '' }, baseSchema);
  assert.equal(r2.errors['phone_primary'], '此项为必填');
});

test('手机号格式：非法报错、合法通过', () => {
  assert.ok(validateStudent(minimalInput({ phonePrimary: '123' }), baseSchema).errors['phone_primary']);
  assert.ok(validateStudent(minimalInput({ phonePrimary: '02912345678' }), baseSchema).errors['phone_primary']);
  assert.equal(
    validateStudent(minimalInput({ phonePrimary: '13912345678' }), baseSchema).errors['phone_primary'],
    undefined,
  );
});

test('日期：历法非法 / 格式错 报错，合法通过', () => {
  assert.equal(
    validateStudent(minimalInput({ birthDate: '2026-02-30' }), baseSchema).errors['birth_date'],
    '不是有效日期',
  );
  assert.equal(
    validateStudent(minimalInput({ birthDate: '2015/05/20' }), baseSchema).errors['birth_date'],
    '日期格式应为 YYYY-MM-DD',
  );
  const okr = validateStudent(minimalInput({ birthDate: '2015-05-20' }), baseSchema);
  assert.equal(okr.errors['birth_date'], undefined);
  assert.equal(okr.values['birthDate'], '2015-05-20');
});

test('数字：非数字报错，合法归一化为 number', () => {
  assert.ok(
    validateStudent(minimalInput({ remainingLessons: 'abc' as unknown as number }), baseSchema).errors[
      'remaining_lessons'
    ],
  );
  const okr = validateStudent(minimalInput({ remainingLessons: '12' as unknown as number }), baseSchema);
  assert.equal(okr.errors['remaining_lessons'], undefined);
  assert.equal(okr.values['remainingLessons'], 12);
});

test('单选 / 多选：取值必须在候选项内', () => {
  assert.ok(validateStudent(minimalInput({ gender: '火星人' }), baseSchema).errors['gender']);
  assert.equal(validateStudent(minimalInput({ gender: '男' }), baseSchema).errors['gender'], undefined);

  assert.ok(validateStudent(minimalInput({ danceTypes: ['太空步'] }), baseSchema).errors['dance_types']);
  const okr = validateStudent(minimalInput({ danceTypes: ['中国舞', '街舞'] }), baseSchema);
  assert.equal(okr.errors['dance_types'], undefined);
  assert.deepEqual(okr.values['danceTypes'], ['中国舞', '街舞']);
});

test('文本长度上限：text ≤ 200，textarea ≤ 2000', () => {
  const longText = 'x'.repeat(201);
  assert.ok(validateStudent(minimalInput({ wechat: longText }), baseSchema).errors['wechat']);

  const longArea = 'y'.repeat(2001);
  assert.ok(validateStudent(minimalInput({ healthAllergy: longArea }), baseSchema).errors['health_allergy']);
});

test('status 省略 → 落为「在读」；显式合法值原样保留', () => {
  assert.equal(validateStudent(minimalInput(), baseSchema).values['status'], '在读');
  assert.equal(validateStudent(minimalInput({ status: '请假' }), baseSchema).values['status'], '请假');
  assert.ok(validateStudent(minimalInput({ status: '离校' }), baseSchema).errors['status']);
});

/* —— 借合成的自定义字段描述，覆盖 money / boolean / 历史值放宽 —— */

function withCustom(...custom: FieldDescriptor[]) {
  return buildSchema(custom);
}
const money: FieldDescriptor = {
  key: 'tuition', label: '学费', type: 'money', group: 'ops',
  options: [], required: false, sensitive: false, origin: 'custom', archived: false,
};
const flag: FieldDescriptor = {
  key: 'vip', label: '是否 VIP', type: 'boolean', group: 'ops',
  options: [], required: false, sensitive: false, origin: 'custom', archived: false,
};
const pickOne: FieldDescriptor = {
  key: 'campus', label: '校区', type: 'select', group: 'ops',
  options: ['东城', '西城'], required: false, sensitive: false, origin: 'custom', archived: false,
};

test('money：负数 / 超两位小数报错，合法通过', () => {
  const s = withCustom(money);
  assert.equal(
    validateStudent(minimalInput({ customFields: { tuition: -5 } }), s).errors['tuition'],
    '金额不能为负',
  );
  assert.equal(
    validateStudent(minimalInput({ customFields: { tuition: 10.999 } }), s).errors['tuition'],
    '金额最多两位小数',
  );
  const okr = validateStudent(minimalInput({ customFields: { tuition: 10.5 } }), s);
  assert.equal(okr.errors['tuition'], undefined);
  assert.equal(okr.values.customFields['tuition'], 10.5);
});

test('boolean：非布尔报错；是/否等价值被归一化', () => {
  const s = withCustom(flag);
  assert.ok(validateStudent(minimalInput({ customFields: { vip: 'maybe' } }), s).errors['vip']);
  assert.equal(validateStudent(minimalInput({ customFields: { vip: '是' } }), s).values.customFields['vip'], true);
  assert.equal(validateStudent(minimalInput({ customFields: { vip: false } }), s).values.customFields['vip'], false);
});

test('select 历史值：不在候选项内，但作为历史值传入时放行', () => {
  const s = withCustom(pickOne);
  const input = minimalInput({ customFields: { campus: '南城' } });
  assert.ok(validateStudent(input, s).errors['campus'], '无历史值时应报错');
  const okr = validateStudent(input, s, { campus: ['南城'] });
  assert.equal(okr.errors['campus'], undefined, '作为历史值时应放行');
  assert.equal(okr.values.customFields['campus'], '南城');
});
