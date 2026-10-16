/**
 * AGC 鸿蒙 业务流程级测试：同一渠道实例贯穿
 *   stage（releaseType=6 测试发布 .hap：上传→绑定→文案，不提审）
 *   → submit（.app 整包 v3 全链：上传→绑定→云端编译轮询→提审）
 *   → status（未接入，返回 unknown）。
 *
 * 业务不变量：
 * - beta 链路绝不调用 app-submit（测试发布没有提审概念，plan 标注 stage-only）；
 * - formal 链路同一 objectId/packageId 贯穿：upload-url 返回的 objectId 进绑定 body，
 *   绑定返回的 packageId 进编译轮询 query（pkgIds=packageId）；
 * - 编译未完成（successStatus=1）时轮询等待而非提审；successStatus=0 后才 POST app-submit。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { ChannelContext } from "../channel.js";
import { AgcHarmonyChannel } from "./agc-harmony.js";
import { mockFetch } from "../test-utils.js";

const BETA_OBJECT_ID = "agc-beta-obj-1";
const FORMAL_OBJECT_ID = "agc-formal-obj-9";
const FORMAL_PACKAGE_ID = "agc-pkg-777";
const APP_ID = "3001234";

const hapBytes = Buffer.from("fake-hap-beta-bytes-0123456789");
const appBytes = Buffer.from("fake-harmony-app-package-0123456789abcdef");

let dir = "";
let hapPath = "";
let appPath = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agc-flow-"));
  hapPath = path.join(dir, "entry-release-test.hap");
  fs.writeFileSync(hapPath, hapBytes);
  appPath = path.join(dir, "entry-release-signed.app");
  fs.writeFileSync(appPath, appBytes);
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function makeCtx(
  target: Record<string, string>,
  artifactPath: string,
): {
  ctx: ChannelContext;
  events: Array<{ type: string; phase?: string; detail?: string; message?: string }>;
} {
  const events: Array<{ type: string; phase?: string; detail?: string; message?: string }> = [];
  return {
    events,
    ctx: {
      credentials: { AGC_CLIENT_ID: "agc-cid", AGC_CLIENT_SECRET: "agc-sec" },
      target,
      artifactPath,
      updateDescription: "内测修复",
      emit: (e) => events.push(e),
    },
  };
}

describe("agc-harmony flow: 同一渠道实例 beta stage → formal submit → status", () => {
  it("releaseType=6 stage 全链 + .app submit 编译轮询提审，objectId/packageId 贯穿", async () => {
    vi.useFakeTimers();
    let compilePolls = 0;

    const fetchMock = mockFetch([
      { match: "oauth2/v1/token", response: { json: { access_token: "agc-flow-token" } } },
      // beta 上传地址（URL 恰以 releaseType=6 结尾；正则避免误吞 formal 调用）
      {
        match: /for-obs\?.*releaseType=6$/,
        response: {
          json: {
            ret: { code: 0 },
            urlInfo: {
              url: "https://obs-agc.example.com/beta",
              objectId: BETA_OBJECT_ID,
              method: "PUT",
            },
          },
        },
      },
      // formal 上传地址（无 releaseType 参数）
      {
        match: "upload-url/for-obs",
        response: {
          json: {
            ret: { code: 0 },
            urlInfo: {
              url: "https://obs-agc.example.com/formal",
              objectId: FORMAL_OBJECT_ID,
              method: "PUT",
            },
          },
        },
      },
      { match: "obs-agc.example.com", response: { status: 200, text: "" } },
      // 绑定：按 releaseType 区分 beta/formal
      {
        match: "app-package-info",
        response: { json: { ret: { code: 0 }, packageId: FORMAL_PACKAGE_ID } },
      },
      { match: "app-language-info", response: { json: { ret: { code: 0 } } } },
      // 编译轮询：第一次编译中（1），第二次成功（0）
      {
        match: "package/compile/status",
        response: () => {
          compilePolls++;
          return {
            json: {
              ret: { code: 0 },
              pkgStateList: [
                { pkgId: FORMAL_PACKAGE_ID, successStatus: compilePolls >= 2 ? 0 : 1 },
              ],
            },
          };
        },
      },
      { match: "publish/v3/app-submit", response: { json: { ret: { code: 0 } } } },
    ]);

    const channel = new AgcHarmonyChannel();
    // ---------- stage：releaseType=6 测试发布（.hap） ----------
    const beta = makeCtx({ appId: APP_ID, releaseType: "6" }, hapPath);
    const betaPlan = await channel.plan(beta.ctx);
    // 不变量：测试发布是 stage-only（无提审动作，afterApproval=none(beta)）
    expect(betaPlan.action).toBe("stage-only");
    expect(betaPlan.afterApproval).toBe("none(beta)");
    const stageResult = await channel.stage(beta.ctx);
    expect(stageResult).toEqual({ ok: true, ref: BETA_OBJECT_ID });
    // 不变量：beta 链路绝不调用 app-submit（测试发布无提审概念）
    expect(fetchMock.calls.some((c) => c.url.includes("app-submit"))).toBe(false);
    // PUT 上传的是真实 .hap 字节（非空产物）
    expect(fetchMock.calls.find((c) => c.url === "https://obs-agc.example.com/beta")!.body).toEqual(
      hapBytes,
    );

    // ---------- submit：.app 整包 v3 全链（同渠道实例） ----------
    const formal = makeCtx({ appId: APP_ID }, appPath);
    const formalPlan = await channel.plan(formal.ctx);
    expect(formalPlan.action).toBe("stage+submit");
    const submitP = channel.submit(formal.ctx);
    // 编译轮询间隔 15s：推进两次轮询（第一次 1=编译中 → 等待 → 第二次 0=完成）
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    const submitResult = await submitP;
    expect(submitResult.ok).toBe(true);

    // 不变量：formal objectId 贯穿 —— upload-url 返回的 objectId 进绑定 body
    const formalBind = fetchMock.calls.find(
      (c) => c.url.includes("app-package-info") && !c.url.includes("releaseType=6"),
    )!;
    expect(formalBind.url).toContain("releaseType=1");
    expect(JSON.parse(formalBind.body as string)).toEqual({
      fileName: "entry-release-signed.app",
      objectId: FORMAL_OBJECT_ID,
    });
    // 不变量：绑定返回的 packageId 进编译轮询 query（同一 packageId 查询两次：1 → 0）
    const pollCalls = fetchMock.calls.filter((c) => c.url.includes("pkgIds="));
    expect(pollCalls).toHaveLength(2);
    for (const p of pollCalls) expect(p.url).toContain(`pkgIds=${FORMAL_PACKAGE_ID}`);
    // 不变量：successStatus=0 后才 POST app-submit（提审在编译完成之后）
    const submitCallIdx = fetchMock.calls.findIndex((c) => c.url.includes("publish/v3/app-submit"));
    expect(submitCallIdx).toBeGreaterThan(
      fetchMock.calls.findIndex((c) => c === (pollCalls[1] ?? pollCalls[0])),
    );
    expect(compilePolls).toBe(2);
    // 事件流：auth → upload → bind → wait → submit → done
    const phases = formal.events.filter((e) => e.type === "phase").map((e) => e.phase);
    expect(phases).toEqual(["auth", "upload", "bind", "wait", "submit", "done"]);

    // ---------- status：未接入，契约返回 unknown ----------
    const st = await channel.status();
    expect(st.state).toBe("unknown");
  });
});
