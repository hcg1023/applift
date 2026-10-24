/**
 * 小米渠道契约测试：RSA 分段加密可解密、SIG 结构、submit 全流程（预检拒绝分支/MI_PRIVATE_KEY 别名/错误字段双检）、capabilities/plan。
 * 证书用 openssl 现生成 1024bit 自签证书（v1 selftest 写法），零外部夹具。
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { execSync } from "node:child_process";
import { privateDecrypt, constants, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// 覆盖 rsaEncryptSegmented 的 modulusLength 缺省回退：X509Certificate 子类屏蔽公钥的
// asymmetricKeyDetails（真实 KeyObject 允许实例级 shadow），迫使 ?? 1024 分支生效
vi.mock("node:crypto", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:crypto")>();
  const X509NoKeyDetails = class extends orig.X509Certificate {
    // d.ts 把 publicKey 声明为属性，运行时实为原型 getter——实例级 shadow 合法，TS 报错抑制
    // @ts-expect-error TS2611 运行时为 getter 可覆写
    override get publicKey() {
      // @ts-expect-error TS2855 运行时原型链可达
      const k = super.publicKey;
      Object.defineProperty(k, "asymmetricKeyDetails", { value: undefined, configurable: true });
      return k;
    }
  };
  return { ...orig, X509Certificate: X509NoKeyDetails };
});
import { md5String, md5File } from "./shared/sign.js";
import { XiaomiChannel, rsaEncryptSegmented, generateMiSig } from "./xiaomi.js";
import { mockFetch, makeTestCtx } from "../test-utils.js";
import type { ChannelContext } from "../channel.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "applift-xiaomi-"));
const certPath = path.join(tmp, "mi-cert.pem");
const keyPath = path.join(tmp, "mi-key.pem");
const apkPath = path.join(tmp, "app-release.apk");
const apkBytes = Buffer.from("fake-apk-bytes-for-xiaomi");
const iconPath = path.join(tmp, "icon.png");
fs.writeFileSync(iconPath, Buffer.from("fake-icon-bytes"));

const PASSWORD = "mi-pass-123";
const CREDS = {
  MI_USER_NAME: "mi-user@example.com",
  MI_PASSWORD: PASSWORD,
  MI_CERT_PATH: certPath,
  MI_APP_NAME: "千云司机端",
};

let certPem: string;
let privKey: string;

beforeAll(() => {
  // v1 selftest 写法：openssl 自签 1024bit 证书（小米签名密钥即 X.509 证书公钥）
  execSync(
    `openssl req -x509 -newkey rsa:1024 -nodes -keyout ${keyPath} -out ${certPath} -days 1 -subj "/CN=applift-test"`,
  );
  certPem = fs.readFileSync(certPath, "utf8");
  privKey = fs.readFileSync(keyPath, "utf8");
  fs.writeFileSync(apkPath, apkBytes);
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 用私钥分段解密 rsaEncryptSegmented 的 hex 输出，还原明文（对拍实现） */
function rsaDecryptSegmented(hex: string): string {
  const buf = Buffer.from(hex, "hex");
  const out: Buffer[] = [];
  for (let i = 0; i < buf.length; i += 128) {
    out.push(
      privateDecrypt(
        { key: privKey, padding: constants.RSA_PKCS1_PADDING },
        buf.subarray(i, i + 128),
      ),
    );
  }
  return Buffer.concat(out).toString("utf8");
}

function makeCtx(
  overrides: {
    credentials?: Record<string, string>;
    target?: Record<string, string>;
    updateDescription?: string;
  } = {},
) {
  return makeTestCtx({
    credentials: { ...CREDS, ...overrides.credentials },
    target: { pkgName: "com.qianyun.driver", icon: iconPath, ...overrides.target },
    artifactPath: apkPath,
    updateDescription: overrides.updateDescription,
  });
}

describe("rsaEncryptSegmented", () => {
  it("1024bit 证书公钥加密后可用私钥分段解密还原（跨段 >117 字节）", () => {
    const plain = "x".repeat(300); // 跨 3 段（117+117+66）
    const hex = rsaEncryptSegmented(plain, certPem);
    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(hex.length).toBe(3 * 256); // 每段密文 128 字节 = 256 hex
    expect(rsaDecryptSegmented(hex)).toBe(plain);
  });

  it("公钥 asymmetricKeyDetails 缺失 → keySize 回退 1024bit（chunk 117），加解密仍一致", () => {
    // 本文件 vi.mock 的 X509Certificate 已屏蔽 asymmetricKeyDetails；1024bit 证书回退后行为不变
    const plain = "y".repeat(250); // 117+117+16
    expect(rsaDecryptSegmented(rsaEncryptSegmented(plain, certPem))).toBe(plain);
  });

  it("短明文单段加密（含中文 utf8）", () => {
    const hex = rsaEncryptSegmented("hello 小米", certPem);
    expect(rsaDecryptSegmented(hex)).toBe("hello 小米");
  });
});

