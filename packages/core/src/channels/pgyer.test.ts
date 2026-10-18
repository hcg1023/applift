import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgyerChannel } from "./pgyer.js";
import { flushRealIo, makeTestCtx, mockFetch, type MockResponseSpec } from "../test-utils.js";

const ARTIFACT = path.join(os.tmpdir(), "pgyer-test-app-release.apk");

const COS_TOKEN_OK = {
  code: 0,
  data: {
    endpoint: "https://bucket.cos.ap-shanghai.myqcloud.com/",
    buildKey: "bk-123",
    params: { signature: "sig==", "x-cos-security-token": "cos-tok", key: "dir/app.apk" },
  },
};

const BUILD_INFO_OK = {
  code: 0,
  data: {
    buildName: "1.2.3",
    buildVersion: "12",
    buildShortcutUrl: "abc123",
    buildQRCodeURL: "https://q.png",
  },
};

type Route = { match: string | RegExp; response: MockResponseSpec | (() => MockResponseSpec) };

function baseRoutes(buildInfo?: Route["response"]): Route[] {
  return [
    { match: "getCOSToken", response: { json: COS_TOKEN_OK } },
    { match: /cos\.ap-shanghai/, response: { status: 204, text: "" } },
    { match: "buildInfo", response: buildInfo ?? { json: BUILD_INFO_OK } },
  ];
}

function allHostsFail(): Route[] {
  const resp = (): MockResponseSpec => ({ json: { code: 10086, message: "invalid api key" } });
  return [
    { match: "api.pgyer.com", response: resp },
    { match: "api.xcxwo.com", response: resp },
    { match: "api.pgyerapp.com", response: resp },
  ];
}

