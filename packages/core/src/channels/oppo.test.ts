/**
 * OppoChannel 契约测试：GET token → app/info（复用线上字段）→ get-upload-url → multipart 上传 → app/upd
 * → task-state 轮询确认异步任务结果。
 * 断言各请求形状（URL/method/关键参数/api_sign）与错误分支（缺凭据、errno 非 0、响应缺字段、异步任务失败/超时）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OppoChannel, resolveVersionCode } from "./oppo.js";
import { hmacSign } from "./shared/sign.js";
import { mockFetch, makeTestCtx } from "../test-utils.js";
import type { MockResponseSpec } from "../test-utils.js";
import type * as Util from "../util.js";

/**
 * sleep 打桩：task-state 轮询间隔 10s，测试内即时放行；间隔契约用 sleepMock 的入参/调用次数断言。
 * oppo.ts 自 ../util.js 引入 sleep，vi.mock 需保留其余导出真实现。
 */
const { sleepMock } = vi.hoisted(() => ({ sleepMock: vi.fn(() => Promise.resolve()) }));
vi.mock("../util.js", async (importOriginal) => {
  const orig = await importOriginal<typeof Util>();
  return { ...orig, sleep: sleepMock };
});

const API_BASE = "https://oop-openapi-cn.heytapmobi.com";
const CLIENT_ID = "oppo-client-id";
const CLIENT_SECRET = "oppo-client-secret";
const TOKEN = "oppo-token-48h";
const PKG_NAME = "com.wlyd.driver";
const UPLOAD_URL = "https://uploadfs.example.com/upload";
const UPLOAD_SIGN = "upload-sign-xyz";
const APK_URL = "https://pkg.example.com/stored.apk";
const APK_MD5 = "d41d8cd98f00b204e9800998ecf8427e";
const ARTIFACT = path.join(os.tmpdir(), "applift-oppo-test-app-release.apk");
const FILE_CONTENT = "OPPO-FAKE-APK-BYTES-0123456789";

/** 线上 app/info 字段（snake_case 响应，submit 复用）—— 对拍 python oppo_submit.py build_publish_params 全集 */
const APP_INFO = {
  pkg_name: PKG_NAME,
  app_name: "千云司机端",
  second_category_id: 109,
  third_category_id: 1102,
  summary: "线上摘要一共十六字符才会截断", // 16 字符 → app/upd 截 13
  detail_desc: "线上详情描述",
  privacy_source_url: "https://example.com/privacy",
  icon_url: "https://cdn.example.com/icon.png",
  pic_url: "https://cdn.example.com/s1.png,https://cdn.example.com/s2.png",
  test_desc: "线上测试备注",
  business_username: "  千云科技 ",
  business_email: " 2052576764@qq.com",
  business_mobile: " 13800138000",
  age_level: 3,
  adaptive_equipment: 4,
  adaptive_type: 1,
  copyright_url: "", // 空 → 兜底 electronic_cert_url（apkgo: 电子版权证书账号）
  electronic_cert_url: "https://cdn.example.com/cert.png",
  icp_url: "https://cdn.example.com/icp.png",
  landscape_pic_url: "", // 空串 → 可选字段不传
  update_desc: "线上更新说明",
  version_code: "208", // 线上旧版本，不用于提交
};

/** 路由条目：match 片段 → 固定响应或按请求动态求值（task-state 顺序状态用） */
interface RouteEntry {
  match: string;
  response: MockResponseSpec | ((req: { method: string; url: string }) => MockResponseSpec);
}

/** 标准路由表，按 match 片段覆写响应（覆写值支持函数形式，task-state 顺序状态用） */
function oppoRoutes(
  overrides: Record<
    string,
    MockResponseSpec | ((req: { method: string; url: string }) => MockResponseSpec)
  > = {},
): RouteEntry[] {
  const base: RouteEntry[] = [
    {
      match: "developer/v1/token",
      response: { json: { errno: 0, data: { access_token: TOKEN } } },
    },
    { match: "/resource/v1/app/info", response: { json: { errno: 0, data: { ...APP_INFO } } } },
    {
      match: "get-upload-url",
      response: { json: { errno: 0, data: { upload_url: UPLOAD_URL, sign: UPLOAD_SIGN } } },
    },
    {
      match: "uploadfs.example",
      response: { json: { errno: 0, data: { url: APK_URL, md5: APK_MD5 } } },
    },
    {
      match: "/resource/v1/app/upd",
      response: { json: { errno: 0, data: { packageId: "pkg-123" } } },
    },
    {
      match: "/resource/v1/app/task-state",
      response: { json: { errno: 0, data: { task_state: 2 } } },
    },
  ];
  return base.map((r) => {
    const override = overrides[r.match];
    return override ? { ...r, response: override } : r;
  });
}

/** 默认补全凭据/pkgName 的 makeTestCtx 包装（显式传 credentials/target 时不合并默认值） */
function makeCtx(
  o: {
    credentials?: Record<string, string>;
    target?: Record<string, string>;
    updateDescription?: string;
  } = {},
) {
  return makeTestCtx({
    credentials: o.credentials ?? { OPPO_CLIENT_ID: CLIENT_ID, OPPO_CLIENT_SECRET: CLIENT_SECRET },
    target: o.target ?? { pkgName: PKG_NAME, versionCode: "301" },
    artifactPath: ARTIFACT,
    updateDescription: o.updateDescription,
  });
}

/** 解析 GET URL 上的 query 参数 */
function queryParams(url: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(url.slice(url.indexOf("?") + 1)));
}

/** 用请求自带的 timestamp 复算 api_sign（HmacSHA256(key=secret, 排序拼接)），校验签名契约 */
function expectSigned(params: Record<string, string>) {
  const { api_sign, ...rest } = params;
  expect(api_sign).toBe(hmacSign(CLIENT_SECRET, rest));
}

beforeEach(() => {
  fs.writeFileSync(ARTIFACT, FILE_CONTENT);
  sleepMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(ARTIFACT, { force: true });
});

