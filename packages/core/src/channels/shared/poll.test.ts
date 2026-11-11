/** pollUntil 契约：终态/间隔/超时/次数上限/异常直抛（docs/fastlane-adoption §1） */
import { afterEach, describe, expect, it, vi } from "vitest";
import { pollUntil, PollTimeoutError } from "./poll.js";

// sleep 打桩记录间隔并等待（fake 的）setTimeout：时钟由 fake timers 推进（Date 一并被 fake）
const sleeps: number[] = [];
vi.mock("../../util.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../util.js")>()),
  sleep: vi.fn(async (ms: number) => {
    sleeps.push(ms);
    // fake timers 下由 advanceTimersByTimeAsync 驱动（非真实等待）；tsconfig lib<es2024 无 withResolvers
    await new Promise<void>((res) => setTimeout(res, ms));
  }),
}));

afterEach(() => {
  vi.useRealTimers();
  sleeps.length = 0;
});

describe("pollUntil", () => {
  it("首轮终态：直接返回值，不 sleep", async () => {
    const r = await pollUntil({
      attempt: async () => ({ done: true, value: 42 }),
      intervalMs: 1000,
      timeoutMs: 5000,
    });
    expect(r).toBe(42);
    expect(sleeps).toEqual([]);
  });

  it("未就绪两次后成功：sleep 两次且入参恒为 intervalMs", async () => {
    vi.useFakeTimers();
    let n = 0;
    const p = pollUntil({
      attempt: async () => (++n === 3 ? { done: true, value: "ok" } : { done: false }),
      intervalMs: 400,
      timeoutMs: 5000,
    });
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(400);
    await expect(p).resolves.toBe("ok");
    expect(sleeps).toEqual([400, 400]);
    expect(n).toBe(3);
  });

  it("attempt 抛错：直抛不吞不重试", async () => {
    await expect(
      pollUntil({
        attempt: async () => {
          throw new Error("终态失败");
        },
        intervalMs: 10,
        timeoutMs: 100,
      }),
    ).rejects.toThrow("终态失败");
  });

  it("墙钟超时：抛 PollTimeoutError，含 label 与秒数", async () => {
    vi.useFakeTimers();
    const p = pollUntil({
      label: "ASC 构建处理",
      attempt: async () => ({ done: false }),
      intervalMs: 400,
      timeoutMs: 1000,
    });
    // t=0/400/800 三次探测后：800+400>1000 → 抛
    const guard = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(400);
    const err = (await guard) as PollTimeoutError;
    expect(err).toBeInstanceOf(PollTimeoutError);
    expect(err.message).toContain("ASC 构建处理");
    expect(err.message).toContain("上限 1s"); // 简报原文 "1000s" 系 ms/秒混写：1000ms 应渲染为 1s
    expect(sleeps).toEqual([400, 400]);
  });

  it("maxAttempts 耗尽：抛 PollTimeoutError（intervalMs=0 间隔自理模式不 sleep）", async () => {
    let n = 0;
    const guard = pollUntil({
      label: "任务状态",
      attempt: async () => {
        n += 1;
        return { done: false as const };
      },
      intervalMs: 0,
      maxAttempts: 5,
    }).catch((e: unknown) => e);
    const err = (await guard) as PollTimeoutError;
    expect(err).toBeInstanceOf(PollTimeoutError);
    expect(n).toBe(5);
    expect(sleeps).toEqual([]);
  });

  it("onWait 每次等待前回调（attempt 序号从 1 起）", async () => {
    vi.useFakeTimers();
    const seen: number[] = [];
    let n = 0;
    const p = pollUntil({
      attempt: async () => (++n === 2 ? { done: true, value: 1 } : { done: false }),
      intervalMs: 100,
      timeoutMs: 1000,
      onWait: ({ attempt }) => seen.push(attempt),
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBe(1);
    expect(seen).toEqual([1]);
  });
});
