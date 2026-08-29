/**
 * 跨层通用的具名错误。
 *
 * domain 层要中断时抛它（带具名 code + 可选字段级提示），
 * ipc 层的包裹器负责把它翻译成 { ok:false, error } 信封。
 * 放在 shared/ 是为了 domain 不必反向依赖 ipc。
 */
import type { IpcErrorCode } from './types';

export class AppError extends Error {
  readonly code: IpcErrorCode;
  readonly fields?: Record<string, string>;

  constructor(code: IpcErrorCode, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.fields = fields;
  }
}
