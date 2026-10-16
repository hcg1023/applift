/**
 * VivoChannel 契约测试：请求形状（URL/method/header/body）、签名规则（file 不参与）、
 * stage→submit serialnumber/versionCode/fileMd5 传递、跳过 stage 回退上传、提审字段集
 * （apk=流水号/versionCode 透传/fileMd5/onlineType 线上复用/updateDesc 门禁）、code/subCode 双检、
 * 缺凭据、plan/status（app.query.details.auditStatus）元数据。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VivoChannel } from "./vivo.js";
import { hmacSign } from "./shared/sign.js";
import { makeTestCtx, mockFetch } from "../test-utils.js";

const API_BASE = "https://developer-api.vivo.com.cn/router/rest";
const NOW = 1_700_000_000_000; // 固定毫秒时间戳
const SECRET = "vivo-secret";
const CREDS = { VIVO_ACCESS_KEY: "ak-123", VIVO_ACCESS_SECRET: SECRET };
const TARGET = { pkgName: "com.demo.app" };

const APK_BYTES = Buffer.from("fake-apk-content-for-vivo-test");
const APK_MD5 = createHash("md5").update(APK_BYTES).digest("hex");

let apkPath: string;

beforeAll(() => {
  apkPath = path.join(os.tmpdir(), `vivo-test-${process.pid}.apk`);
  fs.writeFileSync(apkPath, APK_BYTES);
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function urlencoded(call: { body?: string | FormData | Buffer } | undefined) {
  if (!call || typeof call!.body !== "string") return null;
  return new URLSearchParams(call!.body);
}
function formOf(call: { body?: string | FormData | Buffer } | undefined): FormData {
  if (!call?.body || typeof call!.body === "string") throw new Error("期望 FormData body");
  return call!.body as FormData;
}

/** 安装 fetch mock：同端点按 method 分发（上传=FormData，其余=urlencoded） */
function installMock(responses: { upload?: object; query?: object; update?: object } = {}) {
  const upload = responses.upload ?? {
    code: 0,
    subCode: 0,
    data: { serialnumber: "SN-STAGE-1", versionCode: 101 },
  };
  const query = responses.query ?? { code: 0, subCode: 0, data: { compatibleDevice: "0" } };
  const update = responses.update ?? { code: 0, subCode: 0, data: { status: "审核中" } };
  const mocked = mockFetch([
    {
      match: API_BASE,
      response: () => {
        const last = mocked.calls[mocked.calls.length - 1];
        const method =
          typeof last!.body === "string"
            ? new URLSearchParams(last!.body).get("method")
            : (last!.body as FormData).get("method");
        if (method === "app.query.details") return { json: query };
        if (method === "app.sync.update.app") return { json: update };
        return { json: upload };
      },
    },
  ]);
  return mocked;
}

/** 校验公共参数 + 签名（从实际发送参数重算，sign 字段本身除外） */
function expectSigned(params: URLSearchParams | FormData, business: Record<string, string>) {
  const get = (k: string) =>
    params instanceof URLSearchParams ? params.get(k) : (params.get(k) as string | null);
  expect(get("access_key")).toBe("ak-123");
  expect(get("timestamp")).toBe(String(NOW)); // 毫秒级
  expect(get("format")).toBe("json");
  expect(get("v")).toBe("1.0");
  expect(get("sign_method")).toBe("HMAC-SHA256"); // 与官方文档及 apkgo 一致
  expect(get("target_app_key")).toBe("developer");
  for (const [k, v] of Object.entries(business)) expect(get(k)).toBe(v);
  const unsigned: Record<string, string> = {};
  const keys =
    params instanceof URLSearchParams ? [...params.keys()] : [...(params as FormData).keys()];
  for (const k of keys) if (k !== "sign" && k !== "file") unsigned[k] = get(k)!;
  expect(get("sign")).toBe(hmacSign(SECRET, unsigned)); // 用无 sign 参数重算一致 => file 未参与签名
}

