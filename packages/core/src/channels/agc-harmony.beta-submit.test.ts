/**
 * AGC 鸿蒙 测试发布自动提审契约测试（target.submitTest='true'）：
 * 上传→新建测试版本（testType 透传）→添加软件包→编译→绑定→（按群组名查 groupId）绑群组→提交测试审核。
 *
 * 官方文档契约：
 * - 提审 POST /api/publish/v2/test/app/version/submit?appId=xx，body { versionId }
 *   （agc-help-test-api-submit-test-version-0000002236201334）
 * - 群组列表 GET /api/app-test/v1/test-group/list，appId 走 header，rtnCode 外壳按 groupName 匹配 groupId
 *   （agc-help-test-api-get-test-grouplist-0000002271000717）
 * - 群组绑定走「更新测试版本」PUT /api/publish/v2/test/app/version 的
 *   openTestInfo.testTaskInfo.groupInfos（agc-help-test-api-modify-test-version-0000002271160657）
 *
 * 业务不变量：
 * - 未开 submitTest 时绝不调用 test-group/list 与 version/submit（默认不自动提审）；
 * - 群组名匹配不到 groupId 时报错并提示到控制台建组，且不发起提审。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { ChannelContext } from "../channel.js";
import { AgcHarmonyChannel } from "./agc-harmony.js";
import { mockFetch } from "../test-utils.js";

const APP_ID = "3001234";
const OBJECT_ID = "agc-beta-obj-1";
const VERSION_ID = "agc-beta-ver-1";
const PKG_ID = "agc-beta-pkg-1";
const GROUP_NAME = "内测体验组";
const GROUP_ID = "grp-001";

let dir = "";
let appPath = "";

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-agc-submit-"));
  appPath = path.join(dir, "entry-release-signed.app");
  fs.writeFileSync(appPath, Buffer.from("fake-harmony-app-package-0123456789abcdef"));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeCtx(target: Record<string, string>): ChannelContext {
  return {
    credentials: { AGC_CLIENT_ID: "agc-cid", AGC_CLIENT_SECRET: "agc-sec" },
    target,
    artifactPath: appPath,
    updateDescription: "内测修复",
    emit: () => {},
  };
}

/** 基础 mock 路由（提审/群组相关路由由各用例追加，未命中即测试失败） */
function baseRoutes() {
  return [
    { match: "oauth2/v1/token", response: { json: { access_token: "agc-token" } } },
    // 旧测试版本清理（默认开）：默认无残留，清理用例自行覆盖该路由
    {
      match: "version/brief-info/list",
      response: { json: { ret: { code: 0 }, versionList: [] } },
    },
    {
      match: /for-obs\?.*releaseType=6$/,
      response: {
        json: {
          ret: { code: 0 },
          urlInfo: { url: "https://obs-agc.example.com/beta", objectId: OBJECT_ID, method: "PUT" },
        },
      },
    },
    { match: "obs-agc.example.com", response: { status: 200, text: "" } },
    {
      match: "test/app/version",
      method: "POST",
      response: { json: { ret: { code: 0 }, versionId: VERSION_ID } },
    },
    { match: "test/version/pkg", response: { json: { ret: { code: 0 }, pkgVersion: [PKG_ID] } } },
    {
      match: "package/compile/status",
      response: { json: { ret: { code: 0 }, pkgStateList: [{ pkgId: PKG_ID, successStatus: 0 }] } },
    },
    { match: "test/app/version", method: "PUT", response: { json: { ret: { code: 0 } } } },
  ];
}

