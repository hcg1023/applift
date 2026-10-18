/**
 * 腾讯应用宝渠道契约测试（对拍 python/android-publish 权威链路）：
 * stage: query_app_detail → get_file_upload_info(pkg_name/app_id/file_type=apk/file_name → pre_sign_url+serial_number)
 *        → PUT 预签名 COS（Content-Type: application/octet-stream，无 sign 自签）
 * submit: update_app(pkg_name/app_id/deploy_type/apk32_flag=1/apk32_file_serial_number/apk32_file_md5/feature[+deploy_time])
 * status: query_app_update_status(pkg_name/app_id) → audit_status/audit_reason
 */
import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { YybChannel } from "./yyb.js";
import { hmacSign } from "./shared/sign.js";
import { formatSize } from "../util.js";
import { mockFetch, makeTestCtx } from "../test-utils.js";
import { buildZip } from "./shared/apk-abi.test.js";
import type { MockCall } from "../test-utils.js";

const API_BASE = "https://p.open.qq.com/open_file/developer_api";
const COS_URL =
  "https://yyb-cos-1250000000.cos.ap-guangzhou.myqcloud.com/apk/20240001/presigned?sign=q-sign";

const CREDS = { YYB_USER_ID: "1000123", YYB_ACCESS_SECRET: "yyb-secret", YYB_APP_ID: "20240001" };
const TARGET = { pkgName: "com.qianyun.driver" };
const SECRET = CREDS.YYB_ACCESS_SECRET;

const APK_NAME = "applift-yyb-test.apk";
const APK_CONTENT = "fake apk bytes for yyb contract test";
const APK_MD5 = crypto.createHash("md5").update(Buffer.from(APK_CONTENT, "utf8")).digest("hex");
const apkPath = path.join(os.tmpdir(), APK_NAME);
const SERIAL = "3021000012345678";

/** stage 成功链路的标准路由（detail 扁平 app_name；upload_info 携带 pre_sign_url + 数字 serial_number） */
function stageRoutes() {
  return [
    {
      match: "/query_app_detail",
      response: { json: { ret: 0, app_name: "千云司机端" } },
    },
    {
      match: "/get_file_upload_info",
      // serial_number 为数字：覆盖 String() 转换
      response: { json: { ret: 0, pre_sign_url: COS_URL, serial_number: 3021000012345678 } },
    },
    { match: "cos.ap-guangzhou.myqcloud.com", response: { status: 200, text: "" } },
  ];
}

/** 解析 formPost 的 urlencoded body */
function bodyParams(call: MockCall | undefined): URLSearchParams {
  if (!call || typeof call.body !== "string")
    throw new Error(`预期的表单调用缺失: ${call?.url ?? "none"}`);
  return new URLSearchParams(call.body);
}