describe("VivoChannel 元数据", () => {
  it("capabilities/label/id", () => {
    const ch = new VivoChannel();
    expect(ch.id).toBe("vivo");
    expect(ch.label).toBe("vivo 应用市场");
    expect(ch.capabilities).toEqual({ stage: true, submit: true, scheduled: false, status: true });
  });

  it("plan 返回 stage+submit 编排元数据", async () => {
    const ch = new VivoChannel();
    const { ctx } = makeTestCtx({ credentials: CREDS, target: TARGET });
    const p = await ch.plan(ctx);
    expect(p).toMatchObject({
      channel: "vivo",
      platform: "android",
      action: "stage+submit",
      afterApproval: "auto-publish",
    });
  });

  it("plan 缺 pkgName 报错（含配置路径提示）", async () => {
    const ch = new VivoChannel();
    const { ctx } = makeTestCtx({ credentials: CREDS });
    await expect(ch.plan(ctx)).rejects.toThrow(
      "vivo 渠道缺少 pkgName（项目配置 android.stores.vivo.pkgName）",
    );
  });

  it("status 请求形状与状态映射见 VivoChannel.status 组", async () => {
    // 覆盖点在本文件下方 status describe；此处仅保留元数据冒烟
    expect(new VivoChannel().capabilities.status).toBe(true);
  });
  it("errorHints 覆盖现行码表（10001/10005/10011/12010），旧码 1002/46001 已删", () => {
    const ch = new VivoChannel();
    expect(ch.errorHints).toEqual({
      "10001": "签名校验失败（检查 VIVO_ACCESS_SECRET 是否正确）",
      "10005": "时间戳失效（检查系统时间偏差）",
      "10011": "当天调用次数超限（约 50 次/天）",
      "12010": "应用审核中，不允许更新",
    });
  });
});

