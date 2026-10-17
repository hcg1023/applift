/**
 * ASC（App Store Connect）业务流程级测试：同一渠道实例贯穿
 *   stage（xcrun altool mock 上传 ipa）→ submit（apps→builds→appStoreVersions→
 *   绑构建→reviewSubmissions 三步提审）→ status（M2 未接入，返回 unknown）。
 *
 * 业务不变量：
 * - stage 用的 p8 三元组（KeyID/Issuer/p8）与 submit 同源：submit 的所有 REST 请求
 *   携带同一实例 makeAscJwt 生成的同一 Bearer JWT（kid/iss 一致，20 分钟窗口内不重签）；
 * - submit 请求序列严格按官方链路：定位 App → 找 VALID 构建 → 创建版本 → 绑构建 → 创建提交；
 * - 版本号取自构建关联的 preReleaseVersion（included 按 relationships 匹配，不取 included[0]）。
 */
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { ChannelContext } from "../channel.js";
import { AscChannel } from "./asc.js";
import { mockFetch } from "../test-utils.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
import { spawnSync } from "node:child_process";

const spawnSyncMock = vi.mocked(spawnSync);
const ASC_API = "api.appstoreconnect.apple.com";

const APP_ID = "asc-app-1";
const BUILD_ID = "asc-build-9";
const VERSION_STRING = "2.4.0";
const VERSION_ID = "asc-ver-3";
const SUBMISSION_ID = "asc-sub-1";

let keyRoot = "";
let p8Path = "";
let ipaPath = "";

beforeAll(() => {
  keyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asc-flow-"));
  // p8 放进名为 private_keys 的目录：stage 走 cwd 分支（不触发临时目录软链）
  const pkDir = path.join(keyRoot, "private_keys");
  fs.mkdirSync(pkDir);
  p8Path = path.join(pkDir, "AuthKey_FLOWKEY.p8");
  const key = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  fs.writeFileSync(p8Path, key.export({ type: "pkcs8", format: "pem" }));
  ipaPath = path.join(keyRoot, "Driver-release.ipa");
  fs.writeFileSync(ipaPath, Buffer.from("fake-ipa-bytes-0123456789"));
});