describe("agc beta 自动提审（submitTest）", () => {
  it("submitTest + testGroup：查群组→绑 groupInfos→POST submit（versionId 贯穿）", async () => {
    const fetchMock = mockFetch([
      ...baseRoutes(),
      {
        match: "test-group/list",
        response: {
          json: {
            rtnCode: 0,
            groups: [
              { groupId: "grp-other", groupName: "别的组" },
              { groupId: GROUP_ID, groupName: GROUP_NAME },
            ],
            pageInfo: { current: 1, totalPage: 1 },
          },
        },
      },
      {
        match: "test/app/version/submit",
        method: "POST",
        response: { json: { ret: { code: 0 } } },
      },
    ]);

    const channel = new AgcHarmonyChannel();
    const ctx = makeCtx({
      appId: APP_ID,
      releaseType: "6",
      submitTest: "true",
      testGroup: GROUP_NAME,
      testType: "4",
    });
    const result = await channel.stage(ctx);
    expect(result).toEqual({ ok: true, ref: VERSION_ID });

    // 新建测试版本：testType 从 target 透传（默认 3，配置 4 时传 4）
    const create = fetchMock.find("test/app/version", "POST")!;
    expect(JSON.parse(create.body as string)).toMatchObject({ releaseType: 6, testType: 4 });

    // 群组列表：appId 走 header（非 query），带鉴权头
    const groupCall = fetchMock.find("test-group/list")!;
    expect(groupCall.method).toBe("GET");
    expect(groupCall.headers.appId).toBe(APP_ID);
    expect(groupCall.headers.Authorization).toBe("Bearer agc-token");

    // 群组绑定 PUT：openTestInfo.testTaskInfo.groupInfos 只含 groupId/groupName
    const putCalls = fetchMock.calls.filter(
      (c) => c.url.includes("test/app/version") && c.method === "PUT",
    );
    expect(putCalls).toHaveLength(2);
    expect(JSON.parse(putCalls[0]!.body as string)).toEqual({
      versionId: VERSION_ID,
      pkgId: PKG_ID,
    });
    const groupBind = JSON.parse(putCalls[1]!.body as string) as {
      versionId: string;
      pkgId: string;
      openTestInfo: { startTime: number; endTime: number; testTaskInfo: unknown };
    };
    expect(groupBind.versionId).toBe(VERSION_ID);
    expect(groupBind.pkgId).toBe(PKG_ID);
    // 实测 203489281：openTestInfo 携带时 startTime/endTime 必填（毫秒），窗口 30 天
    expect(groupBind.openTestInfo.startTime).toBeGreaterThan(0);
    expect(groupBind.openTestInfo.endTime - groupBind.openTestInfo.startTime).toBe(
      30 * 24 * 60 * 60 * 1000,
    );
    expect(groupBind.openTestInfo.testTaskInfo).toEqual({
      groupInfos: [{ groupId: GROUP_ID, groupName: GROUP_NAME }],
    });

    // 提审：POST submit?appId=xx，body 只有 versionId，且在群组绑定之后
    const submitCall = fetchMock.find("test/app/version/submit")!;
    expect(submitCall.url).toContain(`appId=${APP_ID}`);
    expect(JSON.parse(submitCall.body as string)).toEqual({ versionId: VERSION_ID });
    expect(fetchMock.calls.indexOf(submitCall)).toBeGreaterThan(
      fetchMock.calls.indexOf(putCalls[1]!),
    );
  });

  it("submitTest 不配 testGroup：跳过群组查询直接提审", async () => {
    const fetchMock = mockFetch([
      ...baseRoutes(),
      {
        match: "test/app/version/submit",
        method: "POST",
        response: { json: { ret: { code: 0 } } },
      },
    ]);

    const channel = new AgcHarmonyChannel();
    const result = await channel.stage(
      makeCtx({ appId: APP_ID, releaseType: "6", submitTest: "true" }),
    );
    expect(result.ok).toBe(true);
    expect(fetchMock.find("test-group/list")).toBeUndefined();
    // 只有绑定软件包一次 PUT（无群组绑定 PUT）
    const putCalls = fetchMock.calls.filter(
      (c) => c.url.includes("test/app/version") && c.method === "PUT",
    );
    expect(putCalls).toHaveLength(1);
    expect(fetchMock.find("test/app/version/submit", "POST")).toBeDefined();
    // testType 默认 3
    expect(JSON.parse(fetchMock.find("test/app/version", "POST")!.body as string)).toMatchObject({
      testType: 3,
    });
  });

  it("群组名匹配不到：报错提示到控制台建组，不发起提审", async () => {
    const fetchMock = mockFetch([
      ...baseRoutes(),
      {
        match: "test-group/list",
        response: {
          json: {
            rtnCode: 0,
            groups: [{ groupId: "grp-x", groupName: "别的组" }],
            pageInfo: { current: 1, totalPage: 1 },
          },
        },
      },
    ]);

    const channel = new AgcHarmonyChannel();
    await expect(
      channel.stage(
        makeCtx({ appId: APP_ID, releaseType: "6", submitTest: "true", testGroup: "不存在的组" }),
      ),
    ).rejects.toThrow(/测试群组.*创建/);
    expect(fetchMock.find("test/app/version/submit", "POST")).toBeUndefined();
  });

  it("未开 submitTest（默认）：到「已就绪」为止，不查群组不提审", async () => {
    const fetchMock = mockFetch(baseRoutes());
    const channel = new AgcHarmonyChannel();
    const result = await channel.stage(makeCtx({ appId: APP_ID, releaseType: "6" }));
    expect(result).toEqual({ ok: true, ref: VERSION_ID });
    expect(fetchMock.find("test-group/list")).toBeUndefined();
    expect(fetchMock.find("test/app/version/submit", "POST")).toBeUndefined();
  });

  it("群组列表 rtnCode 非 0 → 人话报错（含 rtnDesc）", async () => {
    mockFetch([
      ...baseRoutes(),
      {
        match: "test-group/list",
        response: { json: { rtnCode: 204144701, rtnDesc: "无权限" } },
      },
    ]);
    const channel = new AgcHarmonyChannel();
    const ctx = makeCtx({
      appId: APP_ID,
      releaseType: "6",
      submitTest: "true",
      testGroup: GROUP_NAME,
    });
    await expect(channel.stage(ctx)).rejects.toThrow(/查询测试群组失败: rtnCode=204144701 无权限/);
  });
});