describe("OppoChannel 元数据与 plan", () => {
  it("id/label/capabilities", () => {
    const ch = new OppoChannel();
    expect(ch.id).toBe("oppo");
    expect(ch.label).toBe("OPPO 应用市场");
    expect(ch.capabilities).toEqual({ stage: true, submit: true, scheduled: false, status: true });
  });

  it("plan 返回 stage+submit 一次完成、字段复用线上 app/info", async () => {
    const plan = await new OppoChannel().plan(makeCtx().ctx);
    expect(plan).toEqual({
      channel: "oppo",
      platform: "android",
      artifactVersion: "",
      action: "stage+submit",
      afterApproval: "auto-publish",
      notes: "发布字段从线上 app/info 复用，只替换包与更新说明",
    });
  });

  it("errorHints 覆盖现行高频错误码（910003/911045/300002 为本轮按现行文档补齐）", () => {
    expect(new OppoChannel().errorHints).toEqual({
      "911215": "应用已有版本在审核中（等待审核完成或到控制台撤回后再提）",
      "911216": "版本更新任务处理中（稍后用 status 查询结果）",
      "800002": "参数校验失败：常见于简介/截图等商店资料不符合规格",
      "910003": "上传 sign 失效（sign 单次有效），重新发起上传即可重试",
      "911045": "client_id 与包名不匹配（检查 API 客户端与应用的归属关系）",
      "300002": "api_sign 签名错误（检查 client_secret 与系统时间偏移）",
    });
  });
});

describe("OppoChannel.status", () => {
  /** status 链路路由：token + app/info（携带 audit_status） */
  function statusRoutes(data: Record<string, unknown>) {
    return [
      {
        match: "developer/v1/token",
        response: { json: { errno: 0, data: { access_token: TOKEN } } },
      },
      { match: "/resource/v1/app/info", response: { json: { errno: 0, data } } },
    ];
  }

  it("请求形状：GET app/info，query 带 pkg_name（现行文档 id=11004 snake_case）+ api_sign 签名", async () => {
    const mf = mockFetch(statusRoutes({ audit_status: 1 }));
    await expect(new OppoChannel().status(makeCtx().ctx)).resolves.toEqual({ state: "reviewing" });

    const call = mf.find("/resource/v1/app/info")!;
    expect(call.method).toBe("GET");
    const params = queryParams(call.url);
    expect(params.pkg_name).toBe(PKG_NAME);
    expect(params.pkgName).toBeUndefined(); // 旧 camelCase 参数名不再发送
    expect(params.access_token).toBe(TOKEN);
    expectSigned(params);
  });

  it("auditStatus（旧 camelCase 字段）同样识别 → reviewing", async () => {
    mockFetch(statusRoutes({ auditStatus: 1 }));
    await expect(new OppoChannel().status(makeCtx().ctx)).resolves.toEqual({
      state: "reviewing",
    });
  });

  it("audit_status=1 审核中 → reviewing（现行对照表重写，旧映射 1=待提审 已废弃）", async () => {
    mockFetch(statusRoutes({ audit_status: 1 }));
    await expect(new OppoChannel().status(makeCtx().ctx)).resolves.toEqual({ state: "reviewing" });
  });

  it("audit_status=4 运营审核中 → reviewing", async () => {
    mockFetch(statusRoutes({ audit_status: 4 }));
    await expect(new OppoChannel().status(makeCtx().ctx)).resolves.toEqual({ state: "reviewing" });
  });

  it("audit_status=2 审核通过 → approved（未上线 live=false）", async () => {
    mockFetch(statusRoutes({ audit_status: 2 }));
    await expect(new OppoChannel().status(makeCtx().ctx)).resolves.toEqual({
      state: "approved",
      live: false,
    });
  });

  it("audit_status=6 运营通过 → approved（未上线 live=false）", async () => {
    mockFetch(statusRoutes({ audit_status: 6 }));
    await expect(new OppoChannel().status(makeCtx().ctx)).resolves.toEqual({
      state: "approved",
      live: false,
    });
  });

  it("audit_status=111 上线 → approved live", async () => {
    mockFetch(statusRoutes({ audit_status: 111 }));
    await expect(new OppoChannel().status(makeCtx().ctx)).resolves.toEqual({
      state: "approved",
      live: true,
    });
  });

  it.each([3, 5, 444])(
    "audit_status=%s（测试不通过/运营打回/审核不通过）→ rejected，refuse_reason 原样透出不解析",
    async (code) => {
      // 线上 refuse_reason 常为 PHP 序列化串 —— 契约为原样透出，不做解析
      mockFetch(statusRoutes({ audit_status: code, refuse_reason: 'a:1:{i:0;s:6:"启动崩溃";}' }));
      await expect(new OppoChannel().status(makeCtx().ctx)).resolves.toEqual({
        state: "rejected",
        reason: 'a:1:{i:0;s:6:"启动崩溃";}',
      });
    },
  );

  it("旧字段名 audit_reject_reason/rejectReason 不再读取（v1 推测字段已删）", async () => {
    mockFetch(
      statusRoutes({
        audit_status: 444,
        audit_reject_reason: "旧字段值",
        rejectReason: "旧字段值",
      }),
    );
    await expect(new OppoChannel().status(makeCtx().ctx)).resolves.toEqual({
      state: "rejected",
      reason: undefined,
    });
  });

  it("驳回原因为空串 → reason undefined", async () => {
    mockFetch(statusRoutes({ audit_status: 5, refuse_reason: "" }));
    await expect(new OppoChannel().status(makeCtx().ctx)).resolves.toEqual({
      state: "rejected",
      reason: undefined,
    });
  });

  it("未知编号 → unknown raw 含编号", async () => {
    mockFetch(statusRoutes({ audit_status: 9 }));
    await expect(new OppoChannel().status(makeCtx().ctx)).resolves.toEqual({
      state: "unknown",
      raw: "audit_status=9（未验证编号）",
    });
  });

  it("audit_status 非数值 → unknown raw 透传原值", async () => {
    mockFetch(statusRoutes({ audit_status: "pending" }));
    await expect(new OppoChannel().status(makeCtx().ctx)).resolves.toEqual({
      state: "unknown",
      raw: "audit_status=pending",
    });
  });

  it.each([
    { code: 0, label: "未发布" },
    { code: 7, label: "定时发布" },
    { code: 22, label: "已冻结" },
  ])("audit_status=$code（$label）→ unknown + raw 标签", async ({ code, label }) => {
    mockFetch(statusRoutes({ audit_status: code }));
    await expect(new OppoChannel().status(makeCtx().ctx)).resolves.toEqual({
      state: "unknown",
      raw: `${label}（audit_status=${code}）`,
    });
  });

  it("响应无 data → unknown raw 含提示（data ?? {} 回退）", async () => {
    mockFetch([
      {
        match: "developer/v1/token",
        response: { json: { errno: 0, data: { access_token: TOKEN } } },
      },
      { match: "/resource/v1/app/info", response: { json: { errno: 0 } } },
    ]);
    await expect(new OppoChannel().status(makeCtx().ctx)).resolves.toEqual({
      state: "unknown",
      raw: expect.stringContaining("app/info 无 audit_status"),
    });
  });

  it("无 audit_status → unknown raw 含提示", async () => {
    mockFetch(statusRoutes({}));
    await expect(new OppoChannel().status(makeCtx().ctx)).resolves.toEqual({
      state: "unknown",
      raw: expect.stringContaining("app/info 无 audit_status"),
    });
  });

  it("errno 非 0 抛错", async () => {
    mockFetch([
      {
        match: "developer/v1/token",
        response: { json: { errno: 0, data: { access_token: TOKEN } } },
      },
      {
        match: "/resource/v1/app/info",
        response: { json: { errno: 4004, data: { message: "无权限" } } },
      },
    ]);
    await expect(new OppoChannel().status(makeCtx().ctx)).rejects.toThrow(
      "OPPO 查询审核状态失败 errno=4004",
    );
  });

  it("errno 非 0 且 data 无 message → 错误文案 message 段为空", async () => {
    mockFetch([
      {
        match: "developer/v1/token",
        response: { json: { errno: 0, data: { access_token: TOKEN } } },
      },
      { match: "/resource/v1/app/info", response: { json: { errno: 4004, data: {} } } },
    ]);
    await expect(new OppoChannel().status(makeCtx().ctx)).rejects.toThrow(
      "OPPO 查询审核状态失败 errno=4004 :",
    );
  });

  it("缺 pkgName 抛错（含用途提示）", async () => {
    mockFetch([]);
    const { ctx } = makeTestCtx({
      credentials: { OPPO_CLIENT_ID: CLIENT_ID, OPPO_CLIENT_SECRET: CLIENT_SECRET },
    });
    await expect(new OppoChannel().status(ctx)).rejects.toThrow(
      "OPPO 渠道缺少 pkgName（审核状态查询必需）",
    );
  });
});

