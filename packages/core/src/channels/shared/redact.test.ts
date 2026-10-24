import { describe, expect, it } from "vitest";
import { isSensitiveName, redactValue, redactText } from "./redact.js";

describe("isSensitiveName（对拍 apkgo redact.go IsSensitive）", () => {
  it.each([
    "client_secret",
    "access_token",
    "x-cos-security-token",
    "password",
    "passwd",
    "Authorization",
    "credential",
    "cookie",
    "private_key",
    "api_key",
    "_api_key",
    "assertion",
    "jwt",
    "q-signature",
    "signature",
  ])("%s → 包含敏感词", (name) => {
    expect(isSensitiveName(name)).toBe(true);
  });

  it.each([["sig"], ["sign"], ["pwd"], ["auth"], ["SIG"], ["x-sign"], ["api_sign"]])(
    "%s → 归一化全等 / *sign 后缀",
    (name) => {
      expect(isSensitiveName(name)).toBe(true);
    },
  );

  it.each([
    ["design"],
    ["token_type"],
    ["Access-Control-Allow-Credentials"],
    ["buildKey"],
    ["buildShortcutUrl"],
    ["endpoint"],
  ])("%s → 不敏感（design 例外 / token_type / CORS 白名单 / 普通业务名）", (name) => {
    expect(isSensitiveName(name)).toBe(false);
  });
});

describe("redactValue", () => {
  it("敏感名 → [REDACTED <len>] 保留长度", () => {
    expect(redactValue("client_secret", "topsecret")).toBe("[REDACTED 9]");
  });

  it("空串保持空串（“签名为空”本身就是排查线索）", () => {
    expect(redactValue("sign", "")).toBe("");
    expect(redactValue("access_token", "")).toBe("");
  });

  it('Authorization 保留 scheme："Bearer [REDACTED 812]"（对拍 redact.go redactHeaders）', () => {
    expect(redactValue("Authorization", `Bearer ${"t".repeat(812)}`)).toBe("Bearer [REDACTED 812]");
  });

  it("authorization 大小写不敏感；无空格（裸 token）整体掩码", () => {
    expect(redactValue("authorization", "BearerXYZ")).toBe("[REDACTED 9]");
  });

  it("非敏感名 → 递归 redactText：值内 signed URL 仍脱敏", () => {
    expect(redactValue("endpoint", "https://cos.example.com/x?sign=abcdef&buildKey=bk")).toBe(
      "https://cos.example.com/x?sign=[REDACTED 6]&buildKey=bk",
    );
  });
});

describe("redactText", () => {
  it("signed URL：query 参数按名脱敏，非敏感参数（buildKey）保留", () => {
    expect(
      redactText(
        "https://bucket.cos.ap-guangzhou.myqcloud.com/apk/123.apk?x-cos-security-token=SECRET&q-signature=ALSOSECRET&buildKey=bk-123",
      ),
    ).toBe(
      "https://bucket.cos.ap-guangzhou.myqcloud.com/apk/123.apk?x-cos-security-token=[REDACTED 6]&q-signature=[REDACTED 10]&buildKey=bk-123",
    );
  });

  it("无 query 的 URL 原样返回", () => {
    expect(redactText("https://api.pgyer.com/apiv2/app/buildInfo")).toBe(
      "https://api.pgyer.com/apiv2/app/buildInfo",
    );
  });

  it("URL userinfo 剥离", () => {
    expect(redactText("https://user:pass@example.com/x?a=1")).toBe("https://example.com/x?a=1");
  });

  it("URL 带 userinfo 但无 query → 剥 userinfo 后原样返回（走无 query 分支）", () => {
    expect(redactText("https://user:pass@example.com/dir/file")).toBe(
      "https://example.com/dir/file",
    );
  });

  it("JSON 字符串递归脱敏：嵌套对象 + 数组元素继承键名", () => {
    expect(
      redactText(
        '{"client_secret":"s3cr3t!","data":{"access_token":"tok"},"list":[{"sign":"abc"}],"name":"app"}',
      ),
    ).toBe(
      '{"client_secret":"[REDACTED 7]","data":{"access_token":"[REDACTED 3]"},"list":[{"sign":"[REDACTED 3]"}],"name":"app"}',
    );
  });

  it("JSON 敏感名下的数字/布尔 → [REDACTED]（无长度）", () => {
    expect(redactText('{"token":12345,"auth":true}')).toBe(
      '{"token":"[REDACTED]","auth":"[REDACTED]"}',
    );
  });

  it("JSON 值内嵌套 URL / 内嵌 JSON 递归脱敏", () => {
    expect(redactText('{"endpoint":"https://cos.example.com/u?sig=SECRET","ok":true}')).toBe(
      '{"endpoint":"https://cos.example.com/u?sig=[REDACTED 6]","ok":true}',
    );
    expect(redactText('{"payload":"{\\"api_key\\":\\"k1\\"}","n":1}')).toBe(
      '{"payload":"{\\"api_key\\":\\"[REDACTED 2]\\"}","n":1}',
    );
  });

  it("非法 JSON（截断）→ 落到 name=value 正则扫描", () => {
    expect(redactText('{"access_token": "abc"')).toBe('{"access_token": "[REDACTED]"');
  });

  it("自由文本 name=value 扫描（错误消息中嵌入的 COS 签名 URL）", () => {
    expect(
      redactText(
        'Put "https://cos.example.com/a?x-cos-security-token=SECRET&q-signature=ALSO": deadline',
      ),
    ).toBe(
      'Put "https://cos.example.com/a?x-cos-security-token=[REDACTED]&q-signature=[REDACTED]": deadline',
    );
  });

  it('"name":"value" JSON 形态的自由文本同样命中', () => {
    expect(redactText('resp: "access_token":"abc123", ok')).toBe(
      'resp: "access_token":"[REDACTED]", ok',
    );
  });

  it("无凭据文本与空串原样返回", () => {
    expect(redactText("upload succeeded in 12s")).toBe("upload succeeded in 12s");
    expect(redactText("")).toBe("");
  });
});

describe("redactText URL 边界", () => {
  it("无 query 的 URL 原样返回（保留 hash）", () => {
    const out = redactText("https://x.cos.com/dir/file#frag");
    expect(out).toBe("https://x.cos.com/dir/file#frag");
  });
  it("带 hash 与敏感 query 并存", () => {
    const out = redactText("https://x.com/a?sign=abc123#sec");
    expect(out).toContain("[REDACTED");
    expect(out).toContain("#sec");
  });
});