describe("generateMiSig", () => {
  it("SIG 解密后含 RequestData MD5 + 各文件 MD5 + password", () => {
    const requestDataJson = JSON.stringify({ userName: "u1", packageName: "com.a.b" });
    const sig = generateMiSig(requestDataJson, [["apk", apkPath]], PASSWORD, certPem);
    const decoded = JSON.parse(rsaDecryptSegmented(sig)) as {
      sig: Array<{ name: string; hash: string }>;
      password: string;
    };
    expect(decoded.password).toBe(PASSWORD);
    expect(decoded?.sig).toEqual([
      { name: "RequestData", hash: md5String(requestDataJson) },
      { name: "apk", hash: md5File(apkPath) },
    ]);
    // 与 node 原生 MD5 对拍
    expect(decoded?.sig?.[0]?.hash).toBe(createHash("md5").update(requestDataJson).digest("hex"));
    expect(decoded?.sig?.[1]?.hash).toBe(createHash("md5").update(apkBytes).digest("hex"));
  });

  it("无文件项时 sig 仅含 RequestData", () => {
    const sig = generateMiSig("{}", [], "p", certPem);
    const decoded = JSON.parse(rsaDecryptSegmented(sig)) as { sig: unknown[] };
    expect(decoded?.sig).toHaveLength(1);
  });
});

describe("XiaomiChannel 元数据", () => {
  const ch = new XiaomiChannel();

  it("id/label/capabilities（不支持 stage）", () => {
    expect(ch.id).toBe("xiaomi");
    expect(ch.label).toBe("小米应用商店");
    expect(ch.capabilities).toEqual({ stage: false, submit: true, scheduled: false, status: true });
  });

  it("plan 返回 submit-only / auto-publish", async () => {
    const plan = await ch.plan({} as ChannelContext);
    expect(plan).toMatchObject({
      channel: "xiaomi",
      platform: "android",
      action: "submit-only",
      afterApproval: "auto-publish",
    });
  });

  it("stage 返回明确错误（上传即提审）", async () => {
    const r = await ch.stage({} as ChannelContext);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("小米上传与提审一体");
  });
});

