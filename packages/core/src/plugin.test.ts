import { describe, expect, it } from "vitest";
import {
  PluginHost,
  defineConfig,
  resolvePlugins,
  type QypubPlugin,
  type ReleasePlanEntry,
} from "./plugin.js";

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
    const objPlugin: QypubPlugin = { name: "obj" };
    const cfg = defineConfig({ plugins: [objPlugin, () => ({ name: "factory" })] });
    const plugins = resolvePlugins(cfg);
    expect(plugins.map((p) => p.name)).toEqual(["obj", "factory"]);
  });

  it("无 plugins 返回空数组", () => {
    expect(resolvePlugins(defineConfig({}))).toEqual([]);
  });
});
