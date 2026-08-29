/**
 * IPC 错误约定。
 *
 * 处理器内部若要中断，抛 AppError（带具名 code + 可选字段级提示）；
 * 其它意外异常统一归到 DB_ERROR。register.ts 的包裹器负责把异常转成
 * { ok:false, error } 信封，绝不让异常穿过 IPC 边界。
 */
import type { IpcError, IpcResult } from '../shared/types';
import { AppError } from '../shared/app-error';

export { AppError };

export function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

export function toIpcError(err: unknown): { ok: false; error: IpcError } {
  if (err instanceof AppError) {
    return {
      ok: false,
      error: { code: err.code, message: err.message, fields: err.fields },
    };
  }
  // 未归类异常：打原始栈便于排查，对外只给一个笼统 code
  console.error('[ipc] 未处理异常：', err);
  return {
    ok: false,
    error: {
      code: 'DB_ERROR',
      message: err instanceof Error ? err.message : String(err),
    },
  };
}