describe("XiaomiChannel.status", () => {
  it("请求形状：POST /dev/query，RequestData 含 userName/packageName，SIG 可解密一致", async () => {
    const { find, restore } = mockFetch([
      { match: "/dev/query", response: { json: { result: 0, status: 5 } } },
    ]);
    const { ctx } = makeCtx();
    try {
      const st = await new XiaomiChannel().status(ctx);
      expect(st.state).toBe("unknown"); // 取值文档缺失，统一 unknown+raw
      if (st.state !== "unknown") throw new Error("应为 unknown");
      expect(st.raw).toContain('"status":5');

      const call = find("/dev/query")!;
      expect(call.method).toBe("POST");
      expect(call.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      const params = new URLSearchParams(call.body as string);
      expect(params.get("RequestData")).toBe(
        JSON.stringify({ userName: CREDS.MI_USER_NAME, packageName: "com.qianyun.driver" }),
      );
      const decoded = JSON.parse(rsaDecryptSegmented(params.get("SIG")!)) as {
        sig: Array<{ name: string; hash: string }>;
      };
      expect(decoded.sig).toEqual([
        { name: "RequestData", hash: md5String(params.get("RequestData")!) },
      ]);
    } finally {
      restore();
    }
  });

  it("result 非 0 抛错", async () => {
    const { restore } = mockFetch([
      { match: "/dev/query", response: { json: { result: 102, errMsg: "sig invalid" } } },
    ]);
    const { ctx } = makeCtx();
    try {
      await expect(new XiaomiChannel().status(ctx)).rejects.toThrow(
        "小米查询审核状态失败 result=102",
      );
    } finally {
      restore();
    }
  });

  it("result 非 0 且无 errMsg 时错误透传原始 JSON", async () => {
    const { restore } = mockFetch([{ match: "/dev/query", response: { json: { result: 102 } } }]);
    const { ctx } = makeCtx();
    try {
      await expect(new XiaomiChannel().status(ctx)).rejects.toThrow(
        '小米查询审核状态失败 result=102: {"result":102}',
      );
    } finally {
      restore();
    }
  });

  it("非 JSON 响应抛错（含渠道名与 HTTP 状态）", async () => {
    const { restore } = mockFetch([
      { match: "/dev/query", response: { status: 502, text: "<html>Bad Gateway</html>" } },
    ]);
    const { ctx } = makeCtx();
    try {
      await expect(new XiaomiChannel().status(ctx)).rejects.toThrow(
        "小米 查询审核状态返回非 JSON（HTTP 502）",
      );
    } finally {
      restore();
    }
  });

  it("缺 pkgName 抛错（含用途提示）", async () => {
    const { restore } = mockFetch([]);
    const ctx = makeTestCtx({ credentials: CREDS }).ctx;
    try {
      await expect(new XiaomiChannel().status(ctx)).rejects.toThrow(
        "小米渠道缺少 pkgName（审核状态查询必需）",
      );
    } finally {
      restore();
    }
  });
});

describe("XiaomiChannel.submit", () => {
  it("全流程：/dev/query result=0 → /dev/push 上传即提审，请求形状正确", async () => {
    const { calls, find, restore } = mockFetch([
      { match: "/dev/query", response: { json: { result: 0 } } },
      { match: "/dev/push", response: { json: { result: 0, label: "ok" } } },
    ]);
    const { ctx, events } = makeCtx({ updateDescription: "本次更新说明" });
    try {
      const r = await new XiaomiChannel().submit(ctx);
      expect(r.ok).toBe(true);
      expect(r.ref).toContain('"result":0');

      // query 请求形状
      const q = find("/dev/query")!;
      expect(q.url).toBe("https://api.developer.xiaomi.com/devupload/dev/query");
      expect(q.method).toBe("POST");
      expect(q.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
      const qParams = new URLSearchParams(q.body as string);
      expect(JSON.parse(qParams.get("RequestData")!)).toEqual({
        userName: "mi-user@example.com",
        packageName: "com.qianyun.driver",
      });
      // query 的 SIG 可解密且含 RequestData MD5
      const qSig = JSON.parse(rsaDecryptSegmented(qParams.get("SIG")!)) as {
        sig: Array<{ name: string; hash: string }>;
      };
      expect(qSig?.sig).toEqual([
        { name: "RequestData", hash: md5String(qParams.get("RequestData")!) },
      ]);

      // push 请求形状（FormData）
      const p = find("/dev/push")!;
      expect(p.url).toBe("https://api.developer.xiaomi.com/devupload/dev/push");
      expect(p.method).toBe("POST");
      const form = p.body as FormData;
      expect(form.get("RequestData")).toBe(
        JSON.stringify({
          userName: "mi-user@example.com",
          appInfo: JSON.stringify({
            appName: "千云司机端",
            packageName: "com.qianyun.driver",
            updateDesc: "本次更新说明",
          }),
          synchroType: 1,
        }),
      );
      const pSig = JSON.parse(rsaDecryptSegmented(form.get("SIG") as string)) as {
        sig: Array<{ name: string; hash: string }>;
        password: string;
      };
      expect(pSig.password).toBe(PASSWORD);
      expect(pSig?.sig).toEqual([
        { name: "RequestData", hash: md5String(form.get("RequestData") as string) },
        { name: "apk", hash: md5File(apkPath) },
        { name: "icon", hash: md5File(iconPath) },
      ]);
      const iconBlob = form.get("icon") as Blob;
      expect(iconBlob.size).toBe(15);
      const blob = form.get("apk") as Blob;
      expect(blob.size).toBe(apkBytes.length);
      expect(String(events[1]?.detail ?? "")).toContain("com.qianyun.driver");
      // 事件序列：auth → progress → upload → done
      expect(calls).toHaveLength(2);
      expect(events.map((e) => e.type)).toEqual(["phase", "progress", "phase", "phase"]);
    } finally {
      restore();
    }
  });

  it("updateDescription 缺省时 appInfo.updateDesc 用默认文案", async () => {
    const { find, restore } = mockFetch([
      { match: "/dev/query", response: { json: { result: 0 } } },
      { match: "/dev/push", response: { json: { result: 0 } } },
    ]);
    try {
      await new XiaomiChannel().submit(makeCtx().ctx);
      const form = find("/dev/push")!.body as FormData;
      const appInfo = JSON.parse(JSON.parse(form.get("RequestData") as string).appInfo);
      expect(appInfo.updateDesc).toBe("修复已知问题，优化用户体验");
    } finally {
      restore();
    }
  });

  it("updateVersion=false（线上锁定）时拒绝提审并提示", async () => {
    const { calls, restore } = mockFetch([
      { match: "/dev/query", response: { json: { result: 0, updateVersion: false } } },
      { match: "/dev/push", response: { json: { result: 0 } } },
    ]);
    try {
      await expect(new XiaomiChannel().submit(makeCtx().ctx)).rejects.toThrow(
        "小米提审中止：线上不允许更新版本（updateVersion=false，可能审核中）",
      );
      expect(calls).toHaveLength(1); // 预检拒绝，未发 push
    } finally {
      restore();
    }
  });

  it("待提审 versionCode 低于线上时拒绝（版本回退预检）", async () => {
    const { calls, restore } = mockFetch([
      {
        match: "/dev/query",
        response: {
          json: { result: 0, packageInfo: { versionCode: 4234, onlineVersionCode: 4234 } },
        },
      },
      { match: "/dev/push", response: { json: { result: 0 } } },
    ]);
    try {
      await expect(
        new XiaomiChannel().submit(makeCtx({ target: { versionCode: "4233" } }).ctx),
      ).rejects.toThrow("小米提审中止：待提审 versionCode 4233 低于线上 4234（版本回退）");
      expect(calls).toHaveLength(1); // 预检拒绝，未发 push
    } finally {
      restore();
    }
  });

  it("待提审 versionCode 不低于线上时正常提审（预检通过分支）", async () => {
    const { calls, restore } = mockFetch([
      {
        match: "/dev/query",
        response: { json: { result: 0, packageInfo: { versionCode: 4234 } } },
      },
      { match: "/dev/push", response: { json: { result: 0 } } },
    ]);
    try {
      await expect(
        new XiaomiChannel().submit(makeCtx({ target: { versionCode: "4235" } }).ctx),
      ).resolves.toMatchObject({ ok: true });
      expect(calls).toHaveLength(2);
    } finally {
      restore();
    }
  });

  it("错误文案 message 优先于 errMsg（对拍 python mi_submit.py 读 message）", async () => {
    const { restore } = mockFetch([
      {
        match: "/dev/query",
        response: { json: { result: 401, message: "签名无效", errMsg: "sig invalid" } },
      },
    ]);
    try {
      await expect(new XiaomiChannel().submit(makeCtx().ctx)).rejects.toThrow(
        "小米查询应用失败 result=401: 签名无效",
      );
    } finally {
      restore();
    }
  });

  it("MI_PRIVATE_KEY 别名兼容（python 权威键名，未提供 MI_PASSWORD）", async () => {
    const { find, restore } = mockFetch([
      { match: "/dev/query", response: { json: { result: 0 } } },
      { match: "/dev/push", response: { json: { result: 0 } } },
    ]);
    try {
      const ctx = makeTestCtx({
        credentials: {
          MI_USER_NAME: CREDS.MI_USER_NAME,
          MI_PRIVATE_KEY: PASSWORD,
          MI_CERT_PATH: certPath,
          MI_APP_NAME: "千云司机端",
        },
        target: { pkgName: "com.qianyun.driver", icon: iconPath },
        artifactPath: apkPath,
        updateDescription: "别名键回归验证",
      }).ctx;
      await expect(new XiaomiChannel().submit(ctx)).resolves.toMatchObject({ ok: true });
      const form = find("/dev/push")!.body as FormData;
      const pSig = JSON.parse(rsaDecryptSegmented(form.get("SIG") as string)) as {
        password: string;
      };
      expect(pSig.password).toBe(PASSWORD);
    } finally {
      restore();
    }
  });

  it("未配置 icon → 中止并提示配置位置（官方必选，apkgo 同）", async () => {
    const { restore } = mockFetch([
      { match: "/dev/query", response: { json: { result: 0 } } },
      { match: "/dev/push", response: { json: { result: 0 } } },
    ]);
    try {
      // 两臂都算“未配置”：空串与键缺失（undefined 走 ?? 回退）
      const ctxEmpty = makeCtx({ target: { icon: "" } }).ctx;
      await expect(new XiaomiChannel().submit(ctxEmpty)).rejects.toThrow(
        "小米提审缺少 icon：applift.config.ts → android.stores.xiaomi.icon",
      );
      const ctxAbsent = makeCtx({ target: { icon: undefined as unknown as string } }).ctx;
      await expect(new XiaomiChannel().submit(ctxAbsent)).rejects.toThrow("小米提审缺少 icon");
    } finally {
      restore();
    }
  });

  it("icon 文件不存在 → 中止报路径", async () => {
    const { restore } = mockFetch([
      { match: "/dev/query", response: { json: { result: 0 } } },
      { match: "/dev/push", response: { json: { result: 0 } } },
    ]);
    try {
      const ctx = makeCtx({ target: { icon: "/nonexistent/icon.png" } }).ctx;
      await expect(new XiaomiChannel().submit(ctx)).rejects.toThrow("小米 icon 文件不存在");
    } finally {
      restore();
    }
  });

  it("/dev/query result!=0 时抛错含 result 与 errMsg", async () => {
    const { restore } = mockFetch([
      { match: "/dev/query", response: { json: { result: 401, errMsg: "no permission" } } },
    ]);
    try {
      await expect(new XiaomiChannel().submit(makeCtx().ctx)).rejects.toThrow(
        "小米查询应用失败 result=401: no permission",
      );
    } finally {
      restore();
    }
  });

  it("/dev/push result!=0 时抛错", async () => {
    const { restore } = mockFetch([
      { match: "/dev/query", response: { json: { result: 0 } } },
      { match: "/dev/push", response: { json: { result: 1005, errMsg: "sig invalid" } } },
    ]);
    try {
      await expect(new XiaomiChannel().submit(makeCtx().ctx)).rejects.toThrow(
        "小米 push 失败 result=1005: sig invalid",
      );
    } finally {
      restore();
    }
  });

  it("/dev/query result!=0 且无 errMsg 时错误含原始 JSON", async () => {
    const { restore } = mockFetch([{ match: "/dev/query", response: { json: { result: 401 } } }]);
    try {
      await expect(new XiaomiChannel().submit(makeCtx().ctx)).rejects.toThrow(
        '小米查询应用失败 result=401: {"result":401}',
      );
    } finally {
      restore();
    }
  });

  it("/dev/push result!=0 且无 errMsg 时错误含原始 JSON", async () => {
    const { restore } = mockFetch([
      { match: "/dev/query", response: { json: { result: 0 } } },
      { match: "/dev/push", response: { json: { result: 1005 } } },
    ]);
    try {
      await expect(new XiaomiChannel().submit(makeCtx().ctx)).rejects.toThrow(
        '小米 push 失败 result=1005: {"result":1005}',
      );
    } finally {
      restore();
    }
  });

  it("非 JSON 响应抛错（含渠道名与 HTTP 状态）", async () => {
    // /dev/query 网关 502
    const { restore } = mockFetch([
      { match: "/dev/query", response: { status: 502, text: "<html>Bad Gateway</html>" } },
    ]);
    try {
      await expect(new XiaomiChannel().submit(makeCtx().ctx)).rejects.toThrow(
        "小米 查询应用返回非 JSON（HTTP 502）",
      );
    } finally {
      restore();
    }
    // /dev/push 网关 502
    const { restore: restore2 } = mockFetch([
      { match: "/dev/query", response: { json: { result: 0 } } },
      { match: "/dev/push", response: { status: 502, text: "<html>Bad Gateway</html>" } },
    ]);
    try {
      await expect(new XiaomiChannel().submit(makeCtx().ctx)).rejects.toThrow(
        "小米 push返回非 JSON（HTTP 502）",
      );
    } finally {
      restore2();
    }
  });

  it.each(["MI_USER_NAME", "MI_PASSWORD", "MI_CERT_PATH", "MI_APP_NAME"] as const)(
    "缺少凭据 %s 抛错含键名",
    async (key) => {
      const { restore } = mockFetch([]);
      try {
        const creds = { ...CREDS };
        delete creds[key];
        const ctx = makeTestCtx({
          credentials: creds,
          target: { pkgName: "com.qianyun.driver" },
          artifactPath: apkPath,
        }).ctx;
        await expect(new XiaomiChannel().submit(ctx)).rejects.toThrow(`小米渠道缺少 ${key}`);
      } finally {
        restore();
      }
    },
  );

  it("target 缺 pkgName 时报错并提示配置位置", async () => {
    const { restore } = mockFetch([]);
    try {
      const ctx = makeTestCtx({ credentials: { ...CREDS }, artifactPath: apkPath }).ctx;
      await expect(new XiaomiChannel().submit(ctx)).rejects.toThrow(
        "小米渠道缺少 pkgName（项目配置 android.stores.xiaomi.pkgName）",
      );
    } finally {
      restore();
    }
  });

  it("MI_CERT_PATH 指向不存在的文件时抛 ENOENT", async () => {
    const { restore } = mockFetch([]);
    try {
      const ctx = makeTestCtx({
        credentials: { ...CREDS, MI_CERT_PATH: path.join(tmp, "no-such-cert.pem") },
        target: { pkgName: "com.a" },
        artifactPath: apkPath,
      }).ctx;
      await expect(new XiaomiChannel().submit(ctx)).rejects.toThrow(/ENOENT/);
    } finally {
      restore();
    }
  });
});
