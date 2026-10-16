/**
 * 华为渠道业务流程测试：同一渠道实例 + 同一真实临时产物，stage() → submit() → status() 全链路。
 * 业务不变量：
 *   1. 请求顺序 = token → upload-url → OBS 直传 → file-info 登记 → (文案) → 等待120s → app-submit → app-info(状态)
 *   2. app-submit 必须发生在 120s 等待之后，且整个流程只提审一次
 *   3. 事件流 phase 序列完整：auth→upload→bind | wait→submit→done
 *   4. status 终态与提审结果一致（提审后 upgrade 审核中 → reviewing）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HuaweiAndroidChannel, WAIT_BEFORE_SUBMIT_MS } from "./huawei.js";
import { mockFetch, makeTestCtx } from "../test-utils.js";

let artifactPath: string;

beforeAll(() => {
  artifactPath = path.join(os.tmpdir(), `huawei-flow-${process.pid}.apk`);
  fs.writeFileSync(artifactPath, Buffer.from("fake-apk-content-huawei-flow"));
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** URL 片段 → 请求顺序断言用 */
function seqOf(calls: Array<{ url: string }>): string[] {
  return calls.map((c) => {
    if (c.url.includes("oauth2/v1/token")) return "token";
    if (c.url.includes("upload-url/for-obs")) return "upload-url";
    if (c.url.includes("obs.example.com")) return "obs-put";
    if (c.url.includes("app-file-info")) return "file-info";
    if (c.url.includes("app-language-info")) return "language-info";
    if (c.url.includes("app-submit")) return "app-submit";
    if (c.url.includes("publish/v2/app-info")) return "app-info";
    throw new Error(`未预期的请求: ${c.url}`);
  });
}

describe("华为渠道 业务流程", () => {
  it("stage→submit→status 同实例全链：上传登记后等满 120s 才提审且仅一次，状态回到升级审核中", async () => {
    const { calls } = mockFetch([
      { match: "oauth2/v1/token", response: { json: { access_token: "hw-tok" } } },
      {
        match: "upload-url/for-obs",
        response: {
          json: {
            ret: { code: 0 },
            urlInfo: { url: "https://obs.example.com/b/pkg.apk?sig=1", objectId: "obj-flow-9" },
          },
        },
      },
      { match: "obs.example.com", response: { status: 200, text: "" } },
      { match: "app-file-info", response: { json: { ret: { code: 0 } } } },
      { match: "app-language-info", response: { json: { ret: { code: 0 } } } },
      { match: "app-submit", response: { json: { ret: { code: 0 } } } },
      {
        match: "publish/v2/app-info",
        response: { json: { ret: { code: 0 }, appInfo: { releaseState: 5 } } },
      },
    ]);
    const ch = new HuaweiAndroidChannel();
    const { ctx, events } = makeTestCtx({
      credentials: { HW_CLIENT_ID: "cid", HW_CLIENT_SECRET: "sec" },
      target: { appId: "hw-app-1" },
      artifactPath,
      updateDescription: "修复若干问题，优化体验",
    });

    // stage：token → 取上传地址 → OBS 直传 → file-info 登记（草稿），ref=objectId
    const staged = await ch.stage(ctx);
    expect(staged).toEqual({ ok: true, ref: "obj-flow-9" });

    // submit：文案写入 → 等 120s → app-submit（fake timers，无真等待）
    const submitP = ch.submit(ctx);
    await vi.advanceTimersByTimeAsync(0); // 推一个宏任务周期：文案已写，但 120s 未到，绝不能提审
    expect(calls.filter((c) => c.url.includes("app-submit"))).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(WAIT_BEFORE_SUBMIT_MS);
    await submitP;

    // status：releaseState=5（升级审核中）→ reviewing
    const st = await ch.status(ctx);

    // 不变量 1+2：请求顺序，app-submit 在等待后出现且仅一次
    expect(seqOf(calls)).toEqual([
      "token",
      "upload-url",
      "obs-put",
      "file-info", // stage
      "token",
      "language-info",
      "app-submit", // submit（等待后）
      "token",
      "app-info", // status
    ]);
    expect(calls.filter((c) => c.url.includes("app-submit"))).toHaveLength(1);

    // 不变量 3：事件流 phase 序列完整
    expect(events.filter((e) => e.type === "phase").map((e) => e.phase)).toEqual([
      "auth",
      "upload",
      "bind",
      "wait",
      "submit",
      "done",
    ]);

    // 不变量 4：提审后状态 = 审核中
    expect(st).toEqual({ state: "reviewing" });
  });
});
