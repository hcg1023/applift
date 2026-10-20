import { describe, expect, it } from "vitest";
import {
  PluginHost,
  defineConfig,
  resolvePlugins,
  type AppliftPlugin,
  type ReleasePlanEntry,
} from "./plugin.js";
import { runSubmit } from "./pipeline.js";
import type { Channel, ChannelContext } from "./channel.js";
import type { UpdateProvider } from "./update.js";

function mkplan(channel: string): ReleasePlanEntry {
  return {
    channel,
    platform: "android",
    artifactVersion: "1.0.0",
    action: "stage+submit",
    afterApproval: "auto-publish",
  };
}

describe("PluginHost.apply", () => {
  it("链式修改：多个插件依次改写值", async () => {
    const host = new PluginHost([
      {
        name: "a",
        "plan:before"(plans) {
          return plans.map((p) => ({ ...p, notes: "a" }));
        },
      },
      {
        name: "b",
        "plan:before"(plans) {
          return plans.map((p) => ({ ...p, notes: `${p.notes}-b` }));
        },
      },
    ]);
    const r = await host.apply("plan:before", [mkplan("huawei")], { cwd: "/tmp" });
    expect(r.blocked).toBe(false);
    expect(r.value[0]?.notes).toBe("a-b");
  });

  it("拦截：返回 false 立即中止，后续插件不执行", async () => {
    let laterRan = false;
    const host = new PluginHost([
      {
        name: "gate",
        "submit:before"() {
          return false;
        },
      },
      {
        name: "later",
        "submit:before"() {
          laterRan = true;
        },
      },
    ]);
    const r = await host.apply("submit:before", [mkplan("huawei")], { cwd: "/tmp" });
    expect(r.blocked).toBe(true);
    expect(laterRan).toBe(false);
  });

  it("返回 void 透传原值", async () => {
    const host = new PluginHost([
      {
        name: "noop",
        "plan:before"() {
          /* 观察 */
        },
      },
    ]);
    const plans = [mkplan("oppo")];
    const r = await host.apply("plan:before", plans, { cwd: "/tmp" });
    expect(r.value).toBe(plans);
  });

  it("broadcast 顺序通知所有插件（含 async）", async () => {
    const order: string[] = [];
    const host = new PluginHost([
      {
        name: "a",
        async notify() {
          order.push("a");
        },
      },
      {
        name: "b",
        async notify() {
          order.push("b");
        },
      },
    ]);
    await host.broadcast("notify", { cwd: "/tmp" });
    expect(order).toEqual(["a", "b"]);
  });
});

describe("defineConfig / resolvePlugins", () => {
  it("工厂函数惰性求值，对象直接透传", () => {
    const objPlugin: AppliftPlugin = { name: "obj" };
    const cfg = defineConfig({ plugins: [objPlugin, () => ({ name: "factory" })] });
    const plugins = resolvePlugins(cfg);
    expect(plugins.map((p) => p.name)).toEqual(["obj", "factory"]);
  });

  it("无 plugins 返回空数组", () => {
    expect(resolvePlugins(defineConfig({}))).toEqual([]);
  });
});

describe("update:register（UpdateProvider 注册）", () => {
  it("插件注册 UpdateProvider，broadcast 收集到数组", async () => {
    const provider: UpdateProvider = {
      id: "rn-update",
      frameworks: ["rn"],
      judge: () => ({
        recommendation: "ota",
        confidence: "high",
        evidence: [],
      }),
      publishToTest: async () => ({ versionName: "", versionId: 0 }),
      promoteToProd: async () => ({ versionName: "" }),
    };
    const host = new PluginHost([
      {
        name: "p",
        "update:register"(providers) {
          providers.push(provider);
        },
      },
    ]);
    const providers: UpdateProvider[] = [];
    await host.broadcast("update:register", { cwd: "/tmp" }, providers);
    expect(providers).toEqual([provider]);
  });
});

describe("stage:after 广播（stage+submit 一体路径与 runStage 对称）", () => {
  it("runSubmit 内联 stage 成功 → 广播 stage:after 且 result 带 artifactPath（基线上传类插件的依赖）", async () => {
    const received: Array<{ channel: string; ok: boolean; artifactPath?: string }> = [];
    const host = new PluginHost([
      {
        name: "spy",
        "stage:after"(result) {
          received.push({
            channel: result.channel,
            ok: result.ok,
            artifactPath: result.artifactPath,
          });
        },
      },
    ]);
    const channel: Channel = {
      id: "spy-ch",
      label: "桩",
      capabilities: { stage: true, submit: true, scheduled: false, status: false },
      plan: async () => ({
        channel: "spy-ch",
        platform: "harmony",
        artifactVersion: "4.0.2",
        action: "stage+submit",
        afterApproval: "manual",
      }),
      stage: async () => ({ ok: true, ref: "r1" }),
      submit: async () => ({ ok: true }),
      status: async () => ({ state: "unknown" }),
    };
    const ctx = {
      channel,
      cwd: "/tmp",
      credentials: {},
      target: {},
      artifactPath: "/tmp/x.app",
      onEvent: () => {},
    } as unknown as ChannelContext;
    const summary = await runSubmit(
      {
        plugins: host,
        confirm: async () => true,
        channels: [channel],
        contexts: new Map([[channel.id, ctx]]),
        concurrency: 1,
        cwd: "/tmp",
      },
      { skipStage: false },
    );
    expect(summary.submit.every((s) => s.ok)).toBe(true);
    expect(received).toEqual([{ channel: "spy-ch", ok: true, artifactPath: "/tmp/x.app" }]);
  });
});