describe("OppoChannel.stage", () => {
  it("完整链路：token → get-upload-url → multipart 上传，暂存 url/md5（不查 app/info）", async () => {
    const mock = mockFetch(oppoRoutes());
    const { ctx, events } = makeCtx();
    const res = await new OppoChannel().stage(ctx);

    // 调用顺序与 URL（去掉 query）；app/info 有频控且仅 submit 需要，stage 不查
    expect(mock.calls.map((c) => `${c.method} ${c.url.split("?")[0]}`)).toEqual([
      `GET ${API_BASE}/developer/v1/token`,
      `GET ${API_BASE}/resource/v1/upload/get-upload-url`,
      `POST ${UPLOAD_URL}`,
    ]);
    expect(mock.calls.some((c) => c.url.includes("/resource/v1/app/info"))).toBe(false);

    // GET token：client_id/client_secret 明文 query，不带 api_sign
    const tokenParams = queryParams(mock.calls[0]!.url);
    expect(tokenParams).toEqual({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET });

    // get-upload-url：无业务参数，仅公共参数 + 签名
    const cfgParams = queryParams(mock.calls[1]!.url);
    expect(Object.keys(cfgParams).sort()).toEqual(["access_token", "api_sign", "timestamp"]);
    expectSigned(cfgParams);

    // multipart 上传：FormData 含 type/sign/文件（文件名=产物 basename，内容=产物字节）
    const upCall = mock.calls[2]!;
    expect(upCall.body).toBeInstanceOf(FormData);
    const form = upCall.body as FormData;
    expect(form.get("type")).toBe("apk");
    expect(form.get("sign")).toBe(UPLOAD_SIGN);
    const file = form.get("file") as File;
    expect(file.name).toBe("applift-oppo-test-app-release.apk");
    expect(Buffer.from(await file.arrayBuffer()).toString("utf8")).toBe(FILE_CONTENT);

    // 事件与结果（ref=md5）
    expect(events).toEqual([
      { type: "phase", phase: "auth", message: "token 获取成功（48h 有效）" },
      { type: "phase", phase: "upload", message: "上传 applift-oppo-test-app-release.apk" },
      { type: "phase", phase: "bind", message: `上传成功（md5: ${APK_MD5}）` },
    ]);
    expect(res).toEqual({ ok: true, ref: APK_MD5 });
  });

  it("凭据可从 target 兜底（credentials 缺 OPPO_CLIENT_ID）", async () => {
    const mock = mockFetch(oppoRoutes());
    const { ctx } = makeCtx({
      credentials: { OPPO_CLIENT_SECRET: CLIENT_SECRET },
      target: { pkgName: PKG_NAME, OPPO_CLIENT_ID: CLIENT_ID },
    });
    const res = await new OppoChannel().stage(ctx);
    expect(res).toEqual({ ok: true, ref: APK_MD5 });
    expect(queryParams(mock.calls[0]!.url).client_id).toBe(CLIENT_ID);
  });

  it.each([
    ["OPPO_CLIENT_ID", { OPPO_CLIENT_SECRET: CLIENT_SECRET }, { pkgName: PKG_NAME }],
    ["OPPO_CLIENT_SECRET", { OPPO_CLIENT_ID: CLIENT_ID }, { pkgName: PKG_NAME }],
  ] as const)("缺凭据 %s 时抛错且不发请求", async (key, credentials, target) => {
    const mock = mockFetch([]);
    const { ctx } = makeCtx({ credentials: { ...credentials }, target: { ...target } });
    await expect(new OppoChannel().stage(ctx)).rejects.toThrow(`OPPO 渠道缺少 ${key}`);
    expect(mock.calls.length).toBe(0);
  });

  it("缺 pkgName 时抛错并提示项目配置位置", async () => {
    const mock = mockFetch([]);
    const { ctx } = makeCtx({ target: {} });
    await expect(new OppoChannel().stage(ctx)).rejects.toThrow(
      "OPPO 渠道缺少 pkgName（项目配置 android.stores.oppo.pkgName）",
    );
    expect(mock.calls.length).toBe(0);
  });

  it("token errno 非 0 抛错", async () => {
    mockFetch(
      oppoRoutes({
        "developer/v1/token": { json: { errno: 1001, data: { message: "invalid client" } } },
      }),
    );
    const { ctx } = makeCtx();
    await expect(new OppoChannel().stage(ctx)).rejects.toThrow("OPPO token 失败 errno=1001");
  });

  it("token 响应缺 access_token 抛错", async () => {
    mockFetch(oppoRoutes({ "developer/v1/token": { json: { errno: 0, data: {} } } }));
    const { ctx } = makeCtx();
    await expect(new OppoChannel().stage(ctx)).rejects.toThrow("OPPO token 响应缺少 access_token");
  });

  it("get-upload-url errno 非 0 时抛错", async () => {
    mockFetch(oppoRoutes({ "get-upload-url": { json: { errno: 3001 } } }));
    const { ctx } = makeCtx();
    await expect(new OppoChannel().stage(ctx)).rejects.toThrow("OPPO 获取上传配置失败 errno=3001");
  });

  it("get-upload-url 响应缺 upload_url/sign 抛错", async () => {
    mockFetch(oppoRoutes({ "get-upload-url": { json: { errno: 0, data: {} } } }));
    const { ctx } = makeCtx();
    await expect(new OppoChannel().stage(ctx)).rejects.toThrow("OPPO 上传配置缺失");
  });

  it("get-upload-url 响应无 data 字段 → 同样报上传配置缺失", async () => {
    mockFetch(oppoRoutes({ "get-upload-url": { json: { errno: 0 } } }));
    const { ctx } = makeCtx();
    await expect(new OppoChannel().stage(ctx)).rejects.toThrow("OPPO 上传配置缺失");
  });

  it("上传接口 errno 非 0 抛错（无 data 时错误信息仍含 errno）", async () => {
    mockFetch(oppoRoutes({ "uploadfs.example": { json: { errno: 5003 } } }));
    const { ctx } = makeCtx();
    await expect(new OppoChannel().stage(ctx)).rejects.toThrow("OPPO 文件上传失败 errno=5003");
  });

  it("上传响应缺 url（md5 存在）抛错", async () => {
    mockFetch(oppoRoutes({ "uploadfs.example": { json: { errno: 0, data: { md5: APK_MD5 } } } }));
    const { ctx } = makeCtx();
    await expect(new OppoChannel().stage(ctx)).rejects.toThrow("OPPO 上传响应缺少 url/md5");
  });

  it("get-upload-url 响应缺 sign（upload_url 存在）抛错", async () => {
    mockFetch(
      oppoRoutes({ "get-upload-url": { json: { errno: 0, data: { upload_url: UPLOAD_URL } } } }),
    );
    const { ctx } = makeCtx();
    await expect(new OppoChannel().stage(ctx)).rejects.toThrow("OPPO 上传配置缺失");
  });

  it("stage 遇非 JSON 响应抛错（含渠道名与 HTTP 状态）", async () => {
    // token
    mockFetch(
      oppoRoutes({ "developer/v1/token": { status: 502, text: "<html>Bad Gateway</html>" } }),
    );
    await expect(new OppoChannel().stage(makeCtx().ctx)).rejects.toThrow(
      "OPPO token返回非 JSON（HTTP 502）",
    );
    // get-upload-url
    mockFetch(oppoRoutes({ "get-upload-url": { status: 502, text: "<html>Bad Gateway</html>" } }));
    await expect(new OppoChannel().stage(makeCtx().ctx)).rejects.toThrow(
      "OPPO 获取上传配置返回非 JSON（HTTP 502）",
    );
    // 文件上传（文件服务器域名）
    mockFetch(
      oppoRoutes({ "uploadfs.example": { status: 502, text: "<html>Bad Gateway</html>" } }),
    );
    await expect(new OppoChannel().stage(makeCtx().ctx)).rejects.toThrow(
      "OPPO 文件上传返回非 JSON（HTTP 502）",
    );
  });
});