/** 断言 API 调用形状（URL/method/Content-Type）并返回 body 参数 */
function expectApiCall(call: MockCall | undefined, callPath: string): URLSearchParams {
  if (!call) throw new Error(`缺少 ${callPath} 调用`);
  expect(call.url).toBe(`${API_BASE}${callPath}`);
  expect(call.method).toBe("POST");
  expect(call.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
  return bodyParams(call);
}

beforeAll(() => fs.writeFileSync(apkPath, APK_CONTENT));
afterAll(() => fs.unlinkSync(apkPath));
afterEach(() => vi.unstubAllGlobals());

describe("YybChannel 元数据", () => {
  it("id/label/capabilities 声明", () => {
    const ch = new YybChannel();
    expect(ch.id).toBe("yyb");
    expect(ch.label).toBe("腾讯应用宝");
    expect(ch.capabilities).toEqual({ stage: true, submit: true, scheduled: true, status: true });
  });

  it("plan 返回 stage+submit 计划与限额说明", async () => {
    const { ctx } = makeTestCtx({ credentials: CREDS, target: TARGET });
    const plan = await new YybChannel().plan(ctx);
    expect(plan).toMatchObject({
      channel: "yyb",
      platform: "android",
      artifactVersion: "",
      action: "stage+submit",
      afterApproval: "auto-publish",
    });
    expect(plan.notes).toContain("100 次/天");
    expect(plan.notes).toContain("50 次/天");
  });

  it("plan 在 releaseTime 时返回 scheduled", async () => {
    const { ctx } = makeTestCtx({
      credentials: CREDS,
      target: TARGET,
      releaseTime: "2026-11-11T10:00:00+08:00",
    });
    const plan = await new YybChannel().plan(ctx);
    expect(plan.afterApproval).toBe("scheduled");
  });
});

describe("YybChannel.status", () => {
  function statusRoutes(auditStatus: number | undefined, auditReason?: string) {
    return [
      {
        match: "/query_app_update_status",
        response: {
          json:
            auditStatus === undefined
              ? { ret: 0 }
              : auditReason === undefined
                ? { ret: 0, audit_status: auditStatus }
                : { ret: 0, audit_status: auditStatus, audit_reason: auditReason },
        },
      },
    ];
  }

  it("请求形状：POST query_app_update_status，body 带 user_id/timestamp/pkg_name/app_id/sign", async () => {
    const mf = mockFetch(statusRoutes(1));
    const { ctx } = makeTestCtx({ credentials: CREDS, target: TARGET });
    await expect(new YybChannel().status(ctx)).resolves.toEqual({ state: "reviewing" });

    const params = expectApiCall(mf.find("/query_app_update_status"), "/query_app_update_status");
    expect(params.get("user_id")).toBe(CREDS.YYB_USER_ID);
    expect(params.get("pkg_name")).toBe("com.qianyun.driver");
    expect(params.get("app_id")).toBe(CREDS.YYB_APP_ID);
    expect(params.get("timestamp")).toMatch(/^\d+$/);
    // 用请求自带 timestamp 重算签名，锁死参与签名的参数集合
    const { sign, ...rest } = Object.fromEntries(params);
    expect(sign).toBe(hmacSign(SECRET, rest));
  });

  it("audit_status=3 → approved live", async () => {
    mockFetch(statusRoutes(3));
    const { ctx } = makeTestCtx({ credentials: CREDS, target: TARGET });
    await expect(new YybChannel().status(ctx)).resolves.toEqual({ state: "approved", live: true });
  });

  it("audit_status=2 → rejected，audit_reason 作驳回原因", async () => {
    mockFetch(statusRoutes(2, "应用描述与实际功能不符"));
    const { ctx } = makeTestCtx({ credentials: CREDS, target: TARGET });
    await expect(new YybChannel().status(ctx)).resolves.toEqual({
      state: "rejected",
      reason: "应用描述与实际功能不符",
    });
  });

  it("audit_status=2 无 audit_reason → rejected 无 reason", async () => {
    mockFetch(statusRoutes(2));
    const { ctx } = makeTestCtx({ credentials: CREDS, target: TARGET });
    await expect(new YybChannel().status(ctx)).resolves.toEqual({ state: "rejected" });
  });

  it("audit_status=8 → unknown（已撤销）", async () => {
    mockFetch(statusRoutes(8));
    const { ctx } = makeTestCtx({ credentials: CREDS, target: TARGET });
    await expect(new YybChannel().status(ctx)).resolves.toEqual({
      state: "unknown",
      raw: "已撤销（audit_status=8）",
    });
  });

  it("未知编号 → unknown raw 含编号", async () => {
    mockFetch(statusRoutes(6));
    const { ctx } = makeTestCtx({ credentials: CREDS, target: TARGET });
    await expect(new YybChannel().status(ctx)).resolves.toEqual({
      state: "unknown",
      raw: "audit_status=6（未验证编号）",
    });
  });

  it("无 audit_status 字段 → unknown raw 含提示", async () => {
    mockFetch(statusRoutes(undefined));
    const { ctx } = makeTestCtx({ credentials: CREDS, target: TARGET });
    await expect(new YybChannel().status(ctx)).resolves.toEqual({
      state: "unknown",
      raw: expect.stringContaining("query_app_update_status 无 audit_status"),
    });
  });

  it("ret 非 0 抛错", async () => {
    mockFetch([
      { match: "/query_app_update_status", response: { json: { ret: -1, msg: "sign error" } } },
    ]);
    const { ctx } = makeTestCtx({ credentials: CREDS, target: TARGET });
    await expect(new YybChannel().status(ctx)).rejects.toThrow(
      "应用宝 /query_app_update_status 失败 ret=-1",
    );
  });

  it("缺 YYB_APP_ID 抛错（含用途提示）", async () => {
    mockFetch([]);
    const { ctx } = makeTestCtx({
      credentials: { YYB_USER_ID: CREDS.YYB_USER_ID, YYB_ACCESS_SECRET: CREDS.YYB_ACCESS_SECRET },
      target: TARGET,
    });
    await expect(new YybChannel().status(ctx)).rejects.toThrow(
      "应用宝渠道缺少 YYB_APP_ID（审核状态查询必需）",
    );
  });

  it("缺 pkgName 抛错（含位置提示）", async () => {
    mockFetch([]);
    const { ctx } = makeTestCtx({
      credentials: {
        YYB_USER_ID: CREDS.YYB_USER_ID,
        YYB_ACCESS_SECRET: CREDS.YYB_ACCESS_SECRET,
        YYB_APP_ID: CREDS.YYB_APP_ID,
      },
      target: {},
    });
    await expect(new YybChannel().status(ctx)).rejects.toThrow(
      "应用宝渠道缺少 pkgName（项目配置 android.stores.yyb.pkgName）",
    );
  });
});

describe("YybChannel.stage", () => {
  it("完整链路：query_app_detail → get_file_upload_info → PUT 预签名 COS，不调 update_app", async () => {
    const m = mockFetch(stageRoutes());
    const { ctx, events } = makeTestCtx({
      credentials: CREDS,
      target: TARGET,
      artifactPath: apkPath,
    });

    const res = await new YybChannel().stage(ctx);

    // 请求序列契约：恰好 3 次，且不含提审
    expect(m.calls.map((c) => c.url)).toEqual([
      `${API_BASE}/query_app_detail`,
      `${API_BASE}/get_file_upload_info`,
      COS_URL,
    ]);
    expect(m.calls.some((c) => c.url.includes("update_app"))).toBe(false);

    // step 1 签名覆盖 user_id/timestamp/pkg_name/app_id
    const qp = expectApiCall(m.calls[0], "/query_app_detail");
    expect(qp.get("user_id")).toBe("1000123");
    expect(qp.get("pkg_name")).toBe("com.qianyun.driver");
    expect(qp.get("app_id")).toBe("20240001");
    expect(qp.get("timestamp")).toMatch(/^\d+$/);
    expect(qp.get("sign")).toBe(
      hmacSign(SECRET, {
        user_id: "1000123",
        timestamp: qp.get("timestamp"),
        pkg_name: "com.qianyun.driver",
        app_id: "20240001",
      }),
    );

    // step 2 —— 对拍 python get_upload_info: pkg_name+app_id+file_type=apk+file_name
    const up = expectApiCall(m.calls[1], "/get_file_upload_info");
    expect(up.get("user_id")).toBe("1000123");
    expect(up.get("pkg_name")).toBe("com.qianyun.driver");
    expect(up.get("app_id")).toBe("20240001");
    expect(up.get("file_type")).toBe("apk");
    expect(up.get("file_name")).toBe(APK_NAME);
    expect(up.get("sign")).toBe(
      hmacSign(SECRET, {
        user_id: "1000123",
        timestamp: up.get("timestamp"),
        pkg_name: "com.qianyun.driver",
        app_id: "20240001",
        file_type: "apk",
        file_name: APK_NAME,
      }),
    );

    // step 3 —— 对拍 python upload_to_cos: PUT 原始字节到预签名 URL，仅 Content-Type 头，无 sign/无 Authorization
    const uploadCall = m.calls[2]!;
    expect(uploadCall.method).toBe("PUT");
    expect(uploadCall.headers["Content-Type"]).toBe("application/octet-stream");
    expect(uploadCall.headers["sign"]).toBeUndefined();
    expect(uploadCall.headers["Authorization"]).toBeUndefined();
    expect(uploadCall.body).toEqual(Buffer.from(APK_CONTENT, "utf8"));

    // 结果与事件
    expect(res).toEqual({ ok: true, ref: SERIAL });
    expect(events.map((e) => e.type)).toEqual(["progress", "progress", "phase", "phase"]);
    expect(events[1]).toEqual({ type: "progress", detail: "应用「千云司机端」校验通过" });
    expect(events[2]).toEqual({
      type: "phase",
      phase: "upload",
      message: `上传 ${APK_NAME}（${formatSize(APK_CONTENT.length)}）`,
    });
    expect(events[3]).toEqual({ type: "phase", phase: "bind", message: "APK 上传成功（未提审）" });
    m.restore();
  });

  it("detail 无 app_name：进度回退为 app_id，链路不受影响", async () => {
    const m = mockFetch([
      { match: "/query_app_detail", response: { json: { ret: 0 } } },
      {
        match: "/get_file_upload_info",
        response: { json: { ret: 0, pre_sign_url: COS_URL, serial_number: 3021000012345678 } },
      },
      { match: "cos.ap-guangzhou.myqcloud.com", response: { status: 204, text: "" } },
    ]);
    const { ctx, events } = makeTestCtx({
      credentials: CREDS,
      target: TARGET,
      artifactPath: apkPath,
    });

    const res = await new YybChannel().stage(ctx);

    expect(events[1]).toEqual({ type: "progress", detail: "应用「20240001」校验通过" });
    expect(res).toEqual({ ok: true, ref: SERIAL });
    m.restore();
  });

  it.each([
    ["YYB_USER_ID", "应用宝渠道缺少 YYB_USER_ID"],
    ["YYB_ACCESS_SECRET", "应用宝渠道缺少 YYB_ACCESS_SECRET"],
    ["YYB_APP_ID", "应用宝渠道缺少 YYB_APP_ID"],
    ["pkgName", "应用宝渠道缺少 pkgName（项目配置 android.stores.yyb.pkgName）"],
  ])("缺 %s 抛错（含键名）且不发任何请求", async (key, msg) => {
    const credentials: Record<string, string> = { ...CREDS };
    const target: Record<string, string> = { ...TARGET };
    if (key === "pkgName") delete target.pkgName;
    else delete credentials[key];
    const m = mockFetch([]);
    const { ctx } = makeTestCtx({ credentials, target, artifactPath: apkPath });

    await expect(new YybChannel().stage(ctx)).rejects.toThrow(msg);
    expect(m.calls.length).toBe(0);
    m.restore();
  });

  it("query_app_detail ret!=0 抛错并中断链路", async () => {
    const m = mockFetch([
      { match: "/query_app_detail", response: { json: { ret: 10010, msg: "app not found" } } },
    ]);
    const { ctx } = makeTestCtx({ credentials: CREDS, target: TARGET, artifactPath: apkPath });

    await expect(new YybChannel().stage(ctx)).rejects.toThrow(
      "应用宝 /query_app_detail 失败 ret=10010",
    );
    expect(m.calls.length).toBe(1); // 后续 get_file_upload_info/上传未发生
    m.restore();
  });

  it("get_file_upload_info ret!=0 抛错（兼容大写 Ret=0 成功）", async () => {
    const m = mockFetch([
      { match: "/query_app_detail", response: { json: { ret: 0 } } },
      { match: "/get_file_upload_info", response: { json: { Ret: 1002, msg: "no permission" } } },
    ]);
    const { ctx } = makeTestCtx({ credentials: CREDS, target: TARGET, artifactPath: apkPath });

    await expect(new YybChannel().stage(ctx)).rejects.toThrow(
      "应用宝 /get_file_upload_info 失败 ret=1002",
    );
    expect(m.calls.length).toBe(2);
    m.restore();
  });

  it("返回缺少 pre_sign_url 或 serial_number 抛错", async () => {
    const m = mockFetch([
      { match: "/query_app_detail", response: { json: { ret: 0 } } },
      {
        match: "/get_file_upload_info",
        response: { json: { ret: 0, serial_number: 3021000012345678 } },
      },
    ]);
    const { ctx } = makeTestCtx({ credentials: CREDS, target: TARGET, artifactPath: apkPath });

    await expect(new YybChannel().stage(ctx)).rejects.toThrow(
      "应用宝返回缺少 pre_sign_url 或 serial_number",
    );
    expect(m.calls.length).toBe(2);
    m.restore();
  });

  it("COS PUT 返回 4xx/5xx 抛错（含 HTTP 状态码与响应体）", async () => {
    const m = mockFetch([
      ...stageRoutes().slice(0, 2),
      { match: "cos.ap-guangzhou.myqcloud.com", response: { status: 403, text: "AccessDenied" } },
    ]);
    const { ctx } = makeTestCtx({ credentials: CREDS, target: TARGET, artifactPath: apkPath });

    await expect(new YybChannel().stage(ctx)).rejects.toThrow(
      "应用宝 COS 上传失败 HTTP 403: AccessDenied",
    );
    m.restore();
  });

  it("upload_info 缺 pre_sign_url/serial_number → 明确报错", async () => {
    mockFetch([
      { match: "/query_app_detail", response: { json: { ret: 0, app_name: "x" } } },
      { match: "/get_file_upload_info", response: { json: { ret: 0 } } }, // 两字段全缺
    ]);
    const { ctx } = makeTestCtx({ credentials: CREDS, target: TARGET, artifactPath: apkPath });
    await expect(new YybChannel().stage(ctx)).rejects.toThrow(/缺少 pre_sign_url 或 serial_number/);
  });
});

describe("YybChannel.submit", () => {
  /** 走完 stage 暂存 serial_number/md5，供 submit 复用 */
  async function stagedChannel() {
    const ch = new YybChannel();
    const m = mockFetch(stageRoutes());
    const staged = makeTestCtx({ credentials: CREDS, target: TARGET, artifactPath: apkPath });
    await ch.stage(staged.ctx);
    m.restore();
    return ch;
  }

  it("复用 stage 暂存 → update_app python 字段集（feature 透传，deploy_type=1 立即发布）", async () => {
    const ch = await stagedChannel();
    const m = mockFetch([
      { match: "/update_app", response: { json: { ret: 0, app_id: 20240001 } } },
    ]);
    const { ctx, events } = makeTestCtx({
      credentials: CREDS,
      target: TARGET,
      artifactPath: apkPath,
      updateDescription: "修复闪退与登录问题",
    });
    const res = await ch.submit(ctx);

    expect(m.calls.length).toBe(1);
    const params = expectApiCall(m.calls[0], "/update_app");
    expect(params.get("user_id")).toBe("1000123");
    expect(params.get("pkg_name")).toBe("com.qianyun.driver");
    expect(params.get("app_id")).toBe("20240001");
    expect(params.get("deploy_type")).toBe("1");
    expect(params.get("apk32_flag")).toBe("1");
    expect(params.get("apk32_file_serial_number")).toBe(SERIAL);
    expect(params.get("apk32_file_md5")).toBe(APK_MD5);
    expect(params.get("feature")).toBe("修复闪退与登录问题");
    expect(params.get("deploy_time")).toBe(null); // 立即发布不带定时
    expect(params.get("timestamp")).toMatch(/^\d+$/);
    // 提审签名覆盖 update_app 全部业务字段
    const { sign, ...rest } = Object.fromEntries(params);
    expect(sign).toBe(hmacSign(SECRET, rest));

    expect(res).toEqual({ ok: true, ref: SERIAL });
    expect(events.map((e) => e.type)).toEqual(["phase", "phase"]);
    expect(events[0]).toEqual({ type: "phase", phase: "submit" });
    expect(String(events[1]?.message)).toBe(`已提交审核（流水号 ${SERIAL}）`);
    m.restore();
  });

  it("arm64-only APK → apk32_flag=2 + apk64_flag=1 + apk64 流水号/md5（apkgo 三分支同构）", async () => {
    const ch = await stagedChannel();
    const m = mockFetch([
      { match: "/update_app", response: { json: { ret: 0, app_id: 20240001 } } },
    ]);
    const arm64Apk = path.join(
      os.tmpdir(),
      `yyb-arm64-${process.pid}-${Math.random().toString(36).slice(2)}.apk`,
    );
    fs.writeFileSync(arm64Apk, buildZip(["lib/arm64-v8a/libapp.so", "classes.dex"]));
    const { ctx } = makeTestCtx({
      credentials: CREDS,
      target: TARGET,
      artifactPath: arm64Apk,
      updateDescription: "arm64-only 包提审",
    });
    try {
      await ch.submit(ctx);
      const params = expectApiCall(m.calls[0], "/update_app");
      expect(params.get("apk32_flag")).toBe("2");
      expect(params.get("apk64_flag")).toBe("1");
      expect(params.get("apk64_file_serial_number")).toBe(SERIAL);
      expect(params.get("apk64_file_md5")).toBe(APK_MD5);
      expect(params.get("apk32_file_serial_number")).toBe(null);
    } finally {
      fs.rmSync(arm64Apk, { force: true });
      m.restore();
    }
  });

  it("无 updateDescription 时 feature 缺省为空串（python: 未传 --feature 不填字段 → 此处空串占位）", async () => {
    const ch = await stagedChannel();
    const m = mockFetch([{ match: "/update_app", response: { json: { ret: 0 } } }]);
    const { ctx } = makeTestCtx({ credentials: CREDS, target: TARGET, artifactPath: apkPath });

    const res = await ch.submit(ctx);

    const params = bodyParams(m.calls[0]);
    expect(params.get("feature")).toBe("");
    expect(res).toEqual({ ok: true, ref: SERIAL });
    m.restore();
  });

  it("定时发布：releaseTime → deploy_type=2 + deploy_time 秒级时间戳", async () => {
    const ch = await stagedChannel();
    const m = mockFetch([{ match: "/update_app", response: { json: { ret: 0 } } }]);
    const { ctx } = makeTestCtx({
      credentials: CREDS,
      target: TARGET,
      artifactPath: apkPath,
      releaseTime: "2026-11-11T10:00:00+08:00",
    });
    await ch.submit(ctx);

    const params = bodyParams(m.calls[0]);
    expect(params.get("deploy_type")).toBe("2");
    expect(params.get("deploy_time")).toBe(
      String(Math.floor(Date.parse("2026-11-11T10:00:00+08:00") / 1000)),
    );
    const { sign, ...rest } = Object.fromEntries(params);
    expect(sign).toBe(hmacSign(SECRET, rest)); // deploy_time 参与签名
    m.restore();
  });

  it("releaseTime 格式非法抛错，不调 update_app", async () => {
    const ch = await stagedChannel();
    const m = mockFetch([{ match: "/update_app", response: { json: { ret: 0 } } }]);
    const { ctx } = makeTestCtx({
      credentials: CREDS,
      target: TARGET,
      artifactPath: apkPath,
      releaseTime: "not-a-date",
    });

    await expect(ch.submit(ctx)).rejects.toThrow("应用宝 releaseTime 格式异常");
    expect(m.calls.length).toBe(0);
    m.restore();
  });

  it("未 stage 直接 submit（跨进程 --skip-stage）→ 现场重传当前包后提审成功", async () => {
    const m = mockFetch([
      ...stageRoutes(),
      { match: "/update_app", response: { json: { ret: 0 } } },
    ]);
    const { ctx, events } = makeTestCtx({
      credentials: CREDS,
      target: TARGET,
      artifactPath: apkPath,
    });

    const res = await new YybChannel().submit(ctx);

    expect(res).toEqual({ ok: true, ref: SERIAL });
    // 重传链路完整：detail → upload_info → COS PUT → update_app
    expect(m.calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/open_file/developer_api/query_app_detail",
      "/open_file/developer_api/get_file_upload_info",
      "/apk/20240001/presigned",
      "/open_file/developer_api/update_app",
    ]);
    expect(events.some((e) => e.type === "warn" && String(e.message).includes("重新上传"))).toBe(
      true,
    );
    const params = bodyParams(m.calls[3]);
    expect(params.get("apk32_file_serial_number")).toBe(SERIAL);
    m.restore();
  });

  it("未 stage 直接 submit 且 stage 返回不 ok → 抛「重新上传失败」（防御臂，子类直返 not-ok）", async () => {
    class FailingStageYyb extends YybChannel {
      override async stage(): Promise<{ ok: boolean; ref?: string; error?: string }> {
        return { ok: false, error: "上传凭证服务暂不可用" };
      }
    }
    const { ctx } = makeTestCtx({ credentials: CREDS, target: TARGET, artifactPath: apkPath });
    await expect(new FailingStageYyb().submit(ctx)).rejects.toThrow("应用宝重新上传失败");
  });

  it("update_app ret!=0 抛错", async () => {
    const ch = await stagedChannel();
    const m = mockFetch([
      { match: "/update_app", response: { json: { ret: 4000049, msg: "apk32_flag invalid" } } },
    ]);
    const { ctx } = makeTestCtx({ credentials: CREDS, target: TARGET, artifactPath: apkPath });

    await expect(ch.submit(ctx)).rejects.toThrow("应用宝 /update_app 失败 ret=4000049");
    m.restore();
  });
});
