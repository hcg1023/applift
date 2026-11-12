# fastlane 借鉴项落地 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 docs/fastlane-adoption.md 落地 ASC 提审链路加固（等构建/提审幂等/版本状态机/韧性层/合规代答/phased release）+ 渠道共享轮询工具。

**Architecture:** 方案 C——全部 ASC 能力收在 `AscChannel` 内部；仅 `pollUntil` 提为 `channels/shared/poll.ts` 并迁移 AGC/oppo/pgyer 三处现有轮询（纯重构，现有测试兜底"行为不变"）。ASC HTTP 层从"裸函数 + 调用方自签 JWT"重构为 `AscClient`（持有 JWT、自动续签、GET 重试矩阵）。

**Tech Stack:** TypeScript (Node ≥20)、vitest（fake timers + mockFetch 桩）、zod（config schema）、pnpm。

**Spec:** `docs/fastlane-adoption.md`（12 节设计 + 边界 + 风险，本计划从 spec 出发，执行者须同时读 spec）。

## Global Constraints

- Node ≥20 唯一承诺；禁引入单运行时 API。
- 测试只跑 mock（mockFetch / fake timers / 打桩 sleep），**禁真实 ASC/pushy 网络调用**。
- 每步 gate：`pnpm -r build && npx vitest run` 全量绿才 commit；触碰 CLI 入口/配置加载后跑 `pnpm run smoke`。
- 提交用 conventional commits；不 push。
- lint 用 oxlint；现有测试断言的错误文案（AGC/oppo/pgyer 超时消息）必须逐字保留——迁移是纯重构。
- 所有 ASC 新 API 形状未经真实链路验证，属 spec"风险与未验证点"范畴，测试以 mock 路由固定契约。

## 现有代码锚点（执行者先读）

- `packages/core/src/channels/asc.ts`（519 行）：stage 双引擎 / submit 五步 / status 映射；releaseType 三档（2026-11-11 已落地 AFTER_APPROVAL 默认）。
- `packages/core/src/channels/shared/asc-jwt.ts`：`makeAscJwt`（ES256）、`ascGet`/`ascRequest`（裸 fetch + 30s AbortSignal，无重试）。
- `packages/core/src/util.ts`：`sleep(ms)`。
- `packages/core/src/version/artifact.ts`：`readArtifactVersion(path): { versionName?: string; versionCode?: string; source: string } | undefined`。
- 轮询现状：`agc-harmony.ts awaitCompile`（查→判态→超时→sleep 15s，上限 15min）；`oppo.ts pollTaskState`（**先 sleep 10s 后查**，次数上限 5，耗尽=warn 不抛错）；`pgyer.ts stage` buildInfo 循环（**先 sleep 3s 后查**，deadline 15min，连续失败 10 次返回 `{ok:false}` 不抛错）。
- 测试桩：`mockFetch`（test-utils.ts，按 URL 子串路由）；`vi.mock("../util.js")` 打桩 sleep 的先例见 oppo.test.ts。

---

### Task 1: pollUntil 共享轮询 + 三渠道迁移

**Files:**

- Create: `packages/core/src/channels/shared/poll.ts`、`packages/core/src/channels/shared/poll.test.ts`
- Modify: `packages/core/src/channels/agc-harmony.ts:344-379`（awaitCompile）、`packages/core/src/channels/oppo.ts:394-436`（pollTaskState）、`packages/core/src/channels/pgyer.ts:162-207`（buildInfo 循环）

**Interfaces:**

- Produces（后续任务与迁移共同消费）:

  ```ts
  export class PollTimeoutError extends Error {} // name = "PollTimeoutError"
  export interface PollOptions<T> {
    attempt: () => Promise<{ done: true; value: T } | { done: false }>;
    intervalMs: number; // ≤0：间隔由 attempt 自理（oppo/pgyer 的"先 sleep 后查"语义）
    timeoutMs?: number; // 墙钟上限
    maxAttempts?: number; // 探测次数上限（含首次）；与 timeoutMs 至少给一个
    label?: string; // 超时文案前缀
    onWait?: (info: { attempt: number; elapsedMs: number }) => void;
  }
  export function pollUntil<T>(opts: PollOptions<T>): Promise<T>;
  ```

- [ ] **Step 1: 写 poll.test.ts（失败测试）**

```ts
/** pollUntil 契约：终态/间隔/超时/次数上限/异常直抛（docs/fastlane-adoption §1） */
import { afterEach, describe, expect, it, vi } from "vitest";
import { pollUntil, PollTimeoutError } from "./poll.js";

// sleep 打桩记录间隔，时钟由 fake timers 推进（Date 一并被 fake）
const sleeps: number[] = [];
vi.mock("../../util.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../util.js")>()),
  sleep: vi.fn(async (ms: number) => {
    sleeps.push(ms);
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
    expect(err.message).toContain("1000s");
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/core/src/channels/shared/poll.test.ts`
Expected: FAIL（模块 ./poll.js 不存在）。

- [ ] **Step 3: 实现 poll.ts**

```ts
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
```

- [ ] **Step 4: 跑 poll 测试确认全过**

Run: `npx vitest run packages/core/src/channels/shared/poll.test.ts` → PASS（6 例）。

- [ ] **Step 5: 迁移 AGC awaitCompile（替换函数体，超时文案逐字保留）**

```ts
  /** 轮询软件包云端编译：successStatus 0=成功 2=拒绝（终态，多为签名/证书/bundleName 不匹配）其他=编译中 */
  private async awaitCompile(
    ctx: ChannelContext,
    appId: string,
    pkgId: string,
    headers: Record<string, string>,
  ): Promise<void> {
    ctx.emit({ type: "phase", phase: "wait", message: `等待 AGC 云端编译（pkgId: ${pkgId}）` });
    try {
      await pollUntil({
        label: "AGC 云端编译",
        intervalMs: COMPILE_POLL_MS,
        timeoutMs: COMPILE_TIMEOUT_MS,
        onWait: () =>
          ctx.emit({ type: "progress", detail: `编译中，${COMPILE_POLL_MS / 1000}s 后重查…` }),
        attempt: async () => {
          const stQs = new URLSearchParams({ appId, pkgIds: pkgId });
          const st = await agcJson<CompileStatusResp>(
            `${BASE}/publish/v3/package/compile/status?${stQs}`,
            { headers },
            "查询编译状态",
          );
          const state = st.pkgStateList?.find((p) => p.pkgId === pkgId) ?? st.pkgStateList?.[0];
          const s = state?.successStatus;
          if (s === 0) {
            ctx.emit({ type: "progress", detail: "软件包编译完成" });
            return { done: true as const, value: undefined };
          }
          if (s === 2) {
            throw new Error(
              `AGC 编译拒绝（pkgId ${pkgId}）：签名/证书/bundleName 不匹配，到 AGC 控制台核对`,
            );
          }
          ctx.emit({
            type: "progress",
            detail: `编译中（successStatus=${s}），${COMPILE_POLL_MS / 1000}s 后重查…`,
          });
          return { done: false as const };
        },
      });
    } catch (e) {
      if (e instanceof PollTimeoutError)
        throw new Error(`AGC 编译超时（${COMPILE_TIMEOUT_MS / 60000} 分钟，pkgId ${pkgId}）`);
      throw e;
    }
  }
```

