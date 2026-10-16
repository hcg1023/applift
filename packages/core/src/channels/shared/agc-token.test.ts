import { describe, expect, it } from "vitest";
import { getAgcToken } from "./agc-token.js";

describe("getAgcToken", () => {
  it("正常返回 access_token（请求形状：grant_type/client_credentials）", async () => {
    let captured: { url: string; method: string; body: string } | undefined;
    const fetchFn = async (url: string, init?: RequestInit) => {
      captured = { url, method: init?.method ?? "GET", body: String(init?.body) };
      return {
        status: 200,
        ok: true,
        json: async () => ({ access_token: "tok-1" }),
      } as unknown as Response;
    };
    const original = globalThis.fetch;
    globalThis.fetch = fetchFn as typeof fetch;
    try {
      const token = await getAgcToken({ clientId: "cid", clientSecret: "sec" });
      expect(token).toBe("tok-1");
      expect(captured?.url).toBe("https://connect-api.cloud.huawei.com/api/oauth2/v1/token");
      expect(JSON.parse(captured!.body)).toEqual({
        grant_type: "client_credentials",
        client_id: "cid",
        client_secret: "sec",
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("OAuth 错误体（error/error_description）抛错", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      status: 401,
      ok: false,
      json: async () => ({ error: "invalid_client", error_description: "bad secret" }),
    })) as unknown as typeof fetch;
    try {
      await expect(getAgcToken({ clientId: "x", clientSecret: "y" })).rejects.toThrow(/bad secret/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("ret 错误体抛错且提示检查凭据", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      status: 200,
      ok: true,
      json: async () => ({ ret: { code: 1003, msg: "client not found" } }),
    })) as unknown as typeof fetch;
    try {
      await expect(getAgcToken({ clientId: "x", clientSecret: "y" })).rejects.toThrow(
        /client not found.*client_id\/client_secret/s,
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("缺 access_token 抛错", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      status: 200,
      ok: true,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    try {
      await expect(getAgcToken({ clientId: "x", clientSecret: "y" })).rejects.toThrow(
        /\{\}.*client_id\/client_secret/s,
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});
