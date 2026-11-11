/**
 * 渠道共享有界轮询（docs/fastlane-adoption.md §1，fastlane BuildWatcher 模式）。
 * attempt() 返回终态（done）或继续等；抛错 = 终态失败直抛；超时/次数耗尽抛 PollTimeoutError
 * （调用方 catch 后翻译成各渠道自己的超时文案——迁移渠道的既有错误消息契约不变）。
 * intervalMs ≤ 0 表示"间隔由 attempt 自理"（oppo/pgyer 的先 sleep 后查语义）。
 */
import { sleep } from "../../util.js";

export class PollTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PollTimeoutError";
  }
}

export interface PollOptions<T> {
  /** 单次探测：{ done, value } 终态成功；{ done: false } 继续等；抛错=终态失败 */
  attempt: () => Promise<{ done: true; value: T } | { done: false }>;
  /** 轮询间隔 ms；≤0 = 间隔由 attempt 自理 */
  intervalMs: number;
  /** 墙钟上限 ms（与 maxAttempts 至少其一） */
  timeoutMs?: number;
  /** 探测次数上限（含首次） */
  maxAttempts?: number;
  /** 超时/耗尽文案前缀 */
  label?: string;
  /** 每次等待前回调（进度上报） */
  onWait?: (info: { attempt: number; elapsedMs: number }) => void;
}

export async function pollUntil<T>(opts: PollOptions<T>): Promise<T> {
  const label = opts.label ?? "轮询";
  const start = Date.now();
  for (let n = 1; ; n += 1) {
    const r = await opts.attempt();
    if (r.done) return r.value;
    const elapsed = Date.now() - start;
    const attemptsExhausted = opts.maxAttempts !== undefined && n >= opts.maxAttempts;
    const timeExhausted =
      opts.timeoutMs !== undefined &&
      (opts.intervalMs > 0
        ? elapsed + opts.intervalMs > opts.timeoutMs
        : elapsed >= opts.timeoutMs);
    if (attemptsExhausted || timeExhausted) {
      const budget =
        opts.timeoutMs !== undefined
          ? `已等 ${Math.round(elapsed / 1000)}s / 上限 ${Math.round(opts.timeoutMs / 1000)}s`
          : `${n} 次探测未到终态`;
      throw new PollTimeoutError(`${label}${budget}`);
    }
    opts.onWait?.({ attempt: n, elapsedMs: elapsed });
    if (opts.intervalMs > 0) await sleep(opts.intervalMs);
  }
}