describe("OppoChannel.submit", () => {
  /** stage + submit 连跑（submit 依赖 channel 实例内暂存的 apkUrl/md5） */
  async function stageThenSubmit(o: { updateDescription?: string; routes?: RouteEntry[] }) {
    const mock = mockFetch(o.routes ?? oppoRoutes());
    const ch = new OppoChannel();
    await ch.stage(makeCtx().ctx);
    const { ctx, events } = makeCtx({ updateDescription: o.updateDescription });
    const res = await ch.submit(ctx);
    const updCall = mock.calls.find((c) => c.url.includes("/resource/v1/app/upd"))!;
    const params = Object.fromEntries(
      new URLSearchParams((updCall.body as string | undefined) ?? ""),
    );
    return { mock, res, events, updCall, params };
  }

  it("app/upd 复用线上字段（snake_case 全集 + apk_url JSON 数组），update_desc 取 ctx 值；POST form + 合法 api_sign", async () => {
    const { res, events, updCall, params } = await stageThenSubmit({
      updateDescription: "ctx 提供的更新说明",
    });

    expect(updCall.method).toBe("POST");
    expect(updCall.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(updCall.url).toBe(`${API_BASE}/resource/v1/app/upd`);

    // 包引用来自 stage 暂存；apk_url 为 JSON 数组格式（对拍 python build_publish_params 原文）
    expect(params.pkg_name).toBe(PKG_NAME);
    expect(params.version_code).toBe("301");
    expect(JSON.parse(params.apk_url!)).toEqual([{ url: APK_URL, md5: APK_MD5, cpu_code: 0 }]);

    // update_desc 回退链第 1 级：ctx 值优先于线上
    expect(params.update_desc).toBe("ctx 提供的更新说明");

    // 复用线上字段（对拍 python build_publish_params 全集；summary 截 13 字符后滤标点/空格，fixture 无标点故等值）
    expect(APP_INFO.summary.length).toBeGreaterThan(13);
    expect(params.app_name).toBe(APP_INFO.app_name);
    expect(params.second_category_id).toBe("109"); // 线上数值 → String 化
    expect(params.third_category_id).toBe("1102");
    expect(params.summary).toBe(APP_INFO.summary.slice(0, 13));
    expect(params.detail_desc).toBe(APP_INFO.detail_desc);
    expect(params.privacy_source_url).toBe(APP_INFO.privacy_source_url);
    expect(params.icon_url).toBe(APP_INFO.icon_url);
    expect(params.pic_url).toBe(APP_INFO.pic_url);
    expect(params.online_type).toBe("1");
    expect(params.test_desc).toBe(APP_INFO.test_desc);
    // 商务联系人 trim（apkgo: app/info 带前导空白回传会被 [800002] 拒绝）
    expect(params.business_username).toBe("千云科技");
    expect(params.business_email).toBe("2052576764@qq.com");
    expect(params.business_mobile).toBe("13800138000");
    expect(params.age_level).toBe("3");
    expect(params.adaptive_equipment).toBe("4");
    expect(params.adaptive_type).toBe("1");
    // copyright_url 为空 → 兜底 electronic_cert_url（apkgo: 电子版权证书账号）
    expect(params.copyright_url).toBe(APP_INFO.electronic_cert_url);
    expect(params.icp_url).toBe(APP_INFO.icp_url);
    // 可选字段: 线上空串不传（python 原文 if existing 才传）
    expect(params).not.toHaveProperty("landscape_pic_url");

    expect(params.access_token).toBe(TOKEN);
    expectSigned(params);

    expect(res).toEqual({ ok: true, ref: JSON.stringify({ packageId: "pkg-123" }) });
    // versionCode 来源提示 + phase 序列
    expect(
      events.some((e) => e.type === "progress" && e.detail === "versionCode=301（来源: 项目配置）"),
    ).toBe(true);
    expect(events.filter((e) => e.type === "phase").map((e) => e.phase)).toEqual([
      "auth",
      "submit",
      "done",
    ]);
  });

  it("update_desc 回退链第 2 级：无 ctx 值时复用线上 update_desc", async () => {
    const { params } = await stageThenSubmit({});
    expect(params.update_desc).toBe("线上更新说明");
  });

  it("update_desc 回退链第 3 级：线上也没有时用默认文案", async () => {
    const { params } = await stageThenSubmit({
      routes: oppoRoutes({
        "/resource/v1/app/info": { json: { errno: 0, data: { app_name: APP_INFO.app_name } } },
      }),
    });
    expect(params.update_desc).toBe("修复已知问题，优化用户体验");
  });

  it("线上缺字段：固定字段按 python 默认值传，可选字段不传", async () => {
    const { params } = await stageThenSubmit({
      routes: oppoRoutes({
        "/resource/v1/app/info": {
          json: { errno: 0, data: { app_name: "千云司机端", update_desc: "线上更新说明" } },
        },
      }),
    });
    // 固定字段缺省（对拍 python build_publish_params 默认值）
    expect(params.pkg_name).toBe("");
    expect(params.summary).toBe("");
    expect(params.detail_desc).toBe("");
    expect(params.age_level).toBe("3");
    expect(params.adaptive_equipment).toBe("4");
    expect(params.adaptive_type).toBe("1");
    // 可选字段: 线上没有就不传
    expect(params).not.toHaveProperty("electronic_cert_url");
    expect(params).not.toHaveProperty("icp_url");
    expect(params).not.toHaveProperty("landscape_pic_url");
  });

  it("summary 截断后过滤标点与空格（文档要求不含任何标点符号和空格）", async () => {
    const { params } = await stageThenSubmit({
      routes: oppoRoutes({
        "/resource/v1/app/info": {
          json: {
            errno: 0,
            data: { ...APP_INFO, summary: "千云司机端全新版本上线，修复多项问题" },
          },
        },
      }),
    });
    // 13 字截断落在「，修」上，滤掉标点/空格后透出（不再残留尾部逗号）
    expect(params.summary).toBe("千云司机端全新版本上线修");
  });

  it("无 staged 直接 submit：重走上传链路获取 apkUrl/md5 后发布成功（--skip-stage 跨进程场景）", async () => {
    const mock = mockFetch(oppoRoutes());
    const { ctx, events } = makeCtx({ updateDescription: "ctx 提供的更新说明" });
    const res = await new OppoChannel().submit(ctx);

    // 调用顺序：token → app/info → get-upload-url → 上传 → app/upd → task-state（异步任务确认）
    expect(mock.calls.map((c) => `${c.method} ${c.url.split("?")[0]}`)).toEqual([
      `GET ${API_BASE}/developer/v1/token`,
      `GET ${API_BASE}/resource/v1/app/info`,
      `GET ${API_BASE}/resource/v1/upload/get-upload-url`,
      `POST ${UPLOAD_URL}`,
      `POST ${API_BASE}/resource/v1/app/upd`,
      `POST ${API_BASE}/resource/v1/app/task-state`,
    ]);

    // app/info 查询参数为现行文档 snake_case pkg_name（id=11004），旧 pkgName 不再发送
    const infoQuery = queryParams(
      mock.calls.find((c) => c.url.includes("/resource/v1/app/info"))!.url,
    );
    expect(infoQuery.pkg_name).toBe(PKG_NAME);
    expect(infoQuery.pkgName).toBeUndefined();

    // 包引用来自回退重传
    const updCall = mock.calls.find((c) => c.url.includes("/resource/v1/app/upd"))!;
    const params = Object.fromEntries(
      new URLSearchParams((updCall.body as string | undefined) ?? ""),
    );
    expect(JSON.parse(params.apk_url!)).toEqual([{ url: APK_URL, md5: APK_MD5, cpu_code: 0 }]);
    expect(params.update_desc).toBe("ctx 提供的更新说明");

    expect(res).toEqual({ ok: true, ref: JSON.stringify({ packageId: "pkg-123" }) });
    // 回退提示与上传事件存在
    expect(
      events.some((e) => e.type === "progress" && String(e.detail).includes("无 stage 产物")),
    ).toBe(true);
    expect(events.filter((e) => e.type === "phase").map((e) => e.phase)).toEqual([
      "auth",
      "upload",
      "bind",
      "submit",
      "done",
    ]);
  });

  it("app/info errno 非 0 时抛错并携带 data.message（不发上传/提审）", async () => {
    const mock = mockFetch(
      oppoRoutes({
        "/resource/v1/app/info": { json: { errno: 2002, data: { message: "应用不存在" } } },
      }),
    );
    const { ctx } = makeCtx();
    await expect(new OppoChannel().submit(ctx)).rejects.toThrow(
      "OPPO 查询应用详情失败 errno=2002 应用不存在",
    );
    expect(mock.calls.find((c) => c.url.includes("uploadfs.example"))).toBeUndefined();
    expect(mock.calls.find((c) => c.url.includes("/resource/v1/app/upd"))).toBeUndefined();
  });

  it.each([
    { key: "/resource/v1/app/info", msg: "OPPO 查询应用详情返回非 JSON（HTTP 502）" },
    { key: "/resource/v1/app/upd", msg: "OPPO 发布版本返回非 JSON（HTTP 502）" },
  ])("submit 遇非 JSON 响应抛错（$key）", async ({ key, msg }) => {
    mockFetch(oppoRoutes({ [key]: { status: 502, text: "<html>Bad Gateway</html>" } }));
    const ch = new OppoChannel();
    await ch.stage(makeCtx().ctx);
    await expect(ch.submit(makeCtx().ctx)).rejects.toThrow(msg);
  });

  it("app/upd errno 非 0 时抛错并携带 data.message", async () => {
    const mock = mockFetch(
      oppoRoutes({
        "/resource/v1/app/upd": { json: { errno: 4004, data: { message: "包名与线上不一致" } } },
      }),
    );
    const ch = new OppoChannel();
    await ch.stage(makeCtx().ctx);
    const { ctx } = makeCtx();
    await expect(ch.submit(ctx)).rejects.toThrow("OPPO 发布版本失败 errno=4004 包名与线上不一致");
    expect(mock.calls.find((c) => c.url.includes("/resource/v1/app/upd"))).toBeDefined();
  });

  it("app/info 与 app/upd 均无 data 时走默认文案，ref 为 {}", async () => {
    const { res, events, params } = await stageThenSubmit({
      routes: oppoRoutes({
        "/resource/v1/app/info": { json: { errno: 0 } },
        "/resource/v1/app/upd": { json: { errno: 0 } },
      }),
    });
    expect(params.update_desc).toBe("修复已知问题，优化用户体验");
    expect(res).toEqual({ ok: true, ref: "{}" });
    expect(events.at(-1)).toEqual({
      type: "phase",
      phase: "done",
      message: "已提交（versionCode=301）",
    });
  });

  it("errno=911215 应用审核中：非失败，warn 提示 + ok 返回（对拍 apkgo oppo.go 语义）", async () => {
    const { res, events } = await stageThenSubmit({
      updateDescription: "ctx 提供的更新说明",
      routes: oppoRoutes({
        "/resource/v1/app/upd": { json: { errno: 911215, data: { message: "应用审核中" } } },
      }),
    });
    expect(res).toEqual({ ok: true, ref: "errno=911215 已在审核队列" });
    expect(events.some((e) => e.type === "warn" && String(e.message).includes("应用审核中"))).toBe(
      true,
    );
    expect(events.filter((e) => e.type === "phase").map((e) => e.phase)).toEqual([
      "auth",
      "submit",
      "done",
    ]);
  });

  it("errno=911216 版本更新任务处理中：非失败，warn 提示稍后查 status（对拍 apkgo oppo.go 语义）", async () => {
    const { res, events } = await stageThenSubmit({
      updateDescription: "ctx 提供的更新说明",
      routes: oppoRoutes({
        "/resource/v1/app/upd": {
          json: { errno: 911216, data: { message: "版本更新任务处理中" } },
        },
      }),
    });
    expect(res).toEqual({ ok: true, ref: "errno=911216 任务处理中" });
    expect(events.some((e) => e.type === "warn" && String(e.message).includes("任务处理中"))).toBe(
      true,
    );
  });

  describe("app/upd errno=0 后 task-state 异步任务轮询（现行文档「获取任务状态」）", () => {
    /** 顺序返回 states 的 task-state 路由（越界重复末位；state=3 携带 err_msg） */
    function taskStateSequence(states: number[], errMsg = "包名与 APK 内包名不一致") {
      let i = 0;
      return oppoRoutes({
        "/resource/v1/app/task-state": () => {
          const taskState = states[Math.min(i, states.length - 1)]!;
          i += 1;
          return {
            json: {
              errno: 0,
              data:
                taskState === 3 ? { task_state: 3, err_msg: errMsg } : { task_state: taskState },
            },
          };
        },
      });
    }

    it("轮询请求形状：POST task-state（pkg_name+version_code+api_sign）；task_state=2 → ok", async () => {
      const { mock, res } = await stageThenSubmit({ routes: taskStateSequence([2]) });
      const stCall = mock.calls.find((c) => c.url.includes("/resource/v1/app/task-state"))!;
      expect(stCall.method).toBe("POST");
      expect(stCall.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      const stParams = Object.fromEntries(new URLSearchParams((stCall.body as string) ?? ""));
      expect(stParams.pkg_name).toBe(PKG_NAME);
      expect(stParams.version_code).toBe("301");
      expect(stParams.access_token).toBe(TOKEN);
      expectSigned(stParams);
      // 先等间隔再查（现行文档建议 ≥10s），命中终态后不再多查
      expect(sleepMock).toHaveBeenCalledTimes(1);
      expect(sleepMock).toHaveBeenCalledWith(10_000);
      expect(res).toEqual({ ok: true, ref: JSON.stringify({ packageId: "pkg-123" }) });
    });

    it("task_state=1 继续等：1→1→2 第 3 次确认成功，间隔 10s×3", async () => {
      const { mock, res, events } = await stageThenSubmit({ routes: taskStateSequence([1, 1, 2]) });
      expect(mock.calls.filter((c) => c.url.includes("/resource/v1/app/task-state"))).toHaveLength(
        3,
      );
      expect(sleepMock).toHaveBeenCalledTimes(3);
      expect(sleepMock).toHaveBeenNthCalledWith(2, 10_000);
      expect(res.ok).toBe(true);
      expect(
        events.some((e) => e.type === "progress" && String(e.detail).includes("任务处理中")),
      ).toBe(true);
      expect(
        events.some((e) => e.type === "progress" && String(e.detail).includes("任务处理成功")),
      ).toBe(true);
    });

    it("task_state=3 → submit 失败并透出 err_msg（受理后异步失败不误报成功）", async () => {
      const mock = mockFetch(taskStateSequence([3]));
      const ch = new OppoChannel();
      await ch.stage(makeCtx().ctx);
      await expect(ch.submit(makeCtx().ctx)).rejects.toThrow(
        "OPPO 发布任务处理失败（task_state=3）: 包名与 APK 内包名不一致",
      );
      expect(mock.calls.filter((c) => c.url.includes("/resource/v1/app/task-state"))).toHaveLength(
        1,
      );
    });

    it("task_state=3 且无 err_msg → 兜底透出 data 原文", async () => {
      const mock = mockFetch(
        oppoRoutes({
          "/resource/v1/app/task-state": { json: { errno: 0, data: { task_state: 3 } } },
        }),
      );
      const ch = new OppoChannel();
      await ch.stage(makeCtx().ctx);
      await expect(ch.submit(makeCtx().ctx)).rejects.toThrow(
        'OPPO 发布任务处理失败（task_state=3）: {"task_state":3}',
      );
      expect(mock.calls.filter((c) => c.url.includes("/resource/v1/app/task-state"))).toHaveLength(
        1,
      );
    });

    it("5 次均 task_state=1 → 超时视为已受理：warn 提示结果未知 + ok 返回", async () => {
      const { mock, res, events } = await stageThenSubmit({ routes: taskStateSequence([1]) });
      expect(mock.calls.filter((c) => c.url.includes("/resource/v1/app/task-state"))).toHaveLength(
        5,
      );
      expect(sleepMock).toHaveBeenCalledTimes(5);
      expect(res).toEqual({ ok: true, ref: JSON.stringify({ packageId: "pkg-123" }) });
      expect(
        events.some((e) => e.type === "warn" && String(e.message).includes("异步处理结果未知")),
      ).toBe(true);
      expect(events.filter((e) => e.type === "phase").map((e) => e.phase)).toEqual([
        "auth",
        "submit",
        "done",
      ]);
    });

    it("task-state errno 非 0 → 抛错（异步查询失败不静默）", async () => {
      const mock = mockFetch(
        oppoRoutes({
          "/resource/v1/app/task-state": { json: { errno: 300002, data: { message: "签名错误" } } },
        }),
      );
      const ch = new OppoChannel();
      await ch.stage(makeCtx().ctx);
      await expect(ch.submit(makeCtx().ctx)).rejects.toThrow(
        "OPPO 查询任务状态失败 errno=300002 签名错误",
      );
      expect(mock.calls.filter((c) => c.url.includes("/resource/v1/app/task-state"))).toHaveLength(
        1,
      );
    });
  });

  it("versionCode 解析失败（无项目配置/aapt/build.gradle）→ 报错指引配置项，不发 app/upd", async () => {
    // ANDROID_HOME 指向不存在目录：屏蔽本机 SDK build-tools 扫描（冷启动逐个验证二进制会拖慢用例），保证确定性
    const prevHome = process.env.ANDROID_HOME;
    process.env.ANDROID_HOME = path.join(os.tmpdir(), "applift-no-sdk");
    try {
      const mock = mockFetch(oppoRoutes());
      const ch = new OppoChannel();
      await ch.stage(makeCtx().ctx);
      const { ctx } = makeCtx({ target: { pkgName: PKG_NAME } }); // 无 versionCode
      await expect(ch.submit(ctx)).rejects.toThrow("OPPO 渠道无法解析 versionCode");
      expect(mock.calls.find((c) => c.url.includes("/resource/v1/app/upd"))).toBeUndefined();
    } finally {
      if (prevHome === undefined) delete process.env.ANDROID_HOME;
      else process.env.ANDROID_HOME = prevHome;
    }
  });

  it("versionCode 兜底链：aapt 失败后读 APK 相对路径 build.gradle（对拍 python get_apk_version_code）", async () => {
    // 构造 {root}/a/b/c/d/app-release.apk + {root}/app/build.gradle（dirname 上跳 4 级命中）
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "applift-oppo-vc-"));
    // 同上：屏蔽本机 SDK 扫描，PATH 无 aapt 时 ENOENT 快速失败 → 直达 gradle 兜底
    const prevHome = process.env.ANDROID_HOME;
    process.env.ANDROID_HOME = path.join(root, "no-sdk");
    try {
      const apkDir = path.join(root, "a", "b", "c", "d");
      fs.mkdirSync(apkDir, { recursive: true });
      fs.mkdirSync(path.join(root, "app"), { recursive: true });
      const apk = path.join(apkDir, "app-release.apk");
      fs.writeFileSync(apk, FILE_CONTENT);
      fs.writeFileSync(path.join(root, "app", "build.gradle"), "defaultConfig { versionCode 42 }");

      const mock = mockFetch(oppoRoutes());
      const { ctx } = makeTestCtx({
        credentials: { OPPO_CLIENT_ID: CLIENT_ID, OPPO_CLIENT_SECRET: CLIENT_SECRET },
        target: { pkgName: PKG_NAME }, // 无 versionCode，走提取链
        artifactPath: apk,
      });
      await new OppoChannel().submit(ctx);
      const updCall = mock.calls.find((c) => c.url.includes("/resource/v1/app/upd"))!;
      const params = Object.fromEntries(
        new URLSearchParams((updCall.body as string | undefined) ?? ""),
      );
      expect(params.version_code).toBe("42");
    } finally {
      if (prevHome === undefined) delete process.env.ANDROID_HOME;
      else process.env.ANDROID_HOME = prevHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("更新说明少于 5 字 → 本地报错（对拍 python 参数校验），不发 app/upd", async () => {
    const mock = mockFetch(oppoRoutes());
    const ch = new OppoChannel();
    await ch.stage(makeCtx().ctx);
    const { ctx } = makeCtx({ updateDescription: "太短" });
    await expect(ch.submit(ctx)).rejects.toThrow("OPPO 更新说明不少于 5 个字");
    expect(mock.calls.find((c) => c.url.includes("/resource/v1/app/upd"))).toBeUndefined();
  });
});

describe("OPPO version_code 解析分支补齐", () => {
  it("ANDROID_HOME 假 SDK：build-tools 新版优先 + aapt2 dump badging 提取 versionCode", async () => {
    // fs/os/path 已静态导入；局部重绑定为既有测试风格保留——见顶部 import
    const fakeSdk = fs.mkdtempSync(path.join(os.tmpdir(), "applift-sdk-"));
    const bt = path.join(fakeSdk, "build-tools", "34.0.0");
    fs.mkdirSync(bt, { recursive: true });
    // aapt2 假脚本：输出 versionCode
    const script = process.platform === "win32" ? "aapt2.bat" : "aapt2";
    const sh = `#!/bin/sh\necho "package: name=com.x versionCode='4235' versionName='1.2.3'"\n`;
    fs.writeFileSync(path.join(bt, script), sh, { mode: 0o755 });
    process.env.ANDROID_HOME = fakeSdk;
    try {
      const { ctx } = makeCtx({
        credentials: { OPPO_CLIENT_ID: "c", OPPO_CLIENT_SECRET: "s" },
        target: { pkgName: "com.x" },
      });
      const v = resolveVersionCode(ctx);
      expect(v).toBe("4235");
    } finally {
      delete process.env.ANDROID_HOME;
      fs.rmSync(fakeSdk, { recursive: true, force: true });
    }
  });

  it("未设 ANDROID_HOME → 回退 ~/Library/Android/sdk 探测 build-tools", async () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "applift-home-"));
    const bt = path.join(fakeHome, "Library", "Android", "sdk", "build-tools", "34.0.0");
    fs.mkdirSync(bt, { recursive: true });
    fs.writeFileSync(
      path.join(bt, "aapt2"),
      `#!/bin/sh\necho "package: name=com.x versionCode='501' versionName='2.0.0'"\n`,
      { mode: 0o755 },
    );
    const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    const saved = process.env.ANDROID_HOME;
    delete process.env.ANDROID_HOME;
    try {
      const { ctx } = makeCtx({
        credentials: { OPPO_CLIENT_ID: "c", OPPO_CLIENT_SECRET: "s" },
        target: { pkgName: "com.x" }, // 无 versionCode 覆盖
      });
      expect(resolveVersionCode(ctx)).toBe("501");
    } finally {
      homeSpy.mockRestore();
      if (saved !== undefined) process.env.ANDROID_HOME = saved;
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("新版 aapt2 输出无 versionCode → 逐工具回退到旧版 aapt 提取", async () => {
    const fakeSdk = fs.mkdtempSync(path.join(os.tmpdir(), "applift-sdk-"));
    for (const [ver, tool, out] of [
      ["35.0.0", "aapt2", "package: name=com.x versionName='2.1.0'"], // 新版无 versionCode
      ["34.0.0", "aapt", "package: name=com.x versionCode='77' versionName='2.0.0'"],
    ] as const) {
      const bt = path.join(fakeSdk, "build-tools", ver);
      fs.mkdirSync(bt, { recursive: true });
      fs.writeFileSync(path.join(bt, tool), `#!/bin/sh\necho "${out}"\n`, { mode: 0o755 });
    }
    process.env.ANDROID_HOME = fakeSdk;
    try {
      const { ctx } = makeCtx({
        credentials: { OPPO_CLIENT_ID: "c", OPPO_CLIENT_SECRET: "s" },
        target: { pkgName: "com.x" },
      });
      const events: Array<{ type: string; detail?: string }> = [];
      ctx.emit = ((e: { type: string; detail?: string }) => events.push(e)) as typeof ctx.emit;
      expect(resolveVersionCode(ctx)).toBe("77");
      const src = events.find((e) => e.type === "progress")?.detail ?? "";
      expect(src).toContain("来源: ");
      expect(src).toContain("34.0.0");
    } finally {
      delete process.env.ANDROID_HOME;
      fs.rmSync(fakeSdk, { recursive: true, force: true });
    }
  });
});

describe("OPPO version_code 解析防御分支", () => {
  it("build.gradle 存在但无 versionCode → 跳过候选，最终报错含配置指引", () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "applift-home-"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "applift-gradle-"));
    // 产物放四层深，使第一个 gradle 候选 = <root>/app/build.gradle（无 versionCode）
    const apk = path.join(root, "a", "b", "c", "d", "app-release.apk");
    fs.mkdirSync(path.dirname(apk), { recursive: true });
    fs.writeFileSync(apk, "fake");
    fs.mkdirSync(path.join(root, "app"));
    fs.writeFileSync(path.join(root, "app/build.gradle"), "android { compileSdk 35 }");
    const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    const savedPath = process.env.PATH;
    const savedHome = process.env.ANDROID_HOME;
    process.env.PATH = fakeHome; // PATH 上无 aapt2/aapt
    delete process.env.ANDROID_HOME;
    try {
      const { ctx } = makeCtx({
        credentials: { OPPO_CLIENT_ID: "c", OPPO_CLIENT_SECRET: "s" },
        target: { pkgName: "com.x" },
      });
      ctx.artifactPath = apk;
      expect(() => resolveVersionCode(ctx)).toThrow(/无法解析 versionCode.*显式指定/s);
    } finally {
      homeSpy.mockRestore();
      process.env.PATH = savedPath;
      if (savedHome !== undefined) process.env.ANDROID_HOME = savedHome;
      fs.rmSync(fakeHome, { recursive: true, force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
