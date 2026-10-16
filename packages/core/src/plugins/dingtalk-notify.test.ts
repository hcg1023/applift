import { describe, expect, it, vi } from "vitest";
import { dingtalkNotify } from "./dingtalk-notify.js";
import type { PipelineSummary } from "../pipeline.js";

function summary(ok: boolean): PipelineSummary {
  const plan = {
    channel: "huawei",
    platform: "android" as const,
    artifactVersion: "1.0.0",
    action: "stage+submit" as const,
    afterApproval: "auto-publish" as const,
  };
  const entry = {
    channel: "huawei",
    label: "华为应用市场",
    ok,
    plan,
    stageError: ok ? undefined : "boom",
  };
  return { stage: [entry], submit: [{ ...entry }] };
}

describe("dingtalkNotify", () => {
  it("notify 发送 markdown 汇总（成功与失败文案）", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => ({ ok: true }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    const plugin = dingtalkNotify({
      webhook: "https://oapi.dingtalk.com/robot/send?access_token=tok",
    });
    await plugin["notify"]!(summary(true), { cwd: "/tmp" });
    await plugin["notify"]!(summary(false), { cwd: "/tmp" });
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(String(c[1]?.body)));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodies[0]?.markdown?.text).toContain("✅ 成功");
    expect(bodies[1]?.markdown?.text).toContain("❌ boom");
    expect(bodies[0]?.msgtype).toBe("markdown");
    expect(bodies[0]?.markdown?.title).toBe("applift 发布结果");
    vi.unstubAllGlobals();
  });

  it("atMobiles 附加 at 字段", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => ({ ok: true }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    const plugin = dingtalkNotify({ webhook: "https://x/y", atMobiles: ["13800000000"] });
    await plugin["notify"]!(summary(true), { cwd: "/tmp" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).at).toEqual({
      atMobiles: ["13800000000"],
      isAtAll: false,
    });
    // 空数组分支：不附加 at 字段
    const fetch2 = vi.fn(
      async (_url: string, _init?: RequestInit) => ({ ok: true }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetch2);
    await dingtalkNotify({ webhook: "https://x/y", atMobiles: [] })["notify"]!(summary(true), {
      cwd: "/tmp",
    });
    expect(JSON.parse(String(fetch2.mock.calls[0]?.[1]?.body)).at).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("secret 加签：webhook 已带 query 时用 & 追加 timestamp 与 sign", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => ({ ok: true }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    const plugin = dingtalkNotify({ webhook: "https://x/y?access_token=t", secret: "SEC123" });
    await plugin["notify"]!(summary(true), { cwd: "/tmp" });
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toMatch(/&timestamp=\d+&sign=[%0-9A-Za-z]+$/);
    vi.unstubAllGlobals();
  });

  it("webhook 无 query 时加签用 ? 拼接（不产出非法 URL）", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => ({ ok: true }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    const plugin = dingtalkNotify({
      webhook: "https://oapi.dingtalk.com/robot/send",
      secret: "SEC123",
    });
    await plugin["notify"]!(summary(true), { cwd: "/tmp" });
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toMatch(/^https:\/\/oapi\.dingtalk\.com\/robot\/send\?timestamp=\d+&sign=/);
    vi.unstubAllGlobals();
  });

  it("stage-only（submit 空）通知标题标明 stage 草稿（未提审）", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => ({ ok: true }) as unknown as Response,
    );
    vi.stubGlobal("fetch", fetchMock);
    const plugin = dingtalkNotify({ webhook: "https://x/y" });
    const plan = {
      channel: "huawei",
      platform: "android" as const,
      artifactVersion: "1.0.0",
      action: "stage-only" as const,
      afterApproval: "auto-publish" as const,
    };
    await plugin["notify"]!(
      { stage: [{ channel: "huawei", label: "华为应用市场", ok: true, plan }], submit: [] },
      { cwd: "/tmp" },
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.markdown.title).toBe("applift stage 草稿（未提审）");
    expect(body.markdown.text).toContain("### applift stage 草稿（未提审）");
    vi.unstubAllGlobals();
  });

  it("通知失败静默容错（不抛出）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, _i?: RequestInit) => {
        throw new Error("network down");
      }),
    );
    const plugin = dingtalkNotify({ webhook: "https://x/y" });
    await expect(plugin["notify"]!(summary(true), { cwd: "/tmp" })).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("插件元数据", () => {
    expect(dingtalkNotify({ webhook: "x" }).name).toBe("dingtalk-notify");
  });
});
