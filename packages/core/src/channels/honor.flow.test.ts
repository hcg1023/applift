/**
 * 荣耀渠道业务流程测试：同一渠道实例 + 同一真实临时产物，stage() → submit() → status()。
 * 业务不变量：
 *   1. 请求顺序 = iam token → get-file-upload-url → 签名地址上传 → update-file-info（绑定 objectId）
 *      → update-language-info（best-effort）→ submit-audit → get-audit-result
 *   2. stage 绑定的 objectId 即产物登记凭据（提审的是刚上传的包，非线上旧包）
 *   3. 事件流 phase 序列完整：auth→upload→bind | submit→done
 *   4. status 终态与提审结果一致（auditResult=1 → approved，全网发布通过即上架）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HonorChannel } from "./honor.js";
import { mockFetch, makeTestCtx } from "../test-utils.js";

let artifactPath: string;

beforeAll(() => {
  artifactPath = path.join(os.tmpdir(), `honor-flow-${process.pid}.apk`);
  fs.writeFileSync(artifactPath, Buffer.from("fake-apk-content-honor-flow"));
});
afterEach(() => vi.unstubAllGlobals());

function seqOf(calls: Array<{ url: string }>): string[] {
  return calls.map((c) => {
    if (c.url.includes("/auth/token")) return "token";
    if (c.url.includes("get-file-upload-url")) return "get-file-upload-url";
    if (c.url.includes("upload.example.com")) return "upload";
    if (c.url.includes("update-file-info")) return "update-file-info";
    if (c.url.includes("update-language-info")) return "update-language-info";
    if (c.url.includes("submit-audit")) return "submit-audit";
    if (c.url.includes("get-audit-result")) return "get-audit-result";
    throw new Error(`未预期的请求: ${c.url}`);
  });
}

describe("荣耀渠道 业务流程", () => {
  it("stage→submit→status 同实例全链：上传绑定 objectId 后提审，status=审核通过已上架", async () => {
    const { calls } = mockFetch([
      {
        match: "get-file-upload-url",
        response: {
          json: {
            code: 0,
            data: [{ uploadUrl: "https://upload.example.com/signed?x=1", objectId: 30021 }],
          },
        },
      },
      { match: "upload.example.com", response: { json: { code: 0 } } },
      { match: "update-file-info", response: { json: { code: 0 } } },
      { match: "update-language-info", response: { json: { code: 0 } } },
      { match: "submit-audit", response: { json: { code: 0, data: "rel-20261016" } } },
      { match: "get-audit-result", response: { json: { code: 0, data: [{ auditResult: 1 }] } } },
      { match: "/auth/token", response: { json: { access_token: "honor-tok" } } },
    ]);
    const ch = new HonorChannel();
    const { ctx, events } = makeTestCtx({
      credentials: { HONOR_CLIENT_ID: "hcid", HONOR_CLIENT_SECRET: "hsec" },
      target: { appId: "1000123" },
      artifactPath,
      updateDescription: "荣耀流程测试更新说明",
    });

    const staged = await ch.stage(ctx); // ref=objectId
    expect(staged).toEqual({ ok: true, ref: "30021" });
    // 不变量 2：绑定请求 body 携带的正是上传响应的 objectId
    const bind = calls.find((c) => c.url.includes("update-file-info"))!;
    expect(JSON.parse(String(bind.body))).toEqual({ bindingFileList: [{ objectId: 30021 }] });

    const submitted = await ch.submit(ctx);
    expect(submitted).toEqual({ ok: true, ref: "rel-20261016" }); // ref=releaseId
    const st = await ch.status(ctx);

    // 不变量 1：请求顺序
    expect(seqOf(calls)).toEqual([
      "token",
      "get-file-upload-url",
      "upload",
      "update-file-info", // stage
      "token",
      "update-language-info",
      "submit-audit", // submit
      "token",
      "get-audit-result", // status
    ]);

    // 不变量 3：事件流 phase 序列
    expect(events.filter((e) => e.type === "phase").map((e) => e.phase)).toEqual([
      "auth",
      "upload",
      "bind",
      "submit",
      "done",
    ]);

    // 不变量 4：auditResult=1 → approved（全网发布通过即上架）
    expect(st).toEqual({ state: "approved", live: true });
  });
});
