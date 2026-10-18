/**
 * humanizeError 契约：错误码边界匹配（防短数字码误中长数字）、网络故障人话化、透传行为。
 */
import { describe, expect, it } from "vitest";
import { humanizeError } from "./error-codes.js";

const HINTS: Record<string, string> = {
  "1003": "client_id/client_secret 无效（AGC → 项目设置重新获取）",
  "204144719": "软件包正在编译中",
};

describe("humanizeError 错误码匹配", () => {
  it("码命中 → 原文追加提示行", () => {
    expect(humanizeError(HINTS, "AGC 提审失败 1003: invalid client")).toBe(
      "AGC 提审失败 1003: invalid client\n  提示: client_id/client_secret 无效（AGC → 项目设置重新获取）",
    );
  });

  it("数字边界：1003 不误中 11003 / 10031 / 2041447119", () => {
    expect(humanizeError(HINTS, "失败 11003: x")).not.toContain("提示");
    expect(humanizeError(HINTS, "失败 10031: x")).not.toContain("提示");
    expect(humanizeError(HINTS, "失败 2041447119: x")).not.toContain("提示");
  });

  it("长码自身仍精确命中（204144719 不被边界误伤）", () => {
    expect(humanizeError(HINTS, "AGC 失败 204144719: compiling")).toContain("编译中");
  });

  it("非数字码按包含匹配", () => {
    expect(
      humanizeError({ INVALID_SIGNATURE: "签名不匹配" }, "err INVALID_SIGNATURE at x"),
    ).toContain("签名不匹配");
  });

  it("无码表 / 未命中 → 原样返回", () => {
    expect(humanizeError(undefined, "随便什么错误")).toBe("随便什么错误");
    expect(humanizeError(HINTS, "无码错误")).toBe("无码错误");
  });
});

describe("humanizeError 网络故障人话化", () => {
  it("AbortSignal 超时（DOMException 文案）→ 超时提示", () => {
    expect(humanizeError(undefined, "The operation was aborted due to timeout")).toContain(
      "请求超时",
    );
  });

  it("TimeoutError 命名异常 → 超时提示", () => {
    expect(humanizeError(undefined, "TimeoutError: 30s elapsed")).toContain("请求超时");
  });

  it("ECONNRESET / ENOTFOUND / fetch failed → 网络故障提示", () => {
    expect(humanizeError(undefined, "fetch failed: ECONNRESET")).toContain("网络故障");
    expect(humanizeError(undefined, "getaddrinfo ENOTFOUND api.example.com")).toContain("网络故障");
  });

  it("网络提示优先于渠道码表（超时类消息不再扫码表）", () => {
    const out = humanizeError(HINTS, "aborted due to timeout (1003)");
    expect(out).toContain("请求超时");
    expect(out).not.toContain("client_id");
  });
});
