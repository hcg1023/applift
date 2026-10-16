import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HuaweiAndroidChannel, WAIT_BEFORE_SUBMIT_MS } from "./huawei.js";
import { mockFetch, readStreamToBuffer, type MockCall } from "../test-utils.js";
import type { ChannelContext } from "../channel.js";

const TOKEN_BODY = { access_token: "tok-123", ret: { code: 0 } };

function makeCtx(overrides: Partial<ChannelContext> = {}): ChannelContext {
  return {
    credentials: overrides.credentials ?? {
      HW_CLIENT_ID: "cid",
      HW_CLIENT_SECRET: "sec",
      appId: "app-001",
    },
    target: overrides.target ?? {},
    artifactPath: overrides.artifactPath ?? artifactPath,
    updateDescription: overrides.updateDescription,
    releaseTime: overrides.releaseTime,
    remark: overrides.remark,
    emit: overrides.emit ?? (() => {}),
  } as ChannelContext;
}

let artifactPath: string;
let artifactSha256: string;
const artifactContent = Buffer.from("fake-apk-content");

beforeAll(() => {
  artifactPath = path.join(os.tmpdir(), `huawei-test-${process.pid}.apk`);
  fs.writeFileSync(artifactPath, artifactContent);
  artifactSha256 = crypto.createHash("sha256").update(artifactContent).digest("hex");
});

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 标准三条路由：token / upload-url / OBS / file-info */
function happyRoutes(opts: { obsHeaders?: Record<string, string> } = {}) {
  return [
    { match: "oauth2/v1/token", response: { status: 200, json: TOKEN_BODY } },
    {
      match: "upload-url/for-obs",
      response: {
        status: 200,
        json: {
          ret: { code: 0 },
          urlInfo: {
            url: "https://obs.example.com/bucket/pkg.apk?signature=abc",
            objectId: "obj-777",
            headers: opts.obsHeaders,
          },
        },
      },
    },
    { match: "obs.example.com", response: { status: 200, text: "" } },
    { match: "app-file-info", response: { status: 200, json: { ret: { code: 0 } } } },
  ];
}

function obsCall(calls: MockCall[]): MockCall {
  return calls.find((c) => c.url.includes("obs.example.com"))!;
}

describe("HuaweiAndroidChannel 元数据", () => {
  const ch = new HuaweiAndroidChannel();

  it("id/label/capabilities", () => {
    expect(ch.id).toBe("huawei");
    expect(ch.label).toBe("华为应用市场");
    expect(ch.capabilities).toEqual({ stage: true, submit: true, scheduled: true, status: true });
  });

  it("plan: 有 releaseTime → afterApproval=scheduled", async () => {
    const plan = await ch.plan(makeCtx({ releaseTime: "2026-11-01 10:00" }));
    expect(plan.afterApproval).toBe("scheduled");
    expect(plan.action).toBe("stage+submit");
    expect(plan.channel).toBe("huawei");
    expect(plan.platform).toBe("android");
  });

  it("plan: 无 releaseTime → auto-publish", async () => {
    const plan = await ch.plan(makeCtx());
    expect(plan.afterApproval).toBe("auto-publish");
  });
});