顶部 import 改为：`import { pollUntil, PollTimeoutError } from "./shared/poll.js";`（移除仅 awaitCompile 使用的 `sleep` 导入——若文件他处仍用 sleep 则保留）。

- [ ] **Step 6: 迁移 oppo pollTaskState（先 sleep 后查 + 耗尽降级 warn，两个文案逐字保留）**

```ts
  private async pollTaskState(
    ctx: ChannelContext,
    auth: { clientId: string; clientSecret: string; pkgName: string; token: string },
    versionCode: string,
  ): Promise<void> {
    try {
      await pollUntil({
        label: "OPPO 任务状态",
        intervalMs: 0, // 先 sleep 后查语义：间隔在 attempt 内自理（sleep 仍来自 util，可被测试打桩）
        maxAttempts: TASK_STATE_MAX_POLLS,
        attempt: async () => {
          await sleep(TASK_STATE_POLL_INTERVAL_MS);
          const st = checkErrno(
            await oppoApi(
              "/resource/v1/app/task-state",
              auth,
              { pkg_name: auth.pkgName, version_code: versionCode },
              "POST",
              "查询任务状态",
            ),
            "查询任务状态",
          );
          const taskState = st.data?.["task_state"];
          if (taskState === 2) {
            ctx.emit({
              type: "progress",
              detail: `任务处理成功（task_state=2，第 ${TASK_STATE_MAX_POLLS} 次轮询确认）`,
            });
            return { done: true as const, value: undefined };
          }
          if (taskState === 3) {
            const errMsg = st.data?.["err_msg"];
            throw new Error(
              `OPPO 发布任务处理失败（task_state=3）: ${
                typeof errMsg === "string" && errMsg ? errMsg : JSON.stringify(st.data).slice(0, 200)
              }`,
            );
          }
          ctx.emit({
            type: "progress",
            detail: `任务处理中（task_state=${String(taskState)}）`,
          });
          return { done: false as const };
        },
      });
    } catch (e) {
      if (e instanceof PollTimeoutError) {
        ctx.emit({
          type: "warn",
          message: `任务状态轮询 ${TASK_STATE_MAX_POLLS} 次未到终态：app/upd 已受理但异步处理结果未知，请稍后用 status 查询审核状态`,
        });
        return;
      }
      throw e;
    }
  }
```

注意：进度文案里原先带 `第 ${attempt}/${TASK_STATE_MAX_POLLS} 次`，迁移后 attempt 计数不可见——**保留原语义**：把 attempt 序号通过闭包计数器传入文案（`let attempt = 0;` 在 try 前声明、attempt 内 `attempt += 1`，文案恢复 `第 ${attempt}/${TASK_STATE_MAX_POLLS} 次`、"成功"文案恢复 `第 ${attempt} 次轮询确认`）。oppo.test.ts 断言成功文案 `第 1 次轮询确认`（taskStateSequence([2]) 首轮即成功）。

- [ ] **Step 7: 迁移 pgyer buildInfo 循环（stage 内 162-207 行段替换，两个失败文案逐字保留）**

```ts
ctx.emit({ type: "phase", phase: "wait", message: "等待蒲公英处理" });
let consecutiveErrors = 0;
try {
  await pollUntil({
    label: "蒲公英处理",
    intervalMs: 0, // 先 sleep 后查语义自理
    timeoutMs: 15 * 60 * 1000,
    attempt: async () => {
      await sleep(3000);
      let info: BuildInfoResp;
      try {
        info = await pgyerPostFailover<BuildInfoResp>(ctx, "/apiv2/app/buildInfo", {
          _api_key: apiKey,
          buildKey,
        });
        consecutiveErrors = 0;
      } catch (e) {
        consecutiveErrors++;
        const lastErr = e instanceof Error ? e.message : String(e);
        ctx.emit({
          type: "warn",
          message: `buildInfo 状态查询失败（连续 ${consecutiveErrors}/10）: ${lastErr}`,
        });
        if (consecutiveErrors >= 10)
          throw new Error(`蒲公英状态查询持续失败（包已上传，可到控制台确认）: ${lastErr}`);
        return { done: false as const };
      }
      if (info.code === 0 && info.data?.buildShortcutUrl) {
        ctx.emit({
          type: "phase",
          phase: "done",
          message: `https://www.pgyer.com/${info.data.buildShortcutUrl}`,
        });
        return { done: true as const, value: buildKey };
      }
      // 1247 = buildKey 尚未就绪（COS 仍在入库）：处理中继续轮询；其余非 0 码为明确失败
      if (info.code !== 0 && info.code !== 1247) {
        throw new Error(`蒲公英处理失败 ${info.code}: ${info.message ?? ""}`);
      }
      return { done: false as const };
    },
  });
  return { ok: true, ref: buildKey };
} catch (e) {
  if (e instanceof PollTimeoutError)
    return {
      ok: false,
      error:
        "蒲公英 15 分钟内未完成处理（大包云端处理慢属正常，可到 pgyer.com 控制台确认实际状态）",
    };
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}
```

（成功路径原代码 return `{ ok: true, ref: buildKey }`——迁移后由 pollUntil 正常返回带出，在 try 外 return；失败路径统一 catch 翻译，`ok:false.error` 与原文案一致。）

- [ ] **Step 8: 全量迁移 gate**

Run: `pnpm -r build && npx vitest run`
Expected: 全绿（含 agc-harmony.test / agc-harmony.flow.test / oppo.test / oppo.flow.test / pgyer.test / pgyer.flow.test 的轮询次数与文案断言）。**任何文案断言失败 = 迁移改变了行为，修复到绿为止，不许改测试断言。**

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/channels/shared/poll.ts packages/core/src/channels/shared/poll.test.ts packages/core/src/channels/agc-harmony.ts packages/core/src/channels/oppo.ts packages/core/src/channels/pgyer.ts
git commit -m "refactor(channels): 抽取 pollUntil 共享有界轮询并迁移 AGC/oppo/pgyer（行为不变）"
```

---

### Task 2: AscClient 韧性层（JWT 续签 + 重试矩阵 + 错误分类）

**Files:**

- Modify: `packages/core/src/channels/shared/asc-jwt.ts`（全文件重构）、`packages/core/src/channels/shared/asc-jwt.test.ts`
- Modify: `packages/core/src/channels/asc.ts`（调用点：submit/status 从 `makeAscJwt + ascGet/ascRequest` 换 `new AscClient(auth)`）
- Test: `packages/core/src/channels/shared/asc-jwt.test.ts`、`packages/core/src/channels/asc.test.ts`（现有断言保持）

**Interfaces:**

- Produces（Task 3-6 全部消费）:
  ```ts
  export interface AscAuth {
    keyId: string;
    issuerId: string;
    p8Path: string;
  }
  export class AscClient {
    constructor(auth: AscAuth);
    get<T = unknown>(apiPath: string): Promise<T>; // GET，幂等可重试
    request<T = unknown>(apiPath: string, method: string, body?: unknown): Promise<T>; // 写：不自动重试
  }
  ```
