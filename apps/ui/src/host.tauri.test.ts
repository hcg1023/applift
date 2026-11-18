import { describe, expect, it, vi } from "vitest";
import type { TauriInvoke } from "./host.tauri.js";
import { createTauriHost, isTauriEnv, tauriInvoke } from "./host.tauri.js";
import { pickHost, webuiHost } from "./host.js";

/** 按命令名分发的 invoke 替身（记录调用） */
function fakeInvoke(map: Record<string, unknown | ((args?: Record<string, unknown>) => unknown)>): {
  invoke: TauriInvoke;
  calls: Array<{ cmd: string; args?: Record<string, unknown> }>;
} {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const invoke: TauriInvoke = async (cmd, args) => {
    calls.push({ cmd, args });
    const impl = map[cmd];
    if (typeof impl === "function") return impl(args);
    if (impl === undefined) throw new Error(`no stub for ${cmd}`);
    return impl;
  };
  return { invoke, calls };
}

describe("tauriInvoke / isTauriEnv 探测", () => {
  it("无 __TAURI_INTERNALS__ → null / false（浏览器环境）", () => {
    expect(tauriInvoke({} as { __TAURI_INTERNALS__?: never })).toBeNull();
    expect(isTauriEnv()).toBe(false); // node 测试环境无 window
  });

  it("带 invoke 的 __TAURI_INTERNALS__ → 取到 invoke 面", async () => {
    const invoke = vi.fn(async () => null);
    expect(tauriInvoke({ __TAURI_INTERNALS__: { invoke } })).toBe(invoke);
  });

  it("internals 存在但无 invoke 函数 → null（防御半初始化宿主）", () => {
    expect(tauriInvoke({ __TAURI_INTERNALS__: {} })).toBeNull();
  });
});

describe("pickHost 分支", () => {
  it("浏览器（无 internals）→ webuiHost 单例", () => {
    expect(pickHost()).toBe(webuiHost);
  });

  it("Tauri 环境（window.__TAURI_INTERNALS__ 带 invoke）→ 非 webui 实现", async () => {
    const g = globalThis as { window?: unknown };
    const prevWindow = g.window;
    const { invoke } = fakeInvoke({ "plugin:dialog|open": "/tmp/x" });
    g.window = { __TAURI_INTERNALS__: { invoke } };
    try {
      const host = pickHost();
      expect(host).not.toBe(webuiHost);
      await expect(host.pickDirectory()).resolves.toBe("/tmp/x");
    } finally {
      g.window = prevWindow;
    }
  });
});

describe("createTauriHost.notify", () => {
  it("已授权 → 直接 notify 并返回 true", async () => {
    const { invoke, calls } = fakeInvoke({
      "plugin:notification|is-permission-granted": true,
      "plugin:notification|notify": null,
    });
    const host = createTauriHost(invoke);
    await expect(host.notify("t", "b")).resolves.toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual([
      "plugin:notification|is-permission-granted",
      "plugin:notification|notify",
    ]);
    expect(calls[1]!.args).toEqual({ options: { title: "t", body: "b" } });
  });

  it("未授权 → request-permission 授予后送达", async () => {
    const { invoke } = fakeInvoke({
      "plugin:notification|is-permission-granted": false,
      "plugin:notification|request-permission": "granted",
      "plugin:notification|notify": null,
    });
    await expect(createTauriHost(invoke).notify("t", "b")).resolves.toBe(true);
  });

  it("请求被拒 → false（降级未读列表）", async () => {
    const { invoke } = fakeInvoke({
      "plugin:notification|is-permission-granted": false,
      "plugin:notification|request-permission": "denied",
    });
    await expect(createTauriHost(invoke).notify("t", "b")).resolves.toBe(false);
  });

  it("invoke 抛错（插件缺席）→ false 不冒泡", async () => {
    const invoke: TauriInvoke = async () => {
      throw new Error("plugin missing");
    };
    await expect(createTauriHost(invoke).notify("t", "b")).resolves.toBe(false);
  });
});

describe("createTauriHost.pickDirectory", () => {
  it("返回目录路径字符串", async () => {
    const { invoke, calls } = fakeInvoke({ "plugin:dialog|open": "/Users/x/proj" });
    await expect(createTauriHost(invoke).pickDirectory()).resolves.toBe("/Users/x/proj");
    expect(calls[0]!.args).toEqual({ options: { directory: true } });
  });

  it("取消（null）/ 空串 / 非字符串（多选数组防御）→ null", async () => {
    for (const ret of [null, "", ["/a", "/b"], 42]) {
      const { invoke } = fakeInvoke({ "plugin:dialog|open": ret });
      await expect(createTauriHost(invoke).pickDirectory()).resolves.toBeNull();
    }
  });
});

describe("createTauriHost.setBadge", () => {
  it("透传壳命令 set_badge", async () => {
    const { invoke, calls } = fakeInvoke({ set_badge: null });
    await createTauriHost(invoke).setBadge(3);
    expect(calls).toEqual([{ cmd: "set_badge", args: { n: 3 } }]);
  });
});