describe("HuaweiAndroidChannel.status", () => {
  /** releaseState 全表 —— 对拍 python/android-publish hw_query.py（真机验证权威） */
  const RELEASE_STATES: Array<[number, unknown]> = [
    [0, { state: "approved", live: true }], // 已上架
    [1, { state: "rejected" }], // 审核不通过（无 auditDesc → reason undefined）
    [2, { state: "unknown", raw: "已下架（releaseState=2）" }],
    [3, { state: "approved", live: false }], // 待上架：审核通过、尚未上架
    [4, { state: "reviewing" }], // 审核中
    [5, { state: "reviewing" }], // 升级审核中
    [7, { state: "unknown", raw: "草稿，未提审（releaseState=7）" }],
    [8, { state: "rejected" }], // 升级审核不通过
    [11, { state: "unknown", raw: "撤销上架（releaseState=11）" }],
  ];

  it.each(RELEASE_STATES)("releaseState=%i → %o", async (releaseState, expected) => {
    mockFetch([
      { match: "oauth2/v1/token", response: { status: 200, json: TOKEN_BODY } },
      {
        match: "publish/v2/app-info",
        response: { status: 200, json: { ret: { code: 0 }, appInfo: { releaseState } } },
      },
    ]);
    await expect(new HuaweiAndroidChannel().status(makeCtx())).resolves.toEqual(expected);
  });

  it("请求形状：GET app-info，query 带 appId，头带 Bearer + client_id", async () => {
    const mf = mockFetch([
      { match: "oauth2/v1/token", response: { status: 200, json: TOKEN_BODY } },
      {
        match: "publish/v2/app-info",
        response: { status: 200, json: { ret: { code: 0 }, appInfo: { releaseState: 5 } } },
      },
    ]);
    await new HuaweiAndroidChannel().status(makeCtx());

    const call = mf.find("publish/v2/app-info")!;
    expect(call.method).toBe("GET");
    expect(new URL(call.url).searchParams.get("appId")).toBe("app-001");
    expect(call.headers.Authorization).toBe("Bearer tok-123");
    expect(call.headers.client_id).toBe("cid");
  });

  it("releaseState=1 → rejected（auditDesc 作 reason）", async () => {
    mockFetch([
      { match: "oauth2/v1/token", response: { status: 200, json: TOKEN_BODY } },
      {
        match: "publish/v2/app-info",
        response: {
          status: 200,
          json: { ret: { code: 0 }, appInfo: { releaseState: 1, auditDesc: "包名与软著不符" } },
        },
      },
    ]);
    await expect(new HuaweiAndroidChannel().status(makeCtx())).resolves.toEqual({
      state: "rejected",
      reason: "包名与软著不符",
    });
  });

  it("未知 releaseState → unknown raw 含编号", async () => {
    mockFetch([
      { match: "oauth2/v1/token", response: { status: 200, json: TOKEN_BODY } },
      {
        match: "publish/v2/app-info",
        response: { status: 200, json: { ret: { code: 0 }, appInfo: { releaseState: 99 } } },
      },
    ]);
    await expect(new HuaweiAndroidChannel().status(makeCtx())).resolves.toEqual({
      state: "unknown",
      raw: "releaseState=99（hw_query.py 全表未收录编号）",
    });
  });

  it("app-info 无 releaseState → unknown raw 含提示", async () => {
    mockFetch([
      { match: "oauth2/v1/token", response: { status: 200, json: TOKEN_BODY } },
      {
        match: "publish/v2/app-info",
        response: { status: 200, json: { ret: { code: 0 }, appInfo: {} } },
      },
    ]);
    await expect(new HuaweiAndroidChannel().status(makeCtx())).resolves.toEqual({
      state: "unknown",
      raw: expect.stringContaining("app-info 无 releaseState"),
    });
  });

  it("ret 非 0 抛错", async () => {
    mockFetch([
      { match: "oauth2/v1/token", response: { status: 200, json: TOKEN_BODY } },
      {
        match: "publish/v2/app-info",
        response: { status: 200, json: { ret: { code: 203144003, msg: "invalid app" } } },
      },
    ]);
    await expect(new HuaweiAndroidChannel().status(makeCtx())).rejects.toThrow(
      "华为 查询审核状态失败 203144003",
    );
  });

  it("缺 appId 抛错（含用途提示）", async () => {
    mockFetch([]);
    await expect(
      new HuaweiAndroidChannel().status(
        makeCtx({ credentials: { HW_CLIENT_ID: "cid", HW_CLIENT_SECRET: "sec" } }),
      ),
    ).rejects.toThrow("华为渠道缺少 appId（审核状态查询必需）");
  });
});