- `makeAscJwt` 保留导出（iat 改 `now - 60`）；`ascGet`/`ascRequest` 裸函数**删除**（干净切断，asc.ts 与测试全部换 AscClient）。

- [ ] **Step 1: 改写 asc-jwt.test.ts（失败测试；先改 makeAscJwt 的 iat 断言 + 新增 AscClient 用例）**

关键用例（沿用现有 mockFetch/真密钥夹具，文件顶部 import 换 `{ AscClient, makeAscJwt }`）：

```ts
describe("makeAscJwt（iat 时钟偏移防御）", () => {
  it("iat = now - 60（fastlane token.rb 实证），exp - iat 仍 20 分钟", () => {
    const before = Math.floor(Date.now() / 1000);
    const jwt = makeAscJwt({ keyId: "KID", issuerId: "ISS", p8Path });
    const after = Math.floor(Date.now() / 1000);
    const payload = b64urlToJson(jwt.split(".")[1]!);
    const iat = payload.iat as number;
    expect(iat).toBeGreaterThanOrEqual(before - 60);
    expect(iat).toBeLessThanOrEqual(after - 60);
    expect((payload.exp as number) - iat).toBe(20 * 60);
  });
});

describe("AscClient 重试矩阵（docs/fastlane-adoption §5）", () => {
  const auth = () => ({ keyId: "KID", issuerId: "ISS", p8Path });

  it("GET 429：指数退避后成功（1s→2s）， Authorization 每次都带 Bearer", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const m = mockFetch([
      { match: "/v1/apps", response: () => ({ status: 429, json: {} }) },
      { match: "/v1/apps", response: () => ({ status: 429, json: {} }) },
      { match: "/v1/apps", response: () => ({ status: 200, json: { data: [] } }) },
    ]);
    // ⚠️ mockFetch 按注册顺序消费还是按 match 命中需与 test-utils 现状对齐；
    // 若只按子串命中，改用计数器闭包在 response 回调里按 calls 分流（oppo.test taskStateSequence 同款）
    try {
      const p = new AscClient(auth()).get("/v1/apps");
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      await expect(p).resolves.toEqual({ data: [] });
      expect(m.calls.length).toBe(3);
    } finally {
      m.restore();
      vi.useRealTimers();
    }
  });

  it("GET 500 → 2s 后重试成功，共 2 次请求", async () => {
    /* 同款：先 500 后 200，advance 2000 */
  });

  it("GET 401 → 重签 JWT 重试一次成功（两次请求 Authorization 不同）", async () => {
    /* 捕获两次 auth header，断言不相等 */
  });

  it("POST 500 → 不重试直接抛错，文案含「先跑 applift status 确认」", async () => {
    const m = mockFetch([{ match: "/v1/appStoreVersions", response: { status: 500, json: {} } }]);
    try {
      await expect(
        new AscClient(auth()).request("/v1/appStoreVersions", "POST", {}),
      ).rejects.toThrow(/写操作不自动重试.*applift status/);
      expect(m.calls.length).toBe(1);
    } finally {
      m.restore();
    }
  });

  it("403 REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED → 专属人话", async () => {
    const m = mockFetch([
      {
        match: "/v1/apps",
        response: {
          status: 403,
          json: { errors: [{ code: "REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED" }] },
        },
      },
    ]);
    try {
      await expect(new AscClient(auth()).get("/v1/apps")).rejects.toThrow(
        /付费协议未签或已过期.*App Store Connect 网页/,
      );
    } finally {
      m.restore();
    }
  });

  it("非 JSON 200 响应 → 抛「返回非 JSON」", async () => {
    /* status 200, body 非 JSON */
  });
});
```

（mockFetch 的 response 支持形式以 `packages/core/src/test-utils.ts` 现状为准——写用例前先读它；若不支持 status/回调分流，按 taskStateSequence 模式在测试文件内自建计数器路由。）

- [ ] **Step 2: 跑测试确认失败** → `npx vitest run packages/core/src/channels/shared/asc-jwt.test.ts` FAIL（AscClient 不存在）。

- [ ] **Step 3: 重构 asc-jwt.ts**

```ts
/**
 * App Store Connect JWT（ES256）与 API 客户端（docs/fastlane-adoption §5）。
 * - makeAscJwt: iat = now-60（时钟偏移防御，fastlane token.rb），有效期 20 分钟
 * - AscClient: JWT 惰性续签（18 分钟余量）+ 401 重签重试 1 次；
 *   GET 幂等自动重试（429 指数退避封顶 60s/总上限 10min；500/502/503/504 ≤3 次）；
 *   POST/PATCH 不自动重试（防重复创建/重复提审），错误文案提示先 status 确认；
 *   403 REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED → 专属人话。
 */
import { createSign } from "node:crypto";
import fs from "node:fs";
import { sleep } from "../../util.js";

const ASC_API_BASE = "https://api.appstoreconnect.apple.com";
const JWT_TTL_MS = 20 * 60 * 1000;
const JWT_REFRESH_MARGIN_MS = 2 * 60 * 1000; // 剩 2 分钟即续签
const RETRY_5XX_DELAYS_MS = [2000, 4000, 8000];
const RETRY_429_START_MS = 1000;
const RETRY_429_CAP_MS = 60_000;
const RETRY_429_TOTAL_MS = 10 * 60_000;

export interface AscErrorItem {
  id?: string;
  status?: string;
  code?: string;
  title?: string;
  detail?: string;
}
export interface AscErrorBody {
  errors?: AscErrorItem[];
}
export interface AscAuth {
  keyId: string;
  issuerId: string;
  p8Path: string;
}
export type AscJwtOptions = AscAuth;

export function makeAscJwt({ keyId, issuerId, p8Path }: AscJwtOptions): string {
  const header = { alg: "ES256", kid: keyId };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: issuerId, iat: now - 60, exp: now + 20 * 60, aud: "appstoreconnect-v1" };
  // ……（b64url / 签名段与现状逐字一致，仅 payload.iat 变更）
}

export class AscClient {
  private jwt?: { token: string; issuedAt: number };
  constructor(private readonly auth: AscAuth) {}

  get<T = unknown>(apiPath: string): Promise<T> {
    return this.request<T>("GET", apiPath);
  }

  async request<T = unknown>(apiPath: string, method: string, body?: unknown): Promise<T> {
    const idempotent = method === "GET";
    let refreshed401 = false;
    let n5xx = 0;
    let backoff429 = RETRY_429_START_MS;
    let spent429 = 0;
    for (;;) {
      const res = await fetch(`${ASC_API_BASE}${apiPath}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token()}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return (await parseBody<T>(res, apiPath)) as T;
      if (res.status === 401 && !refreshed401) {
        refreshed401 = true;
        this.jwt = undefined; // 强制重签后重试一次
        continue;
      }
      if (idempotent && res.status === 429 && spent429 < RETRY_429_TOTAL_MS) {
        await sleep(backoff429);
        spent429 += backoff429;
        backoff429 = Math.min(backoff429 * 2, RETRY_429_CAP_MS);
        continue;
      }
      if (
        idempotent &&
        [500, 502, 503, 504].includes(res.status) &&
        n5xx < RETRY_5XX_DELAYS_MS.length
      ) {
        await sleep(RETRY_5XX_DELAYS_MS[n5xx]!);
        n5xx += 1;
        continue;
      }
      throw await httpError(res, apiPath, method, idempotent);
    }
  }

  /** JWT 惰性续签：无/临期（剩 <2 分钟）即重签 */
  private token(): string {
    const now = Date.now();
    if (!this.jwt || now - this.jwt.issuedAt > JWT_TTL_MS - JWT_REFRESH_MARGIN_MS) {
      this.jwt = { token: makeAscJwt(this.auth), issuedAt: now };
    }
    return this.jwt.token;
  }
}

