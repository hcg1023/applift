/**
 * 用户旅程级 e2e：模拟 CLI 的一切（无 UI）——临时项目目录 → loadProjectConfig →
 * registry 注册真渠道 → runStage 并发传包 → runSubmit（skipStage=true，confirm 自动 yes，
 * historySink 落临时 history.jsonl）→ 读历史 → status 终态。
 *
 * 业务不变量（每个用例注释标明）：
 * 1. 双渠道并发发布全链路走得通：confirm 收到的 plans 必须含全部渠道（用户看到完整计划才能放行 L3）；
 *    history.jsonl 每渠道恰好两条（stage+submit），结构与 HistoryEntry 契约一致；
 *    stage ref（华为 objectId / 应用宝 serial_number）落进历史，供幂等与审计回溯。
 * 2. stage 失败的渠道在 submit 阶段被短路（runSubmit skipStage=false 时 stage 不 ok 不调 submit），
 *    不可逆操作（app-submit）绝不发生；另一渠道不受牵连（渠道间故障隔离）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { loadProjectConfig } from "./config/project.js";
import { DefaultChannelRegistry } from "./registry.js";
import { runStage, runSubmit, type PipelineInput } from "./pipeline.js";
import type { ChannelContext, ReleasePlanEntry } from "./channel.js";
import { HuaweiAndroidChannel, WAIT_BEFORE_SUBMIT_MS } from "./channels/huawei.js";
import { YybChannel } from "./channels/yyb.js";
import { appendEntry, readEntries, type HistoryEvent } from "./history.js";
import { sha256File } from "./util.js";
import { mockFetch } from "./test-utils.js";

const HW_TOKEN = "hw-e2e-token";
const YYB_SERIAL = "889900";
const HW_OBJECT_ID = "hw-obj-e2e-1";

const apkBytes = Buffer.from("e2e-fake-apk-bytes-0123456789");

let projDir = "";
let historyPath = "";
let artifactPath = "";

beforeAll(() => {
  projDir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-e2e-"));
  // 假项目配置：华为 + 应用宝双渠道（stores 里列出的渠道才发——CLI 据此选渠道）
  fs.writeFileSync(
    path.join(projDir, "applift.config.ts"),
    [
      "export default {",
      "  name: 'e2e-demo',",
      "  android: {",
      "    pkgName: 'com.example.e2e',",
      "    stores: {",
      '      huawei: { appId: "1008888" },',
      '      yyb: { YYB_APP_ID: "2000" },',
      "    },",
      "  },",
      "};",
    ].join("\n"),
  );
  // 真实产物文件：渠道 stage 会 statSync/sha256/md5，必须写真字节
  artifactPath = path.join(projDir, "app-release.apk");
  fs.writeFileSync(artifactPath, apkBytes);
  historyPath = path.join(projDir, "history.jsonl");
});

afterAll(() => {
  fs.rmSync(projDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** CLI 等价物：historySink 补 ts/cwd/artifactSha256 后 appendEntry（core 不碰文件系统） */
function makeHistorySink(sha: string, cwd: string) {
  return (e: HistoryEvent) => {
    appendEntry({ ts: Date.now(), artifactSha256: sha, cwd, ...e }, historyPath);
  };
}

/** 华为 + 应用宝双渠道完整 happy 路由（华为含 120s 等待前的全链） */
function happyRoutes() {
  return [
    // 华为 AGC token（安卓/鸿蒙同源接口）
    { match: "oauth2/v1/token", response: { json: { access_token: HW_TOKEN } } },
    // 华为：上传地址 → OBS PUT → 登记软件包 → 文案 → 提审 → 状态
    {
      match: "publish/v2/upload-url/for-obs",
      response: {
        json: {
          ret: { code: 0 },
          urlInfo: { url: "https://obs-hw.example.com/e2e", objectId: HW_OBJECT_ID, method: "PUT" },
        },
      },
    },
    { match: "obs-hw.example.com", response: { status: 200, text: "" } },
    { match: "app-file-info", response: { json: { ret: { code: 0 } } } },
    { match: "app-language-info", response: { json: { ret: { code: 0 } } } },
    { match: "app-submit", response: { json: { ret: { code: 0 } } } },
    {
      match: "publish/v2/app-info",
      response: { json: { ret: { code: 0 }, appInfo: { releaseState: 0 } } },
    },
    // 应用宝：详情 → 上传信息 → COS PUT → 提审 → 状态
    {
      match: "query_app_detail",
      response: { json: { ret: 0, app_info: { app_name: "e2e 应用", version: "1.2.3" } } },
    },
    {
      match: "get_file_upload_info",
      response: {
        json: {
          ret: 0,
          pre_sign_url: "https://cos-yyb.example.com/e2e-apk",
          serial_number: 889900,
        },
      },
    },
    { match: "cos-yyb.example.com", response: { status: 200, text: "" } },
    { match: "update_app", response: { json: { ret: 0 } } },
    { match: "query_app_update_status", response: { json: { ret: 0, audit_status: 3 } } },
  ];
}

