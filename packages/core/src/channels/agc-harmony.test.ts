import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgcHarmonyChannel, getHarmonyAppId } from "./agc-harmony.js";
import { mockFetch, makeTestCtx } from "../test-utils.js";

const TOKEN = "tok-abc123";
const ARTIFACT = path.join(os.tmpdir(), "applift-test-agc-harmony.app");
const FILE_CONTENT = Buffer.from("harmony-app-bytes");

const TOKEN_ROUTE = {
  match: "oauth2/v1/token",
  response: { json: { ret: { code: 0 }, access_token: TOKEN } },
};

function obsRoutes(overrides: Partial<Record<string, unknown>> = {}) {
  const urlInfo = {
    url: "https://obs.example.com/bucket/obj-1",
    objectId: "obj-1",
    method: "PUT",
    headers: { "x-obs-acl": "public-read" },
    ...overrides,
  };
  return urlInfo;
}

beforeEach(() => {
  fs.writeFileSync(ARTIFACT, FILE_CONTENT);
});

afterEach(() => {
  try {
    fs.unlinkSync(ARTIFACT);
  } catch {
    /* ignore */
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function baseCtx(over: Parameters<typeof makeTestCtx>[0] = {}) {
  return makeTestCtx({
    credentials: { AGC_CLIENT_ID: "cid-1", AGC_CLIENT_SECRET: "sec-1" },
    target: { appId: "app-1" },
    artifactPath: ARTIFACT,
    ...over,
  });
}

describe("AgcHarmonyChannel 元数据", () => {
  it("id/label/capabilities", async () => {
    const ch = new AgcHarmonyChannel();
    expect(ch.id).toBe("agc-harmony");
    expect(ch.label).toBe("华为 AGC(鸿蒙)");
    expect(ch.capabilities).toEqual({ stage: true, submit: true, scheduled: true, status: false });
    await expect(ch.plan(baseCtx().ctx)).resolves.toMatchObject({
      channel: "agc-harmony",
      platform: "harmony",
    });
  });

  it("plan：releaseType=6 为 stage-only 不提审", async () => {
    const ch = new AgcHarmonyChannel();
    const { ctx } = baseCtx({ target: { appId: "app-1", releaseType: "6" } });
    const plan = await ch.plan(ctx);
    expect(plan.action).toBe("stage-only");
    expect(plan.afterApproval).toBe("none(beta)");
  });

  it("plan：默认 stage+submit，releaseTime 存在时 scheduled", async () => {
    const ch = new AgcHarmonyChannel();
    const { ctx } = baseCtx({ target: { appId: "app-1", releaseTime: "2026-01-01 10:00:00" } });
    Object.assign(ctx, { releaseTime: "2026-01-01 10:00:00" });
    expect((await ch.plan(ctx)).afterApproval).toBe("scheduled");
    const { ctx: ctx2 } = baseCtx();
    expect((await ch.plan(ctx2)).afterApproval).toBe("auto-publish");
  });

  it("status 未接入，返回 unknown", async () => {
    const st = await new AgcHarmonyChannel().status();
    expect(st.state === "unknown" && st.raw ? st.raw : "").toContain("未接入");
  });
});
describe("getHarmonyAppId", () => {
  it("按 bundleName 大小写不敏感匹配，兼容 AppId/BundleName 大写字段", async () => {
    const { calls } = mockFetch([
      TOKEN_ROUTE,
      {
        match: "appid-list",
        response: {
          json: {
            ret: { code: 0 },
            appIdList: [{ AppId: "APP-9", BundleName: "Com.Example.Foo" }],
          },
        },
      },
    ]);
    const appId = await getHarmonyAppId({
      clientId: "cid",
      token: "tk",
      bundleName: "com.example.foo",
    });
    expect(appId).toBe("APP-9");
    const call = calls.find((c) => c.url.includes("appid-list"))!;
    expect(call.url).toContain("packageTypes=7");
    expect(call.url).toContain("packageName=com.example.foo");
    expect(call.headers).toEqual({ client_id: "cid", Authorization: "Bearer tk" });
  });

  it("未找到 bundleName 抛错", async () => {
    mockFetch([
      TOKEN_ROUTE,
      {
        match: "appid-list",
        response: {
          json: { ret: { code: 0 }, appIds: [{ appId: "a1", bundleName: "other.pkg" }] },
        },
      },
    ]);
    await expect(
      getHarmonyAppId({ clientId: "cid", token: "tk", bundleName: "com.example.foo" }),
    ).rejects.toThrow("AGC 未找到 bundleName=com.example.foo 的鸿蒙应用");
  });
});

describe("AgcHarmonyChannel.submit 全链路", () => {
  it("上传→绑定→轮询编译→提审（含编译中重查、204144719 重试）", async () => {
    vi.useFakeTimers();
    const sha256 = createHash("sha256").update(FILE_CONTENT).digest("hex");
    let compileCalls = 0;
    let submitCalls = 0;
    const { find } = mockFetch([
      TOKEN_ROUTE,
      {
        // 第一次轮询：其他包在编（未匹配 pkgId）→ 视为编译中；第二次：本包仍在编（1）；第三次：成功（0）
        match: "compile/status",
        response: () => {
          compileCalls += 1;
          if (compileCalls === 1)
            return {
              json: { ret: { code: 0 }, pkgStateList: [{ pkgId: "other", successStatus: 1 }] },
            };
          if (compileCalls === 2)
            return {
              json: { ret: { code: 0 }, pkgStateList: [{ pkgId: "pkg-1", successStatus: 1 }] },
            };
          return {
            json: { ret: { code: 0 }, pkgStateList: [{ pkgId: "pkg-1", successStatus: 0 }] },
          };
        },
      },
      {
        match: "app-submit",
        response: () => {
          submitCalls += 1;
          if (submitCalls === 1)
            return {
              json: { ret: { code: 204144719, msg: "release audit package is compiling" } },
            };
          return { json: { ret: { code: 0 } } };
        },
      },
      { match: "upload-url", response: { json: { ret: { code: 0 }, urlInfo: obsRoutes() } } },
      { match: "obs.example.com", response: { status: 200, text: "" } },
      { match: "app-package-info", response: { json: { ret: { code: 0 }, packageId: "pkg-1" } } },
      {
        match: "app-info",
        response: { json: { ret: { code: 0 }, appInfo: { defaultLang: "zh-CN" } } },
      },
      { match: "app-language-info", response: { json: { ret: { code: 0 } } } },
    ]);

    const { ctx, events } = baseCtx({ updateDescription: "修复若干问题" });
    const ch = new AgcHarmonyChannel();
    const p = ch.submit(ctx);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await p;

    expect(result).toEqual({ ok: true });
    expect(compileCalls).toBe(3);
    expect(submitCalls).toBe(2);

    // token 请求形状
    const tokenCall = find("oauth2/v1/token")!;
    expect(tokenCall.method).toBe("POST");
    expect(JSON.parse(String(tokenCall.body ?? ""))).toEqual({
      grant_type: "client_credentials",
      client_id: "cid-1",
      client_secret: "sec-1",
    });

    // upload-url 查询参数
    const urlCall = find("upload-url")!;
    expect(urlCall.url).toContain("appId=app-1");
    expect(urlCall.url).toContain(`fileName=${encodeURIComponent("applift-test-agc-harmony.app")}`);
    expect(urlCall.url).toContain(`sha256=${sha256}`);
    expect(urlCall.url).toContain(`contentLength=${FILE_CONTENT.length}`);
    expect(urlCall.headers.Authorization).toBe(`Bearer ${TOKEN}`);

    // OBS PUT：沿用华为返回的 header，补 Content-Length
    const put = find("obs.example.com")!;
    expect(put.method).toBe("PUT");
    expect(put.headers["x-obs-acl"]).toBe("public-read");
    expect(put.headers["Content-Length"]).toBe(String(FILE_CONTENT.length));
    expect(put.body).toEqual(FILE_CONTENT);

    // v3 绑定
    const bind = find("app-package-info")!;
    expect(bind.method).toBe("PUT");
    expect(bind.url).toContain("releaseType=1");
    expect(JSON.parse(String(bind.body ?? ""))).toEqual({
      fileName: "applift-test-agc-harmony.app",
      objectId: "obj-1",
    });

    // 文案写入默认语言位
    const lang = find("app-language-info")!;
    expect(JSON.parse(String(lang.body ?? ""))).toEqual({
      lang: "zh-CN",
      newFeatures: "修复若干问题",
    });

    // 提审请求形状
    const submit = find("app-submit")!;
    expect(submit.method).toBe("POST");
    expect(submit.url).toBe(
      `https://connect-api.cloud.huawei.com/api/publish/v3/app-submit?appId=app-1`,
    );
    expect(JSON.parse(String(submit.body ?? ""))).toEqual({ releaseType: 1 });

    // 事件：编译重查 + 提审重试 warn + done
    expect(
      events.some(
        (e) => e.type === "progress" && String(e.detail).includes("编译中（successStatus=1）"),
      ),
    ).toBe(true);
    expect(
      events.some((e) => e.type === "progress" && String(e.detail).includes("软件包编译完成")),
    ).toBe(true);
    expect(events.some((e) => e.type === "warn" && String(e.message).includes("提审暂缓"))).toBe(
      true,
    );
    expect(events.at(-1)).toMatchObject({ type: "phase", phase: "done" });
  });

  it("successStatus=2 抛签名/证书错误", async () => {
    vi.useFakeTimers();
    mockFetch([
      TOKEN_ROUTE,
      {
        match: "compile/status",
        response: {
          json: { ret: { code: 0 }, pkgStateList: [{ pkgId: "pkg-1", successStatus: 2 }] },
        },
      },
      { match: "upload-url", response: { json: { ret: { code: 0 }, urlInfo: obsRoutes() } } },
      { match: "obs.example.com", response: { status: 200, text: "" } },
      { match: "app-package-info", response: { json: { ret: { code: 0 }, packageId: "pkg-1" } } },
    ]);
    const { ctx } = baseCtx();
    const p = new AgcHarmonyChannel().submit(ctx);
    const assertion = expect(p).rejects.toThrow(
      "AGC 编译拒绝（packageId pkg-1）：签名/证书/bundleName 不匹配",
    );
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("提审错误含「编译」字样但非 204144719/204144727 时不重试，立即抛原错误", async () => {
    vi.useFakeTimers();
    let submitCalls = 0;
    mockFetch([
      TOKEN_ROUTE,
      {
        match: "compile/status",
        response: {
          json: { ret: { code: 0 }, pkgStateList: [{ pkgId: "pkg-1", successStatus: 0 }] },
        },
      },
      { match: "upload-url", response: { json: { ret: { code: 0 }, urlInfo: obsRoutes() } } },
      { match: "obs.example.com", response: { status: 200, text: "" } },
      { match: "app-package-info", response: { json: { ret: { code: 0 }, packageId: "pkg-1" } } },
      {
        match: "app-submit",
        response: () => {
          submitCalls += 1;
          return { json: { ret: { code: 500000, msg: "应用被驳回：编译产物信息不完整" } } };
        },
      },
    ]);
    const { ctx } = baseCtx();
    // 不推进定时器：若被误判为可重试，会先 sleep 15s 卡住且 submitCalls 增加
    await expect(new AgcHarmonyChannel().submit(ctx)).rejects.toThrow(
      "AGC 提交审核失败 500000: 应用被驳回：编译产物信息不完整",
    );
    expect(submitCalls).toBe(1);
  });

  it("非 .app 后缀抛错", async () => {
    const apk = path.join(os.tmpdir(), "applift-test-agc-harmony.apk");
    fs.writeFileSync(apk, FILE_CONTENT);
    mockFetch([TOKEN_ROUTE]);
    const { ctx } = baseCtx({ artifactPath: apk });
    try {
      await expect(new AgcHarmonyChannel().submit(ctx)).rejects.toThrow(
        "鸿蒙上架只接受 DevEco 打出的 .app 整包",
      );
    } finally {
      fs.unlinkSync(apk);
    }
  });

  it("releaseType=6 不自动提审", async () => {
    const { ctx } = baseCtx({ target: { appId: "app-1", releaseType: "6" } });
    const r = await new AgcHarmonyChannel().submit(ctx);
    expect(r).toEqual({ ok: false, error: expect.stringContaining("不做自动提审") });
  });

  it("缺少凭据抛错（含键名）", async () => {
    mockFetch([]);
    const { ctx } = makeTestCtx({
      credentials: { AGC_CLIENT_SECRET: "sec-1" },
      target: {},
      artifactPath: ARTIFACT,
    });
    await expect(new AgcHarmonyChannel().submit(ctx)).rejects.toThrow(
      "AGC 鸿蒙渠道缺少 AGC_CLIENT_ID",
    );
  });

  it("upload-url 返回非 0 错误码抛错", async () => {
    mockFetch([
      TOKEN_ROUTE,
      { match: "upload-url", response: { json: { ret: { code: 1003, msg: "invalid app" } } } },
    ]);
    const { ctx } = baseCtx();
    await expect(new AgcHarmonyChannel().submit(ctx)).rejects.toThrow(
      "AGC 获取上传地址失败 1003: invalid app",
    );
  });

  it("appId 缺省时按 bundleName 查询", async () => {
    mockFetch([
      TOKEN_ROUTE,
      {
        match: "appid-list",
        response: {
          json: { ret: { code: 0 }, appIds: [{ appId: "resolved-1", bundleName: "com.foo" }] },
        },
      },
      { match: "upload-url", response: { json: { ret: { code: 0 }, urlInfo: obsRoutes() } } },
      { match: "obs.example.com", response: { status: 200, text: "" } },
      { match: "app-package-info", response: { json: { ret: { code: 0 }, packageId: "pkg-1" } } },
    ]);
    const { ctx, events } = baseCtx({ target: { bundleName: "com.foo" } });
    const r = await new AgcHarmonyChannel().stage(ctx);
    expect(r).toEqual({ ok: true, ref: "pkg-1" });
    expect(
      events.some((e) => e.type === "progress" && String(e.detail).includes("bundleName=com.foo")),
    ).toBe(true);
  });
});

describe("AgcHarmonyChannel.stage（releaseType=6 测试发布）", () => {
  it("走测试发布路径：releaseType=6 上传/绑定/文案，不提审，绑定失败不阻断", async () => {
    let bindCalls = 0;
    const { find } = mockFetch([
      TOKEN_ROUTE,
      {
        match: "app-package-info",
        response: () => {
          bindCalls += 1;
          return { json: { ret: { code: 800, msg: "bind fail" } } };
        },
      },
      { match: "upload-url", response: { json: { ret: { code: 0 }, urlInfo: obsRoutes() } } },
      { match: "obs.example.com", response: { status: 200, text: "" } },
      { match: "app-info", response: { json: { ret: { code: 0 }, appInfo: {} } } },
      { match: "app-language-info", response: { json: { ret: { code: 0 } } } },
    ]);

    const { ctx, events } = baseCtx({
      target: { appId: "app-1", releaseType: "6" },
      updateDescription: "beta 文案",
    });
    const r = await new AgcHarmonyChannel().stage(ctx);

    expect(r).toEqual({ ok: true, ref: "obj-1" });
    // 测试发布：upload-url 与绑定/文案都带 releaseType=6
    expect(find("upload-url")!.url).toContain("releaseType=6");
    expect(bindCalls).toBe(1);
    expect(find("app-package-info")!.url).toContain("releaseType=6");
    // defaultLang 缺省回退 zh-CN
    expect(JSON.parse(String(find("app-language-info")?.body ?? ""))).toEqual({
      lang: "zh-CN",
      newFeatures: "beta 文案",
    });
    // 无提审请求
    expect(find("app-submit")).toBeUndefined();
    // 绑定失败仅 warn 不阻断
    expect(
      events.some((e) => e.type === "warn" && String(e.message).includes("软件包绑定未成功")),
    ).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "phase", phase: "done" });
  });

  it("stage 正式路径返回 packageId，updateDescription 缺省跳过文案", async () => {
    const { find } = mockFetch([
      TOKEN_ROUTE,
      { match: "upload-url", response: { json: { ret: { code: 0 }, urlInfo: obsRoutes() } } },
      { match: "obs.example.com", response: { status: 200, text: "" } },
      { match: "app-package-info", response: { json: { ret: { code: 0 }, packageId: "pkg-1" } } },
    ]);
    const { ctx } = baseCtx();
    const r = await new AgcHarmonyChannel().stage(ctx);
    expect(r).toEqual({ ok: true, ref: "pkg-1" });
    expect(find("app-info")).toBeUndefined();
    expect(find("app-language-info")).toBeUndefined();
  });
});

describe("AgcHarmonyChannel 异常与分支补齐", () => {
  it("响应非 JSON 抛「返回非 JSON」", async () => {
    mockFetch([
      TOKEN_ROUTE,
      { match: "upload-url", response: { status: 500, text: "<html>gateway error</html>" } },
    ]);
    const { ctx } = baseCtx();
    await expect(new AgcHarmonyChannel().submit(ctx)).rejects.toThrow(
      "AGC 获取上传地址返回非 JSON（HTTP 500）",
    );
  });

  it("HTTP !ok 且 ret 缺失时 code 回退 HTTP 状态码、desc 回退 JSON 摘要", async () => {
    mockFetch([
      TOKEN_ROUTE,
      { match: "appid-list", response: { status: 502, json: { foo: "bar" } } },
    ]);
    await expect(
      getHarmonyAppId({ clientId: "cid", token: "tk", bundleName: "com.foo" }),
    ).rejects.toThrow('AGC 查询应用列表失败 502: {"foo":"bar"}');
  });

  it("编译轮询持续编译中超时抛错", async () => {
    vi.useFakeTimers();
    mockFetch([
      TOKEN_ROUTE,
      {
        match: "compile/status",
        response: {
          json: { ret: { code: 0 }, pkgStateList: [{ pkgId: "pkg-1", successStatus: 1 }] },
        },
      },
      { match: "upload-url", response: { json: { ret: { code: 0 }, urlInfo: obsRoutes() } } },
      { match: "obs.example.com", response: { status: 200, text: "" } },
      { match: "app-package-info", response: { json: { ret: { code: 0 }, packageId: "pkg-1" } } },
    ]);
    const { ctx } = baseCtx();
    const p = new AgcHarmonyChannel().submit(ctx);
    const assertion = expect(p).rejects.toThrow("AGC 编译超时（15 分钟，packageId pkg-1）");
    await vi.advanceTimersByTimeAsync(16 * 60 * 1000);
    await assertion;
  });

  it("编译状态 pkgStateList 缺失视为编译中，恢复后继续", async () => {
    vi.useFakeTimers();
    let compileCalls = 0;
    mockFetch([
      TOKEN_ROUTE,
      {
        match: "compile/status",
        response: () => {
          compileCalls += 1;
          if (compileCalls === 1) return { json: { ret: { code: 0 } } };
          return {
            json: { ret: { code: 0 }, pkgStateList: [{ pkgId: "pkg-1", successStatus: 0 }] },
          };
        },
      },
      { match: "upload-url", response: { json: { ret: { code: 0 }, urlInfo: obsRoutes() } } },
      { match: "obs.example.com", response: { status: 200, text: "" } },
      { match: "app-package-info", response: { json: { ret: { code: 0 }, packageId: "pkg-1" } } },
      { match: "app-submit", response: { json: { ret: { code: 0 } } } },
    ]);
    const { ctx, events } = baseCtx();
    const p = new AgcHarmonyChannel().submit(ctx);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(p).resolves.toEqual({ ok: true });
    expect(compileCalls).toBe(2);
    expect(
      events.some(
        (e) =>
          e.type === "progress" && String(e.detail).includes("编译中（successStatus=undefined）"),
      ),
    ).toBe(true);
  });

  it("绑定无 packageId 时跳过编译轮询直接提审，releaseTime +08:00 规范化去冒号", async () => {
    const { find } = mockFetch([
      TOKEN_ROUTE,
      { match: "upload-url", response: { json: { ret: { code: 0 }, urlInfo: obsRoutes() } } },
      { match: "obs.example.com", response: { status: 200, text: "" } },
      { match: "app-package-info", response: { json: { ret: { code: 0 } } } },
      { match: "app-submit", response: { json: { ret: { code: 0 } } } },
    ]);
    const { ctx, events } = baseCtx();
    Object.assign(ctx, { releaseTime: "2026-06-01 10:00:00+08:00" });
    await expect(new AgcHarmonyChannel().submit(ctx)).resolves.toEqual({ ok: true });
    expect(find("compile/status")).toBeUndefined();
    expect(JSON.parse(String(find("app-submit")!.body ?? ""))).toEqual({
      releaseType: 1,
      releaseTime: "2026-06-01 10:00:00+0800",
    });
    expect(events.some((e) => e.type === "phase" && e.phase === "wait")).toBe(false);
  });

  it("releaseTime 为 Z 结尾时转 +0000", async () => {
    const { find } = mockFetch([
      TOKEN_ROUTE,
      { match: "upload-url", response: { json: { ret: { code: 0 }, urlInfo: obsRoutes() } } },
      { match: "obs.example.com", response: { status: 200, text: "" } },
      { match: "app-package-info", response: { json: { ret: { code: 0 } } } },
      { match: "app-submit", response: { json: { ret: { code: 0 } } } },
    ]);
    const { ctx } = baseCtx();
    Object.assign(ctx, { releaseTime: "2026-06-01T02:00:00Z" });
    await new AgcHarmonyChannel().submit(ctx);
    expect(JSON.parse(String(find("app-submit")!.body ?? ""))).toEqual({
      releaseType: 1,
      releaseTime: "2026-06-01T02:00:00+0000",
    });
  });

  it("提审持续「编译中」到截止后抛原错误", async () => {
    vi.useFakeTimers();
    mockFetch([
      TOKEN_ROUTE,
      {
        match: "compile/status",
        response: {
          json: { ret: { code: 0 }, pkgStateList: [{ pkgId: "pkg-1", successStatus: 0 }] },
        },
      },
      { match: "upload-url", response: { json: { ret: { code: 0 }, urlInfo: obsRoutes() } } },
      { match: "obs.example.com", response: { status: 200, text: "" } },
      { match: "app-package-info", response: { json: { ret: { code: 0 }, packageId: "pkg-1" } } },
      {
        match: "app-submit",
        response: { json: { ret: { code: 204144727, msg: "package is compiling" } } },
      },
    ]);
    const { ctx, events } = baseCtx();
    const p = new AgcHarmonyChannel().submit(ctx);
    const assertion = expect(p).rejects.toThrow("AGC 提交审核失败 204144727");
    await vi.advanceTimersByTimeAsync(16 * 60 * 1000);
    await assertion;
    expect(events.some((e) => e.type === "warn" && String(e.message).includes("提审暂缓"))).toBe(
      true,
    );
  });

  it("正式链路：urlInfo 顶层字段形态 + method 小写 + 已带 Content-Type 不覆盖", async () => {
    const { find } = mockFetch([
      TOKEN_ROUTE,
      {
        match: "upload-url",
        response: {
          json: {
            ret: { code: 0 },
            url: "https://obs.example.com/top-level-obj",
            objectId: "top-obj",
            method: "put",
            headers: { "Content-Type": "application/octet-stream" },
          },
        },
      },
      { match: "obs.example.com", response: { status: 204, text: "" } },
      { match: "app-package-info", response: { json: { ret: { code: 0 }, packageId: "pkg-top" } } },
    ]);
    const { ctx } = baseCtx();
    const r = await new AgcHarmonyChannel().stage(ctx);
    expect(r).toEqual({ ok: true, ref: "pkg-top" });
    const put = find("top-level-obj")!;
    expect(put.method).toBe("PUT");
    expect(put.headers["Content-Type"]).toBe("application/octet-stream");
  });

  it("上传地址缺 url/objectId 抛响应异常", async () => {
    mockFetch([
      TOKEN_ROUTE,
      {
        match: "upload-url",
        response: { json: { ret: { code: 0 }, urlInfo: { objectId: "obj-only" } } },
      },
    ]);
    const { ctx } = baseCtx();
    await expect(new AgcHarmonyChannel().submit(ctx)).rejects.toThrow("AGC 上传地址响应异常");

    mockFetch([
      TOKEN_ROUTE,
      {
        match: "upload-url",
        response: { json: { ret: { code: 0 }, urlInfo: { url: "https://x/y" } } },
      },
    ]);
    await expect(new AgcHarmonyChannel().submit(baseCtx().ctx)).rejects.toThrow(
      "AGC 上传地址响应异常",
    );
  });

  it("正式链路 OBS PUT 非 2xx 抛文件上传失败", async () => {
    mockFetch([
      TOKEN_ROUTE,
      { match: "upload-url", response: { json: { ret: { code: 0 }, urlInfo: obsRoutes() } } },
      { match: "obs.example.com", response: { status: 500, text: "boom" } },
    ]);
    const { ctx } = baseCtx();
    await expect(new AgcHarmonyChannel().stage(ctx)).rejects.toThrow("AGC 文件上传失败 HTTP 500");
  });

  it("测试链路 OBS PUT 非 2xx 抛文件上传失败", async () => {
    const { ctx } = baseCtx({ target: { appId: "app-1", releaseType: "6" } });
    mockFetch([
      TOKEN_ROUTE,
      { match: "upload-url", response: { json: { ret: { code: 0 }, urlInfo: obsRoutes() } } },
      { match: "obs.example.com", response: { status: 403, text: "denied" } },
    ]);
    await expect(new AgcHarmonyChannel().stage(ctx)).rejects.toThrow("AGC 文件上传失败 HTTP 403");
  });

  it("测试链路返回地址缺 url 抛错", async () => {
    const { ctx } = baseCtx({ target: { appId: "app-1", releaseType: "6" } });
    mockFetch([
      TOKEN_ROUTE,
      {
        match: "upload-url",
        response: { json: { ret: { code: 0 }, urlInfo: { objectId: "obj-1" } } },
      },
    ]);
    await expect(new AgcHarmonyChannel().stage(ctx)).rejects.toThrow("AGC 返回的上传地址为空");
  });

  it("测试链路绑定成功 + 默认语言查询失败回退 zh-CN + 文案写入失败仅告警", async () => {
    const { find } = mockFetch([
      TOKEN_ROUTE,
      { match: "upload-url", response: { json: { ret: { code: 0 }, urlInfo: obsRoutes() } } },
      { match: "obs.example.com", response: { status: 200, text: "" } },
      {
        match: "app-package-info",
        response: { json: { ret: { code: 0 }, packageId: "pkg-beta" } },
      },
      { match: "app-info", response: { json: { ret: { code: 1000, msg: "lang query fail" } } } },
      { match: "app-language-info", response: { json: { ret: { code: 900, msg: "write fail" } } } },
    ]);
    const { ctx, events } = baseCtx({
      target: { appId: "app-1", releaseType: "6" },
      updateDescription: "beta 描述",
    });
    const r = await new AgcHarmonyChannel().stage(ctx);
    expect(r).toEqual({ ok: true, ref: "obj-1" });
    expect(
      events.some(
        (e) =>
          e.type === "phase" &&
          e.phase === "bind" &&
          String(e.message).includes("软件包已绑定到应用"),
      ),
    ).toBe(true);
    // 默认语言查询失败 → lang 回退 zh-CN 再写入
    expect(JSON.parse(String(find("app-language-info")!.body ?? ""))).toEqual({
      lang: "zh-CN",
      newFeatures: "beta 描述",
    });
    expect(
      events.some(
        (e) =>
          e.type === "warn" &&
          String(e.message).includes("更新文案未写入（不阻断）: AGC 更新文案失败 900: write fail"),
      ),
    ).toBe(true);
  });

  it("正式链路文案写入失败仅告警不阻断", async () => {
    const { find } = mockFetch([
      TOKEN_ROUTE,
      { match: "upload-url", response: { json: { ret: { code: 0 }, urlInfo: obsRoutes() } } },
      { match: "obs.example.com", response: { status: 200, text: "" } },
      { match: "app-package-info", response: { json: { ret: { code: 0 }, packageId: "pkg-1" } } },
      {
        match: "app-info",
        response: { json: { ret: { code: 0 }, appInfo: { defaultLang: "en-US" } } },
      },
      { match: "app-language-info", response: { json: { ret: { code: 777, msg: "nope" } } } },
    ]);
    const { ctx, events } = baseCtx({ updateDescription: "desc" });
    const r = await new AgcHarmonyChannel().stage(ctx);
    expect(r).toEqual({ ok: true, ref: "pkg-1" });
    expect(JSON.parse(String(find("app-language-info")!.body ?? ""))).toEqual({
      lang: "en-US",
      newFeatures: "desc",
    });
    expect(
      events.some(
        (e) => e.type === "warn" && String(e.message).includes("更新文案未写入（不阻断）"),
      ),
    ).toBe(true);
  });

  it("appId/bundleName 均缺时抛错带指引", async () => {
    mockFetch([TOKEN_ROUTE]);
    const { ctx } = makeTestCtx({
      credentials: { AGC_CLIENT_ID: "cid-1", AGC_CLIENT_SECRET: "sec-1" },
      target: {},
      artifactPath: ARTIFACT,
    });
    await expect(new AgcHarmonyChannel().stage(ctx)).rejects.toThrow(
      "AGC 鸿蒙渠道缺少 bundleName（项目配置 appId / bundleName 至少配一个）",
    );
  });

  it("stage 正式：urlInfo 缺 method/headers 时回退 PUT+补 Content-Type，绑定无 packageId 时 ref 回退 objectId", async () => {
    const { find } = mockFetch([
      TOKEN_ROUTE,
      {
        match: "upload-url",
        response: {
          json: {
            ret: { code: 0 },
            urlInfo: { url: "https://obs.example.com/bare", objectId: "obj-bare" },
          },
        },
      },
      { match: "obs.example.com/bare", response: { status: 200, text: "" } },
      { match: "app-package-info", response: { json: { ret: { code: 0 } } } },
    ]);
    const { ctx } = baseCtx();
    const r = await new AgcHarmonyChannel().stage(ctx);
    expect(r).toEqual({ ok: true, ref: "obj-bare" });
    const put = find("obs.example.com/bare")!;
    expect(put.method).toBe("PUT");
    expect(put.headers["Content-Type"]).toBe("application/octet-stream");
  });

  it("stage 测试：urlInfo 顶层形态且缺 objectId → 跳过绑定，ref 为空串", async () => {
    const { find, calls } = mockFetch([
      TOKEN_ROUTE,
      {
        match: "upload-url",
        response: { json: { ret: { code: 0 }, url: "https://top.example.com/no-obj" } },
      },
      { match: "top.example.com", response: { status: 201, text: "" } },
    ]);
    const { ctx, events } = baseCtx({ target: { appId: "app-1", releaseType: "6" } });
    const r = await new AgcHarmonyChannel().stage(ctx);
    expect(r).toEqual({ ok: true, ref: "" });
    expect(find("app-package-info")).toBeUndefined();
    const put = calls.find((c) => c.url.includes("top.example.com"))!;
    expect(put.method).toBe("PUT");
    expect(put.headers["Content-Type"]).toBe("application/octet-stream");
    expect(events.some((e) => e.type === "phase" && e.phase === "done")).toBe(true);
  });

  it("响应无任何列表字段 → 空列表 → 未找到抛错", async () => {
    mockFetch([TOKEN_ROUTE, { match: "appid-list", response: { json: { ret: { code: 0 } } } }]);
    await expect(
      getHarmonyAppId({ clientId: "cid", token: "tk", bundleName: "com.foo" }),
    ).rejects.toThrow("AGC 未找到 bundleName=com.foo 的鸿蒙应用");
  });

  it("条目缺 bundleName 字段时不命中 → 未找到抛错", async () => {
    mockFetch([
      TOKEN_ROUTE,
      {
        match: "appid-list",
        response: { json: { ret: { code: 0 }, appIds: [{ appId: "lonely" }] } },
      },
    ]);
    await expect(
      getHarmonyAppId({ clientId: "cid", token: "tk", bundleName: "com.foo" }),
    ).rejects.toThrow("AGC 未找到 bundleName=com.foo 的鸿蒙应用");
  });

  it("bundleName 可来自凭据（target 未配时）", async () => {
    mockFetch([
      TOKEN_ROUTE,
      {
        match: "appid-list",
        response: {
          json: { ret: { code: 0 }, appIds: [{ appId: "cred-1", bundleName: "com.cred" }] },
        },
      },
      { match: "upload-url", response: { json: { ret: { code: 0 }, urlInfo: obsRoutes() } } },
      { match: "obs.example.com", response: { status: 200, text: "" } },
      {
        match: "app-package-info",
        response: { json: { ret: { code: 0 }, packageId: "pkg-cred" } },
      },
    ]);
    const { ctx } = makeTestCtx({
      credentials: { AGC_CLIENT_ID: "cid-1", AGC_CLIENT_SECRET: "sec-1", bundleName: "com.cred" },
      target: {},
      artifactPath: ARTIFACT,
    });
    const r = await new AgcHarmonyChannel().stage(ctx);
    expect(r).toEqual({ ok: true, ref: "pkg-cred" });
  });
});

describe("getHarmonyAppId 补充分支", () => {
  it("appIds 为非数组时按空列表处理 → 未找到抛错", async () => {
    mockFetch([
      TOKEN_ROUTE,
      { match: "appid-list", response: { json: { ret: { code: 0 }, appIds: "not-a-list" } } },
    ]);
    await expect(
      getHarmonyAppId({ clientId: "cid", token: "tk", bundleName: "com.foo" }),
    ).rejects.toThrow("AGC 未找到 bundleName=com.foo 的鸿蒙应用");
  });

  it("命中条目无 appId 字段时返回空串", async () => {
    mockFetch([
      TOKEN_ROUTE,
      {
        match: "appid-list",
        response: { json: { ret: { code: 0 }, appIds: [{ bundleName: "com.foo" }] } },
      },
    ]);
    await expect(
      getHarmonyAppId({ clientId: "cid", token: "tk", bundleName: "com.foo" }),
    ).resolves.toBe("");
  });
});
