/**
 * OPPO 渠道业务流程测试：同一渠道实例 + 同一真实临时产物。
 * 业务不变量：
 *   1. stage→submit：submit 复用 stage 暂存的 apkUrl/md5，不发生二次上传（get-upload-url/文件上传各仅一次）
 *   2. 无 stage 直接 submit：回退链 = token → app/info → 重新上传 → app/upd（用户可 --skip-stage 跨进程补提审）
 *   3. app/upd 的 apk_url 数组携带的正是上传响应的 url/md5（提审包 = 上传的包）
 *   4. status 终态与提审结果一致（audit_status=3 → approved 上架）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { OppoChannel } from "./oppo.js";
import { mockFetch, makeTestCtx } from "../test-utils.js";

let artifactPath: string;

beforeAll(() => {
  artifactPath = path.join(os.tmpdir(), `oppo-flow-${process.pid}.apk`);
  fs.writeFileSync(artifactPath, Buffer.from("fake-apk-content-oppo-flow"));
});
afterEach(() => vi.unstubAllGlobals());

const CREDS = { OPPO_CLIENT_ID: "ocid", OPPO_CLIENT_SECRET: "osec" };
const TARGET = { pkgName: "com.demo.oppo", versionCode: "101" };

function installMock() {
  let infoCalls = 0; // app/info: 前两次（submit 复用字段/status 前的发布字段）返回线上信息，status 那次带 audit_status
  return mockFetch([
    {
      match: "developer/v1/token",
      response: { json: { errno: 0, data: { access_token: "oppo-tok" } } },
    },
    {
      match: "get-upload-url",
      response: {
        json: {
          errno: 0,
          data: { upload_url: "https://file.upload.example.com/up", sign: "sgn-1" },
        },
      },
    },
    {
      match: "file.upload.example.com",
      response: {
        json: {
          errno: 0,
          data: { url: "https://cdn.example.com/apk-flow.apk", md5: "md5-flow-abc" },
        },
      },
    },
    {
      match: "/resource/v1/app/info",
      response: () => {
        infoCalls += 1;
        // 第 1 次发布字段查询（无审核位），此后（status 查询）带 audit_status=3
        return infoCalls === 1
          ? {
              json: {
                errno: 0,
                data: {
                  pkg_name: "com.demo.oppo",
                  app_name: "演示应用",
                  update_desc: "历史更新说明文字",
                },
              },
            }
          : { json: { errno: 0, data: { pkg_name: "com.demo.oppo", audit_status: 3 } } };
      },
    },
    { match: "/resource/v1/app/upd", response: { json: { errno: 0, data: { task_id: "t-1" } } } },
  ]);
}

function seqOf(calls: Array<{ url: string }>): string[] {
  return calls.map((c) => {
    if (c.url.includes("developer/v1/token")) return "token";
    if (c.url.includes("get-upload-url")) return "get-upload-url";
    if (c.url.includes("file.upload.example.com")) return "upload";
    if (c.url.includes("/resource/v1/app/info")) return "app/info";
    if (c.url.includes("/resource/v1/app/upd")) return "app/upd";
    throw new Error(`未预期的请求: ${c.url}`);
  });
}

describe("OPPO 渠道 业务流程", () => {
  it("stage→submit→status：submit 复用 staged 上传产物（无二次上传），app/upd 携带上传响应的 url/md5，status=已上架", async () => {
    const { calls } = installMock();
    const ch = new OppoChannel();
    const { ctx, events } = makeTestCtx({
      credentials: CREDS,
      target: TARGET,
      artifactPath,
      updateDescription: "修复已知问题，优化体验流程",
    });

    const staged = await ch.stage(ctx); // ref=md5
    expect(staged).toEqual({ ok: true, ref: "md5-flow-abc" });
    const submitted = await ch.submit(ctx);
    expect(submitted.ok).toBe(true);
    const st = await ch.status(ctx);

    // 不变量 1：整链上传仅发生一次（stage 那次）
    expect(seqOf(calls)).toEqual([
      "token",
      "get-upload-url",
      "upload", // stage
      "token",
      "app/info",
      "app/upd", // submit（复用 staged，不再 get-upload-url/upload）
      "token",
      "app/info", // status
    ]);
    expect(calls.filter((c) => c.url.includes("file.upload.example.com"))).toHaveLength(1);

    // 不变量 3：app/upd 的 apk_url = 上传响应 url + md5
    const updBody = new URLSearchParams(String(calls.find((c) => c.url.includes("app/upd"))!.body));
    expect(JSON.parse(updBody.get("apk_url")!)).toEqual([
      { url: "https://cdn.example.com/apk-flow.apk", md5: "md5-flow-abc", cpu_code: 0 },
    ]);

    // 事件流：stage auth→upload→bind，submit auth→submit→done
    expect(events.filter((e) => e.type === "phase").map((e) => e.phase)).toEqual([
      "auth",
      "upload",
      "bind",
      "auth",
      "submit",
      "done",
    ]);

    // 不变量 4：audit_status=3 → approved 已上架
    expect(st).toEqual({ state: "approved", live: true });
  });

  it("无 stage 直接 submit 的回退链：app/info 后现场重新上传再提审，事件含「无 stage 产物」提示", async () => {
    const { calls } = installMock();
    const ch = new OppoChannel(); // 全新实例：无 staged 暂存
    const { ctx, events } = makeTestCtx({
      credentials: CREDS,
      target: TARGET,
      artifactPath,
      updateDescription: "跳过 stage 直接提审的回退链验证",
    });

    const submitted = await ch.submit(ctx);
    expect(submitted.ok).toBe(true);

    // 不变量 2：回退链顺序 = token → app/info → get-upload-url → upload → app/upd
    expect(seqOf(calls)).toEqual(["token", "app/info", "get-upload-url", "upload", "app/upd"]);
    expect(
      events.some((e) => e.type === "progress" && String(e.detail).includes("无 stage 产物")),
    ).toBe(true);
  });
});
