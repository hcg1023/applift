/**
 * asc-jwt 单元测试：ES256 JWT 生成自校验（真密钥签名/验签）+ AscClient 韧性层
 * （JWT 惰性续签、401 重签重试、GET 429/5xx 重试矩阵、写操作不重试、协议未签人话）。
 */
import { createVerify, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AscClient, makeAscJwt } from "./asc-jwt.js";
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
    expect(iat).toBeGreaterThanOrEqual(before - 60);
    expect(iat).toBeLessThanOrEqual(after - 60);
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

  it("iat = now - 60（fastlane token.rb 实证，时钟偏移防御），exp - iat 仍 20 分钟", () => {
    const before = Math.floor(Date.now() / 1000);
    const jwt = makeAscJwt({ keyId: "KID", issuerId: "ISS", p8Path });
    const after = Math.floor(Date.now() / 1000);
    const payload = b64urlToJson(jwt.split(".")[1]!);
    const iat = payload.iat as number;
    expect(iat).toBeGreaterThanOrEqual(before - 60);
    expect(iat).toBeLessThanOrEqual(after - 60);
    expect((payload.exp as number) - iat).toBe(20 * 60);
  });

  it("p8 文件不存在时抛错", () => {
    expect(() =>
      makeAscJwt({ keyId: "K", issuerId: "I", p8Path: "/nonexistent/AuthKey_X.p8" }),
    ).toThrow();
  });
});

describe("AscClient 请求形状", () => {
  const auth = () => ({ keyId: "KID", issuerId: "ISS", p8Path });

  it("GET：URL 拼接、Bearer 头、返回解析后的 JSON、带超时信号", async () => {
    const m = mockFetch([
      { match: "/v1/apps", response: { status: 200, json: { data: [{ id: "a1" }] } } },
    ]);
    try {
      const out = await new AscClient(auth()).get<{ data: unknown[] }>("/v1/apps?limit=5");
      expect(out).toEqual({ data: [{ id: "a1" }] });
      expect(m.calls).toHaveLength(1);
      expect(m.calls[0]!.url).toBe("https://api.appstoreconnect.apple.com/v1/apps?limit=5");
      expect(m.calls[0]!.method).toBe("GET");
      expect(m.calls[0]!.headers.Authorization).toMatch(/^Bearer ey/);
      expect(m.calls[0]!.signal).toBeInstanceOf(AbortSignal); // P2-4：全部 fetch 带超时信号
    } finally {
      m.restore();
    }
  });

  it("POST：method/Content-Type/body 序列化", async () => {
    const m = mockFetch([
      {
        match: "/v1/appStoreVersionSubmissions",
        response: { status: 201, json: { data: { id: "sub1" } } },
      },
    ]);
    try {
      const body = { data: { type: "appStoreVersionSubmissions" } };
      const out = await new AscClient(auth()).request(
        "/v1/appStoreVersionSubmissions",
        "POST",
        body,
      );
      expect(out).toEqual({ data: { id: "sub1" } });
      expect(m.calls[0]!.method).toBe("POST");
      expect(m.calls[0]!.headers.Authorization).toMatch(/^Bearer ey/);
      expect(m.calls[0]!.headers["Content-Type"]).toBe("application/json");
      expect(m.calls[0]!.signal).toBeInstanceOf(AbortSignal);
      expect(m.calls[0]!.body).toBe(JSON.stringify(body));
    } finally {
      m.restore();
    }
  });

  it("body 缺省时不发送 body 也不带 Content-Type", async () => {
    const m = mockFetch([{ match: "/v1/y", response: { status: 200, json: { ok: true } } }]);
    try {
      await new AscClient(auth()).request("/v1/y", "DELETE");
      expect(m.calls[0]!.method).toBe("DELETE");
      expect(m.calls[0]!.body).toBeUndefined();
      expect(m.calls[0]!.headers["Content-Type"]).toBeUndefined();
    } finally {
      m.restore();
    }
  });
});

