/**
 * vivo 渠道业务流程测试：同一渠道实例 + 同一真实临时产物，单一端点按 method 分发。
 * 业务不变量：
 *   1. stage→submit：上传响应的 serialnumber/versionCode 被 submit 复用（提审字段 apk=流水号、versionCode 透传、fileMd5=工件 MD5）
 *   2. 请求顺序（method 序列）= app.upload.apk.app → app.query.details → app.sync.update.app → app.query.details(status)
 *   3. submit 不再二次上传（app.upload.apk.app 全链仅一次）
 *   4. status 终态与提审结果一致（auditStatus=1 → reviewing）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VivoChannel } from "./vivo.js";
import { mockFetch, makeTestCtx } from "../test-utils.js";

const API_BASE = "https://developer-api.vivo.com.cn/router/rest";
const APK_BYTES = Buffer.from("fake-apk-content-vivo-flow");
const APK_MD5 = createHash("md5").update(APK_BYTES).digest("hex");

let apkPath: string;

beforeAll(() => {
  apkPath = path.join(os.tmpdir(), `vivo-flow-${process.pid}.apk`);
  fs.writeFileSync(apkPath, APK_BYTES);
});
afterEach(() => vi.unstubAllGlobals());

/** 同端点按 body method 分发：query 前两次返回线上详情，status 那次带 auditStatus */
function installMock() {
  let queryCalls = 0;
  const mocked = mockFetch([
    {
      match: API_BASE,
      response: () => {
        const last = mocked.calls[mocked.calls.length - 1]!;
        const method =
          typeof last.body === "string"
            ? new URLSearchParams(last.body).get("method")
            : (last.body as FormData).get("method");
        if (method === "app.upload.apk.app") {
          return {
            json: { code: 0, subCode: 0, data: { serialnumber: "SN-FLOW-42", versionCode: 202 } },
          };
        }
        if (method === "app.sync.update.app") {
          return { json: { code: 0, subCode: 0, data: { status: "审核中" } } };
        }
        queryCalls += 1;
        return queryCalls === 1
          ? { json: { code: 0, subCode: 0, data: { onlineType: 1, compatibleDevice: 0 } } }
          : { json: { code: 0, subCode: 0, data: { status: 2 } } };
      },
    },
  ]);
  return mocked;
}

function methodsOf(calls: Array<{ body?: string | FormData | Buffer }>): string[] {
  return calls.map((c) =>
    typeof c.body === "string"
      ? new URLSearchParams(c.body).get("method")!
      : ((c.body as FormData).get("method") as string),
  );
}

describe("vivo 渠道 业务流程", () => {
  it("stage→submit→status 同实例全链：上传流水号/版本号回传提审，无二次上传，状态=审核中", async () => {
    const { calls } = installMock();
    const ch = new VivoChannel();
    const { ctx, events } = makeTestCtx({
      credentials: { VIVO_ACCESS_KEY: "ak", VIVO_ACCESS_SECRET: "sec" },
      target: { pkgName: "com.demo.vivo" },
      artifactPath: apkPath,
      updateDescription: "流程测试更新说明",
    });

    const staged = await ch.stage(ctx);
    expect(staged).toEqual({ ok: true, ref: "SN-FLOW-42" }); // ref=上传流水号
    const submitted = await ch.submit(ctx);
    expect(submitted.ok).toBe(true);
    const st = await ch.status(ctx);

    // 不变量 2+3：method 序列，上传全链仅一次（submit 复用 stage 产物）
    expect(methodsOf(calls)).toEqual([
      "app.upload.apk.app", // stage
      "app.query.details",
      "app.sync.update.app", // submit（先查详情复用线上字段，再提审）
      "app.query.details", // status
    ]);

    // 不变量 1：提审回传 apk=serialnumber（非 serialnumber 字段名）+ versionCode 透传 + 工件 fileMd5
    const upd = new URLSearchParams(
      String(calls.find((c) => methodsOf([c])[0] === "app.sync.update.app")!.body),
    );
    expect(upd.get("apk")).toBe("SN-FLOW-42");
    expect(upd.get("versionCode")).toBe("202");
    expect(upd.get("fileMd5")).toBe(APK_MD5);
    expect(upd.get("updateDesc")).toBe("流程测试更新说明");

    // 事件流：upload→bind | submit→done
    expect(events.filter((e) => e.type === "phase").map((e) => e.phase)).toEqual([
      "upload",
      "bind",
      "submit",
      "done",
    ]);

    // 不变量 4：status=2 → reviewing（apkgo mapVivoAuditState）
    expect(st).toEqual({ state: "reviewing" });
  });
});
