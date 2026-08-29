/**
 * 库存管理的权威校验。
 *
 * 整体类比：仓库门口的「验收员」。渲染层填完表格递进来，验收员按每一栏该长什么样
 * 逐项检查，不合格的当场在那一栏画红叉（errors），合格的抄进干净的登记册（values）
 * 交给仓库层入库。渲染层自己也做一遍即时提示，但那只是体验；能不能入库以这里为准。
 */
import type { InventoryItemInput } from '../shared/types';

const MAX_NAME = 40;
const MAX_CATEGORY = 40;
const MAX_UNIT = 10;
const MAX_NOTE = 200;

/** 校验后的物件值：quantity 为 undefined 表示「编辑时不改这一项」。 */
export interface ItemValues {
  name: string;
  category: string | null;
  unit: string;
  quantity: number | undefined;
  lowStockThreshold: number;
  note: string | null;
}

/** 把「可能是数字 / 数字字符串 / 空」的原始值归一化为整数或 undefined。 */
function toIntOrUndefined(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  return Number.isFinite(n) ? n : NaN;
}

/**
 * 校验新建 / 编辑物件的入参。
 * @param opts.isEdit 编辑态：quantity 省略则 values.quantity 为 undefined（仓库层保持原值）
 */
export function validateItem(
  input: InventoryItemInput,
  opts: { isEdit?: boolean } = {},
): { values: ItemValues; errors: Record<string, string> } {
  const errors: Record<string, string> = {};

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (name.length === 0) errors['name'] = '请填写物件名';
  else if (name.length > MAX_NAME) errors['name'] = `物件名不超过 ${MAX_NAME} 字`;

  const categoryRaw = typeof input.category === 'string' ? input.category.trim() : '';
  if (categoryRaw.length > MAX_CATEGORY) errors['category'] = `分类不超过 ${MAX_CATEGORY} 字`;
  const category = categoryRaw.length > 0 ? categoryRaw : null;

  const unitRaw = typeof input.unit === 'string' ? input.unit.trim() : '';
  if (unitRaw.length > MAX_UNIT) errors['unit'] = `单位不超过 ${MAX_UNIT} 字`;
  const unit = unitRaw.length > 0 ? unitRaw : '件';

  // quantity：新建省略 → 0（仓库层兜底）；编辑省略 → undefined（保持原值）
  const q = toIntOrUndefined(input.quantity);
  let quantity: number | undefined;
  if (q === undefined) {
    quantity = opts.isEdit ? undefined : 0;
  } else if (!Number.isInteger(q) || q < 0) {
    errors['quantity'] = '库存数量必须是不小于 0 的整数';
    quantity = undefined;
  } else {
    quantity = q;
  }

  const t = toIntOrUndefined(input.lowStockThreshold);
  let lowStockThreshold = 0;
  if (t === undefined) {
    lowStockThreshold = 0;
  } else if (!Number.isInteger(t) || t < 0) {
    errors['lowStockThreshold'] = '预警阈值必须是不小于 0 的整数';
  } else {
    lowStockThreshold = t;
  }

  const noteRaw = typeof input.note === 'string' ? input.note.trim() : '';
  if (noteRaw.length > MAX_NOTE) errors['note'] = `备注不超过 ${MAX_NOTE} 字`;
  const note = noteRaw.length > 0 ? noteRaw : null;

  return {
    values: { name, category, unit, quantity, lowStockThreshold, note },
    errors,
  };
}
