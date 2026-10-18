/**
 * asc-jwt 单元测试：ES256 JWT 生成自校验（真密钥签名/验签）+ ascGet/ascRequest 契约与错误分支。
 */
import { createVerify, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ascGet, ascRequest, makeAscJwt } from "./asc-jwt.js";
import { mockFetch } from "../../test-utils.js";

let p8Path = "";
let publicKey = "";

beforeAll(() => {
  const { publicKey: pub, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  publicKey = pub.export({ type: "spki", format: "pem" }).toString();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "asc-jwt-test-"));
  p8Path = path.join(dir, "AuthKey_TESTKEY.p8");
  fs.writeFileSync(p8Path, privateKey.export({ type: "pkcs8", format: "pem" }));
});

afterAll(() => {
  fs.rmSync(path.dirname(p8Path), { recursive: true, force: true });
});

function b64urlToJson(part: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
  );
}

describe("makeAscJwt", () => {
  it("生成 ES256 JWT：签名可验、header/payload 正确、20 分钟过期", () => {
    const before = Math.floor(Date.now() / 1000);
    const jwt = makeAscJwt({ keyId: "KID123", issuerId: "ISS456", p8Path });
    const after = Math.floor(Date.now() / 1000);

    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);

    const header = b64urlToJson(parts[0]!);
    expect(header).toEqual({ alg: "ES256", kid: "KID123" });

    const payload = b64urlToJson(parts[1]!);
    expect(payload.iss).toBe("ISS456");
    expect(payload.aud).toBe("appstoreconnect-v1");
    const iat = payload.iat as number;
    expect(iat).toBeGreaterThanOrEqual(before);
    expect(iat).toBeLessThanOrEqual(after);
    // 20 分钟有效
    expect((payload.exp as number) - iat).toBe(20 * 60);

    // 签名可验（p1363 raw r||s 直接作 JWS 签名）
    const verifier = createVerify("SHA256");
    verifier.update(`${parts[0]}.${parts[1]}`);
    expect(
      verifier.verify(
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(parts[2]!.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
      ),
    ).toBe(true);
  });

  it("p8 文件不存在时抛错", () => {
    expect(() =>
      makeAscJwt({ keyId: "K", issuerId: "I", p8Path: "/nonexistent/AuthKey_X.p8" }),
    ).toThrow();
  });
});

describe("ascGet", () => {
  it("GET 请求形状：URL 拼接、Bearer 头、返回解析后的 JSON", async () => {
    const m = mockFetch([
      { match: "/v1/apps", response: { status: 200, json: { data: [{ id: "a1" }] } } },
    ]);
    try {
      const out = await ascGet("jwt-token", "/v1/apps?limit=5");
      expect(out).toEqual({ data: [{ id: "a1" }] });
      expect(m.calls).toHaveLength(1);
      expect(m.calls[0]!.url).toBe("https://api.appstoreconnect.apple.com/v1/apps?limit=5");
      expect(m.calls[0]!.method).toBe("GET");
      expect(m.calls[0]!.headers.Authorization).toBe("Bearer jwt-token");
      expect(m.calls[0]!.signal).toBeInstanceOf(AbortSignal); // P2-4：全部 fetch 带超时信号
    } finally {
      m.restore();
    }
  });

  it("非 2xx 抛错，错误信息含路径/状态码/errors[] 内容", async () => {
    const m = mockFetch([
      {
        match: "/v1/builds",
        response: {
          status: 403,
          json: {
            errors: [
              { status: "403", code: "FORBIDDEN", title: "Not Authorized", detail: "key revoked" },
            ],
          },
        },
      },
    ]);
    try {
      await expect(ascGet("j", "/v1/builds")).rejects.toThrow("ASC API /v1/builds 失败 HTTP 403");
      await expect(ascGet("j", "/v1/builds")).rejects.toThrow("Not Authorized");
    } finally {
      m.restore();
    }
  });

  it("无 errors[] 时回退整个响应体并截断 300 字符", async () => {
    const m = mockFetch([
      { match: "/v1/x", response: { status: 500, json: { blob: "x".repeat(500) } } },
    ]);
    try {
      const err = await ascGet("j", "/v1/x").catch((e) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("HTTP 500");
      expect((err as Error).message.length).toBeLessThanOrEqual(
        300 + "ASC API /v1/x 失败 HTTP 500: ".length,
      );
    } finally {
      m.restore();
    }
  });

  it("返回非 JSON（HTML 网关页）→ 报返回非 JSON（HTTP x）", async () => {
    const m = mockFetch([
      { match: "/v1/x", response: { status: 502, text: "<html>bad gateway</html>" } },
    ]);
    try {
      await expect(ascGet("j", "/v1/x")).rejects.toThrow("ASC API /v1/x 返回非 JSON（HTTP 502）");
    } finally {
      m.restore();
    }
  });
});

describe("ascRequest", () => {
  it("POST 请求形状：method/Content-Type/body 序列化", async () => {
    const m = mockFetch([
      {
        match: "/v1/appStoreVersionSubmissions",
        response: { status: 201, json: { data: { id: "sub1" } } },
      },
    ]);
    try {
      const body = { data: { type: "appStoreVersionSubmissions" } };
      const out = await ascRequest("jwt1", "/v1/appStoreVersionSubmissions", "POST", body);
      expect(out).toEqual({ data: { id: "sub1" } });
      expect(m.calls[0]!.method).toBe("POST");
      expect(m.calls[0]!.headers).toEqual({
        Authorization: "Bearer jwt1",
        "Content-Type": "application/json",
      });
      expect(m.calls[0]!.signal).toBeInstanceOf(AbortSignal); // P2-4：全部 fetch 带超时信号
      expect(m.calls[0]!.body).toBe(JSON.stringify(body));
    } finally {
      m.restore();
    }
  });

  it("body 缺省时不发送 body", async () => {
    const m = mockFetch([{ match: "/v1/y", response: { status: 200, json: { ok: true } } }]);
    try {
      await ascRequest("j", "/v1/y", "DELETE");
      expect(m.calls[0]!.method).toBe("DELETE");
      expect(m.calls[0]!.body).toBeUndefined();
    } finally {
      m.restore();
    }
  });

  it("非 2xx 且响应非 JSON（json 解析失败回退 {}）时抛错", async () => {
    const m = mockFetch([
      { match: "/v1/z", response: { status: 502, text: "<html>bad gateway</html>" } },
    ]);
    try {
      await expect(ascRequest("j", "/v1/z", "PATCH", { a: 1 })).rejects.toThrow(
        "ASC API PATCH /v1/z 失败 HTTP 502",
      );
    } finally {
      m.restore();
    }
  });
});
