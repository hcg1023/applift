/**
 * Google Play 业务流程级测试：同一渠道实例贯穿
 *   stage（internal 内测轨道全链：token→edit→上传→track 读取合并→commit）
 *   → submit（production 轨道同链，合并存量 completed release） → status（官方只读端点，production completed = 审核通过已发布）。
 *
 * 业务不变量：
 * - 两次动作各开独立 edit（edit 是一次性事务，不可跨动作复用）；
 * - 同一产物的 versionCode 在两次上传中一致（stage/submit 上传的是同一个 aab）；
 * - internal 部署不携带 releaseNotes（内测无声量文案），production 携带 zh-CN 文案；
 * - track PUT 前先 GET 合并：production 存量 completed release 追加新 versionCode（不剔除旧版本）；
 * - 请求顺序：每动作内 edit → 上传 → track GET → track PUT → :commit。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import type { ChannelContext } from "../channel.js";
import { GooglePlayChannel } from "./googleplay.js";
import { mockFetch } from "../test-utils.js";

const TOKEN = "gp-flow-token";
const VERSION_CODE = 42;
const OLD_VERSION_CODE = 41;
const PKG = "com.example.driver";

const aabBytes = Buffer.from("gp-flow-fake-aab-0123456789abcdef");
let aabPath = "";
let saJson = "";

beforeAll(() => {
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  saJson = JSON.stringify({
    client_email: "deployer@example.iam.gserviceaccount.com",
    private_key: privateKey,
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gp-flow-"));
  aabPath = path.join(dir, "driver-release.aab");
  fs.writeFileSync(aabPath, aabBytes);
});

afterAll(() => {
  fs.rmSync(path.dirname(aabPath), { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeCtx(): {
  ctx: ChannelContext;
  events: Array<{ type: string; phase?: string; message?: string; detail?: string }>;
} {
  const events: Array<{ type: string; phase?: string; message?: string; detail?: string }> = [];
  return {
    events,
    ctx: {
      credentials: { GOOGLEPLAY_SA_KEY: saJson },
      target: { pkgName: PKG },
      artifactPath: aabPath,
      updateDescription: "修复司机端定位漂移",
      emit: (e) => events.push(e),
    },
  };
}

describe("googleplay flow: 同一渠道实例 internal stage → production submit → status", () => {
  it("两次动作独立 edit、versionCode 一致、production 提审后状态 completed", async () => {
    let editCount = 0;
    const fetchMock = mockFetch([
      { match: "oauth2.googleapis.com/token", response: { json: { access_token: TOKEN } } },
      // 两次动作各开独立 edit：edit-1（internal）/ edit-2（production）
      {
        match: /\/edits$/,
        response: () => {
          editCount++;
          return { json: { id: `edit-${editCount}` } };
        },
      },
      { match: "uploadType=media", response: { json: { versionCode: VERSION_CODE } } },
      { match: "/tracks/internal", response: { json: { releases: [] } } },
      {
        // submit 的轨道读取（edit 内）返回存量 completed release；status 走官方只读端点（无 editId）返回提交后状态
        match: "/tracks/production",
        method: "GET",
        response: ({ url }) =>
          url.includes("/edits/")
            ? { json: { releases: [{ versionCodes: [OLD_VERSION_CODE], status: "completed" }] } }
            : { json: { releases: [{ versionCodes: [VERSION_CODE], status: "completed" }] } },
      },
      { match: "/tracks/production", method: "PUT", response: { json: {} } },
      { match: ":commit", response: { json: {} } },
    ]);

    const channel = new GooglePlayChannel();
    const { ctx, events } = makeCtx();

    // ---------- stage：internal 内测轨道 ----------
    const stage = await channel.stage(ctx);
    expect(stage).toEqual({ ok: true, ref: `edit-1:${VERSION_CODE}` });
    // 不变量：internal 轨道不带 releaseNotes（内测无用户可见文案）
    const internalTrack = fetchMock.calls.find(
      (c) => c.url.includes("/tracks/internal") && c.method === "PUT",
    )!;
    expect(internalTrack.method).toBe("PUT");
    expect(JSON.parse(internalTrack.body as string).releases).toEqual([
      { versionCodes: [VERSION_CODE], status: "completed" },
    ]);

    // ---------- submit：production 正式轨道（同渠道实例、同一 aab） ----------
    const submit = await channel.submit(ctx);
    expect(submit).toEqual({ ok: true, ref: `edit-2:${VERSION_CODE}` });

    // 不变量：两次动作各开独立 edit（edit-1 ≠ edit-2，每次上传挂在自己的 edit 下）
    const editCalls = fetchMock.calls.filter((c) => c.url.endsWith("/edits"));
    expect(editCalls).toHaveLength(2);
    const mediaUploads = fetchMock.calls.filter((c) => c.url.includes("uploadType=media"));
    expect(mediaUploads.map((c) => c.url)).toEqual([
      expect.stringContaining("/edits/edit-1/bundles?uploadType=media"),
      expect.stringContaining("/edits/edit-2/bundles?uploadType=media"),
    ]);
    // 不变量：production PUT 合并存量 completed release——新 versionCode 追加在旧版本之后，不剔除旧版本
    const prodTrack = fetchMock.calls.find(
      (c) => c.url.includes("/tracks/production") && c.method === "PUT",
    )!;
    expect(JSON.parse(prodTrack.body as string).releases).toEqual([
      {
        versionCodes: [OLD_VERSION_CODE, VERSION_CODE],
        status: "completed",
        releaseNotes: [{ language: "zh-CN", text: "修复司机端定位漂移" }],
      },
    ]);
    // 不变量：每动作内顺序 = edit → 上传 → track GET+PUT → :commit（两次 commit，各自轨道部署之后）
    const commits = fetchMock.calls.filter((c) => c.url.includes(":commit"));
    expect(commits).toHaveLength(2);
    expect(fetchMock.calls.indexOf(commits[0]!)).toBeGreaterThan(
      fetchMock.calls.indexOf(internalTrack!),
    );
    expect(fetchMock.calls.indexOf(commits[1]!)).toBeGreaterThan(
      fetchMock.calls.indexOf(prodTrack!),
    );
    // token 每动作独立获取（两次 OAuth2 换 token，携带 SA 签名的 assertion）
    expect(
      fetchMock.calls.filter((c) => c.url.includes("oauth2.googleapis.com/token")),
    ).toHaveLength(2);
    // 事件流：两次 auth→upload→bind→done
    const phases = events.filter((e) => e.type === "phase").map((e) => e.phase);
    expect(phases).toEqual(["auth", "upload", "bind", "done", "auth", "upload", "bind", "done"]);

    // ---------- status：官方只读端点（无 editId），production completed = 审核通过且已全量发布 ----------
    const st = await channel.status({ credentials: ctx.credentials, target: ctx.target });
    expect(st).toEqual({ state: "approved", live: true });
  });
});
