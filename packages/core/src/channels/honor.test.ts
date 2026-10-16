import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HonorChannel } from "./honor.js";
import { mockFetch, makeTestCtx } from "../test-utils.js";
import type { ChannelContext } from "../channel.js";

const PUBLISH_BASE = "https://appmarket-openapi-drcn.cloud.honor.com";
const TOKEN = "honor-tok-1";
const APP_ID = "901234567";
const OBJECT_ID = 8888;
const RELEASE_ID = "rel-20260620001";
const UPLOAD_URL =
  "https://upload-drcn.example.com/signed/obj?Expires=1781900000&signature=sig-abc";
const CREDS = { HONOR_CLIENT_ID: "honor-cid", HONOR_CLIENT_SECRET: "honor-sec" };

const artifactContent = Buffer.from("fake-honor-apk-0123456789abcdef");
let ARTIFACT = "";
let artifactSha256 = "";

beforeAll(() => {
  ARTIFACT = path.join(os.tmpdir(), `honor-test-${process.pid}.apk`);
  fs.writeFileSync(ARTIFACT, artifactContent);
  artifactSha256 = crypto.createHash("sha256").update(artifactContent).digest("hex");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeCtx(
  over: {
    credentials?: Record<string, string>;
    target?: Record<string, string>;
    updateDescription?: string;
    releaseTime?: string;
    emit?: ChannelContext["emit"];
  } = {},
): ChannelContext {
  const built = makeTestCtx({
    credentials: over.credentials ?? CREDS,
    target: over.target ?? { appId: APP_ID },
    artifactPath: ARTIFACT,
    updateDescription: over.updateDescription,
  });
  return {
    ...built.ctx,
    releaseTime: over.releaseTime,
    emit: over.emit ?? built.ctx.emit,
  } as ChannelContext;
}

const TOKEN_ROUTE = {
  match: "iam.developer.honor.com/auth/token",
  response: { json: { access_token: TOKEN } },
};

/** stage 标准四条路由：token / get-file-upload-url / 签名上传地址 / update-file-info */
function happyStageRoutes() {
  return [
    TOKEN_ROUTE,
    {
      match: "get-file-upload-url",
      response: { json: { code: 0, data: [{ uploadUrl: UPLOAD_URL, objectId: OBJECT_ID }] } },
    },
    { match: "upload-drcn.example.com", response: { json: { code: 0 } } },
    { match: "update-file-info", response: { json: { code: 0 } } },
  ];
}

describe("HonorChannel 元数据", () => {
  const ch = new HonorChannel();

  it("id/label/capabilities", () => {
    expect(ch.id).toBe("honor");
    expect(ch.label).toBe("荣耀应用市场");
    expect(ch.capabilities).toEqual({ stage: true, submit: true, scheduled: true, status: true });
  });

  it("plan: 无 releaseTime → auto-publish", async () => {
    await expect(ch.plan(makeCtx())).resolves.toMatchObject({
      channel: "honor",
      platform: "android",
      artifactVersion: "",
      action: "stage+submit",
      afterApproval: "auto-publish",
    });
  });

  it("plan: 有 releaseTime → scheduled，notes 提示定时走 releaseType=2", async () => {
    const plan = await ch.plan(makeCtx({ releaseTime: "2026-06-20T10:00:00+08:00" }));
    expect(plan.afterApproval).toBe("scheduled");
    expect(plan.notes).toContain("releaseType=2");
  });
});

describe("HonorChannel.stage", () => {
  it("完整链路：token(form) → get-file-upload-url(数组 body fileType=100) → multipart 签名地址 → update-file-info bindingFileList", async () => {
    const mf = mockFetch(happyStageRoutes());
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const res = await new HonorChannel().stage(makeCtx({ emit: (e) => events.push(e) }));

    expect(res).toEqual({ ok: true, ref: "8888" });
    expect(mf.calls).toHaveLength(4);

    // token: client_credentials 表单
    const tokenCall = mf.find("iam.developer.honor.com/auth/token")!;
    expect(tokenCall.method).toBe("POST");
    expect(tokenCall.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(tokenCall.body).toBe(
      "client_id=honor-cid&client_secret=honor-sec&grant_type=client_credentials",
    );

    // step 1: 申请上传地址，appId 走 query，body 是数组（支持多文件）
    const urlCall = mf.find("get-file-upload-url")!;
    expect(urlCall.url).toBe(
      `${PUBLISH_BASE}/openapi/v1/publish/get-file-upload-url?appId=${APP_ID}`,
    );
    expect(urlCall.method).toBe("POST");
    expect(urlCall.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(urlCall.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(urlCall.body as string)).toEqual([
      {
        fileName: path.basename(ARTIFACT),
        fileType: 100, // 100=应用包(APK)
        fileSize: artifactContent.length,
        fileSha256: artifactSha256,
      },
    ]);

    // step 2: multipart 上传到签名地址（仅 Bearer，无手动 Content-Type）
    const upCall = mf.find("upload-drcn.example.com")!;
    expect(upCall.url).toBe(UPLOAD_URL);
    expect(upCall.method).toBe("POST");
    expect(upCall.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(upCall.body).toBeInstanceOf(FormData);
    expect((upCall.body as FormData).get("file")).toBeInstanceOf(Blob);

    // step 3: 绑定文件
    const bindCall = mf.find("update-file-info")!;
    expect(bindCall.url).toBe(
      `${PUBLISH_BASE}/openapi/v1/publish/update-file-info?appId=${APP_ID}`,
    );
    expect(bindCall.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(bindCall.body as string)).toEqual({
      bindingFileList: [{ objectId: OBJECT_ID }],
    });

    expect(events).toEqual([
      { type: "phase", phase: "auth", message: "token 获取成功" },
      {
        type: "phase",
        phase: "upload",
        message: `上传 ${path.basename(ARTIFACT)}（${artifactContent.length} B）`,
      },
      { type: "phase", phase: "bind", message: `软件包已绑定（objectId: ${OBJECT_ID}）` },
    ]);
  });

  it("缺 appId 抛错（含配置位置提示）", async () => {
    mockFetch([]);
    await expect(new HonorChannel().stage(makeCtx({ target: {} }))).rejects.toThrow(
      "荣耀渠道缺少 appId（项目配置 android.stores.honor.appId）",
    );
  });

  it("缺 HONOR_CLIENT_ID 抛错含键名", async () => {
    mockFetch([]);
    await expect(
      new HonorChannel().stage(makeCtx({ credentials: { HONOR_CLIENT_SECRET: "sec" } })),
    ).rejects.toThrow("荣耀渠道缺少 HONOR_CLIENT_ID");
  });

  it("缺 HONOR_CLIENT_SECRET 抛错含键名", async () => {
    mockFetch([]);
    await expect(
      new HonorChannel().stage(makeCtx({ credentials: { HONOR_CLIENT_ID: "cid" } })),
    ).rejects.toThrow("荣耀渠道缺少 HONOR_CLIENT_SECRET");
  });

  it("token 失败：透传 error + error_description", async () => {
    mockFetch([
      {
        match: "iam.developer.honor.com/auth/token",
        response: {
          status: 401,
          json: { error: "invalid_client", error_description: "client secret 有误" },
        },
      },
    ]);
    await expect(new HonorChannel().stage(makeCtx())).rejects.toThrow(
      "荣耀 token 失败: invalid_client client secret 有误",
    );
  });

  it("token 失败：非 JSON 响应回退 HTTP 状态", async () => {
    mockFetch([
      {
        match: "iam.developer.honor.com/auth/token",
        response: { status: 503, text: "Service Unavailable" },
      },
    ]);
    // error 缺省为空串，与 HTTP 状态间留双空格（源码行为）
    await expect(new HonorChannel().stage(makeCtx())).rejects.toThrow("荣耀 token 失败:  HTTP 503");
  });

  it("get-file-upload-url code!=0 抛错（HTTP 200 也可能带错误 code）", async () => {
    mockFetch([
      TOKEN_ROUTE,
      { match: "get-file-upload-url", response: { json: { code: 100202, msg: "appId 不存在" } } },
    ]);
    await expect(new HonorChannel().stage(makeCtx())).rejects.toThrow(
      "荣耀 获取上传地址失败 code=100202 appId 不存在",
    );
  });

  it("get-file-upload-url code!=0 且无 msg 时不阻断报错", async () => {
    mockFetch([TOKEN_ROUTE, { match: "get-file-upload-url", response: { json: { code: 1 } } }]);
    await expect(new HonorChannel().stage(makeCtx())).rejects.toThrow(
      "荣耀 获取上传地址失败 code=1 :",
    );
  });

  it("get-file-upload-url 返回非 JSON 抛错（含 HTTP 状态）", async () => {
    mockFetch([
      TOKEN_ROUTE,
      { match: "get-file-upload-url", response: { status: 502, text: "<html>Bad Gateway</html>" } },
    ]);
    await expect(new HonorChannel().stage(makeCtx())).rejects.toThrow(
      "荣耀 获取上传地址返回非 JSON（HTTP 502）",
    );
  });

  it("data[0] 缺 uploadUrl/objectId 抛上传地址响应异常", async () => {
    mockFetch([
      TOKEN_ROUTE,
      { match: "get-file-upload-url", response: { json: { code: 0, data: [{ objectId: 1 }] } } },
    ]);
    await expect(new HonorChannel().stage(makeCtx())).rejects.toThrow("荣耀上传地址响应异常");
  });

  it("data 整体缺失同样抛上传地址响应异常", async () => {
    mockFetch([TOKEN_ROUTE, { match: "get-file-upload-url", response: { json: { code: 0 } } }]);
    await expect(new HonorChannel().stage(makeCtx())).rejects.toThrow("荣耀上传地址响应异常");
  });

  it("签名地址上传 HTTP 200 但 code!=0 抛错（URL 过期/摘要不匹配提示）", async () => {
    mockFetch([
      TOKEN_ROUTE,
      {
        match: "get-file-upload-url",
        response: { json: { code: 0, data: [{ uploadUrl: UPLOAD_URL, objectId: OBJECT_ID }] } },
      },
      {
        match: "upload-drcn.example.com",
        response: { json: { code: 403, msg: "signature expired" } },
      },
    ]);
    await expect(new HonorChannel().stage(makeCtx())).rejects.toThrow(
      "荣耀上传失败 code=403 signature expired（签名 URL 过期或 sha256 不匹配）",
    );
  });

  it("签名地址上传 code!=0 且无 msg 时仍抛错", async () => {
    mockFetch([
      TOKEN_ROUTE,
      {
        match: "get-file-upload-url",
        response: { json: { code: 0, data: [{ uploadUrl: UPLOAD_URL, objectId: OBJECT_ID }] } },
      },
      { match: "upload-drcn.example.com", response: { json: { code: 500 } } },
    ]);
    await expect(new HonorChannel().stage(makeCtx())).rejects.toThrow(
      "荣耀上传失败 code=500 （签名 URL 过期或 sha256 不匹配）",
    );
  });

  it("签名地址上传返回非 JSON 抛错", async () => {
    mockFetch([
      TOKEN_ROUTE,
      {
        match: "get-file-upload-url",
        response: { json: { code: 0, data: [{ uploadUrl: UPLOAD_URL, objectId: OBJECT_ID }] } },
      },
      {
        match: "upload-drcn.example.com",
        response: { status: 200, text: "<xml>PartEnvelopeBroken</xml>" },
      },
    ]);
    await expect(new HonorChannel().stage(makeCtx())).rejects.toThrow(
      "荣耀上传返回非 JSON（HTTP 200）",
    );
  });

  it("update-file-info code!=0 抛错", async () => {
    mockFetch([
      TOKEN_ROUTE,
      {
        match: "get-file-upload-url",
        response: { json: { code: 0, data: [{ uploadUrl: UPLOAD_URL, objectId: OBJECT_ID }] } },
      },
      { match: "upload-drcn.example.com", response: { json: { code: 0 } } },
      { match: "update-file-info", response: { json: { code: 100303, msg: "objectId 无效" } } },
    ]);
    await expect(new HonorChannel().stage(makeCtx())).rejects.toThrow(
      "荣耀 绑定文件失败 code=100303 objectId 无效",
    );
  });
});

describe("HonorChannel.submit", () => {
  it("全网发布：releaseType=1，无文案时不调 update-language-info", async () => {
    const mf = mockFetch([
      TOKEN_ROUTE,
      { match: "submit-audit", response: { json: { code: 0, data: RELEASE_ID } } },
    ]);
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const res = await new HonorChannel().submit(makeCtx({ emit: (e) => events.push(e) }));

    expect(res).toEqual({ ok: true, ref: RELEASE_ID });
    expect(mf.find("update-language-info")).toBeUndefined();

    const sub = mf.find("submit-audit")!;
    expect(sub.url).toBe(`${PUBLISH_BASE}/openapi/v1/publish/submit-audit?appId=${APP_ID}`);
    expect(sub.method).toBe("POST");
    expect(sub.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(sub.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(sub.body as string)).toEqual({ releaseType: 1 });
    expect(events[events.length - 1]).toEqual({
      type: "phase",
      phase: "done",
      message: `已提审（审核通过后自动上架，releaseId: ${RELEASE_ID}）`,
    });
  });

  it("submit-audit 无 data 时 ref 缺省，done 事件 releaseId 显示 ?", async () => {
    mockFetch([TOKEN_ROUTE, { match: "submit-audit", response: { json: { code: 0 } } }]);
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const res = await new HonorChannel().submit(makeCtx({ emit: (e) => events.push(e) }));

    expect(res).toEqual({ ok: true });
    expect(events[events.length - 1]).toEqual({
      type: "phase",
      phase: "done",
      message: "已提审（审核通过后自动上架，releaseId: ?）",
    });
  });

  it("定时上架且无 data 时 done 事件 releaseId 显示 ?", async () => {
    mockFetch([TOKEN_ROUTE, { match: "submit-audit", response: { json: { code: 0 } } }]);
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    await new HonorChannel().submit(
      makeCtx({ releaseTime: "2026-06-20T10:00:00+08:00", emit: (e) => events.push(e) }),
    );
    expect(events[events.length - 1]).toEqual({
      type: "phase",
      phase: "done",
      message: "已提审（定时上架 2026-06-20T10:00:00+08:00，releaseId: ?）",
    });
  });

  it("updateDescription：先写 update-language-info(newFeature) 再提审", async () => {
    const mf = mockFetch([
      TOKEN_ROUTE,
      { match: "update-language-info", response: { json: { code: 0 } } },
      { match: "submit-audit", response: { json: { code: 0, data: RELEASE_ID } } },
    ]);
    await new HonorChannel().submit(makeCtx({ updateDescription: "修复若干已知问题" }));

    const lang = mf.find("update-language-info")!;
    expect(lang.url).toBe(
      `${PUBLISH_BASE}/openapi/v1/publish/update-language-info?appId=${APP_ID}`,
    );
    expect(JSON.parse(lang.body as string)).toEqual({ newFeature: "修复若干已知问题" });
    // 顺序：token → 文案 → 提审
    expect(mf.calls[1]!.url).toContain("update-language-info");
    expect(mf.calls[2]!.url).toContain("submit-audit");
  });

  it("update-language-info 失败 best-effort：warn 不阻断，仍提审成功", async () => {
    const mf = mockFetch([
      TOKEN_ROUTE,
      { match: "update-language-info", response: { json: { code: 40001, msg: "应用简介未填写" } } },
      { match: "submit-audit", response: { json: { code: 0, data: RELEASE_ID } } },
    ]);
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const res = await new HonorChannel().submit(
      makeCtx({ updateDescription: "新功能上线", emit: (e) => events.push(e) }),
    );

    expect(res).toEqual({ ok: true, ref: RELEASE_ID });
    const warn = events.find((e) => e.type === "warn");
    expect(warn?.message).toContain("更新文案未写入（不阻断）");
    expect(warn?.message).toContain("荣耀 更新文案失败 code=40001 应用简介未填写");
    expect(mf.find("submit-audit")).toBeTruthy();
  });

  it("定时上架：releaseTime 偏移去冒号（+08:00→+0800，支持毫秒），releaseType=2", async () => {
    const mf = mockFetch([
      TOKEN_ROUTE,
      { match: "submit-audit", response: { json: { code: 0, data: RELEASE_ID } } },
    ]);
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    await new HonorChannel().submit(
      makeCtx({ releaseTime: "2026-06-20T10:00:00.500+08:00", emit: (e) => events.push(e) }),
    );

    expect(JSON.parse(mf.find("submit-audit")!.body as string)).toEqual({
      releaseType: 2,
      releaseTime: "2026-06-20T10:00:00.500+0800",
    });
    expect(events[events.length - 1]).toEqual({
      type: "phase",
      phase: "done",
      message: `已提审（定时上架 2026-06-20T10:00:00.500+08:00，releaseId: ${RELEASE_ID}）`,
    });
  });

  it("releaseTime Z 结尾转 +0000", async () => {
    const mf = mockFetch([
      TOKEN_ROUTE,
      { match: "submit-audit", response: { json: { code: 0, data: RELEASE_ID } } },
    ]);
    await new HonorChannel().submit(makeCtx({ releaseTime: "2026-06-20T02:00:00Z" }));
    expect(JSON.parse(mf.find("submit-audit")!.body as string)).toEqual({
      releaseType: 2,
      releaseTime: "2026-06-20T02:00:00+0000",
    });
  });

  it("releaseTime 非 RFC3339 抛格式错误", async () => {
    mockFetch([TOKEN_ROUTE]);
    await expect(
      new HonorChannel().submit(makeCtx({ releaseTime: "2026-06-20 10:00:00" })),
    ).rejects.toThrow("荣耀 releaseTime 格式异常（需 RFC3339）: 2026-06-20 10:00:00");
  });

  it("缺 appId 抛错", async () => {
    mockFetch([]);
    await expect(new HonorChannel().submit(makeCtx({ target: {} }))).rejects.toThrow(
      "荣耀渠道缺少 appId",
    );
  });

  it("submit-audit code!=0 抛错", async () => {
    mockFetch([
      TOKEN_ROUTE,
      { match: "submit-audit", response: { json: { code: 100101, msg: "存在审核中的版本" } } },
    ]);
    await expect(new HonorChannel().submit(makeCtx())).rejects.toThrow(
      "荣耀 提交审核失败 code=100101 存在审核中的版本",
    );
  });
});

describe("HonorChannel.status", () => {
  function statusRoutes(auditResult: number, extra: Record<string, unknown> = {}) {
    return [
      TOKEN_ROUTE,
      {
        match: "get-audit-result",
        response: { json: { code: 0, data: [{ releaseId: "rel-1", auditResult, ...extra }] } },
      },
    ];
  }

  it("请求形状：appId 走 body 数字数组（不带 query），auditResult=0 → reviewing", async () => {
    const mf = mockFetch(statusRoutes(0));
    const st = await new HonorChannel().status(makeCtx());

    expect(st).toEqual({ state: "reviewing" });
    const call = mf.find("get-audit-result")!;
    expect(call.url).toBe(`${PUBLISH_BASE}/openapi/v1/publish/get-audit-result`); // 例外：不走 query
    expect(call.method).toBe("POST");
    expect(call.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(call.body as string)).toEqual({ appId: [{ appId: Number(APP_ID) }] });
  });

  it("auditResult=1 → approved（审核通过即自动上架 live=true）", async () => {
    mockFetch(statusRoutes(1));
    await expect(new HonorChannel().status(makeCtx())).resolves.toEqual({
      state: "approved",
      live: true,
    });
  });

  it("auditResult=2 → rejected（带 auditMessage）", async () => {
    mockFetch(statusRoutes(2, { auditMessage: "应用简介含敏感信息" }));
    await expect(new HonorChannel().status(makeCtx())).resolves.toEqual({
      state: "rejected",
      reason: "应用简介含敏感信息",
    });
  });

  it("auditResult=3 → unknown（非审核状态）", async () => {
    mockFetch(statusRoutes(3));
    await expect(new HonorChannel().status(makeCtx())).resolves.toEqual({
      state: "unknown",
      raw: "非审核状态（auditResult=3）",
    });
  });

  it("auditResult=4 → unknown（编辑中未提交）", async () => {
    mockFetch(statusRoutes(4));
    await expect(new HonorChannel().status(makeCtx())).resolves.toEqual({
      state: "unknown",
      raw: "编辑中未提交（auditResult=4）",
    });
  });

  it("未知编号回退 raw（含编号与消息）", async () => {
    mockFetch(statusRoutes(9, { auditMessage: "新状态" }));
    await expect(new HonorChannel().status(makeCtx())).resolves.toEqual({
      state: "unknown",
      raw: "auditResult=9 新状态",
    });
  });

  it("未知编号且无 auditMessage 时 raw 仅含编号", async () => {
    mockFetch(statusRoutes(7));
    await expect(new HonorChannel().status(makeCtx())).resolves.toEqual({
      state: "unknown",
      raw: "auditResult=7",
    });
  });

  it("data 无条目 → unknown raw 含提示", async () => {
    mockFetch([
      TOKEN_ROUTE,
      { match: "get-audit-result", response: { json: { code: 0, data: [] } } },
    ]);
    await expect(new HonorChannel().status(makeCtx())).resolves.toEqual({
      state: "unknown",
      raw: expect.stringContaining("get-audit-result 无数据"),
    });
  });

  it("缺 appId 抛错（含用途提示）", async () => {
    mockFetch([]);
    await expect(new HonorChannel().status(makeCtx({ target: {} }))).rejects.toThrow(
      "荣耀渠道缺少 appId（审核状态查询必需）",
    );
  });

  it("appId 非数字抛错（get-audit-result 要求数字）", async () => {
    mockFetch([]);
    await expect(
      new HonorChannel().status(makeCtx({ target: { appId: "com.foo.bar" } })),
    ).rejects.toThrow("荣耀 appId 非数字: com.foo.bar（get-audit-result 要求 body 内为数字）");
  });
});