/**
 * 旧测试版本自动清理契约（target.cleanup !== 'false' 默认开）：
 * AGC 测试版本数量约束（在审上限→204144692 / 在架上限）导致旧版本不清理会阻塞新版本提审。
 * - 发现：brief-info/list 反向过滤 testType 3/4（商用版本绝不动）
 * - 清理：stop（完全下架）→ delete 级联，且都发生在「新建测试版本」之前（不给新版本误删窗口）
 * - best-effort：查询/单版本 stop/delete 失败仅告警，不阻断发布（提审 204144692 兜底提示人工）
 */
describe("agc beta 旧测试版本自动清理（默认开）", () => {
  const staleList = () => [
    {
      versionId: "old-v1",
      testType: 3,
      state: 7,
      packageList: [{ versionName: "4.0.1000", versionCode: 100 }],
    },
    { versionId: "old-v2", testType: 4, state: 1 },
    // 重复 versionId 只清一次
    { versionId: "old-v2", testType: 4, state: 1 },
    // 商用版本（testType=1 / 缺省）绝不触碰
    { versionId: "live-v", testType: 1, state: 0 },
    { versionId: "legacy-v" },
  ];

  /** 自定义 brief-info/list 路由放数组最前（mockFetch 首个命中生效），其余走基础路由 */
  const briefRoute = (versionList: unknown) => ({
    match: "version/brief-info/list",
    response: { json: { ret: { code: 0 }, versionList } },
  });

  it("默认清理：逐个 stop+delete 测试版本，商用版本不动，且全部发生在新建之前", async () => {
    const fetchMock = mockFetch([
      briefRoute(staleList()),
      // stop / delete 成功
      { match: "test/version/stop", response: { json: { ret: { code: 0 } } } },
      { match: "test/app/version", method: "DELETE", response: { json: { ret: { code: 0 } } } },
      ...baseRoutes(),
    ]);
    const channel = new AgcHarmonyChannel();
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const result = await channel.stage({
      ...makeCtx({ appId: APP_ID, releaseType: "6", submitTest: "true" }),
      emit: (e) => events.push(e as { type: string; [k: string]: unknown }),
    });
    expect(result).toEqual({ ok: true, ref: VERSION_ID });

    const stopCalls = fetchMock.calls.filter((c) => c.url.includes("test/version/stop"));
    expect(stopCalls).toHaveLength(2);
    expect(stopCalls.map((c) => JSON.parse(c.body as string))).toEqual([
      { versionId: "old-v1" },
      { versionId: "old-v2" },
    ]);
    for (const c of stopCalls) {
      expect(c.method).toBe("POST");
      expect(c.url).toContain(`appId=${APP_ID}`);
    }

    const deleteCalls = fetchMock.calls.filter(
      (c) => c.url.includes("test/app/version") && c.method === "DELETE",
    );
    expect(deleteCalls).toHaveLength(2);
    expect(deleteCalls[0]!.url).toContain("versionId=old-v1");
    expect(deleteCalls[0]!.url).toContain(`appId=${APP_ID}`);
    expect(deleteCalls[1]!.url).toContain("versionId=old-v2");

    // 商用版本（testType=1/缺省）绝不进清理
    expect(fetchMock.calls.some((c) => c.url.includes("live-v"))).toBe(false);
    expect(fetchMock.calls.some((c) => c.url.includes("legacy-v"))).toBe(false);

    // 时序：清理全部完成后才新建测试版本（新版本不会被误删）
    const createIdx = fetchMock.calls.findIndex(
      (c) => c.url.includes("test/app/version") && c.method === "POST",
    );
    const lastCleanupIdx = Math.max(
      fetchMock.calls.indexOf(deleteCalls[1]!),
      fetchMock.calls.indexOf(stopCalls[1]!),
    );
    expect(createIdx).toBeGreaterThan(lastCleanupIdx);

    expect(
      events.some((e) => e.type === "progress" && String(e.detail).includes("发现 2 个旧测试版本")),
    ).toBe(true);
    expect(events.some((e) => e.type === "progress" && String(e.detail).includes("4.0.1000"))).toBe(
      true,
    );
  });

  it("cleanup='false'：完全不查旧版本、不发清理请求（零侵入逃生口）", async () => {
    const fetchMock = mockFetch(baseRoutes());
    const channel = new AgcHarmonyChannel();
    const result = await channel.stage(
      makeCtx({ appId: APP_ID, releaseType: "6", cleanup: "false" }),
    );
    expect(result).toEqual({ ok: true, ref: VERSION_ID });
    expect(fetchMock.find("version/brief-info/list")).toBeUndefined();
    expect(fetchMock.calls.some((c) => c.url.includes("test/version/stop"))).toBe(false);
    expect(fetchMock.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("无旧测试版本：提示无残留，正常发布", async () => {
    const mock = mockFetch(baseRoutes());
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    await new AgcHarmonyChannel().stage({
      ...makeCtx({ appId: APP_ID, releaseType: "6" }),
      emit: (e) => events.push(e as { type: string; [k: string]: unknown }),
    });
    expect(mock.calls.some((c) => c.url.includes("test/version/stop"))).toBe(false);
    expect(events.some((e) => e.type === "progress" && String(e.detail).includes("无残留"))).toBe(
      true,
    );
  });

  it("stop 失败（如审核中不可停）：告警后仍尝试 delete，发布继续", async () => {
    const fetchMock = mockFetch([
      briefRoute([
        { versionId: "old-v1", testType: 3, packageList: [{ versionName: "4.0.1000" }] },
      ]),
      {
        match: "test/version/stop",
        response: { json: { ret: { code: 204144699, msg: "version can not be stopped" } } },
      },
      ...baseRoutes(),
    ]);
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const result = await new AgcHarmonyChannel().stage({
      ...makeCtx({ appId: APP_ID, releaseType: "6" }),
      emit: (e) => events.push(e as { type: string; [k: string]: unknown }),
    });
    expect(result).toEqual({ ok: true, ref: VERSION_ID });
    expect(
      events.some(
        (e) =>
          e.type === "warn" &&
          String(e.message).includes(
            "停止测试版本 4.0.1000（versionId old-v1）失败（继续尝试删除）",
          ),
      ),
    ).toBe(true);
    // stop 失败不挡 delete
    expect(
      fetchMock.calls.some((c) => c.url.includes("test/app/version") && c.method === "DELETE"),
    ).toBe(true);
  });

  it("delete 失败：告警不阻断（提审若仍超限由 204144692 提示兜底）", async () => {
    mockFetch([
      briefRoute([{ versionId: "old-v1", testType: 3 }]),
      {
        match: "test/app/version",
        method: "DELETE",
        response: { json: { ret: { code: 204144001, msg: "delete denied" } } },
      },
      ...baseRoutes(),
    ]);
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    await expect(
      new AgcHarmonyChannel().stage({
        ...makeCtx({ appId: APP_ID, releaseType: "6" }),
        emit: (e) => events.push(e as { type: string; [k: string]: unknown }),
      }),
    ).resolves.toEqual({ ok: true, ref: VERSION_ID });
    expect(
      events.some(
        (e) =>
          e.type === "warn" &&
          String(e.message).includes(
            "删除测试版本 ?（versionId old-v1）失败: AGC 删除测试版本失败",
          ),
      ),
    ).toBe(true);
  });

  it("brief-info/list 查询失败：告警跳过清理，不阻断发布", async () => {
    const fetchMock = mockFetch([
      { match: "version/brief-info/list", response: { json: { ret: { code: 500, msg: "boom" } } } },
      ...baseRoutes(),
    ]);
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    const result = await new AgcHarmonyChannel().stage({
      ...makeCtx({ appId: APP_ID, releaseType: "6" }),
      emit: (e) => events.push(e as { type: string; [k: string]: unknown }),
    });
    expect(result).toEqual({ ok: true, ref: VERSION_ID });
    expect(
      events.some(
        (e) =>
          e.type === "warn" && String(e.message).includes("旧测试版本查询失败（跳过清理，不阻断）"),
      ),
    ).toBe(true);
    expect(fetchMock.calls.some((c) => c.url.includes("test/version/stop"))).toBe(false);
  });
});