async function parseBody<T>(res: Response, apiPath: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`ASC API ${apiPath} 返回非 JSON（HTTP ${res.status}）: ${text.slice(0, 300)}`);
  }
}

async function httpError(
  res: Response,
  apiPath: string,
  method: string,
  idempotent: boolean,
): Promise<Error> {
  const json = (await res.json().catch(() => ({}))) as AscErrorBody;
  const first = json.errors?.[0];
  if (res.status === 403 && first?.code === "REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED")
    return new Error(
      `ASC API ${method} ${apiPath} 失败：付费协议未签或已过期——到 App Store Connect 网页（商务 → 协议）签署后重试`,
    );
  const retryHint = idempotent
    ? ""
    : "（写操作不自动重试：可能已成功，先跑 applift status 确认再重试）";
  const methodPrefix = method === "GET" ? "" : `${method} `;
  return new Error(
    `ASC API ${methodPrefix}${apiPath} 失败 HTTP ${res.status}: ${JSON.stringify(json.errors ?? json).slice(0, 300)}${retryHint}`,
  );
}
```

- [ ] **Step 4: asc.ts 调用点切换**

`submit()`/`status()` 内：`const jwt = makeAscJwt(...)` → `const asc = new AscClient({ keyId, issuerId, p8Path })`；所有 `ascGet< T >(jwt, path)` → `asc.get<T>(path)`；`ascRequest< T >(jwt, path, method, body)` → `asc.request<T>(path, method, body)`；import 改 `import { AscClient } from "./shared/asc-jwt.js"`。submit 开头的 `ctx.emit({ type:"phase", phase:"auth", ... })` 保留，文案改 `ASC 客户端就绪（JWT 惰性续签，20 分钟有效）`。

- [ ] **Step 5: 跑 asc-jwt + asc + flow 全部测试**（`npx vitest run packages/core/src/channels/asc.test.ts packages/core/src/channels/asc.flow.test.ts packages/core/src/channels/shared/asc-jwt.test.ts`）→ PASS。

- [ ] **Step 6: 全量 gate + smoke**（改了 asc.ts 但未动 CLI 入口，smoke 顺带跑一次）→ `pnpm -r build && npx vitest run && pnpm run smoke`。

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/channels/shared/asc-jwt.ts packages/core/src/channels/shared/asc-jwt.test.ts packages/core/src/channels/asc.ts
git commit -m "feat(asc): AscClient 韧性层——JWT 续签/iat-60、GET 重试矩阵、写操作不重试、协议未签人话"
```

---

### Task 3: ASC 等构建处理完成 + build 号预检

**Files:**

- Modify: `packages/core/src/channels/asc.ts`（submit 第 2 步重构为 `awaitValidBuild`；stage 入口加 build 号预检）
- Test: `packages/core/src/channels/asc.test.ts`

**Interfaces:**

- Consumes: `pollUntil`/`PollTimeoutError`（Task 1）、`AscClient`（Task 2）、`readArtifactVersion`（version/artifact.ts）。
- Produces: `private async awaitValidBuild(asc, appId, artifactVer, ctx): Promise<{ buildId: string; versionString: string }>`——versionString 恒取 builds include 的 preReleaseVersion（现有推导逻辑保留），Task 4/6 消费。

- [ ] **Step 1: 失败测试（asc.test.ts 新增 describe）**

```ts
describe("submit 等构建处理完成（docs/fastlane-adoption §2）", () => {
  it("PROCESSING→VALID 两轮后继续提审；请求按产物锚定（preReleaseVersions 查询在先）", async () => {
    vi.useFakeTimers();
    let pollCount = 0;
    const m = mockFetch(
      submitRoutes({
        preVersions: {
          data: [{ type: "preReleaseVersions", id: "PR1", attributes: { version: "1.2.3" } }],
        },
        builds: {
          // 首轮 PROCESSING，次轮 VALID（响应回调按计数分流，参照 taskStateSequence 模式）
          response: () => {
            pollCount += 1;
            return pollCount === 1
              ? { data: [buildProcessing], included: [pre] }
              : { data: [buildValid], included: [pre] };
          },
        },
      }),
    );
    try {
      const ctx = makeCtx({
        artifactVersion: { versionName: "1.2.3", versionCode: "42" } as never,
      });
      const p = ch.submit(ctx);
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(p).resolves.toEqual({ ok: true, ref: "SUB1" });
      expect(m.calls.some((c) => c.url.includes("filter[preReleaseVersion]=PR1"))).toBe(true);
      expect(m.calls.some((c) => c.url.includes("filter[version]=42"))).toBe(true);
    } finally {
      m.restore();
      vi.useRealTimers();
    }
  });

  it("锚定后构建 INVALID：立即报错（不再等满 30 分钟）", async () => {
    // builds 恒返回 INVALID + include pre → rejects /构建处理失败（INVALID/
  });

  it("持续 PROCESSING 超时：报错文案指引 --skip-stage 重跑", async () => {
    vi.useFakeTimers();
    // 恒 PROCESSING；advance 30*60_000+，断言 rejects /构建处理超时.*--skip-stage/
  });

  it("产物读不出（--skip-stage 无产物场景语义）：退回最新 VALID 行为（现状兼容）", async () => {
    // artifactPath 指向不存在文件 → 不发 preReleaseVersions 查询，直接 builds?filter[app] 取 VALID
  });
});

describe("stage build 号预检（§9）", () => {
  it("产物 versionCode 已存在于 ASC：上传前报错", async () => {
    // mock builds?filter[version]=42 命中 → stage rejects /build 号已被占用.*42/
  });
  it("无占用：正常走上传引擎（Transporter 探测存在时走 iTMSTransporter 桩）", async () => {
    // builds 空 → stage 走到 spawn 桩，resolves ok
  });
});
```

（`submitRoutes` 现有夹具按需扩 `preVersions`/响应回调参数；`makeCtx` 扩 `artifactVersion` 或让 `readArtifactVersion` 走真实不存在路径。）

- [ ] **Step 2: 跑测试确认失败。**

- [ ] **Step 3: 实现**

asc.ts 顶部：`import { readArtifactVersion } from "../version/artifact.js";`、`import { pollUntil, PollTimeoutError } from "./shared/poll.js";` + 常量 `const BUILD_POLL_MS = 30_000; const BUILD_TIMEOUT_MS = 30 * 60_000;`。

