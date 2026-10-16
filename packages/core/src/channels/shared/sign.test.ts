import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac, createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sortedQueryString, hmacSign, md5String, md5File, formPost } from "./sign.js";

describe("sortedQueryString（应用宝/OPPO/vivo 签名基础）", () => {
  it("按 key ASCII 升序拼接并过滤空值", () => {
    const q = sortedQueryString({
      user_id: "u1",
      timestamp: "123",
      sign: undefined,
      app_id: "a1",
      extra: null,
    });
    expect(q).toBe("app_id=a1&timestamp=123&user_id=u1");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hmacSign", () => {
  it("与 HmacSHA256 已知向量一致（v1 selftest 迁移）", () => {
    const expected = createHmac("sha256", "abc").update("a=1&b=2").digest("hex");
    expect(hmacSign("abc", { b: "2", a: "1" })).toBe(expected);
  });
});

describe("md5File", () => {
  it("9MB+7B（跨 8MB 分块边界）与整读一致", () => {
    const p = path.join(os.tmpdir(), "applift-test-md5.bin");
    fs.writeFileSync(p, Buffer.alloc(9 * 1024 * 1024 + 7, 1));
    try {
      const whole = createHash("md5").update(fs.readFileSync(p)).digest("hex");
      expect(md5File(p)).toBe(whole);
    } finally {
      fs.unlinkSync(p);
    }
  });
});

describe("md5String", () => {
  it("与 node 一致", () => {
    expect(md5String("hello")).toBe(createHash("md5").update("hello", "utf8").digest("hex"));
  });
});

describe("formPost", () => {
  it("非 JSON 响应抛错（含 HTTP 状态与响应体片段）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({ status: 502, text: async () => "<html>Bad Gateway</html>" }) as unknown as Response,
      ),
    );
    await expect(formPost("https://api.example.com/x", { a: "b" })).rejects.toThrow(
      "HTTP 502 非 JSON 响应: <html>Bad Gateway</html>",
    );
  });

  it("JSON 响应解析返回", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 200, text: async () => '{"ok":1}' }) as unknown as Response),
    );
    await expect(formPost<{ ok: number }>("https://api.example.com/x", {})).resolves.toEqual({
      ok: 1,
    });
  });
});