describe("HuaweiAndroidChannel.stage", () => {
  it("完整链路：token → upload-url → PUT → file-info 登记", async () => {
    const mf = mockFetch(happyRoutes());
    const ch = new HuaweiAndroidChannel();
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const ctx = makeCtx({ emit: (e) => events.push(e) });

    const result = await ch.stage(ctx);

    expect(result).toEqual({ ok: true, ref: "obj-777" });

    // token 请求形状
    const tc = mf.calls.find((c) => c.url.includes("oauth2/v1/token"))!;
    expect(tc.method).toBe("POST");
    expect(tc.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(tc.body ?? ""))).toEqual({
      grant_type: "client_credentials",
      client_id: "cid",
      client_secret: "sec",
    });

    // upload-url 请求形状（qs 含 appId/fileName/sha256/contentLength；headers 带 client_id + Bearer）
    const uc = mf.calls.find((c) => c.url.includes("upload-url/for-obs"))!;
    expect(uc.method).toBe("GET");
    expect(uc.headers["client_id"]).toBe("cid");
    expect(uc.headers["Authorization"]).toBe("Bearer tok-123");
    const qs = new URL(uc.url).searchParams;
    expect(qs.get("appId")).toBe("app-001");
    expect(qs.get("fileName")).toBe(path.basename(artifactPath));
    expect(qs.get("sha256")).toBe(artifactSha256);
    expect(qs.get("contentLength")).toBe(String(artifactContent.length));

    // OBS PUT：缺 Content-Type 时补 application/octet-stream，带 Content-Length；body 为流式（ReadableStream，P2-3），
    // 读尽后字节与产物一致，且带超时信号（900s）
    const oc = obsCall(mf.calls);
    expect(oc.method).toBe("PUT");
    expect(oc.headers["Content-Type"]).toBe("application/octet-stream");
    expect(oc.headers["Content-Length"]).toBe(String(artifactContent.length));
    expect(oc.body).toBeInstanceOf(ReadableStream);
    expect(await readStreamToBuffer(oc.body)).toEqual(artifactContent);
    expect(oc.signal).toBeInstanceOf(AbortSignal);

    // file-info 登记（fileType=5，fileDestUrl=objectId）
    const fc = mf.calls.find((c) => c.url.includes("app-file-info"))!;
    expect(fc.method).toBe("PUT");
    expect(fc.headers["Authorization"]).toBe("Bearer tok-123");
    expect(fc.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(fc.body ?? ""))).toEqual({
      fileType: 5,
      files: { fileName: path.basename(artifactPath), fileDestUrl: "obj-777" },
    });

    // 事件
    expect(events.map((e) => e.type)).toEqual(["phase", "phase", "phase"]);
    expect(events[2]).toMatchObject({ type: "phase", phase: "bind" });
  });

  it("OBS PUT：urlInfo.headers 已带 Content-Type 则尊重不覆盖", async () => {
    const mf = mockFetch(
      happyRoutes({
        obsHeaders: {
          "Content-Type": "application/vnd.android.package-archive",
          "x-obs-acl": "public-read",
        },
      }),
    );
    const ch = new HuaweiAndroidChannel();
    await ch.stage(makeCtx());

    const oc = obsCall(mf.calls);
    expect(oc.headers["Content-Type"]).toBe("application/vnd.android.package-archive");
    expect(oc.headers["x-obs-acl"]).toBe("public-read");
    // 仍补 Content-Length
    expect(oc.headers["Content-Length"]).toBe(String(artifactContent.length));
  });

  it("OBS PUT：urlInfo.method 非 PUT 时按其值", async () => {
    const mf = mockFetch([
      { match: "oauth2/v1/token", response: { status: 200, json: TOKEN_BODY } },
      {
        match: "upload-url/for-obs",
        response: {
          status: 200,
          json: {
            ret: { code: 0 },
            urlInfo: { url: "https://obs.example.com/b", objectId: "obj-1", method: "post" },
          },
        },
      },
      { match: "obs.example.com", response: { status: 200, text: "" } },
      { match: "app-file-info", response: { status: 200, json: { ret: { code: 0 } } } },
    ]);
    await new HuaweiAndroidChannel().stage(makeCtx());
    expect(obsCall(mf.calls).method).toBe("POST");
  });

  it("缺 HW_CLIENT_ID 抛错（含键名）", async () => {
    mockFetch([]);
    const ctx = makeCtx({ credentials: { HW_CLIENT_SECRET: "sec", appId: "app-001" } });
    await expect(new HuaweiAndroidChannel().stage(ctx)).rejects.toThrow("HW_CLIENT_ID");
  });

  it("缺 HW_CLIENT_SECRET 抛错（含键名）", async () => {
    mockFetch([]);
    const ctx = makeCtx({ credentials: { HW_CLIENT_ID: "cid", appId: "app-001" } });
    await expect(new HuaweiAndroidChannel().stage(ctx)).rejects.toThrow("HW_CLIENT_SECRET");
  });

  it("缺 appId 抛错（含提示来源）", async () => {
    mockFetch([]);
    const ctx = makeCtx({ credentials: { HW_CLIENT_ID: "cid", HW_CLIENT_SECRET: "sec" } });
    await expect(new HuaweiAndroidChannel().stage(ctx)).rejects.toThrow(
      /appId.*android\.stores\.huawei\.appId/,
    );
  });

  it("upload-url ret.code 非 0 抛错（含 code/msg）", async () => {
    mockFetch([
      { match: "oauth2/v1/token", response: { status: 200, json: TOKEN_BODY } },
      {
        match: "upload-url/for-obs",
        response: { status: 200, json: { ret: { code: 800, msg: "鉴权失败" } } },
      },
    ]);
    await expect(new HuaweiAndroidChannel().stage(makeCtx())).rejects.toThrow(/800.*鉴权失败/);
  });

  it("upload-url 返回 urlInfo.url 为空抛错", async () => {
    mockFetch([
      { match: "oauth2/v1/token", response: { status: 200, json: TOKEN_BODY } },
      {
        match: "upload-url/for-obs",
        response: { status: 200, json: { ret: { code: 0 }, urlInfo: {} } },
      },
    ]);
    await expect(new HuaweiAndroidChannel().stage(makeCtx())).rejects.toThrow("上传地址为空");
  });

  it.each([403, 500])("OBS 返回 HTTP %s 抛错", async (status) => {
    mockFetch([
      { match: "oauth2/v1/token", response: { status: 200, json: TOKEN_BODY } },
      {
        match: "upload-url/for-obs",
        response: {
          status: 200,
          json: { ret: { code: 0 }, urlInfo: { url: "https://obs.example.com/b", objectId: "o" } },
        },
      },
      { match: "obs.example.com", response: { status, text: "" } },
    ]);
    await expect(new HuaweiAndroidChannel().stage(makeCtx())).rejects.toThrow(
      `华为 OBS 上传失败 HTTP ${status}`,
    );
  });

  it("OBS 201/204 也算成功", async () => {
    for (const status of [201, 204]) {
      const mf = mockFetch([
        { match: "oauth2/v1/token", response: { status: 200, json: TOKEN_BODY } },
        {
          match: "upload-url/for-obs",
          response: {
            status: 200,
            json: {
              ret: { code: 0 },
              urlInfo: { url: "https://obs.example.com/b", objectId: "o" },
            },
          },
        },
        { match: "obs.example.com", response: { status, text: "" } },
        { match: "app-file-info", response: { status: 200, json: { ret: { code: 0 } } } },
      ]);
      const r = await new HuaweiAndroidChannel().stage(makeCtx());
      expect(r.ok).toBe(true);
      expect(obsCall(mf.calls)).toBeTruthy();
    }
  });

  it("file-info ret.code 非 0 抛错", async () => {
    mockFetch([
      ...happyRoutes().slice(0, 3),
      {
        match: "app-file-info",
        response: { status: 200, json: { ret: { code: 901, msg: "包名不符" } } },
      },
    ]);
    await expect(new HuaweiAndroidChannel().stage(makeCtx())).rejects.toThrow(/901.*包名不符/);
  });

  it("file-info HTTP 非 2xx 抛错（用 status 兜底 code）", async () => {
    mockFetch([
      ...happyRoutes().slice(0, 3),
      { match: "app-file-info", response: { status: 500, json: {} } },
    ]);
    await expect(new HuaweiAndroidChannel().stage(makeCtx())).rejects.toThrow(/500/);
  });
});