stage 预检（resolveAuth 之后、resolveTransporterPath 之前）：

```ts
// build 号预检（§9）：ios build 号全 app 唯一，占用则上传必失败——提前拦截省 5-15 分钟
const av = ctx.artifactPath ? readArtifactVersion(ctx.artifactPath) : undefined;
if (av?.versionCode) {
  const asc = new AscClient(auth);
  const appId = await this.resolveAppId(asc, ctx); // 抽取 submit 第 1 步的 apps 查询
  const dup = await asc.get<AscListResponse<AscBuildAttrs>>(
    `/v1/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(av.versionCode)}&limit=1`,
  );
  if (dup.data.length > 0)
    throw new Error(
      `build 号已被占用（版本 ${av.versionName ?? "?"} 构建号 ${av.versionCode} 已在 App Store Connect）` +
        "——升 versionCode 重新出包后重试（versionCode 以工程文件为准）",
    );
}
```

submit 第 2 步替换为 `const build = await this.awaitValidBuild(asc, app.id, av, ctx);`，新私有方法（versionString 推导沿用现状 include 匹配逻辑）：

```ts
  /**
   * 等待本次构建处理完成（§2）。锚定优先：产物 versionName/versionCode 精确匹配
   * （preReleaseVersions?filter[version] → builds?filter[preReleaseVersion]&filter[version]），
   * 防"多 train 并存取最新绑错包"；锚定链路任一环节失角（查询失败/无记录）退回"最新 VALID"（现状兼容）。
   * X.Y ≡ X.Y.0（ASC 只按先传格式可查，fastlane #22248）：双格式查询 uniq。
   */
  private async awaitValidBuild(
    asc: AscClient,
    appId: string,
    av: ReturnType<typeof readArtifactVersion>,
    ctx: Pick<ChannelContext, "emit">,
  ): Promise<{ buildId: string; versionString: string }> {
    ctx.emit({ type: "phase", phase: "wait", message: "等待 App Store Connect 构建处理完成（约 10 分钟）" });
    const trainIds = av?.versionName ? await this.resolveTrainIds(asc, appId, av.versionName) : [];
    const anchored = trainIds.length > 0 && !!av?.versionCode;
    try {
      return await pollUntil({
        label: "ASC 构建处理",
        intervalMs: BUILD_POLL_MS,
        timeoutMs: BUILD_TIMEOUT_MS,
        onWait: ({ attempt, elapsedMs }) =>
          ctx.emit({
            type: "progress",
            detail: `构建处理中（已等 ${Math.round(elapsedMs / 60000)} 分钟，第 ${attempt} 次探测，${BUILD_POLL_MS / 1000}s 后重查）`,
          }),
        attempt: async () => {
          const qs = anchored
            ? `filter[app]=${appId}&filter[preReleaseVersion]=${trainIds.join(",")}&filter[version]=${encodeURIComponent(av!.versionCode!)}`
            : `filter[app]=${appId}&sort=-uploadedDate&limit=20`;
          const builds = await asc.get<AscListResponse<AscBuildAttrs>>(`/v1/builds?${qs}&include=preReleaseVersion`);
          const valid = builds.data.find((b) => b.attributes?.processingState === "VALID");
          if (valid?.id) {
            // versionString 恒按 build 的 preReleaseVersion 关系推导（现状逻辑，防 included[0] 误取）
            const preId = valid.relationships?.preReleaseVersion?.data?.id;
            const pre = builds.included?.find((d) => d.type === "preReleaseVersions" && d.id === preId);
            const versionString = (pre?.attributes as AscPreReleaseAttrs | undefined)?.version;
            if (!versionString) throw new Error("ASC 构建缺少 preReleaseVersion 版本号，无法定位/创建 App Store 版本");
            ctx.emit({
              type: "progress",
              detail: `构建处理完成 build ${valid.attributes?.version ?? ""}（版本 ${versionString}）`,
            });
            return { done: true as const, value: { buildId: valid.id, versionString } };
          }
          const bad = builds.data.find(
            (b) => b.attributes?.processingState === "INVALID" || b.attributes?.processingState === "FAILED",
          );
          if (bad && anchored)
            throw new Error(
              `构建处理失败（${bad.attributes?.processingState}，versionCode=${av!.versionCode}）——到 App Store Connect 网页查看原因（常见：签名/缺 entitlement/缺 Info.plist 键）`,
            );
          return { done: false as const };
        },
      });
    } catch (e) {
      if (e instanceof PollTimeoutError)
        throw new Error(
          "构建处理超时（30 分钟）——构建完成后用 applift release ios --submit --skip-stage 重跑提审（提审幂等，重跑安全）",
        );
      throw e;
    }
  }

  /** preReleaseVersions 双格式查询（X.Y / X.Y.0 + 前导零归一）；任何失败返回 []（走退回路径） */
  private async resolveTrainIds(asc: AscClient, appId: string, versionName: string): Promise<string[]> {
    const norm = versionName.split(".").map((s) => String(Number(s))).join(".");
    const alt = norm.endsWith(".0")
      ? norm.slice(0, norm.length - 2)
      : norm.split(".").length === 2
        ? `${norm}.0`
        : undefined;
    const ids = new Set<string>();
    for (const v of [norm, alt]) {
      if (!v) continue;
      try {
        const r = await asc.get<AscListResponse<AscPreReleaseAttrs>>(
          `/v1/preReleaseVersions?filter[app]=${appId}&filter[version]=${encodeURIComponent(v)}&limit=5`,
        );
        for (const d of r.data) if (d.id) ids.add(d.id);
      } catch {
        return []; // 锚定是优化不是依赖：失败退回"最新 VALID"
      }
    }
    return [...ids];
  }
```

注意：submit 原第 2 步的"无 VALID 构建抛最近状态"错误信息删除（被等待+超时取代）；submit 里 build.id 引用改 build.buildId。status() 不动。

- [ ] **Step 4: 测试过 → 全量 gate。**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/channels/asc.ts packages/core/src/channels/asc.test.ts
git commit -m "feat(asc): 提审前有界等待构建处理（产物锚定防绑错包）+ stage 前 build 号占用预检"
```

---

### Task 4: 提审幂等三查 + 版本状态机扩展

**Files:**

- Modify: `packages/core/src/channels/asc.ts`（submit 第 3 步 editable 集合/分支；第 5 步前三查）
- Test: `packages/core/src/channels/asc.test.ts`

**Interfaces:**

- Consumes: `AscClient`、Task 3 的 build/versionString。
- Produces（Task 6 消费）: `private async resolveEditableVersion(asc, appId, versionString, releaseAttrs, ctx): Promise<string>`（返回 versionId；含改名/报错分支）。

- [ ] **Step 1: 失败测试**

```ts
describe("版本状态机扩展（§4）", () => {
  it("editable 集合含被拒四态：filter[appVersionState] 五值逗号列表", async () => {
    // submitRoutes mock 捕获 versions 查询 URL，断言含
    // filter[appVersionState]=PREPARE_FOR_SUBMISSION,DEVELOPER_REJECTED,REJECTED,METADATA_REJECTED,INVALID_BINARY
  });
  it("REJECTED 同号：复用 PATCH，不 POST 新版本", async () => {
    /* versions 返回 REJECTED V1 → 断言无 POST appStoreVersions */
  });
  it("PREPARE 异号：PATCH versionString 改名续用（ensure_version! 语义）", async () => {
    /* 断言 PATCH body 含 versionString */
  });
  it("REJECTED 异号：报错人话（不自动改名），提示控制台人工处置", async () => {
    /* rejects /被拒.*人工|控制台/ */
  });
});

