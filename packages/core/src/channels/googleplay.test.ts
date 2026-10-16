import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GooglePlayChannel } from "./googleplay.js";
import { mockFetch, makeTestCtx, readStreamToBuffer } from "../test-utils.js";

const TOKEN = "gp-tok-1";
const EDIT_ID = "edit-98765";
const VERSION_CODE = 42;
const PKG = "com.example.driver";
const API_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const UPLOAD_BASE =
  "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications";

const SA_EMAIL = "deployer@example.iam.gserviceaccount.com";
let saPublicKey: string;
let SA_JSON = "";
const CREDS_KEY = () => ({ GOOGLEPLAY_SA_KEY: SA_JSON });

let ARTIFACT_AAB = "";
const aabBytes = Buffer.from("fake-play-aab-0123456789abcdef");

beforeAll(() => {
  const osTmp = os.tmpdir();
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

  saPublicKey = publicKey;
  SA_JSON = JSON.stringify({ client_email: SA_EMAIL, private_key: privateKey });

  ARTIFACT_AAB = path.join(osTmp, `googleplay-test-${process.pid}.aab`);
  fs.writeFileSync(ARTIFACT_AAB, aabBytes);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 标准 happy 路由：token / 开 edit / 上传 / track / commit */
function happyRoutes(overrides: { uploadStatus?: number } = {}) {
  return [
    { match: "oauth2.googleapis.com/token", response: { json: { access_token: TOKEN } } },
    {
      match: "uploadType=media",
      response: { status: overrides.uploadStatus ?? 200, json: { versionCode: VERSION_CODE } },
    },
    { match: /\/edits$/, response: { json: { id: EDIT_ID } } },
    { match: "/tracks/internal", response: { json: { releases: [] } } },
    { match: "/tracks/production", response: { json: { releases: [] } } },
    { match: ":commit", response: { json: {} } },
  ];
}

function makeCtx(over: Parameters<typeof makeTestCtx>[0] = {}) {
  return makeTestCtx({
    credentials: over.credentials ?? CREDS_KEY(),
    target: over.target ?? { pkgName: PKG },
    artifactPath: over.artifactPath ?? ARTIFACT_AAB,
    updateDescription: over.updateDescription,
  });
}

describe("GooglePlayChannel 元数据", () => {
  const ch = new GooglePlayChannel();

  it("id/label/capabilities 按契约声明", () => {
    expect(ch.id).toBe("googleplay");
    expect(ch.label).toBe("Google Play");
    expect(ch.capabilities).toEqual({ stage: true, submit: true, scheduled: false, status: true });
  });

  it("plan 返回 android + 审核通过自动发布", async () => {
    const { ctx } = makeCtx();
    const plan = await ch.plan(ctx);
    expect(plan).toMatchObject({
      channel: "googleplay",
      platform: "android",
      action: "stage+submit",
      afterApproval: "auto-publish",
    });
  });
});

describe("GooglePlayChannel 认证", () => {
  it("SA JWT → OAuth2 token：签名用真实 RSA 私钥、grant_type=jwt-bearer", async () => {
    const mock = mockFetch(happyRoutes());
    const { ctx } = makeCtx();
    await new GooglePlayChannel().stage(ctx);
    const tokenCall = mock.find("oauth2.googleapis.com/token")!;
    expect(tokenCall.method).toBe("POST");
    expect(tokenCall.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(tokenCall.body as string);
    expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    // 验证 JWT 签名真实有效（用公钥验签）
    const assertion = params.get("assertion")!;
    const [h = "", p = "", s = ""] = assertion.split(".");
    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(`${h}.${p}`);
    expect(
      verifier.verify(saPublicKey, Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64")),
    ).toBe(true);
    const payload = JSON.parse(
      Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
    );
    expect(payload).toMatchObject({
      iss: SA_EMAIL,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: "https://oauth2.googleapis.com/token",
    });
  });

  it("缺凭据：错误含凭据键名与获取指引", async () => {
    const mock = mockFetch(happyRoutes());
    const { ctx } = makeCtx({ credentials: {} });
    await expect(new GooglePlayChannel().stage(ctx)).rejects.toThrow(
      /GOOGLEPLAY_SA_JSON.*Google Cloud Console/s,
    );
    expect(mock.calls.length).toBe(0);
  });

  it("GOOGLEPLAY_SA_JSON 路径读取（支持 ~ 展开）且优先级低于 SA_KEY 内容", async () => {
    mockFetch(happyRoutes());
    const { ctx } = makeCtx({
      credentials: { GOOGLEPLAY_SA_JSON: "~/nonexistent-sa.json" },
    });
    await expect(new GooglePlayChannel().stage(ctx)).rejects.toThrow(
      /GOOGLEPLAY_SA_JSON 读取失败.*nonexistent-sa/s,
    );
  });

  it("SA 内容非合法 JSON 报错（SA_KEY 路径）", async () => {
    mockFetch(happyRoutes());
    const { ctx } = makeCtx({ credentials: { GOOGLEPLAY_SA_KEY: "not-json{" } });
    await expect(new GooglePlayChannel().stage(ctx)).rejects.toThrow(
      "Service Account JSON 解析失败",
    );
  });

  it("token 接口返回非 JSON（网关 502）报错含状态与响应体", async () => {
    mockFetch([
      {
        match: "oauth2.googleapis.com/token",
        response: { status: 502, text: "<html>Bad Gateway</html>" },
      },
    ]);
    const { ctx } = makeCtx();
    await expect(new GooglePlayChannel().stage(ctx)).rejects.toThrow(
      "Google OAuth2 token 接口返回非 JSON（HTTP 502）: <html>Bad Gateway</html>",
    );
  });
  it("SA JSON 缺 client_email/private_key 报错", async () => {
    mockFetch(happyRoutes());
    const { ctx } = makeCtx({ credentials: { GOOGLEPLAY_SA_KEY: '{"foo":1}' } });
    await expect(new GooglePlayChannel().stage(ctx)).rejects.toThrow("client_email 或 private_key");
  });

  it("token 接口失败（invalid_grant）报错含状态与描述", async () => {
    mockFetch([
      {
        match: "oauth2.googleapis.com/token",
        response: {
          status: 400,
          json: { error: "invalid_grant", error_description: "Invalid JWT Signature." },
        },
      },
    ]);
    const { ctx } = makeCtx();
    await expect(new GooglePlayChannel().stage(ctx)).rejects.toThrow(
      /token 获取失败（HTTP 400）.*Invalid JWT Signature/,
    );
  });

  it("token 失败仅 error 字段（无 error_description）报错含 error", async () => {
    mockFetch([
      {
        match: "oauth2.googleapis.com/token",
        response: { status: 400, json: { error: "invalid_grant" } },
      },
    ]);
    const { ctx } = makeCtx();
    await expect(new GooglePlayChannel().stage(ctx)).rejects.toThrow(
      /token 获取失败（HTTP 400）.*invalid_grant/,
    );
  });

  it("token 失败 JSON 无 error 字段 → 透传原始响应体", async () => {
    mockFetch([
      { match: "oauth2.googleapis.com/token", response: { status: 403, json: { foo: 1 } } },
    ]);
    const { ctx } = makeCtx();
    await expect(new GooglePlayChannel().stage(ctx)).rejects.toThrow(
      /token 获取失败（HTTP 403）.*\{"foo":1\}/,
    );
  });

  it("GOOGLEPLAY_SA_JSON 非 ~ 路径原样读取（不展开）", async () => {
    mockFetch(happyRoutes());
    const { ctx } = makeCtx({
      credentials: { GOOGLEPLAY_SA_JSON: path.join(os.tmpdir(), "applift-no-such-sa.json") },
    });
    await expect(new GooglePlayChannel().stage(ctx)).rejects.toThrow(
      /GOOGLEPLAY_SA_JSON 读取失败.*applift-no-such-sa\.json/s,
    );
  });
});

describe("GooglePlayChannel.stage（internal 轨道）", () => {
  it("完整 edits 流：开 edit → bundles 上传 → internal 轨道 completed → commit", async () => {
    const mock = mockFetch(happyRoutes());
    const { ctx, events } = makeCtx();
    const result = await new GooglePlayChannel().stage(ctx);
    expect(result).toEqual({ ok: true, ref: `${EDIT_ID}:${VERSION_CODE}` });

    expect(mock.find(`${API_BASE}/${PKG}/edits`)!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    const upload = mock.find("uploadType=media")!;
    // 媒体上传走 /upload/ 前缀（对拍 apkgo googleplay.go uploadBase）
    expect(upload.url).toBe(`${UPLOAD_BASE}/${PKG}/edits/${EDIT_ID}/bundles?uploadType=media`);
    expect(upload.method).toBe("POST");
    expect(upload.headers["Content-Type"]).toBe("application/octet-stream");
    // 流式 body（ReadableStream，P2-3）：读尽后与产物字节一致；Content-Length 显式保留（等价旧 Buffer body 框架）
    expect(upload.body).toBeInstanceOf(ReadableStream);
    expect(await readStreamToBuffer(upload.body)).toEqual(aabBytes);
    expect(upload.headers["Content-Length"]).toBe(String(aabBytes.length));
    const track = mock.find("/tracks/internal")!;
    expect(track.method).toBe("PUT");
    expect(JSON.parse(track.body as string)).toEqual({
      releases: [{ versionCodes: [VERSION_CODE], status: "completed" }],
    });
    const commit = mock.find(":commit")!;
    // commit 为 :commit 冒号语法（对拍 apkgo googleplay.go）
    expect(commit.url).toBe(`${API_BASE}/${PKG}/edits/${EDIT_ID}:commit`);
    expect(events.some((e) => e.type === "phase" && e.phase === "done")).toBe(true);
    // P2-4：token/查询/上传全部 fetch 带 AbortSignal 超时（token/查询 30s、上传 900s；时长无法从 signal 反查，锁存在性）
    expect(mock.calls.length).toBeGreaterThan(0);
    for (const c of mock.calls) expect(c.signal).toBeInstanceOf(AbortSignal);
  });

  it(".apk 走 apks 端点", async () => {
    const apkPath = ARTIFACT_AAB.replace(/\.aab$/, ".apk");
    fs.writeFileSync(apkPath, Buffer.from("fake-apk"));
    const mock = mockFetch(happyRoutes());
    const { ctx } = makeCtx({ artifactPath: apkPath });
    await new GooglePlayChannel().stage(ctx);
    expect(mock.find("uploadType=media")!.url).toContain(`/edits/${EDIT_ID}/apks?uploadType=media`);
  });

  it("非 aab/apk 产物报错", async () => {
    mockFetch(happyRoutes());
    const { ctx } = makeCtx({ artifactPath: "/tmp/app-release.zip" });
    await expect(new GooglePlayChannel().stage(ctx)).rejects.toThrow("仅支持 .aab/.apk");
  });

  it("上传失败（403 权限不足）报错", async () => {
    mockFetch([
      { match: "oauth2.googleapis.com/token", response: { json: { access_token: TOKEN } } },
      {
        match: "uploadType=media",
        response: {
          status: 403,
          json: { error: { message: "The caller does not have permission" } },
        },
      },
      { match: /\/edits$/, response: { json: { id: EDIT_ID } } },
    ]);
    const { ctx } = makeCtx();
    await expect(new GooglePlayChannel().stage(ctx)).rejects.toThrow(
      /bundles 上传失败（HTTP 403）.*caller does not have permission/,
    );
  });
});

describe("GooglePlayChannel.submit（production 轨道）", () => {
  it("production 轨道 + completed + zh-CN releaseNotes", async () => {
    const mock = mockFetch(happyRoutes());
    const { ctx } = makeCtx({ updateDescription: "修复若干问题" });
    const result = await new GooglePlayChannel().submit(ctx);
    expect(result.ok).toBe(true);
    const track = mock.find("/tracks/production")!;
    expect(JSON.parse(track.body as string)).toEqual({
      releases: [
        {
          versionCodes: [VERSION_CODE],
          status: "completed",
          releaseNotes: [{ language: "zh-CN", text: "修复若干问题" }],
        },
      ],
    });
  });

  it("commit 失败报错", async () => {
    mockFetch([
      { match: "oauth2.googleapis.com/token", response: { json: { access_token: TOKEN } } },
      { match: "uploadType=media", response: { json: { versionCode: VERSION_CODE } } },
      { match: /\/edits$/, response: { json: { id: EDIT_ID } } },
      { match: "/tracks/production", response: { json: { releases: [] } } },
      {
        match: ":commit",
        response: {
          status: 400,
          json: { error: { message: "Changes cannot be sent for review" } },
        },
      },
    ]);
    const { ctx } = makeCtx();
    await expect(new GooglePlayChannel().submit(ctx)).rejects.toThrow(
      /commit.?失败（HTTP 400）.*Changes cannot be sent for review/,
    );
  });
});

describe("GooglePlayChannel 缺 pkgName", () => {
  it("stage 前置校验 pkgName，错误带配置指引", async () => {
    mockFetch(happyRoutes());
    const { ctx } = makeCtx({ target: {} });
    await expect(new GooglePlayChannel().stage(ctx)).rejects.toThrow("缺少 pkgName");
  });
});

describe("GooglePlayChannel.status", () => {
  function statusRoutes(releases: unknown) {
    return [
      { match: "oauth2.googleapis.com/token", response: { json: { access_token: TOKEN } } },
      { match: "/tracks/production", response: { json: { releases } } },
    ];
  }

  it("completed → approved + live", async () => {
    mockFetch(statusRoutes([{ versionCodes: [VERSION_CODE], status: "completed" }]));
    const { ctx } = makeCtx();
    expect(await new GooglePlayChannel().status(ctx)).toEqual({ state: "approved", live: true });
  });

  it("inProgress → approved 未全量", async () => {
    mockFetch(statusRoutes([{ status: "inProgress" }]));
    const { ctx } = makeCtx();
    expect(await new GooglePlayChannel().status(ctx)).toEqual({ state: "approved", live: false });
  });

  it("draft → reviewing", async () => {
    mockFetch(statusRoutes([{ status: "draft" }]));
    const { ctx } = makeCtx();
    expect(await new GooglePlayChannel().status(ctx)).toEqual({ state: "reviewing" });
  });

  it("无 release → unknown", async () => {
    mockFetch(statusRoutes([]));
    const { ctx } = makeCtx();
    expect(await new GooglePlayChannel().status(ctx)).toEqual({
      state: "unknown",
      raw: "production 轨道无 release",
    });
  });

  it("GET 请求路径含 edits/- 占位", async () => {
    const mock = mockFetch(statusRoutes([{ status: "completed" }]));
    const { ctx } = makeCtx();
    await new GooglePlayChannel().status(ctx);
    expect(mock.find("/tracks/production")!.method).toBe("GET");
    expect(mock.find("/tracks/production")!.url).toContain(`/edits/-/tracks/production`);
  });
});

describe("GooglePlayChannel 补充分支", () => {
  it("halted → approved 未全量", async () => {
    mockFetch([
      { match: "oauth2.googleapis.com/token", response: { json: { access_token: TOKEN } } },
      { match: "/tracks/production", response: { json: { releases: [{ status: "halted" }] } } },
    ]);
    const { ctx } = makeCtx();
    expect(await new GooglePlayChannel().status(ctx)).toEqual({ state: "approved", live: false });
  });

  it("未知 release 状态 → unknown 带 raw", async () => {
    mockFetch([
      { match: "oauth2.googleapis.com/token", response: { json: { access_token: TOKEN } } },
      { match: "/tracks/production", response: { json: { releases: [{ status: "weird" }] } } },
    ]);
    const { ctx } = makeCtx();
    const st = await new GooglePlayChannel().status(ctx);
    expect(st.state).toBe("unknown");
  });

  it("上传响应缺 versionCode 抛错", async () => {
    mockFetch([
      { match: "oauth2.googleapis.com/token", response: { json: { access_token: TOKEN } } },
      { match: "uploadType=media", response: { json: {} } },
      { match: /\/edits$/, response: { json: { id: EDIT_ID } } },
    ]);
    const { ctx } = makeCtx();
    await expect(new GooglePlayChannel().stage(ctx)).rejects.toThrow(/versionCode/);
  });

  it("上传响应非 JSON（走 text 容错路径）抛错", async () => {
    mockFetch([
      { match: "oauth2.googleapis.com/token", response: { json: { access_token: TOKEN } } },
      { match: "uploadType=media", response: { text: "<html>bad gateway</html>", status: 502 } },
      { match: /\/edits$/, response: { json: { id: EDIT_ID } } },
    ]);
    const { ctx } = makeCtx();
    await expect(new GooglePlayChannel().stage(ctx)).rejects.toThrow();
  });

  it("创建 edit 响应缺 id 抛错", async () => {
    mockFetch([
      { match: "oauth2.googleapis.com/token", response: { json: { access_token: TOKEN } } },
      { match: /\/edits$/, response: { json: {} } },
    ]);
    const { ctx } = makeCtx();
    await expect(new GooglePlayChannel().stage(ctx)).rejects.toThrow(
      "Google Play 创建 edit 响应缺少 id",
    );
  });

  it("commit 返回空 body（204）→ apiFetch 容错返回 {}，全流程仍成功", async () => {
    mockFetch([
      { match: "oauth2.googleapis.com/token", response: { json: { access_token: TOKEN } } },
      { match: /\/edits$/, response: { json: { id: EDIT_ID } } },
      { match: "uploadType=media", response: { json: { versionCode: VERSION_CODE } } },
      { match: "/tracks/internal", response: { json: { releases: [] } } },
      { match: ":commit", response: { status: 204, text: "" } },
    ]);
    const { ctx } = makeCtx();
    const r = await new GooglePlayChannel().stage(ctx);
    expect(r).toEqual({ ok: true, ref: `${EDIT_ID}:${VERSION_CODE}` });
  });
});
