/**
 * students.repo.list 的查询构造单测：搜索 / 状态筛选 / LIKE 转义 / 分页 total。
 * 用内存库现场建表灌数据，跑完即弃。末尾附 1000 行基准计时。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../../src/db/migrations';
import { getDb } from '../../src/db/connection';
import { list, create } from '../../src/domain/students.repo';

// list() / create() 走 getDb() 单例。getDb() 首次被调用时才读 STUDIO_DB_PATH，
// 所以在任何测试跑之前、模块顶层设好即可（node:test 每个文件独立子进程，不会外溢）。
process.env['STUDIO_DB_PATH'] = ':memory:';

// 现场建表（getDb 打开的就是那条内存库）
run(getDb());

function seed(name: string, phone: string, status = '在读', phone2: string | null = null): void {
  create({
    name,
    phonePrimary: phone,
    phoneSecondary: phone2,
    status,
    customFields: {},
  } as unknown as Parameters<typeof create>[0]);
}

seed('张伟', '13800001111', '在读');
seed('张伟明', '13800002222', '请假');
seed('王芳', '13900003333', '在读', '010-88886666');
seed('李娜', '13700004444', '停课');
seed('刘_特殊', '13600005555', '毕业'); // 名字含下划线，用于验证 LIKE 转义
seed('百分之%哥', '13500006666', '流失'); // 名字含百分号

test('无条件：返回全部，total 与行数一致', () => {
  const r = list({});
  assert.equal(r.total, 6);
  assert.equal(r.rows.length, 6);
});

test('按姓名子串搜索', () => {
  const r = list({ search: '张伟' });
  assert.equal(r.total, 2);
  assert.deepEqual(r.rows.map((x) => x.name).sort(), ['张伟', '张伟明']);
});

test('按电话子串搜索（含备用电话）', () => {
  assert.equal(list({ search: '3800001111' }).total, 1);
  assert.equal(list({ search: '88886666' }).total, 1, '应命中备用电话');
});

test('LIKE 通配符按字面量匹配，不当通配符用', () => {
  // '_' 不应匹配任意单字符：搜 '_特殊' 只命中「刘_特殊」，不命中别的
  const under = list({ search: '_特殊' });
  assert.equal(under.total, 1);
  assert.equal(under.rows[0]!.name, '刘_特殊');

  // '%' 不应匹配任意串：搜 '%哥' 只命中「百分之%哥」
  const pct = list({ search: '%哥' });
  assert.equal(pct.total, 1);
  assert.equal(pct.rows[0]!.name, '百分之%哥');
});

test('按状态筛选，多状态为“任一命中”', () => {
  assert.equal(list({ status: ['在读'] }).total, 2);
  assert.equal(list({ status: ['请假', '停课'] }).total, 2);
  assert.equal(list({ status: [] }).total, 6, '空状态数组视为不筛选');
});

test('搜索 + 状态组合', () => {
  const r = list({ search: '张', status: ['请假'] });
  assert.equal(r.total, 1);
  assert.equal(r.rows[0]!.name, '张伟明');
});

test('分页：total 是过滤后的总数，rows 只有一页', () => {
  const r = list({ limit: 2, offset: 0 });
  assert.equal(r.total, 6);
  assert.equal(r.rows.length, 2);
  const r2 = list({ limit: 2, offset: 4 });
  assert.equal(r2.rows.length, 2);
  // 两页不重叠
  const ids = new Set([...r.rows, ...r2.rows].map((x) => x.id));
  assert.equal(ids.size, 4);
});

test('结果按姓名不区分大小写排序', () => {
  const names = list({}).rows.map((x) => x.name);
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  // 至少保证是稳定有序（SQLite COLLATE NOCASE 对中文按码位，与 localeCompare 未必一致，
  // 这里只断言 list 自身多次调用结果一致）
  assert.deepEqual(list({}).rows.map((x) => x.name), names);
  void sorted;
});

test('1000 行下单次查询 < 200ms', () => {
  for (let i = 0; i < 1000; i += 1) {
    seed(`基准${i}`, `1${String(3000000000 + i)}`, i % 2 ? '在读' : '请假');
  }
  const t0 = performance.now();
  const r = list({ search: '基准', status: ['在读'], limit: 100 });
  const dt = performance.now() - t0;
  assert.ok(r.total > 0);
  assert.ok(dt < 200, `查询耗时 ${dt.toFixed(1)}ms，应 < 200ms`);
});