describe("VivoChannel.status", () => {
  function statusRoutes(data: Record<string, unknown>) {
    return [{ match: API_BASE, response: { json: { code: 0, subCode: 0, data } } }];
  }

  it("请求形状：复用 app.query.details、body packageName、公共参数+签名（sign_method=HMAC-SHA256）", async () => {
    const mf = mockFetch(statusRoutes({ status: 2 }));
    await expect(
      new VivoChannel().status(makeTestCtx({ credentials: CREDS, target: TARGET }).ctx),
    ).resolves.toEqual({
      state: "reviewing",
    });
    const call = mf.find(API_BASE)!;
    expect(call.method).toBe("POST");
    expect(call.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(call.body as string);
    expect(params.get("sign_method")).toBe("HMAC-SHA256");
    expectSigned(params, { method: "app.query.details", packageName: TARGET.pkgName });
  });

  it("status=3 → approved live（apkgo mapVivoAuditState）", async () => {
    mockFetch(statusRoutes({ status: 3 }));
    await expect(
      new VivoChannel().status(makeTestCtx({ credentials: CREDS, target: TARGET }).ctx),
    ).resolves.toEqual({
      state: "approved",
      live: true,
    });
  });

  it("status=4 → rejected（auditMessage 作 reason）", async () => {
    mockFetch(statusRoutes({ status: 4, auditMessage: "应用描述不合规" }));
    await expect(
      new VivoChannel().status(makeTestCtx({ credentials: CREDS, target: TARGET }).ctx),
    ).resolves.toEqual({
      state: "rejected",
      reason: "应用描述不合规",
    });
  });

  it("status=1 → unknown 草稿、status=5 → unknown 已撤销", async () => {
    mockFetch(statusRoutes({ status: 1 }));
    await expect(
      new VivoChannel().status(makeTestCtx({ credentials: CREDS, target: TARGET }).ctx),
    ).resolves.toEqual({
      state: "unknown",
      raw: "status=1（草稿，未提交审核）",
    });
    mockFetch(statusRoutes({ status: 5 }));
    await expect(
      new VivoChannel().status(makeTestCtx({ credentials: CREDS, target: TARGET }).ctx),
    ).resolves.toEqual({
      state: "unknown",
      raw: "status=5（已撤销）",
    });
  });

  it("未知编号 → unknown raw 含编号", async () => {
    mockFetch(statusRoutes({ status: 7 }));
    await expect(
      new VivoChannel().status(makeTestCtx({ credentials: CREDS, target: TARGET }).ctx),
    ).resolves.toEqual({
      state: "unknown",
      raw: "status=7（未验证编号）",
    });
  });

  it("无 status → unknown raw 含提示", async () => {
    mockFetch(statusRoutes({}));
    await expect(
      new VivoChannel().status(makeTestCtx({ credentials: CREDS, target: TARGET }).ctx),
    ).resolves.toEqual({
      state: "unknown",
      raw: expect.stringContaining("app.query.details 无 status"),
    });
  });

  it("响应无 data → unknown raw 含提示（data ?? {} 回退）", async () => {
    mockFetch([{ match: API_BASE, response: { json: { code: 0, subCode: 0 } } }]);
    await expect(
      new VivoChannel().status(makeTestCtx({ credentials: CREDS, target: TARGET }).ctx),
    ).resolves.toEqual({
      state: "unknown",
      raw: expect.stringContaining("app.query.details 无 status"),
    });
  });

  it("status 非数值 → unknown raw 透传原值", async () => {
    mockFetch(statusRoutes({ status: "pending" }));
    await expect(
      new VivoChannel().status(makeTestCtx({ credentials: CREDS, target: TARGET }).ctx),
    ).resolves.toEqual({
      state: "unknown",
      raw: "status=pending",
    });
  });

  it("旧字段 audit_status 蛇形命名兜底（status 缺失时回退，编号按 apkgo 表）", async () => {
    mockFetch(statusRoutes({ audit_status: 2 }));
    await expect(
      new VivoChannel().status(makeTestCtx({ credentials: CREDS, target: TARGET }).ctx),
    ).resolves.toEqual({
      state: "reviewing",
    });
  });

  it("驳回原因字段兜底 auditMsg（auditMessage 缺失）", async () => {
    mockFetch(statusRoutes({ status: 4, auditMsg: "截图不合规" }));
    await expect(
      new VivoChannel().status(makeTestCtx({ credentials: CREDS, target: TARGET }).ctx),
    ).resolves.toEqual({
      state: "rejected",
      reason: "截图不合规",
    });
  });

  it("驳回原因为空串 → reason undefined", async () => {
    mockFetch(statusRoutes({ status: 4, auditMessage: "" }));
    await expect(
      new VivoChannel().status(makeTestCtx({ credentials: CREDS, target: TARGET }).ctx),
    ).resolves.toEqual({
      state: "rejected",
      reason: undefined,
    });
  });

  it("code 非 0 且无 msg → 错误文案 msg 段为空", async () => {
    mockFetch([{ match: API_BASE, response: { json: { code: 1002 } } }]);
    await expect(
      new VivoChannel().status(makeTestCtx({ credentials: CREDS, target: TARGET }).ctx),
    ).rejects.toThrow("vivo 查询应用详情失败 code=1002 ");
  });

  it("code 非 0 抛错", async () => {
    mockFetch([{ match: API_BASE, response: { json: { code: 1001, msg: "签名错误" } } }]);
    await expect(
      new VivoChannel().status(makeTestCtx({ credentials: CREDS, target: TARGET }).ctx),
    ).rejects.toThrow("vivo 查询应用详情失败 code=1001");
  });

  it("缺 pkgName 抛错（含用途提示）", async () => {
    mockFetch([]);
    await expect(new VivoChannel().status(makeTestCtx({ credentials: CREDS }).ctx)).rejects.toThrow(
      "vivo 渠道缺少 pkgName（审核状态查询必需）",
    );
  });

  it("非 JSON 响应抛错（含渠道名与 HTTP 状态）", async () => {
    mockFetch([{ match: API_BASE, response: { status: 502, text: "<html>Bad Gateway</html>" } }]);
    await expect(
      new VivoChannel().status(makeTestCtx({ credentials: CREDS, target: TARGET }).ctx),
    ).rejects.toThrow("vivo 查询应用详情返回非 JSON（HTTP 502）");
  });
});

describe("VivoChannel.stage", () => {
  it("上传：multipart、file 不参与签名、fileMd5、毫秒 timestamp、serialnumber 暂存", async () => {
    const mock = installMock({ upload: { code: 0, data: { serialnumber: 99 } } });
    const ch = new VivoChannel();
    const { ctx, events } = makeTestCtx({
      credentials: CREDS,
      target: TARGET,
      artifactPath: apkPath,
    });

    const res = await ch.stage(ctx);

    expect(res).toEqual({ ok: true, ref: "99" }); // String(serialnumber)
    expect(mock.calls).toHaveLength(1);
    const call = mock.calls[0];
    expect(call!.url).toBe(API_BASE);
    expect(call!.method).toBe("POST");

    const form = formOf(call);
    expect(form.get("method")).toBe("app.upload.apk.app");
    expect(form.get("packageName")).toBe(TARGET.pkgName);
    expect(form.get("fileMd5")).toBe(APK_MD5);
    expectSigned(form, { packageName: TARGET.pkgName, fileMd5: APK_MD5 });
    // file 字段存在且为 Blob（内容完整），但签名串（重算自无 file 参数）一致 => file 不参与签名
    const file = form.get("file") as Blob;
    expect(file).toBeInstanceOf(Blob);
    expect(file.size).toBe(APK_BYTES.length);

    expect(events.some((e) => e.type === "phase" && e.phase === "upload")).toBe(true);
    expect(
      events.some(
        (e) => e.type === "phase" && e.phase === "bind" && String(e.message).includes("草稿"),
      ),
    ).toBe(true);
  });

  it("缺凭据抛错（键名明确）", async () => {
    installMock();
    const ch = new VivoChannel();
    const noKey = makeTestCtx({
      credentials: { VIVO_ACCESS_SECRET: SECRET },
      target: TARGET,
      artifactPath: apkPath,
    });
    await expect(ch.stage(noKey.ctx)).rejects.toThrow("vivo 渠道缺少 VIVO_ACCESS_KEY");
    const noSecret = makeTestCtx({
      credentials: { VIVO_ACCESS_KEY: "ak" },
      target: TARGET,
      artifactPath: apkPath,
    });
    await expect(ch.stage(noSecret.ctx)).rejects.toThrow("vivo 渠道缺少 VIVO_ACCESS_SECRET");
  });

  it("code != 0 抛错", async () => {
    installMock({ upload: { code: 10001, msg: "sign error" } });
    const ch = new VivoChannel();
    const { ctx } = makeTestCtx({ credentials: CREDS, target: TARGET, artifactPath: apkPath });
    await expect(ch.stage(ctx)).rejects.toThrow("vivo 文件上传失败 code=10001 sign error");
  });

  it("subCode != 0 抛错（数字与字符串形式）", async () => {
    installMock({ upload: { code: 0, subCode: 30001, msg: "pkg mismatch" } });
    const ch = new VivoChannel();
    const { ctx } = makeTestCtx({ credentials: CREDS, target: TARGET, artifactPath: apkPath });
    await expect(ch.stage(ctx)).rejects.toThrow("vivo 文件上传业务失败 subCode=30001 pkg mismatch");

    installMock({ upload: { code: 0, subCode: "30002" } });
    const ch2 = new VivoChannel();
    await expect(ch2.stage(ctx)).rejects.toThrow("subCode=30002");
  });

  it("上传响应非 JSON 抛错（含渠道名与 HTTP 状态）", async () => {
    mockFetch([{ match: API_BASE, response: { status: 502, text: "<html>Bad Gateway</html>" } }]);
    const ch = new VivoChannel();
    const { ctx } = makeTestCtx({ credentials: CREDS, target: TARGET, artifactPath: apkPath });
    await expect(ch.stage(ctx)).rejects.toThrow("vivo 文件上传返回非 JSON（HTTP 502）");
  });
});

describe("VivoChannel.submit", () => {
  it("stage 后 submit：复用上传结果不重复上传；提审字段集齐全（apk/versionCode/fileMd5/onlineType）", async () => {
    const mock = installMock({
      upload: { code: 0, subCode: 0, data: { serialnumber: "SN-REUSE", versionCode: 202 } },
      query: { code: 0, data: { compatibleDevice: 1, onlineType: 3 } },
    });
    const ch = new VivoChannel();
    const { ctx, events } = makeTestCtx({
      credentials: CREDS,
      target: TARGET,
      artifactPath: apkPath,
      updateDescription: "v2.1 更新说明",
    });

    await ch.stage(ctx);
    const res = await ch.submit(ctx);

    expect(res.ok).toBe(true);
    // 3 次调用：upload → query.details → sync.update（无第二次上传）
    expect(mock.calls).toHaveLength(3);

    const call1 = mock.calls[1]!;
    const q = urlencoded(call1);
    expect(call1.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(q?.get("method")).toBe("app.query.details");
    expectSigned(q as URLSearchParams, { packageName: TARGET.pkgName });

    const u = urlencoded(mock.calls[2])!;
    expect(u.get("method")).toBe("app.sync.update.app");
    expectSigned(u, {
      packageName: TARGET.pkgName,
      apk: "SN-REUSE", // 对拍 python：字段名 apk，值为上传流水号 serialnumber
      versionCode: "202", // 上传响应 versionCode 透传
      fileMd5: APK_MD5, // 上传时算好的工件 MD5 回传
      onlineType: "3", // query.details 线上复用
      compatibleDevice: "1",
      updateDesc: "v2.1 更新说明",
    });
    expect(u.has("serialnumber")).toBe(false); // 提审字段名是 apk 非 serialnumber

    expect(events.some((e) => e.type === "phase" && e.phase === "done")).toBe(true);
  });

  it("updateDesc 为空时拒绝提审（不再伪造占位文案）", async () => {
    const mock = installMock();
    const ch = new VivoChannel();
    const { ctx } = makeTestCtx({ credentials: CREDS, target: TARGET, artifactPath: apkPath });
    await ch.stage(ctx);
    await expect(ch.submit(ctx)).rejects.toThrow("vivo 提审 updateDesc 需 5-200 字（当前 0 字）");
    // 未发出提审请求（仅 stage 的 upload + submit 的 query.details）
    expect(mock.calls).toHaveLength(2);
  });

  it("updateDesc 短于 5 字时拒绝提审", async () => {
    const mock = installMock();
    const ch = new VivoChannel();
    const { ctx } = makeTestCtx({
      credentials: CREDS,
      target: TARGET,
      artifactPath: apkPath,
      updateDescription: "修复",
    });
    await expect(ch.submit(ctx)).rejects.toThrow("vivo 提审 updateDesc 需 5-200 字（当前 2 字）");
    expect(urlencoded(mock.calls[0])!.get("method")).toBe("app.query.details");
  });
  it("updateDesc 超过 200 字时拒绝提审", async () => {
    const mock = installMock();
    const ch = new VivoChannel();
    const { ctx } = makeTestCtx({
      credentials: CREDS,
      target: TARGET,
      artifactPath: apkPath,
      updateDescription: "长".repeat(201),
    });
    await expect(ch.submit(ctx)).rejects.toThrow(
      "vivo 提审 updateDesc 需 5-200 字（当前 201 字，超出上限），请精简更新说明",
    );
    // 未发出提审请求（仅 stage 的 upload + submit 的 query.details）
    expect(mock.calls).toHaveLength(2);
  });

  it("跳过 stage 直接 submit：先现场上传再提审，versionCode/fileMd5 透传", async () => {
    const mock = installMock({
      upload: { code: 0, data: { serialnumber: "SN-FALLBACK", versionCode: 303 } },
    });
    const ch = new VivoChannel();
    const { ctx } = makeTestCtx({
      credentials: CREDS,
      target: TARGET,
      artifactPath: apkPath,
      updateDescription: "v1.0 现场更新说明",
    });

    const res = await ch.submit(ctx);

    expect(res.ok).toBe(true);
    // 顺序：query.details → upload（FormData）→ sync.update
    expect(mock.calls).toHaveLength(3);
    expect(urlencoded(mock.calls[0])!.get("method")).toBe("app.query.details");
    expect(formOf(mock.calls[1]).get("method")).toBe("app.upload.apk.app");
    const u = urlencoded(mock.calls[2])!;
    expect(u.get("method")).toBe("app.sync.update.app");
    expect(u.get("apk")).toBe("SN-FALLBACK");
    expect(u.get("versionCode")).toBe("303");
    expect(u.get("fileMd5")).toBe(APK_MD5);
  });

  it("上传未返回 serialnumber 时提审抛错", async () => {
    installMock({ upload: { code: 0, data: {} } });
    const ch = new VivoChannel();
    const { ctx } = makeTestCtx({ credentials: CREDS, target: TARGET, artifactPath: apkPath });
    await expect(ch.submit(ctx)).rejects.toThrow("vivo 提审缺少 serialnumber（上传未返回）");
  });

  it("query.details 失败传导（code!=0）", async () => {
    installMock({ query: { code: 40001, msg: "not found" } });
    const ch = new VivoChannel();
    const { ctx } = makeTestCtx({ credentials: CREDS, target: TARGET, artifactPath: apkPath });
    await expect(ch.submit(ctx)).rejects.toThrow("vivo 查询应用详情失败 code=40001 not found");
  });

  it("提审接口 subCode!=0 抛错", async () => {
    installMock({ update: { code: 0, subCode: 50001, msg: "repeat submit" } });
    const ch = new VivoChannel();
    const { ctx } = makeTestCtx({
      credentials: CREDS,
      target: TARGET,
      artifactPath: apkPath,
      updateDescription: "回归测试更新说明",
    });
    await expect(ch.submit(ctx)).rejects.toThrow("vivo 提审业务失败 subCode=50001 repeat submit");
  });

  it("缺凭据抛错", async () => {
    installMock();
    const ch = new VivoChannel();
    const { ctx } = makeTestCtx({ credentials: {}, target: TARGET, artifactPath: apkPath });
    await expect(ch.submit(ctx)).rejects.toThrow("vivo 渠道缺少 VIVO_ACCESS_KEY");
  });

  it("query.details 无 data → compatibleDevice/onlineType 回退 1（python 默认值）", async () => {
    const mock = installMock({ query: { code: 0 } });
    const ch = new VivoChannel();
    const { ctx } = makeTestCtx({
      credentials: CREDS,
      target: TARGET,
      artifactPath: apkPath,
      updateDescription: "默认值回归验证",
    });
    await ch.stage(ctx);
    const res = await ch.submit(ctx);
    expect(res.ok).toBe(true);
    const u = urlencoded(mock.calls[2])!;
    expect(u.get("compatibleDevice")).toBe("1");
    expect(u.get("onlineType")).toBe("1");
  });

  it("上传响应无 data → serialnumber 缺失抛错", async () => {
    installMock({ upload: { code: 0 } });
    const ch = new VivoChannel();
    const { ctx } = makeTestCtx({ credentials: CREDS, target: TARGET, artifactPath: apkPath });
    await expect(ch.submit(ctx)).rejects.toThrow("vivo 提审缺少 serialnumber（上传未返回）");
  });
});
