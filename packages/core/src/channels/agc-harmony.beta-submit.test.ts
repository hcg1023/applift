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
    expect(JSON.parse(putCalls[1]!.body as string)).toEqual({
      versionId: VERSION_ID,
      pkgId: PKG_ID,
      openTestInfo: {
        testTaskInfo: { groupInfos: [{ groupId: GROUP_ID, groupName: GROUP_NAME }] },
      },
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
});
