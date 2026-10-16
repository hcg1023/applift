/**
 * 应用宝渠道业务流程测试：同一渠道实例 + 同一真实临时产物。
 * 业务不变量：
 *   1. stage 返回的 serial_number 被 submit 的 update_app 复用（apk32_file_serial_number），
 *      且 apk32_file_md5 = 上传工件真实 MD5（提审包 = COS 上传的包）
 *   2. 请求顺序 = query_app_detail → get_file_upload_info → COS PUT → update_app → query_app_update_status
 *   3. submit 前必须先 stage（无 stage 时 submit 拒绝，不允许无流水号提审）
 *   4. status 终态与提审结果一致（audit_status=3 → approved 已上架）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { YybChannel } from "./yyb.js";
import { mockFetch, makeTestCtx } from "../test-utils.js";

const APK_BYTES = Buffer.from("fake-apk-content-yyb-flow");
const APK_MD5 = createHash("md5").update(APK_BYTES).digest("hex");
let apkPath: string;

beforeAll(() => {
  apkPath = path.join(os.tmpdir(), `yyb-flow-${process.pid}.apk`);
  fs.writeFileSync(apkPath, APK_BYTES);
});
afterEach(() => vi.unstubAllGlobals());

function seqOf(calls: Array<{ url: string }>): string[] {
  return calls.map((c) => {
    if (c.url.includes("query_app_detail")) return "query_app_detail";
    if (c.url.includes("get_file_upload_info")) return "get_file_upload_info";
    if (c.url.includes("cos.example.com")) return "cos-put";
    if (c.url.includes("update_app")) return "update_app";
    if (c.url.includes("query_app_update_status")) return "query_app_update_status";
    throw new Error(`未预期的请求: ${c.url}`);
  });
}

function installMock() {
  return mockFetch([
    {
      match: "query_app_detail",
      response: { json: { ret: 0, app_info: { app_name: "演示应用", version: "1.0.0" } } },
    },
    {
      match: "get_file_upload_info",
      response: {
        json: {
          ret: 0,
          pre_sign_url: "https://cos.example.com/yyb/apk.pkg?sign=abc",
          serial_number: 556677,
        },
      },
    },
    { match: "cos.example.com", response: { status: 200, text: "" } },
    { match: "update_app", response: { json: { ret: 0 } } },
    { match: "query_app_update_status", response: { json: { ret: 0, audit_status: 3 } } },
  ]);
}

describe("应用宝渠道 业务流程", () => {
  it("stage→submit→status 同实例全链：serial_number 贯穿 COS 上传与 update_app 提审，md5=工件真实值，status=已上架", async () => {
    const { calls } = installMock();
    const ch = new YybChannel();
    const { ctx, events } = makeTestCtx({
      credentials: { YYB_USER_ID: "u1", YYB_ACCESS_SECRET: "sec", YYB_APP_ID: "yyb-app-9" },
      target: { pkgName: "com.demo.yyb" },
      artifactPath: apkPath,
      updateDescription: "流程测试更新说明",
    });

    const staged = await ch.stage(ctx);
    expect(staged).toEqual({ ok: true, ref: "556677" }); // ref=COS 上传流水号
    const submitted = await ch.submit(ctx);
    expect(submitted).toEqual({ ok: true, ref: "556677" }); // submit ref 复用同一流水号
    const st = await ch.status(ctx);

    // 不变量 2：请求顺序
    expect(seqOf(calls)).toEqual([
      "query_app_detail",
      "get_file_upload_info",
      "cos-put", // stage
      "update_app", // submit
      "query_app_update_status", // status
    ]);

    // 不变量 1：update_app 复用 stage 的 serial_number；md5 = 上传文件的真实 MD5
    const upd = new URLSearchParams(String(calls.find((c) => c.url.includes("update_app"))!.body));
    expect(upd.get("apk32_file_serial_number")).toBe("556677");
    expect(upd.get("apk32_file_md5")).toBe(APK_MD5);
    expect(upd.get("deploy_type")).toBe("1");

    // COS PUT 的 body = 真实产物字节
    expect(calls.find((c) => c.url.includes("cos.example.com"))!.body).toEqual(APK_BYTES);

    // 事件流：upload→bind | submit→done
    expect(events.filter((e) => e.type === "phase").map((e) => e.phase)).toEqual([
      "upload",
      "bind",
      "submit",
      "done",
    ]);

    // 不变量 4：audit_status=3 → approved 已上架
    expect(st).toEqual({ state: "approved", live: true });
  });

  it("无 stage 直接 submit 被拒绝：不允许无上传流水号提审（防止提审到旧包）", async () => {
    installMock();
    const ch = new YybChannel();
    const { ctx } = makeTestCtx({
      credentials: { YYB_USER_ID: "u1", YYB_ACCESS_SECRET: "sec", YYB_APP_ID: "yyb-app-9" },
      target: { pkgName: "com.demo.yyb" },
      artifactPath: apkPath,
    });
    await expect(ch.submit(ctx)).rejects.toThrow("缺少上传流水号");
  });
});