describe("HuaweiAndroidChannel.submit", () => {
  it("完整链路：文案 best-effort → 等 120s（fake timers）→ app-submit", async () => {
    const mf = mockFetch([
      { match: "oauth2/v1/token", response: { status: 200, json: TOKEN_BODY } },
      { match: "app-language-info", response: { status: 200, json: { ret: { code: 0 } } } },
      {
        match: "app-submit",
        response: { status: 200, json: { ret: { code: 0 }, submissionId: "sub-9" } },
      },
    ]);
    const ch = new HuaweiAndroidChannel();
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const ctx = makeCtx({
      updateDescription: "修复闪退",
      remark: "hotfix-1",
      emit: (e) => events.push(e),
    });

    const promise = ch.submit(ctx);
    // 120s 等待被 fake timers 挡住，app-submit 尚未发出
    await vi.advanceTimersByTimeAsync(WAIT_BEFORE_SUBMIT_MS - 1);
    expect(mf.find("app-submit")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;

    expect(result.ok).toBe(true);
    expect(result.ref).toContain("sub-9");

    // 文案请求形状
    const lc = mf.find("app-language-info")!;
    expect(lc.method).toBe("PUT");
    expect(new URL(lc.url).searchParams.get("appId")).toBe("app-001");
    expect(JSON.parse(String(lc.body ?? ""))).toEqual({ lang: "zh-CN", newFeatures: "修复闪退" });

    // app-submit 请求形状（remark 走 query）
    const sc = mf.find("app-submit")!;
    expect(sc.method).toBe("POST");
    expect(sc.headers["Authorization"]).toBe("Bearer tok-123");
    const sq = new URL(sc.url).searchParams;
    expect(sq.get("appId")).toBe("app-001");
    expect(sq.get("remark")).toBe("hotfix-1");

    // 事件序列：wait → submit → done
    const phases = events.filter((e) => e.type === "phase").map((e) => e.phase);
    expect(phases).toEqual(["wait", "submit", "done"]);
  });

  it("无 remark 时 query 不带 remark 键", async () => {
    const mf = mockFetch([
      { match: "oauth2/v1/token", response: { status: 200, json: TOKEN_BODY } },
      { match: "app-submit", response: { status: 200, json: { ret: { code: 0 } } } },
    ]);
    const promise = new HuaweiAndroidChannel().submit(makeCtx());
    await vi.advanceTimersByTimeAsync(WAIT_BEFORE_SUBMIT_MS);
    await promise;
    const sc = mf.find("app-submit")!;
    expect(new URL(sc.url).searchParams.has("remark")).toBe(false);
  });

  it("无 updateDescription 时跳过 language-info", async () => {
    const mf = mockFetch([
      { match: "oauth2/v1/token", response: { status: 200, json: TOKEN_BODY } },
      { match: "app-submit", response: { status: 200, json: { ret: { code: 0 } } } },
    ]);
    const promise = new HuaweiAndroidChannel().submit(makeCtx());
    await vi.advanceTimersByTimeAsync(WAIT_BEFORE_SUBMIT_MS);
    await promise;
    expect(mf.find("app-language-info")).toBeUndefined();
  });

  it("language-info 失败不阻断（发 warn 事件，仍提审）", async () => {
    mockFetch([
      { match: "oauth2/v1/token", response: { status: 200, json: TOKEN_BODY } },
      {
        match: "app-language-info",
        response: { status: 200, json: { ret: { code: 700, msg: "文案敏感" } } },
      },
      { match: "app-submit", response: { status: 200, json: { ret: { code: 0 } } } },
    ]);
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const promise = new HuaweiAndroidChannel().submit(
      makeCtx({ updateDescription: "x", emit: (e) => events.push(e) }),
    );
    await vi.advanceTimersByTimeAsync(WAIT_BEFORE_SUBMIT_MS);
    const result = await promise;

    expect(result.ok).toBe(true);
    expect(events.some((e) => e.type === "warn" && String(e.message).includes("不阻断"))).toBe(
      true,
    );
  });

  it("缺凭据抛错（submit 侧缺 appId）", async () => {
    mockFetch([]);
    const promise = new HuaweiAndroidChannel().submit(
      makeCtx({ credentials: { HW_CLIENT_ID: "cid", HW_CLIENT_SECRET: "sec" } }),
    );
    await expect(promise).rejects.toThrow("appId");
  });

  it("app-submit ret.code 非 0 抛错", async () => {
    mockFetch([
      { match: "oauth2/v1/token", response: { status: 200, json: TOKEN_BODY } },
      {
        match: "app-submit",
        response: { status: 200, json: { ret: { code: 1001, msg: "存在未解析软件包" } } },
      },
    ]);
    const promise = new HuaweiAndroidChannel().submit(makeCtx());
    const _rejection = promise.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(WAIT_BEFORE_SUBMIT_MS);
    await expect(promise).rejects.toThrow(/1001.*未解析软件包/);
  });
});

describe("HuaweiAndroidChannel.updateListing", () => {
  it("brief+description 写入 v3 app-language-info（请求形状：URL/method/body 字段）", async () => {
    const mock = mockFetch([
      { match: "oauth2/v1/token", response: { status: 200, json: TOKEN_BODY } },
      { match: "app-language-info", response: { status: 200, json: { ret: { code: 0 } } } },
    ]);
    const res = await new HuaweiAndroidChannel().updateListing(makeCtx(), {
      brief: "一句话简介",
      description: "长描述",
      stores: { huawei: { brief: "渠道覆盖简介" } },
    });
    const call = mock.find("app-language-info")!;
    expect(call.url).toContain("/api/publish/v3/app-language-info?appId=app-001");
    expect(call.method).toBe("PUT");
    expect(JSON.parse(call.body as string)).toEqual({
      lang: "zh-CN",
      briefInfo: "渠道覆盖简介",
      appDesc: "长描述",
    });
    expect(res).toMatchObject({
      ok: true,
      store: "huawei",
      updated: ["brief", "description"],
      skipped: [],
    });
  });

  it("仅 brief 时只带 briefInfo", async () => {
    const mock = mockFetch([
      { match: "oauth2/v1/token", response: { status: 200, json: TOKEN_BODY } },
      { match: "app-language-info", response: { status: 200, json: { ret: { code: 0 } } } },
    ]);
    await new HuaweiAndroidChannel().updateListing(makeCtx(), { brief: "只改简介" });
    expect(JSON.parse(mock.find("app-language-info")!.body as string)).toEqual({
      lang: "zh-CN",
      briefInfo: "只改简介",
    });
  });

  it("iconPath/screenshots 存在时跳过绑定（fileType 未验证），不发 upload-url/app-file-info 请求", async () => {
    const mock = mockFetch([
      { match: "oauth2/v1/token", response: { status: 200, json: TOKEN_BODY } },
      { match: "app-language-info", response: { status: 200, json: { ret: { code: 0 } } } },
    ]);
    const events: Array<{ type: string; message?: string }> = [];
    const res = await new HuaweiAndroidChannel().updateListing(
      makeCtx({ emit: (e) => events.push(e as { type: string }) }),
      { brief: "x", iconPath: "/tmp/icon.png", screenshots: ["/tmp/s1.png"] },
    );
    expect(
      mock.calls
        .map((c) => c.url)
        .some((u) => u.includes("upload-url") || u.includes("app-file-info")),
    ).toBe(false);
    expect(res.updated).toEqual(["brief"]);
    expect(res.skipped).toEqual(["iconPath", "screenshots"]);
    expect(events.some((e) => e.type === "warn")).toBe(true);
  });

  it("文案为空时直接返回，不请求 token/接口", async () => {
    const mock = mockFetch([]);
    const res = await new HuaweiAndroidChannel().updateListing(makeCtx(), {
      iconPath: "/tmp/icon.png",
    });
    expect(mock.calls.length).toBe(0);
    expect(res).toMatchObject({ ok: true, updated: [], skipped: ["iconPath"] });
  });

  it("ret.code 非 0 抛错", async () => {
    mockFetch([
      { match: "oauth2/v1/token", response: { status: 200, json: TOKEN_BODY } },
      {
        match: "app-language-info",
        response: { status: 200, json: { ret: { code: 1003, msg: "参数错误" } } },
      },
    ]);
    await expect(
      new HuaweiAndroidChannel().updateListing(makeCtx(), { brief: "x" }),
    ).rejects.toThrow(/1003.*参数错误/);
  });
});

describe("HuaweiAndroidChannel submit 定时上架（capabilities.scheduled 兑现）", () => {
  it("releaseTime 转 +0800 无冒号格式进 app-submit query", async () => {
    const fetchMock = mockFetch([
      ...happyRoutes(),
      { match: "app-submit", response: { json: { ret: { code: 0 } } } },
    ]);
    const ctx = makeCtx({});
    (ctx as { releaseTime?: string }).releaseTime = "2026-06-20T10:00:00+08:00";
    const p = new HuaweiAndroidChannel().submit(ctx);
    await vi.advanceTimersByTimeAsync(120_000);
    await p;
    const submitCall = fetchMock.find("app-submit");
    expect(submitCall?.url).toContain("releaseTime=2026-06-20T10%3A00%3A00%2B0800");
  });

  it("无 releaseTime 不带该参数", async () => {
    const fetchMock = mockFetch([
      ...happyRoutes(),
      { match: "app-submit", response: { json: { ret: { code: 0 } } } },
    ]);
    const ctx = makeCtx({});
    const p = new HuaweiAndroidChannel().submit(ctx);
    await vi.advanceTimersByTimeAsync(120_000);
    await p;
    expect(fetchMock.find("app-submit")?.url.includes("releaseTime")).toBe(false);
  });
});