describe("提审三查（§3）", () => {
  it("已有进行中 reviewSubmission 且含本版本：报错勿重复提交", async () => {
    // reviewSubmissions 路由返回 active + items 含 versionId → rejects /已在审核中，勿重复提交/
    // 且断言未发生 POST /v1/reviewSubmissions
  });
  it("存在 items 为空的草稿 submission：复用其 id，不再 POST 创建", async () => {
    /* 断言无 POST reviewSubmissions，POST items 用旧 id */
  });
  it("草稿含其他条目：报错引导网页处理", async () => {
    /* rejects /ASC 网页.*人工/ */
  });
});
```

- [ ] **Step 2: 跑测试确认失败。**

- [ ] **Step 3: 实现**

```ts
/** 可编辑版本状态全集（fastlane get_edit_app_store_version 同款；含被拒四态——被拒后重跑续用不再撞同号建重复版本） */
const EDITABLE_STATES = [
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
] as const;
const REJECTED_STATES = new Set(["DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED"]);
/** reviewSubmission 终态（枚举真实链路首用核对，spec 风险节） */
const SUBMISSION_TERMINAL_STATES = new Set(["COMPLETED", "CANCELLED"]);
```

`resolveEditableVersion`（替换现第 3 步内联逻辑）：

```ts
  /**
   * 定位/创建本次提审的 appStoreVersion（§4）：
   * - editable 五态按 versionString 取最大者（semver 分段数值比较）
   * - 同号 → PATCH releaseAttrs（现状）；PREPARE/INVALID_BINARY 异号 → PATCH versionString 改名续用；
   *   被拒态异号 → 报错（被拒记录连着审核沟通历史，不自动改名——比 fastlane 保守，控制台人工处置）
   * - 无 editable → POST 创建（现状）
   */
  private async resolveEditableVersion(
    asc: AscClient,
    appId: string,
    versionString: string,
    releaseAttrs: Record<string, string>,
    ctx: Pick<ChannelContext, "emit">,
  ): Promise<string> {
    const versions = await asc.get<AscListResponse<AscVersionAttrs>>(
      `/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&filter[appVersionState]=${EDITABLE_STATES.join(",")}&limit=10`,
    );
    const picked = versions.data
      .filter((v) => v.id)
      .sort((a, b) => cmpVersion(b.attributes?.versionString ?? "", a.attributes?.versionString ?? ""))[0];
    if (!picked?.id) {
      const created = await asc.request<AscSingleResponse<AscVersionAttrs>>("/v1/appStoreVersions", "POST", {
        data: {
          type: "appStoreVersions",
          attributes: { platform: "IOS", versionString, ...releaseAttrs },
          relationships: { app: { data: { type: "apps", id: appId } } },
        },
      });
      if (!created.data?.id) throw new Error(`ASC 创建 appStoreVersion（${versionString}）未返回 id`);
      ctx.emit({ type: "phase", phase: "bind", message: `已创建版本 ${versionString}` });
      return created.data.id;
    }
    const state = picked.attributes?.appVersionState ?? "";
    const existing = picked.attributes?.versionString ?? "";
    if (existing === versionString) {
      await asc.request(`/v1/appStoreVersions/${picked.id}`, "PATCH", {
        data: { type: "appStoreVersions", id: picked.id, attributes: releaseAttrs },
      });
      ctx.emit({ type: "phase", phase: "bind", message: `复用版本 ${existing}（state=${state}）` });
      return picked.id;
    }
    if (REJECTED_STATES.has(state))
      throw new Error(
        `ASC 存在被拒版本 ${existing}（${state}）与目标版本 ${versionString} 不同——被拒记录需人工在控制台处置（放弃该版本或改号续用）后再重跑`,
      );
    await asc.request(`/v1/appStoreVersions/${picked.id}`, "PATCH", {
      data: { type: "appStoreVersions", id: picked.id, attributes: { versionString, ...releaseAttrs } },
    });
    ctx.emit({ type: "phase", phase: "bind", message: `续用版本记录并改名 ${existing} → ${versionString}（state=${state}）` });
    return picked.id;
  }

  /** semver 风格分段数值比较（"4.0.1000" > "4.0.999"） */
  function cmpVersion(a: string, b: string): number {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const d = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (d !== 0) return d;
    }
    return 0;
  }
```

（cmpVersion 为模块级函数。）三查（替换现第 5 步 a/b/c 的入口）：

```ts
// 5) 提审三查（§3）：已在审拒绝 / 草稿复用 / 他人条目拒绝，然后三步流
const subs = await asc.get<AscListResponse<{ state?: string }>>(
  `/v1/reviewSubmissions?filter[app]=${app.id}&include=items&limit=10`,
);
const items = subs.included?.filter((d) => d.type === "reviewSubmissionItems") ?? [];
const active = subs.data.find((s) => !SUBMISSION_TERMINAL_STATES.has(s.attributes?.state ?? ""));
let reviewSubmissionId: string;
if (active?.id && active.attributes?.state !== undefined) {
  const mine = items.find(
    (it) => it.relationships?.appStoreVersion?.data?.id === versionId, // AscDoc 的 relationships 类型按需扩 appStoreVersion
  );
  if (mine && active.attributes.state !== "READY")
    throw new Error(
      `版本已在审核流程中（submission state=${active.attributes.state}），勿重复提交——改文案先在 ASC 控制台撤回`,
    );
  if (!mine && items.some((it) => it.relationships?.appStoreVersion))
    throw new Error("存在进行中的提审且含其他条目——到 ASC 网页（App Review → 草稿）人工处置后再试");
  reviewSubmissionId = active.id; // 草稿复用（state=READY 且无冲突条目）
  ctx.emit({ type: "progress", detail: `复用未提交的提审草稿 ${reviewSubmissionId}` });
} else {
  const created = await asc.request<AscSingleResponse<Record<string, unknown>>>(
    "/v1/reviewSubmissions",
    "POST",
    {
      data: {
        type: "reviewSubmissions",
        attributes: {},
        relationships: { app: { data: { type: "apps", id: app.id } } },
      },
    },
  );
  reviewSubmissionId = created.data?.id ?? "";
  if (!reviewSubmissionId) throw new Error("ASC 创建 reviewSubmission 未返回 id");
}
await asc.request(`/v1/reviewSubmissions/${reviewSubmissionId}/items`, "POST", {
  data: {
    type: "reviewSubmissionItems",
    attributes: {},
    relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: versionId } } },
  },
});
await asc.request(`/v1/reviewSubmissions/${reviewSubmissionId}`, "PATCH", {
  data: { type: "reviewSubmissions", attributes: { action: "SUBMIT" } },
});
```

（AscDoc 的 `relationships` 类型扩 `appStoreVersion?: { data?: { id?: string; type?: string } }`。）

- [ ] **Step 4: 测试过 → 全量 gate。**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/channels/asc.ts packages/core/src/channels/asc.test.ts
git commit -m "feat(asc): 提审幂等三查 + 可编辑版本状态机扩展（被拒续用/改名/异号拒绝）"
```

