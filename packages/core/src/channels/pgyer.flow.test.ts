/**
 * 蒲公英（内测分发）业务流程级测试：stage 全流程（getCOSToken → COS 上传 →
 * buildInfo 轮询 1247 入库中 → code 0 出短链）→ 短链可用；无 submit。
 *
 * 业务不变量：
 * - 轮询语义：1247（buildKey 未就绪）视为处理中继续轮询，不误判失败；
 * - 发布完成 = code 0 且短链非空，done 事件携带可分享的 https://www.pgyer.com/<短链>；
 * - 内测渠道无提审概念：capabilities.submit=false，submit() 返回明确错误而非副作用；
 * - COS 上传携带凭证服务下发的 signature/token/key（凭证贯穿，不混用）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { ChannelContext } from "../channel.js";
import { PgyerChannel } from "./pgyer.js";
import { flushRealIo, mockFetch } from "../test-utils.js";

const BUILD_KEY = "pgy-buildkey-flow-1";
const SHORT_URL = "xY9zFlow";

const apkBytes = Buffer.from("pgy-flow-fake-apk-0123456789");
let apkPath = "";

beforeAll(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pgy-flow-"));
  apkPath = path.join(dir, "driver-beta.apk");
  fs.writeFileSync(apkPath, apkBytes);
});

afterAll(() => {
  fs.rmSync(path.dirname(apkPath), { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function makeCtx(): {
  ctx: ChannelContext;
  events: Array<{ type: string; phase?: string; message?: string; detail?: string }>;
} {
  const events: Array<{ type: string; phase?: string; message?: string; detail?: string }> = [];
  return {
    events,
    ctx: {
      credentials: { PGYER_API_KEY: "pgy-api-key-flow" },
      target: {},
      artifactPath: apkPath,
      updateDescription: "内测包：修复闪退",
      installPassword: "1234",
      emit: (e) => events.push(e),
    },
  };
}

describe("pgyer flow: stage 全流程（1247 → ok）出短链，无 submit", () => {
  it("凭证 → COS 上传 → 轮询 1247 入库 → 短链可用", async () => {
    vi.useFakeTimers();
    let buildInfoCalls = 0;

    const fetchMock = mockFetch([
      // 首选域名直接成功（不走备用域名切换）
      {
        match: "/apiv2/app/getCOSToken",
        response: {
          json: {
            code: 0,
            data: {
              endpoint: "https://cos-pgyer.example.com/put",
              key: BUILD_KEY,
              params: {
                signature: "sig-flow",
                "x-cos-security-token": "cos-tok-flow",
                key: "flow/key.apk",
              },
            },
          },
        },
      },
      { match: "cos-pgyer.example.com", response: { status: 200, text: "" } },
      // 首次 1247（COS 仍在入库），第二次 code 0 + 短链
      {
        match: "/apiv2/app/buildInfo",
        response: () => {
          buildInfoCalls++;
          return buildInfoCalls === 1
            ? { json: { code: 1247, message: "build key not ready" } }
            : {
                json: {
                  code: 0,
                  data: {
                    buildName: "1.2.0",
                    buildVersion: "12",
                    buildShortcutUrl: SHORT_URL,
                    buildQRCodeURL: "https://www.pgyer.com/q/qr.png",
                  },
                },
              };
        },
      },
    ]);

    const channel = new PgyerChannel();
    const { ctx, events } = makeCtx();

    // 内测渠道无提审能力（契约：plan 显示 stage-only，submit 不适用）
    expect(channel.capabilities.submit).toBe(false);
    const plan = await channel.plan(ctx);
    expect(plan.action).toBe("stage-only");

    // ---------- stage 全流程 ----------
    const stageP = channel.stage(ctx);
    await flushRealIo();
    await vi.advanceTimersByTimeAsync(3_000); // 首轮轮询：1247
    await vi.advanceTimersByTimeAsync(3_000); // 次轮轮询：code 0 出短链
    const stage = await stageP;
    expect(stage).toEqual({ ok: true, ref: BUILD_KEY });

    // 不变量：getCOSToken 携带 API key + 安装密码（密码安装 buildInstallType=2）
    const tokenCall = fetchMock.calls.find((c) => c.url.includes("getCOSToken"))!;
    expect(tokenCall.body).toContain("_api_key=pgy-api-key-flow");
    expect(tokenCall.body).toContain("buildInstallType=2");
    expect(tokenCall.body).toContain("buildPassword=1234");
    expect(tokenCall.body).toContain("buildType=android");
    // 不变量：COS 上传携带凭证服务下发的 signature/token/key（FormData body；Content-Type 由 undici 自动生成）
    const cosCall = fetchMock.calls.find((c) => c.url === "https://cos-pgyer.example.com/put")!;
    const fd = cosCall.body as unknown as FormData;
    expect(fd.get("signature")).toBe("sig-flow");
    expect(fd.get("x-cos-security-token")).toBe("cos-tok-flow");
    expect(fd.get("key")).toBe("flow/key.apk");
    // 不变量：1247 只算处理中 —— 恰好轮询两次（未误判失败提前返回）
    expect(buildInfoCalls).toBe(2);
    expect(fetchMock.calls.filter((c) => c.url.includes("buildInfo")).length).toBe(2);
    // 不变量：发布完成（code 0 + 短链）→ done 事件携带可分享短链
    const done = events.find((e) => e.type === "phase" && e.phase === "done");
    expect(done?.message).toBe(`https://www.pgyer.com/${SHORT_URL}`);
    // 事件流：auth → upload → wait → done
    expect(events.filter((e) => e.type === "phase").map((e) => e.phase)).toEqual([
      "auth",
      "upload",
      "wait",
      "done",
    ]);

    // 不变量：无 submit —— 内测渠道调用 submit 返回明确错误，无网络副作用
    const callsBefore = fetchMock.calls.length;
    const submit = await channel.submit();
    expect(submit).toEqual({ ok: false, error: "蒲公英为内测渠道，无提审概念" });
    expect(fetchMock.calls.length).toBe(callsBefore);
  });

  it("轮询遇非 0/1247 明确失败码 → 直接失败不再轮询", async () => {
    vi.useFakeTimers();
    let buildInfoCalls = 0;
    mockFetch([
      {
        match: "/apiv2/app/getCOSToken",
        response: {
          json: {
            code: 0,
            data: {
              endpoint: "https://cos-pgyer.example.com/put",
              key: BUILD_KEY,
              params: { signature: "s", "x-cos-security-token": "t", key: "k.apk" },
            },
          },
        },
      },
      { match: "cos-pgyer.example.com", response: { status: 200, text: "" } },
      {
        match: "/apiv2/app/buildInfo",
        response: () => {
          buildInfoCalls++;
          return { json: { code: 2009, message: "应用解析失败" } };
        },
      },
    ]);
    const { ctx } = makeCtx();
    const stageP = new PgyerChannel().stage(ctx);
    await flushRealIo();
    await vi.advanceTimersByTimeAsync(3_000); // 首轮轮询即遇 2009
    const r = await stageP;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/蒲公英处理失败 2009: 应用解析失败/);
    expect(buildInfoCalls).toBe(1); // 明确失败不重试
    vi.useRealTimers();
  });
});