describe("AscClient 重试矩阵（docs/fastlane-adoption §5）", () => {
  const auth = () => ({ keyId: "KID", issuerId: "ISS", p8Path });

  it("GET 429：指数退避后成功（1s→2s），Authorization 每次都带 Bearer", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const m = mockFetch([
      {
        match: "/v1/apps",
        response: () => {
          calls += 1;
          return calls <= 2 ? { status: 429, json: {} } : { status: 200, json: { data: [] } };
        },
      },
    ]);
    try {
      const p = new AscClient(auth()).get("/v1/apps");
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      await expect(p).resolves.toEqual({ data: [] });
      expect(m.calls.length).toBe(3);
      for (const c of m.calls) expect(c.headers.Authorization).toMatch(/^Bearer ey/);
    } finally {
      m.restore();
      vi.useRealTimers();
    }
  });

  it("GET 500 → 2s 后重试成功，共 2 次请求", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const m = mockFetch([
      {
        match: "/v1/apps",
        response: () => {
          calls += 1;
          return calls === 1 ? { status: 500, json: {} } : { status: 200, json: { data: [] } };
        },
      },
    ]);
    try {
      const p = new AscClient(auth()).get("/v1/apps");
      await vi.advanceTimersByTimeAsync(2000);
      await expect(p).resolves.toEqual({ data: [] });
      expect(m.calls.length).toBe(2);
    } finally {
      m.restore();
      vi.useRealTimers();
    }
  });

  it("GET 401 → 重签 JWT 重试一次成功（两次请求 Authorization 不同）", async () => {
    let calls = 0;
    const m = mockFetch([
      {
        match: "/v1/apps",
        response: () => {
          calls += 1;
          return calls === 1 ? { status: 401, json: {} } : { status: 200, json: { data: [] } };
        },
      },
    ]);
    try {
      const first = new AscClient(auth());
      await expect(first.get("/v1/apps")).resolves.toEqual({ data: [] });
      expect(m.calls.length).toBe(2);
      expect(m.calls[0]!.headers.Authorization).not.toBe(m.calls[1]!.headers.Authorization);
      expect(m.calls[1]!.headers.Authorization).toMatch(/^Bearer ey/);
    } finally {
      m.restore();
    }
  });

  it("POST 500 → 不重试直接抛错，文案含「先跑 applift status 确认」", async () => {
    const m = mockFetch([{ match: "/v1/appStoreVersions", response: { status: 500, json: {} } }]);
    try {
      await expect(
        new AscClient(auth()).request("/v1/appStoreVersions", "POST", {}),
      ).rejects.toThrow(/写操作不自动重试.*applift status/);
      expect(m.calls.length).toBe(1);
    } finally {
      m.restore();
    }
  });

  it("403 REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED → 专属人话", async () => {
    const m = mockFetch([
      {
        match: "/v1/apps",
        response: {
          status: 403,
          json: { errors: [{ code: "REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED" }] },
        },
      },
    ]);
    try {
      await expect(new AscClient(auth()).get("/v1/apps")).rejects.toThrow(
        /付费协议未签或已过期.*App Store Connect 网页/,
      );
    } finally {
      m.restore();
    }
  });

  it("非 2xx 抛错：错误信息含路径/状态码/errors[] 内容（GET 用前缀不带 method）", async () => {
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
      await expect(new AscClient(auth()).get("/v1/builds")).rejects.toThrow(
        "ASC API /v1/builds 失败 HTTP 403",
      );
      await expect(new AscClient(auth()).get("/v1/builds")).rejects.toThrow("Not Authorized");
    } finally {
      m.restore();
    }
  });

  it("无 errors[] 时回退整个响应体并截断 300 字符", async () => {
    const m = mockFetch([
      { match: "/v1/x", response: { status: 500, json: { blob: "x".repeat(500) } } },
    ]);
    vi.useFakeTimers();
    try {
      const p = new AscClient(auth()).get("/v1/x");
      p.catch(() => {});
      // 500 重试 3 次（2s/4s/8s）后仍失败才抛
      await vi.advanceTimersByTimeAsync(2000 + 4000 + 8000);
      const err = (await p.then(
        () => null,
        (e) => e as Error,
      ))!;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("HTTP 500");
      // GET 错误无写操作提示后缀；主体截断 300 字符
      expect(err.message.length).toBeLessThanOrEqual(300 + "ASC API /v1/x 失败 HTTP 500: ".length);
      expect(m.calls.length).toBe(4);
    } finally {
      m.restore();
      vi.useRealTimers();
    }
  });

  it("非 JSON 200 响应 → 抛「返回非 JSON」", async () => {
    const m = mockFetch([
      { match: "/v1/x", response: { status: 200, text: "<html>not json</html>" } },
    ]);
    try {
      await expect(new AscClient(auth()).get("/v1/x")).rejects.toThrow(
        "ASC API /v1/x 返回非 JSON（HTTP 200）",
      );
    } finally {
      m.restore();
    }
  });

  it("非 2xx 且响应非 JSON（json 解析失败回退 {}）时抛错（POST）", async () => {
    const m = mockFetch([
      { match: "/v1/z", response: { status: 502, text: "<html>bad gateway</html>" } },
    ]);
    try {
      await expect(new AscClient(auth()).request("/v1/z", "PATCH", { a: 1 })).rejects.toThrow(
        "ASC API PATCH /v1/z 失败 HTTP 502",
      );
    } finally {
      m.restore();
    }
  });

  it("JWT 惰性续签：同一实例同窗口内复用同一 Bearer，临期（>18 分钟）后重签", async () => {
    vi.useFakeTimers();
    const m = mockFetch([{ match: "/v1/apps", response: { status: 200, json: { data: [] } } }]);
    try {
      const c = new AscClient(auth());
      await c.get("/v1/apps");
      await c.get("/v1/apps");
      expect(m.calls.length).toBe(2);
      expect(m.calls[0]!.headers.Authorization).toBe(m.calls[1]!.headers.Authorization);

      // 推进 19 分钟：超过 18 分钟续签余量 → 重签新 JWT
      await vi.advanceTimersByTimeAsync(19 * 60 * 1000);
      await c.get("/v1/apps");
      expect(m.calls.length).toBe(3);
      expect(m.calls[2]!.headers.Authorization).not.toBe(m.calls[0]!.headers.Authorization);
    } finally {
      m.restore();
      vi.useRealTimers();
    }
  });
});