---

### Task 5: 出口合规代答 + preflight 规则化

**Files:**

- Modify: `packages/core/src/config/schema.ts`（ios.exportCompliance）、`packages/core/src/channel.ts`（ChannelContext.exportCompliance）、`packages/cli/src/index.ts`（makeContext extra 透传 config.ios?.exportCompliance）
- Modify: `packages/core/src/channels/asc.ts`（preflightLocalizations → preflightRules；submit 绑 build 后合规代答）
- Test: `packages/core/src/channels/asc.test.ts`、`packages/cli/src/index.test.ts`

**Interfaces:**

- Produces: `ChannelContext.exportCompliance?: { usesNonExemptEncryption: boolean }`；schema `ios.exportCompliance` 同形（`.optional()`，无默认=不代答）。
- Produces: `type PreflightRule = { key: string; level: "warn" | "error"; check: () => Promise<string | null> }`——asc 内部类型，error 抛 / warn emit。

- [ ] **Step 1: 失败测试**

```ts
describe("出口合规代答（§6）", () => {
  it("配置代答 + build usesNonExemptEncryption 为 null：PATCH builds/<id> 补写；非 null 跳过", async () => {
    // submitRoutes builds 响应 attributes 补 usesNonExemptEncryption: null
    // ctx.exportCompliance = { usesNonExemptEncryption: false }
    // 断言出现 PATCH /v1/builds/B1 body attributes.usesNonExemptEncryption=false
  });
  it("未配置代答 + null：emit warn 提示（现行为保留），不 PATCH", async () => {
    /* events 断言 */
  });
  it("已声明（非 null）：零请求零提示", async () => {
    /* usesNonExemptEncryption: false 直接给值 */
  });
});

describe("preflight 规则引擎（§8）", () => {
  it("error 级阻断：localizations 缺描述仍抛（迁移后语义不变）", async () => {
    /* 现有断言保留 */
  });
  it("warn 级不阻断：被拒版本续用时 emit warn", async () => {
    /* resolveEditableVersion 返回 REJECTED 态 → warn 事件 */
  });
});
```

cli 侧：`index.test.ts` 旗标面 describe 补一条 e2e——config 写 `ios: { exportCompliance: { usesNonExemptEncryption: false } }`，桩渠道捕获 `ctx.exportCompliance`（复用 ios.release manual 用例结构，独立 it + 独立渠道 id `stub-cmp`）。

- [ ] **Step 2: 跑测试确认失败。**

- [ ] **Step 3: 实现**

schema（ios 段）：

```ts
      /** 出口合规代答：仅当 build 的 usesNonExemptEncryption 未声明（null）时 PATCH 代答；缺省不代答（保持提示） */
      exportCompliance: z.object({ usesNonExemptEncryption: z.boolean() }).optional(),
```

channel.ts（releaseMode 旁）：

```ts
  /** 出口合规代答（仅 asc 消费：build 未声明时按此 PATCH usesNonExemptEncryption） */
  exportCompliance?: { usesNonExemptEncryption: boolean };
```

cli makeContext 调用点 extra 增 `exportCompliance: config.ios?.exportCompliance`（无旗标——设计定约配置，YAGNI）；makeContext extra 类型与 ctx 组装同 releaseMode 模式。

asc.ts：AscBuildAttrs 扩 `usesNonExemptEncryption?: boolean | null`；submit 绑 build 后：

```ts
// 4.5) 出口合规代答（§6）：build 未声明（null）才写——幂等判据（fastlane 同款）；
//      Info.plist 已声明（ITSAppUsesNonExemptEncryption）的 build 此处为非 null，自动跳过
if (build.attrs.usesNonExemptEncryption == null) {
  if (ctx.exportCompliance) {
    await asc.request(`/v1/builds/${build.buildId}`, "PATCH", {
      data: {
        type: "builds",
        id: build.buildId,
        attributes: { usesNonExemptEncryption: ctx.exportCompliance.usesNonExemptEncryption },
      },
    });
    ctx.emit({
      type: "progress",
      detail: `已代答出口合规（usesNonExemptEncryption=${ctx.exportCompliance.usesNonExemptEncryption}）`,
    });
  } else {
    ctx.emit({
      type: "progress",
      detail:
        "出口合规提示：Info.plist 声明 ITSAppUsesNonExemptEncryption（按实际加密用途取值）可免每次提审被问询",
    });
  }
}
```

preflight 规则化（`preflightLocalizations` 改 `preflight`，返回规则数组并顺序执行）：

```ts
  /** 提审前预检规则（§8）：error 抛出阻断，warn 仅提示。规则接口可移植（不提升 core）。 */
  private async preflight(
    asc: AscClient,
    versionId: string,
    ctx: Pick<ChannelContext, "emit">,
    warns: string[], // 上游（resolveEditableVersion 等）收集的 warn 事实
  ): Promise<void> {
    const rules: Array<{ key: string; level: "warn" | "error"; check: () => Promise<string | null> }> = [
      {
        key: "localizations-description",
        level: "error",
        check: async () => {
          const locs = await asc.get<AscListResponse<AscVersionLocAttrs>>(
            `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=50`,
          );
          if (locs.data.length === 0)
            return "ASC 版本无任何本地化记录，无法提审——请在 ASC 后台补全商店元数据（描述/关键词/截图）后重试";
          const missing = locs.data
            .filter((d) => !(d.attributes?.description ?? "").trim())
            .map((d) => d.attributes?.locale ?? d.id);
          return missing.length > 0
            ? `以下本地化缺少商店描述（description），无法提审: ${missing.join(", ")}——请在 ASC 后台或经 API 补全后重试`
            : null;
        },
      },
      { key: "rejected-version-reuse", level: "warn", check: async () => (warns.includes("rejected-reuse") ? "续用被拒版本记录：请确认拒审原因已解决" : null) },
    ];
    for (const r of rules) {
      const msg = await r.check();
      if (!msg) continue;
      if (r.level === "error") throw new Error(msg);
      ctx.emit({ type: "warn", message: msg });
    }
    ctx.emit({ type: "progress", detail: "提审预检通过" });
  }
```

（resolveEditableVersion 复用被拒版本时 push `"rejected-reuse"` 进 warns；原"预检通过：本地化 … 描述齐备"事件保留在 localizations 规则的 null 分支里 emit。）