function makeContexts(updateDescription?: string): Map<string, ChannelContext> {
  // pipeline 契约要求 Map<channelId, ctx>（动态键、渠道实例注入），事件仅计数不打断
  const mk = (
    credentials: Record<string, string>,
    target: Record<string, string>,
  ): ChannelContext => ({
    credentials,
    target,
    artifactPath,
    updateDescription,
    emit: () => {},
  });
  return new Map<string, ChannelContext>([
    ["huawei", mk({ HW_CLIENT_ID: "cid", HW_CLIENT_SECRET: "sec" }, { appId: "1008888" })],
    [
      "yyb",
      mk(
        { YYB_USER_ID: "u1", YYB_ACCESS_SECRET: "s1", YYB_APP_ID: "2000" },
        { pkgName: "com.example.e2e" },
      ),
    ],
  ]);
}

describe("e2e: 临时项目 → 双渠道 stage/submit → history → status", () => {
  it("全链路：loadProjectConfig → registry → runStage → runSubmit(skipStage) → history 每渠道两条 → status 终态", async () => {
    vi.useFakeTimers();
    // CLI 第一件事：装载项目配置（c12 执行 TS），渠道选择依据 stores 键
    const { config, cwd } = await loadProjectConfig(projDir);
    expect(config.android?.stores.huawei?.appId).toBe("1008888");
    expect(Object.keys(config.android?.stores ?? {})).toEqual(["huawei", "yyb"]);

    // registry 注册真渠道（与 CLI 同构：register(all channels) → 按配置选）
    const reg = new DefaultChannelRegistry();
    reg.register(new HuaweiAndroidChannel());
    reg.register(new YybChannel());
    const channels = ["huawei", "yyb"].map((id) => reg.get(id)!);
    expect(channels.map((c) => c.id)).toEqual(["huawei", "yyb"]);

    const fetchMock = mockFetch(happyRoutes());
    const sha = sha256File(artifactPath);
    const contexts = makeContexts("修复若干问题");

    const confirmedPlans: ReleasePlanEntry[][] = [];
    const input: PipelineInput = {
      channels,
      contexts,
      confirm: async (plans) => {
        confirmedPlans.push(plans);
        return true; // CLI 用户按了 yes
      },
      concurrency: 2,
      cwd,
      historySink: makeHistorySink(sha, cwd),
    };

    // stage 阶段：并发传包到两渠道草稿（不提审）
    const stageSummary = await runStage(input);
    expect(stageSummary.stage.map((s) => s.channel).sort()).toEqual(["huawei", "yyb"]);
    for (const s of stageSummary.stage) expect(s.ok).toBe(true);
    expect(stageSummary.stage.find((s) => s.channel === "huawei")?.plan.notes).toContain("120s");
    // stage ref 落渠道草稿标识：华为 objectId / 应用宝 serial_number
    expect(fetchMock.find("upload-url/for-obs")!.url).toContain("appId=1008888");

    // submit 阶段：skipStage=true（stage 已完成，不重传）+ confirm 自动 yes
    const submitP = runSubmit(input, { skipStage: true });
    await vi.advanceTimersByTimeAsync(WAIT_BEFORE_SUBMIT_MS); // 华为提审前 120s 包解析等待
    const submitSummary = await submitP;
    expect(submitSummary.submit.map((s) => s.channel).sort()).toEqual(["huawei", "yyb"]);
    for (const s of submitSummary.submit) expect(s.ok).toBe(true);

    // 不变量 1a：confirm 收到的 plans 含两渠道（用户看到完整计划才放行 L3）
    expect(confirmedPlans).toHaveLength(1);
    expect(confirmedPlans[0]?.map((p) => p.channel).sort()).toEqual(["huawei", "yyb"]);

    // 不变量 1b：请求顺序 —— 华为 app-submit 在 120s 等待后（即 stage 全部请求之后）才发出
    const submitCallIdx = fetchMock.calls.findIndex((c) => c.url.includes("app-submit"));
    const uploadUrlIdx = fetchMock.calls.findIndex((c) => c.url.includes("upload-url/for-obs"));
    expect(submitCallIdx).toBeGreaterThan(uploadUrlIdx);
    // 应用宝 update_app 携带 stage 得到的 serial_number + 真实 md5（stage 结果喂 submit）
    const updateApp = fetchMock.calls.find((c) => c.url.includes("update_app"))!;
    expect(updateApp.body).toContain(`apk32_file_serial_number=${YYB_SERIAL}`);
    expect(updateApp.body).toContain(
      `apk32_file_md5=${require("node:crypto").createHash("md5").update(apkBytes).digest("hex")}`,
    );
    expect(updateApp.body).toContain(`feature=${encodeURIComponent("修复若干问题")}`);

    // 不变量 1c：history.jsonl 每渠道恰好两条（stage+submit），结构完整可回读
    const entries = readEntries({ sha256: sha }, historyPath);
    expect(entries.filter((e) => e.channel === "huawei").map((e) => e.action)).toEqual([
      "stage",
      "submit",
    ]);
    expect(entries.filter((e) => e.channel === "yyb").map((e) => e.action)).toEqual([
      "stage",
      "submit",
    ]);
    const hwStage = entries.find((e) => e.channel === "huawei" && e.action === "stage")!;
    expect(hwStage.ok).toBe(true);
    expect(hwStage.ref).toBe(HW_OBJECT_ID);
    expect(hwStage.cwd).toBe(cwd);
    const yybStage = entries.find((e) => e.channel === "yyb" && e.action === "stage")!;
    expect(yybStage.ref).toBe(YYB_SERIAL);

    // 不变量 1d：status 查询反映 submit 后的终态（华为已上架 / 应用宝审核通过）
    const hwStatus = await reg.get("huawei")!.status({
      credentials: { HW_CLIENT_ID: "cid", HW_CLIENT_SECRET: "sec" },
      target: { appId: "1008888" },
    });
    expect(hwStatus).toEqual({ state: "approved", live: true });
    const yybStatus = await reg.get("yyb")!.status({
      credentials: { YYB_USER_ID: "u1", YYB_ACCESS_SECRET: "s1", YYB_APP_ID: "2000" },
      target: { pkgName: "com.example.e2e" },
    });
    expect(yybStatus).toEqual({ state: "approved", live: true });
  });

  it("stage 失败渠道（华为 upload-url 500）不入 submit：不可逆的 app-submit 绝不发生，应用宝不受牵连", async () => {
    vi.useFakeTimers();
    const reg = new DefaultChannelRegistry();
    reg.register(new HuaweiAndroidChannel());
    reg.register(new YybChannel());

    const fetchMock = mockFetch([
      { match: "oauth2/v1/token", response: { json: { access_token: HW_TOKEN } } },
      // 华为上传地址接口 500：stage 必败（业务码 shell 都拿不到）
      {
        match: "publish/v2/upload-url/for-obs",
        response: { status: 500, json: { error: "server error" } },
      },
      ...happyRoutes().filter(
        (r) =>
          !String(r.match).includes("upload-url") && !String(r.match).includes("oauth2/v1/token"),
      ),
    ]);

    const sha = sha256File(artifactPath);
    const input: PipelineInput = {
      channels: [reg.get("huawei")!, reg.get("yyb")!],
      contexts: makeContexts(),
      confirm: async () => true,
      concurrency: 2,
      cwd: projDir,
      historySink: makeHistorySink(sha, projDir),
    };

    fs.rmSync(historyPath, { force: true }); // 每用例独立历史文件（test 1 的落盘不泄漏）
    const stageSummary = await runStage(input);
    const hw = stageSummary.stage.find((s) => s.channel === "huawei")!;
    const yyb = stageSummary.stage.find((s) => s.channel === "yyb")!;
    expect(hw.ok).toBe(false);
    expect(hw.stageError).toBeTruthy();
    expect(yyb.ok).toBe(true);

    // 不变量 2b：runSubmit（skipStage=false，stage 阶段失败）华为短路 —— 全程无 app-submit 请求
    const submitP = runSubmit(input, { skipStage: false });
    await vi.advanceTimersByTimeAsync(WAIT_BEFORE_SUBMIT_MS);
    const submitSummary = await submitP;
    const hwSubmit = submitSummary.submit.find((s) => s.channel === "huawei")!;
    expect(hwSubmit.ok).toBe(false);
    expect(hwSubmit.submitError).toBeTruthy(); // stage 抛错走 runSubmit catch 分支，落 submitError
    expect(fetchMock.calls.some((c) => c.url.includes("app-submit"))).toBe(false); // 不可逆操作未发生

    // 不变量 2c：应用宝 stage+submit 正常完成（同渠道实例贯穿：serial_number 从 stage 传给 update_app）
    const yybSubmit = submitSummary.submit.find((s) => s.channel === "yyb")!;
    expect(yybSubmit.ok).toBe(true);
    expect(fetchMock.calls.find((c) => c.url.includes("update_app"))!.body).toContain(
      `apk32_file_serial_number=${YYB_SERIAL}`,
    );

    // 不变量 2d：history 华为只有失败记录（stage 失败 + runSubmit catch 落的 submit:false），无成功动作；
    // 应用宝 stage（runStage+runSubmit 各一次）+ submit 全成功
    const entries = readEntries({ sha256: sha }, historyPath);
    const hwEntries = entries.filter((e) => e.channel === "huawei");
    expect(hwEntries.map((e) => `${e.action}:${e.ok}`)).toEqual(["stage:false", "submit:false"]);
    const yybEntries = entries.filter((e) => e.channel === "yyb");
    expect(yybEntries.map((e) => `${e.action}:${e.ok}`)).toEqual([
      "stage:true",
      "stage:true",
      "submit:true",
    ]);
  });
});