afterAll(() => {
  fs.rmSync(keyRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  spawnSyncMock.mockReset();
});

function makeCtx(): {
  ctx: ChannelContext;
  events: Array<{ type: string; phase?: string; message?: string; detail?: string }>;
} {
  const events: Array<{ type: string; phase?: string; message?: string; detail?: string }> = [];
  return {
    events,
    ctx: {
      credentials: { ASC_KEY_ID: "FLOWKEY", ASC_ISSUER_ID: "iss-flow-1", ASC_P8_PATH: p8Path },
      target: { bundleId: "com.example.driver" },
      artifactPath: ipaPath,
      emit: (e) => events.push(e),
    },
  };
}

describe("asc flow: 同一渠道实例 altool stage → REST submit → status", () => {
  it("altool 上传后按官方链路提审，同一 JWT 贯穿全部 REST 请求", async () => {
    // altool 成功（exit 0，输出经 emit 透传）
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "Uploading finished\nNo errors uploading",
      stderr: "",
    } as never);

    const fetchMock = mockFetch([
      // 注意路由顺序：先匹配更长路径，避免 appStoreVersions 相互误命中
      // reviewSubmissions 三步流：items 路由在前避免被基础路由先命中
      {
        match: "/items",
        method: "POST",
        response: { json: { data: { type: "reviewSubmissionItems", id: "item-1" } } },
      },
      {
        match: "reviewSubmissions",
        method: "POST",
        response: { json: { data: { type: "reviewSubmissions", id: SUBMISSION_ID } } },
      },
      { match: "reviewSubmissions", method: "PATCH", response: { json: { data: [] } } },
      { match: "relationships/builds", response: { json: { data: [] } } },
      // 版本列表为空 → 走 POST 创建分支
      { match: "appStoreVersions?", response: { json: { data: [] } } },
      {
        match: "/v1/appStoreVersions",
        response: {
          json: {
            data: {
              type: "appStoreVersions",
              id: VERSION_ID,
              attributes: { versionString: VERSION_STRING },
            },
          },
        },
      },
      {
        match: "/v1/builds",
        response: {
          json: {
            data: [
              {
                type: "builds",
                id: BUILD_ID,
                attributes: { version: "42", processingState: "VALID" },
                relationships: {
                  preReleaseVersion: { data: { type: "preReleaseVersions", id: "pr-24" } },
                },
              },
            ],
            included: [
              { type: "preReleaseVersions", id: "pr-0", attributes: { version: "9.9.9" } },
              { type: "preReleaseVersions", id: "pr-24", attributes: { version: VERSION_STRING } },
            ],
          },
        },
      },
      {
        match: "/v1/apps?",
        response: {
          json: {
            data: [{ type: "apps", id: APP_ID, attributes: { bundleId: "com.example.driver" } }],
          },
        },
      },
    ]);

    const channel = new AscChannel();
    const { ctx, events } = makeCtx();

    // ---------- stage：altool 上传（TestFlight） ----------
    const stage = await channel.stage(ctx);
    expect(stage).toEqual({ ok: true });
    // altool 参数完整：上传 ipa + 同一 KeyID/Issuer
    const altoolArgs = spawnSyncMock.mock.calls[0]?.[1];
    expect(spawnSyncMock.mock.calls[0]?.[0]).toBe("xcrun");
    expect(altoolArgs).toContain("--upload-app");
    expect(altoolArgs).toContain(ipaPath);
    expect(altoolArgs).toContain("--apiKey");
    expect(altoolArgs).toContain("FLOWKEY");
    expect(events.some((e) => e.type === "phase" && e.phase === "done")).toBe(true);

    // ---------- submit：REST 提审（同渠道实例） ----------
    const submit = await channel.submit(ctx);
    expect(submit).toEqual({ ok: true, ref: SUBMISSION_ID });

    const ascCalls = fetchMock.calls.filter((c) => c.url.includes(ASC_API));
    // 不变量：请求序列 = 定位 App → 找 VALID 构建 → 创建版本 → 绑构建 → reviewSubmissions 三步
    const seq = [
      "/v1/apps?",
      "/v1/builds",
      "/v1/appStoreVersions", // POST 创建（版本列表 GET 命中 appStoreVersions? 路由在前）
      "relationships/builds",
      "/v1/reviewSubmissions", // POST 创建 reviewSubmission
      "/items", // POST 绑定版本到 submission item
      '"action":"SUBMIT"', // PATCH 提交审核（以 body 特征定位）
    ];
    let lastIdx = -1;
    for (const part of seq) {
      const idx = ascCalls.findIndex(
        (c) => c.url.includes(part) || String(c.body ?? "").includes(part),
      );
      expect(idx, `请求序列缺少 ${part}`).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
    // 不变量：全部 REST 请求携带同一 JWT（makeAscJwt 单次实例贯穿，Bearer 完整一致）
    const bearer = ascCalls[0]?.headers.Authorization;
    expect(bearer).toMatch(/^Bearer ey/);
    for (const c of ascCalls) expect(c.headers.Authorization).toBe(bearer);
    // JWT kid/iss 与凭据一致（解码 header/payload 验证同一密钥三元组）
    const [h, p] = (bearer ?? "").slice("Bearer ".length).split(".");
    const dec = (seg: string | undefined) =>
      JSON.parse(
        Buffer.from((seg ?? "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(),
      );
    expect(dec(h)).toEqual({ alg: "ES256", kid: "FLOWKEY" });
    expect(dec(p).iss).toBe("iss-flow-1");
    expect(dec(p).aud).toBe("appstoreconnect-v1");
    // 不变量：版本号按 build.relationships.preReleaseVersion 匹配 included（非 included[0] 的 9.9.9）
    const createVersion = ascCalls.find(
      (c) => c.url.endsWith("/v1/appStoreVersions") && c.method === "POST",
    )!;
    expect(JSON.parse(createVersion.body as string).data.attributes.versionString).toBe(
      VERSION_STRING,
    );
    // 绑定的构建 id 来自 builds 查询结果
    const bindBuild = ascCalls.find((c) => c.url.includes("relationships/builds"))!;
    expect(JSON.parse(bindBuild.body as string)).toEqual({
      data: [{ type: "builds", id: BUILD_ID }],
    });
    // reviewSubmissions 三步流断言：创建（关联 app）→ items（关联版本）→ PATCH SUBMIT
    const createSub = ascCalls.find(
      (c) => c.url.endsWith("/v1/reviewSubmissions") && c.method === "POST",
    )!;
    expect(JSON.parse(createSub.body as string).data.relationships).toEqual({
      app: { data: { type: "apps", id: APP_ID } },
    });
    const addItem = ascCalls.find((c) => c.url.includes("/items") && c.method === "POST")!;
    expect(JSON.parse(addItem.body as string).data.relationships).toEqual({
      appStoreVersion: { data: { type: "appStoreVersions", id: VERSION_ID } },
    });
    const patchSub = ascCalls.find(
      (c) => c.url.includes("/v1/reviewSubmissions/") && c.method === "PATCH",
    )!;
    expect(JSON.parse(patchSub.body as string).data.attributes).toEqual({ action: "SUBMIT" });
    // iOS 默认手动发布（releaseType=MANUAL：审核通过后人工上架）
    expect(JSON.parse(createVersion.body as string).data.attributes.releaseType).toBe("MANUAL");

    // ---------- status：契约未接入，返回 unknown（不抛错） ----------
    const st = await channel.status();
    expect(st.state).toBe("unknown");
  });

  it("创建 reviewSubmission 未返回 id → 明确报错", async () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "Uploading finished\nNo errors uploading",
      stderr: "",
    } as never);
    const fetchMock = mockFetch([
      { match: "reviewSubmissions", method: "POST", response: { json: { data: [] } } }, // 无 id
      { match: "relationships/builds", response: { json: { data: [] } } },
      { match: "appStoreVersions?", response: { json: { data: [] } } },
      {
        match: "/v1/appStoreVersions",
        response: { json: { data: { type: "appStoreVersions", id: VERSION_ID } } },
      },
      {
        match: "/v1/builds",
        response: {
          json: {
            data: [
              {
                type: "builds",
                id: BUILD_ID,
                attributes: { version: "42", processingState: "VALID" },
                relationships: {
                  preReleaseVersion: { data: { type: "preReleaseVersions", id: "pr-24" } },
                },
              },
            ],
            included: [
              { type: "preReleaseVersions", id: "pr-24", attributes: { version: VERSION_STRING } },
            ],
          },
        },
      },
      { match: "/v1/apps", response: { json: { data: [{ id: "app-1" }] } } },
    ]);
    const ch = new AscChannel();
    const { ctx } = makeCtx();
    await ch.stage(ctx);
    await expect(ch.submit(ctx)).rejects.toThrow(/reviewSubmission 未返回 id/);
    fetchMock.restore();
  });

  it("缺 bundleId（submit 定位 App 必需）→ required 人话报错", async () => {
    const ch = new AscChannel();
    const { ctx } = makeCtx();
    await expect(ch.submit({ ...ctx, target: {} })).rejects.toThrow(/ASC 渠道缺少/);
  });
});