- [ ] **Step 4: 测试过 → 全量 gate + smoke（动了 cli/config）。**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/schema.ts packages/core/src/channel.ts packages/cli/src/index.ts packages/core/src/channels/asc.ts packages/core/src/channels/asc.test.ts packages/cli/src/index.test.ts
git commit -m "feat(asc): 出口合规可配置代答（null 才写幂等）+ 提审预检规则化（warn/error 分级）"
```

---

### Task 6: phased release（iOS 灰度）

**Files:**

- Modify: `packages/core/src/config/schema.ts`（ios.phasedRelease）、`packages/core/src/channel.ts`（ChannelContext.phasedRelease）、`packages/cli/src/index.ts`（透传）
- Modify: `packages/core/src/channels/asc.ts`（submit 提审前 POST phasedRelease；preflight 加首版冲突 warn 规则）
- Test: `packages/core/src/channels/asc.test.ts`、`packages/cli/src/index.test.ts`

**Interfaces:**

- Produces: `ChannelContext.phasedRelease?: boolean`；schema `ios.phasedRelease: z.boolean().default(false)`。

- [ ] **Step 1: 失败测试**

```ts
describe("phased release（§7）", () => {
  it("配置开启 + 非首版：POST /v1/appStoreVersionPhasedReleases 关联 versionId", async () => {
    // appStoreVersions 列表路由返回 2 条 → 断言 POST body relationships.appStoreVersion.data.id
  });
  it("配置开启 + 首版（仅 1 条版本记录）：emit warn 跳过，不 POST", async () => {
    /* events + 无 POST 断言 */
  });
  it("未配置：零 phased 请求", async () => {
    /* 现有用例回归 */
  });
});
```

- [ ] **Step 2: 确认失败。**

- [ ] **Step 3: 实现**

schema：`phasedRelease: z.boolean().default(false)`（注释引官方首版限制原文）；channel.ts/cli 透传同 Task 5 模式（`phasedRelease: config.ios?.phasedRelease`）。

asc.ts（三查之前、resolveEditableVersion 之后）：

```ts
// 4.7) phased release（§7，7 天 1%→100% 自动更新灰度）。官方限制：仅后续版本可用
//      （"not available for the first version of an app"）——版本记录数 ≤1 判首版，warn 跳过
if (ctx.phasedRelease) {
  const all = await asc.get<AscListResponse<AscVersionAttrs>>(
    `/v1/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=2`,
  );
  if (all.data.length > 1) {
    await asc.request("/v1/appStoreVersionPhasedReleases", "POST", {
      data: {
        type: "appStoreVersionPhasedReleases",
        relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: versionId } } },
      },
    });
    ctx.emit({ type: "progress", detail: "已开启分阶段发布（7 天 1%→100%，仅自动更新用户）" });
  } else {
    ctx.emit({
      type: "warn",
      message:
        "phased release 已配置但本 app 尚无在架版本（官方：首版不可用）——本次跳过，下一版本自动生效",
    });
  }
}
```

preflight 增规则 `{ key: "phased-first-version", level: "warn" }`：phasedRelease 配置且首版时输出提示（与 4.7 的 warn 二选一即可——实现取 4.7，preflight 规则仅当首版判定与 4.7 重复时省略；**决定：不重复，4.7 一处 warn，preflight 不加此规则**——spec §8 该条以 4.7 落地为準，spec 歧义在此收敛）。

- [ ] **Step 4: 测试过 → 全量 gate + smoke。**

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config/schema.ts packages/core/src/channel.ts packages/cli/src/index.ts packages/core/src/channels/asc.ts packages/core/src/channels/asc.test.ts packages/cli/src/index.test.ts
git commit -m "feat(asc): iOS 分阶段发布开关（ios.phasedRelease，首版官方限制自动跳过并告警）"
```

---

### Task 7: 文档 + 变更集收口

**Files:**

- Modify: `README.md`（ios 配置段：release/exportCompliance/phasedRelease 与 --release-mode 说明——auto-publish 三档已先行落地，一并补全）、`docs/llms.txt`（同步）、`AGENTS.md`（当前状态追加一段）、`.changeset/asc-hardening.md`（新建）

- [ ] **Step 1: README 补 ios 配置文档**（示例块）：

```ts
export default defineConfig({
  ios: {
    bundleId: "com.example.app",
    release: "auto", // auto=审核通过自动上架（默认）| manual
    exportCompliance: { usesNonExemptEncryption: false }, // 可选：提审时代答出口合规
    phasedRelease: true, // 可选：后续版本 7 天分阶段灰度（首版自动跳过）
  },
});
```

- [ ] **Step 2: AGENTS.md 当前状态追加**（要点：等构建有界轮询 30s/30min 产物锚定、提审三查、editable 五态、AscClient 韧性、合规代答、phased 首版跳过；全部未经真实链路验证、首发灰度顺序核对）。

- [ ] **Step 3: 变更集 `.changeset/asc-hardening.md`**

```markdown
---
"@applift/core": minor
"@applift/cli": minor
---

ASC 提审链路加固（fastlane 审查落地，docs/fastlane-adoption.md）：

- 提审前有界等待构建处理完成（30s 轮询 / 30min 上限，产物 versionName+versionCode 精确锚定防多 train 绑错包；X.Y≡X.Y.0 双格式兼容）
- stage 前 build 号占用预检（ios build 号全 app 唯一，提前拦截省一次无效上传）
- 提审幂等三查：已在审拒绝 / 未提交草稿复用 / 他人条目拒绝
- 可编辑版本状态机扩展：被拒四态可续用；PREPARE 异号改名；被拒异号报错人工处置
- AscClient：JWT 惰性续签 + iat-60 时钟偏移防御、GET 429/5xx 自动重试、401 重签、写操作不重试、协议未签专属提示
- 出口合规可配置代答（ios.exportCompliance，build 未声明才写）；提审预检规则化（warn/error 分级）
- iOS 分阶段发布开关（ios.phasedRelease，官方首版限制自动跳过）
- 渠道共享 pollUntil，AGC/oppo/pgyer 轮询统一（行为不变）
```

- [ ] **Step 4: 终验**：`pnpm -r build && npx vitest run && pnpm run smoke` 全绿；`npx oxlint packages` 无新告警。

- [ ] **Step 5: Commit**

```bash
git add README.md docs/llms.txt AGENTS.md .changeset/asc-hardening.md
git commit -m "docs: fastlane 落地文档收口（README ios 配置/AGENTS 状态/变更集）"
```

---

## Self-Review（已执行）

1. **Spec 覆盖**：§1→Task 1；§2/§9→Task 3；§3/§4→Task 4；§5→Task 2；§6/§8→Task 5；§7→Task 6；§10/§11→Task 7 + 各任务全量 gate；§12 是影响面记录（无代码）。无缺口。
2. **占位符扫描**：Task 2 Step 1 两条 `/* 同款 */` 注释用例（500 重试/401 重签/非 JSON）为示意省写——执行者按 429 用例同构展开，mock 路由分流模式已给（计数器闭包）。其余步骤均含完整代码。
3. **类型一致性**：`pollUntil`/`PollTimeoutError`（Task 1 定义，Task 3 消费）；`AscClient.get/request`（Task 2 定义，3/4/5/6 消费）；`awaitValidBuild` 返回 `{ buildId, versionString }`（Task 3 定义，Task 4/5/6 经 submit 主线消费）；`resolveEditableVersion` 返回 versionId 字符串。`AscDoc.relationships` 在 Task 4 扩 `appStoreVersion` 字段。
