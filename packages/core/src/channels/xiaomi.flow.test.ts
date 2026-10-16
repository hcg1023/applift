/**
 * 小米渠道业务流程测试：小米无 stage（上传即提审），submit（预检→push）→ status。
 * 业务不变量：
 *   1. 请求顺序 = /dev/query（账号/包名预检）→ /dev/push（上传即提审）→ /dev/query（status）
 *   2. push 的 multipart 携带真实产物字节（提审的包 = 本地产物，SIG 覆盖该文件的 MD5）
 *   3. 事件流 phase 序列：auth → upload → done
 *   4. 预检通过（updateVersion 未锁定、无版本回退）才发 push；status 透出原始响应（小米无专用审核接口 → unknown+raw）
 */
import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { XiaomiChannel } from "./xiaomi.js";
import { mockFetch, makeTestCtx } from "../test-utils.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "applift-xiaomi-flow-"));
const certPath = path.join(tmp, "mi-cert.pem");
const apkPath = path.join(tmp, "app-release.apk");
const iconPath = path.join(tmp, "icon.png");
const APK_BYTES = Buffer.from("fake-apk-bytes-for-xiaomi-flow");

beforeAll(() => {
  // 契约测试同款：openssl 自签 1024bit 证书（小米签名密钥即 X.509 证书公钥）
  execSync(
    `openssl req -x509 -newkey rsa:1024 -nodes -keyout ${tmp}/mi-key.pem -out ${certPath} -days 1 -subj "/CN=applift-flow"`,
  );
  fs.writeFileSync(apkPath, APK_BYTES);
  fs.writeFileSync(iconPath, Buffer.from("fake-icon-flow"));
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

const CREDS = {
  MI_USER_NAME: "mi-user@example.com",
  MI_PASSWORD: "mi-pass-123",
  MI_CERT_PATH: certPath,
  MI_APP_NAME: "千云司机端",
};

function seqOf(calls: Array<{ url: string }>): string[] {
  return calls.map((c) => (c.url.includes("/dev/push") ? "push" : "query"));
}

describe("小米渠道 业务流程", () => {
  it("submit（预检→push 上传即提审）→status：真实产物字节进 push，状态查询透出原始响应", async () => {
    let queryCalls = 0;
    const { calls } = mockFetch([
      {
        match: "/dev/query",
        response: () => {
          queryCalls += 1;
          // 第 1 次=预检（线上版本信息），其后=status（无专用审核接口）
          return queryCalls === 1
            ? {
                json: {
                  result: 0,
                  updateVersion: true,
                  packageInfo: { versionCode: 100, onlineVersionCode: 100 },
                },
              }
            : { json: { result: 0, packageInfo: { versionCode: 100 }, status: "auditing" } };
        },
      },
      { match: "/dev/push", response: { json: { result: 0, message: "success" } } },
    ]);
    const ch = new XiaomiChannel();
    const { ctx, events } = makeTestCtx({
      credentials: CREDS,
      target: { pkgName: "com.qianyun.driver", versionCode: "101", icon: iconPath }, // 101 >= 线上 100，预检放行
      artifactPath: apkPath,
      updateDescription: "小米流程测试更新说明",
    });

    const submitted = await ch.submit(ctx);
    expect(submitted.ok).toBe(true);
    const st = await ch.status(ctx);

    // 不变量 1：请求顺序 预检 → push → status 查询
    expect(seqOf(calls)).toEqual(["query", "push", "query"]);

    // 不变量 2：push multipart 携带真实产物字节 + 签名 + 提审元数据
    const pushForm = calls.find((c) => c.url.includes("/dev/push"))!.body as FormData;
    expect(await (pushForm.get("apk") as File).arrayBuffer()).toEqual(
      APK_BYTES.buffer.slice(
        APK_BYTES.byteOffset,
        APK_BYTES.byteOffset + APK_BYTES.byteLength,
      ) as ArrayBuffer,
    );
    expect(String(pushForm.get("SIG"))).toMatch(/^[0-9a-f]+$/);
    const reqData = JSON.parse(String(pushForm.get("RequestData")));
    expect(JSON.parse(reqData.appInfo)).toMatchObject({
      appName: "千云司机端",
      packageName: "com.qianyun.driver",
      updateDesc: "小米流程测试更新说明",
    });

    // 不变量 3：事件流 auth → upload → done
    expect(events.filter((e) => e.type === "phase").map((e) => e.phase)).toEqual([
      "auth",
      "upload",
      "done",
    ]);

    // 不变量 4：小米无审核状态映射 → unknown + 原始响应透出
    expect(st.state).toBe("unknown");
    expect(st.state === "unknown" && st.raw ? st.raw : "").toContain("auditing");
  });
});