describe("PgyerChannel", () => {
  let ch: PgyerChannel;

  beforeEach(() => {
    fs.writeFileSync(ARTIFACT, "fake-apk-bytes");
    ch = new PgyerChannel();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    fs.rmSync(ARTIFACT, { force: true });
  });

  it("元数据: id/label/capabilities", () => {
    expect(ch.id).toBe("pgyer");
    expect(ch.label).toBe("蒲公英");
    expect(ch.capabilities).toEqual({
      stage: true,
      submit: false,
      scheduled: false,
      status: false,
    });
  });

  it("plan 返回 stage-only 计划并按扩展名识别平台", async () => {
    const { ctx } = makeTestCtx({ artifactPath: "/tmp/a.hap" });
    await expect(ch.plan(ctx)).resolves.toMatchObject({
      channel: "pgyer",
      platform: "harmony",
      action: "stage-only",
      afterApproval: "none(beta)",
    });
    const { ctx: ipaCtx } = makeTestCtx({ artifactPath: "/tmp/a.ipa" });
    await expect(ch.plan(ipaCtx)).resolves.toMatchObject({ platform: "ios" });
    const { ctx: apkCtx } = makeTestCtx({ artifactPath: "/tmp/a.apk" });
    await expect(ch.plan(apkCtx)).resolves.toMatchObject({ platform: "android" });
  });

  it("stage 全流程: getCOSToken → COS 上传 → buildInfo 轮询（1247 处理中 → code=0 出短链）", async () => {
    vi.useFakeTimers();
    let polls = 0;
    const fetchMock = mockFetch(
      baseRoutes(() =>
        polls++ === 0
          ? { json: { code: 1247, message: "buildKey not found" } }
          : { json: BUILD_INFO_OK },
      ),
    );
    const { ctx, events } = makeTestCtx({
      credentials: { PGYER_API_KEY: "pk-test" },
      artifactPath: ARTIFACT,
      updateDescription: "修复若干问题",
    });

    const p = ch.stage(ctx);
    // fileBlob 惰性读走真实线程池：先 flush 事件循环再驱动 fake 时钟，否则 sleep 定时器挂不上
    await flushRealIo();
    // 两次轮询各一次 sleep(3000)，一次推进 6s 驱动两轮
    await vi.advanceTimersByTimeAsync(6000);
    const result = await p;

    expect(result).toEqual({ ok: true, ref: "bk-123" });

    // getCOSToken 请求形状
    const tokenCall = fetchMock.find("getCOSToken");
    expect(tokenCall?.url).toBe("https://api.pgyer.com/apiv2/app/getCOSToken");
    expect(tokenCall?.method).toBe("POST");
    expect(tokenCall?.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(tokenCall?.body as string);
    expect(form.get("_api_key")).toBe("pk-test");
    expect(form.get("buildType")).toBe("android");
    expect(form.get("buildUpdateDescription")).toBe("修复若干问题");

    // COS 上传形状（FormData）
    const uploadCall = fetchMock.calls.find((c) => c.url.includes("cos.ap-shanghai"));
    expect(uploadCall?.url).toBe("https://bucket.cos.ap-shanghai.myqcloud.com/");
    expect(uploadCall?.method).toBe("POST");
    const fd = uploadCall?.body as FormData;
    expect(fd.get("signature")).toBe("sig==");
    expect(fd.get("x-cos-security-token")).toBe("cos-tok");
    expect(fd.get("key")).toBe("dir/app.apk");
    expect(fd.get("x-cos-meta-file-name")).toBe("pgyer-test-app-release.apk");
    expect((fd.get("file") as File).name).toBe("pgyer-test-app-release.apk");
    // openAsBlob 惰性 Blob 字节数与源文件一致（file-blob 契约）
    expect((fd.get("file") as File).size).toBe(fs.statSync(ARTIFACT).size);

    // buildInfo 请求形状 + 轮询两次
    const infoCall = fetchMock.find("buildInfo");
    const infoForm = new URLSearchParams(infoCall?.body as string);
    expect(infoForm.get("_api_key")).toBe("pk-test");
    expect(infoForm.get("buildKey")).toBe("bk-123");
    expect(fetchMock.calls.filter((c) => c.url.includes("buildInfo"))).toHaveLength(2);

    // 事件流: auth → upload → wait → done(短链)
    expect(events.map((e) => e.type)).toEqual(["phase", "phase", "phase", "phase"]);
    expect(events.at(-1)).toMatchObject({ phase: "done", message: "https://www.pgyer.com/abc123" });
    // P2-4 契约：pgyerPost（getCOSToken/buildInfo）与 COS 上传全部 fetch 带 AbortSignal 超时
    for (const c of fetchMock.calls) expect(c.signal).toBeInstanceOf(AbortSignal);
  });

  it("stage 密码安装: installPassword 传 buildInstallType=2 + buildPassword（v1 回归）", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch(baseRoutes(() => ({ json: BUILD_INFO_OK })));
    const { ctx } = makeTestCtx({
      credentials: { PGYER_API_KEY: "pk-test" },
      artifactPath: ARTIFACT,
    });
    (ctx as { installPassword?: string }).installPassword = "secret-123";

    const p = ch.stage(ctx);
    await flushRealIo();
    await vi.advanceTimersByTimeAsync(6000);
    await p;

    const form = new URLSearchParams(fetchMock.find("getCOSToken")?.body as string);
    expect(form.get("buildInstallType")).toBe("2");
    expect(form.get("buildPassword")).toBe("secret-123");
  });

  it("主域名失败切换备用域名", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch([
      { match: "api.pgyer.com/apiv2/app/getCOSToken", response: { status: 500, text: "oops" } },
      { match: "api.xcxwo.com", response: { json: COS_TOKEN_OK } },
      { match: /cos\.ap-shanghai/, response: { status: 204, text: "" } },
      { match: "buildInfo", response: { json: BUILD_INFO_OK } },
    ]);
    const { ctx, events } = makeTestCtx({
      credentials: { PGYER_API_KEY: "pk" },
      artifactPath: ARTIFACT,
    });

    const p = ch.stage(ctx);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toEqual({ ok: true, ref: "bk-123" });
    expect(fetchMock.find("api.xcxwo.com/apiv2/app/getCOSToken")).toBeTruthy();
    expect(
      events.some((e) => e.type === "warn" && String(e.message).includes("api.pgyer.com 不可用")),
    ).toBe(true);
  });

  it("全部域名失败时抛最后错误", async () => {
    const fetchMock = mockFetch(allHostsFail());
    const { ctx } = makeTestCtx({ credentials: { PGYER_API_KEY: "pk" }, artifactPath: ARTIFACT });
    await expect(ch.stage(ctx)).rejects.toThrow("getCOSToken 失败 10086: invalid api key");
    expect(fetchMock.calls.filter((c) => c.url.includes("getCOSToken"))).toHaveLength(3);
  });

  it("全部域名抛非 Error（网络层字符串异常）→ 统一转蒲公英凭证获取失败", async () => {
    const boom = (): MockResponseSpec => {
      throw "network-down";
    };
    mockFetch([
      { match: "api.pgyer.com", response: boom },
      { match: "api.xcxwo.com", response: boom },
      { match: "api.pgyerapp.com", response: boom },
    ]);
    const { ctx } = makeTestCtx({ credentials: { PGYER_API_KEY: "pk" }, artifactPath: ARTIFACT });
    await expect(ch.stage(ctx)).rejects.toThrow("蒲公英凭证获取失败");
  });

  it("缺 PGYER_API_KEY 抛错含键名", async () => {
    const { ctx } = makeTestCtx({ credentials: {}, artifactPath: ARTIFACT });
    await expect(ch.stage(ctx)).rejects.toThrow("蒲公英缺少 PGYER_API_KEY");
  });

  it("不支持的扩展名抛错", async () => {
    const bad = ARTIFACT.replace(/\.apk$/, ".zip");
    fs.writeFileSync(bad, "x");
    const { ctx } = makeTestCtx({ credentials: { PGYER_API_KEY: "pk" }, artifactPath: bad });
    await expect(ch.stage(ctx)).rejects.toThrow("不支持的文件类型 .zip");
    fs.rmSync(bad, { force: true });
  });

  it("返回非 JSON 时抛错", async () => {
    mockFetch([
      { match: "api.pgyer.com", response: { status: 502, text: "<html>bad gateway</html>" } },
      { match: "api.xcxwo.com", response: { status: 502, text: "<html>bad gateway</html>" } },
      { match: "api.pgyerapp.com", response: { status: 502, text: "<html>bad gateway</html>" } },
    ]);
    const { ctx } = makeTestCtx({ credentials: { PGYER_API_KEY: "pk" }, artifactPath: ARTIFACT });
    // 三域名都 502 非 JSON，最终抛最后一个的解析错误
    await expect(ch.stage(ctx)).rejects.toThrow(
      "蒲公英 /apiv2/app/getCOSToken 返回非 JSON（HTTP 502）",
    );
  });

  it("COS 上传 HTTP 失败抛错", async () => {
    const fetchMock = mockFetch([
      { match: "getCOSToken", response: { json: COS_TOKEN_OK } },
      { match: /cos\.ap-shanghai/, response: { status: 403, text: "denied" } },
    ]);
    const { ctx } = makeTestCtx({ credentials: { PGYER_API_KEY: "pk" }, artifactPath: ARTIFACT });
    await expect(ch.stage(ctx)).rejects.toThrow("COS 上传失败 HTTP 403");
    expect(fetchMock.find("cos.ap-shanghai")).toBeTruthy();
  });

  it("buildInfo 非 0/1247 码 → 立即返回明确失败（只认失败码，不看文案）", async () => {
    vi.useFakeTimers();
    mockFetch(baseRoutes(() => ({ json: { code: 9001, message: "build deleted" } })));
    const { ctx } = makeTestCtx({ credentials: { PGYER_API_KEY: "pk" }, artifactPath: ARTIFACT });

    const p = ch.stage(ctx);
    await flushRealIo();
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toEqual({ ok: false, error: "蒲公英处理失败 9001: build deleted" });
  });

  it("buildInfo 1247（无 message）→ 视为处理中继续轮询直至成功（对拍 apkgo pgyer.go）", async () => {
    vi.useFakeTimers();
    let calls = 0;
    mockFetch(
      baseRoutes(() => (calls++ === 0 ? { json: { code: 1247 } } : { json: BUILD_INFO_OK })),
    );
    const { ctx } = makeTestCtx({ credentials: { PGYER_API_KEY: "pk" }, artifactPath: ARTIFACT });

    const p = ch.stage(ctx);
    await flushRealIo();
    await vi.advanceTimersByTimeAsync(6000);
    await expect(p).resolves.toEqual({ ok: true, ref: "bk-123" });
  });

  it("code=0 未出短链（message 含 error 文案）→ 不按文案正则判败，继续轮询直至出短链", async () => {
    vi.useFakeTimers();
    let calls = 0;
    mockFetch(
      baseRoutes(() =>
        calls++ === 0
          ? { json: { code: 0, message: "build is processing, no error yet", data: {} } }
          : { json: BUILD_INFO_OK },
      ),
    );
    const { ctx } = makeTestCtx({ credentials: { PGYER_API_KEY: "pk" }, artifactPath: ARTIFACT });

    const p = ch.stage(ctx);
    await flushRealIo();
    await vi.advanceTimersByTimeAsync(6000);
    await expect(p).resolves.toEqual({ ok: true, ref: "bk-123" });
  });

  it("buildInfo 主域名持续 502 → 备用域名接管 → 最终 done", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch([
      { match: "getCOSToken", response: { json: COS_TOKEN_OK } },
      { match: /cos\.ap-shanghai/, response: { status: 204, text: "" } },
      {
        match: "api.pgyer.com/apiv2/app/buildInfo",
        response: { status: 502, text: "<html>bad gateway</html>" },
      },
      { match: "api.xcxwo.com/apiv2/app/buildInfo", response: { json: BUILD_INFO_OK } },
    ]);
    const { ctx, events } = makeTestCtx({
      credentials: { PGYER_API_KEY: "pk" },
      artifactPath: ARTIFACT,
    });

    const p = ch.stage(ctx);
    await flushRealIo();
    await vi.advanceTimersByTimeAsync(6000);
    await expect(p).resolves.toEqual({ ok: true, ref: "bk-123" });
    expect(fetchMock.find("api.xcxwo.com/apiv2/app/buildInfo")).toBeTruthy();
    expect(
      events.some((e) => e.type === "warn" && String(e.message).includes("api.pgyer.com 不可用")),
    ).toBe(true);
  });

  it("buildInfo 全域名持续失败 → 连续 10 次后提前失败（文案含控制台）", async () => {
    vi.useFakeTimers();
    const bad = (): MockResponseSpec => ({ status: 502, text: "<html>bad gateway</html>" });
    const fetchMock = mockFetch([
      { match: "getCOSToken", response: { json: COS_TOKEN_OK } },
      { match: /cos\.ap-shanghai/, response: { status: 204, text: "" } },
      { match: "api.pgyer.com", response: bad },
      { match: "api.xcxwo.com", response: bad },
      { match: "api.pgyerapp.com", response: bad },
    ]);
    const { ctx, events } = makeTestCtx({
      credentials: { PGYER_API_KEY: "pk" },
      artifactPath: ARTIFACT,
    });

    const p = ch.stage(ctx);
    await flushRealIo();
    await vi.advanceTimersByTimeAsync(10 * 3000 + 2000);
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain(
      "蒲公英状态查询持续失败（包已上传，可到控制台确认）",
    );
    // 10 轮 × 3 域名全试尽；轮询计数在成功时清零，此处每轮 3 域名计 1 次连续失败
    expect(fetchMock.calls.filter((c) => c.url.includes("buildInfo"))).toHaveLength(30);
    expect(events.some((e) => e.type === "warn" && String(e.message).includes("10/10"))).toBe(true);
  });

  it("15 分钟超时返回错误", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch(
      baseRoutes(() => ({ json: { code: 1247, message: "buildKey not found" } })),
    );
    const { ctx } = makeTestCtx({ credentials: { PGYER_API_KEY: "pk" }, artifactPath: ARTIFACT });

    const p = ch.stage(ctx);
    // 推进 15 分钟以上，驱动所有轮询轮次
    await flushRealIo();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 10_000);
    await expect(p).resolves.toEqual({
      ok: false,
      error:
        "蒲公英 15 分钟内未完成处理（大包云端处理慢属正常，可到 pgyer.com 控制台确认实际状态）",
    });
    // 3000ms 一轮 → 300 轮；buildInfo 走三域名 failover，首轮成功即止（1247 有效 JSON）→ 每轮 1 次
    expect(fetchMock.calls.filter((c) => c.url.includes("buildInfo"))).toHaveLength(300);
  });

  it("submit 返回不支持错误; status 返回 unknown", async () => {
    await expect(ch.submit()).resolves.toEqual({
      ok: false,
      error: "蒲公英为内测渠道，无提审概念",
    });
    await expect(ch.status()).resolves.toEqual({ state: "unknown", raw: "蒲公英无审核状态" });
  });
});
