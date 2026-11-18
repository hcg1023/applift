import { describe, expect, it } from "vitest";
import { createWebuiHost } from "./host.js";

/** Notification 替身：permission 可控、构造记录、requestPermission 可注入 */
function fakeNotification(
  permission: NotificationPermission,
  requestResult?: NotificationPermission | Error,
): {
  Ctor: typeof Notification;
  shown: Array<{ title: string; body: string }>;
  requests: number;
} {
  const shown: Array<{ title: string; body: string }> = [];
  const requests = { n: 0 };
  const Ctor = class {
    static permission: NotificationPermission = permission;
    static requestPermission(): Promise<NotificationPermission> {
      requests.n += 1;
      if (requestResult instanceof Error) return Promise.reject(requestResult);
      return Promise.resolve(requestResult ?? permission);
    }
    constructor(title: string, opts?: NotificationOptions) {
      shown.push({ title, body: opts?.body ?? "" });
    }
  } as unknown as typeof Notification;
  return {
    Ctor,
    shown,
    get requests() {
      return requests.n;
    },
  };
}

describe("webuiHost.notify", () => {
  it("已授权：送达并返回 true", async () => {
    const f = fakeNotification("granted");
    const host = createWebuiHost({ Notification: f.Ctor });
    await expect(host.notify("状态变化", "华为 已上架")).resolves.toBe(true);
    expect(f.shown).toEqual([{ title: "状态变化", body: "华为 已上架" }]);
    expect(f.requests).toBe(0);
  });

  it("授权拒绝（denied）：不请求不送达，返回 false（降级未读列表）", async () => {
    const f = fakeNotification("denied");
    const host = createWebuiHost({ Notification: f.Ctor });
    await expect(host.notify("t", "b")).resolves.toBe(false);
    expect(f.shown).toHaveLength(0);
    expect(f.requests).toBe(0);
  });

  it("未决定（default）：发起请求且当次授予 → 送达返回 true", async () => {
    const f = fakeNotification("default", "granted");
    const host = createWebuiHost({ Notification: f.Ctor });
    await expect(host.notify("t", "b")).resolves.toBe(true);
    expect(f.requests).toBe(1);
    expect(f.shown).toHaveLength(1);
  });

  it("未决定（default）：请求被拒 → 返回 false", async () => {
    const f = fakeNotification("default", "denied");
    const host = createWebuiHost({ Notification: f.Ctor });
    await expect(host.notify("t", "b")).resolves.toBe(false);
    expect(f.shown).toHaveLength(0);
  });

  it("请求抛错（宿主限制）→ 返回 false 不冒泡", async () => {
    const f = fakeNotification("default", new Error("not allowed"));
    const host = createWebuiHost({ Notification: f.Ctor });
    await expect(host.notify("t", "b")).resolves.toBe(false);
  });

  it("Notification API 不存在 → 返回 false", async () => {
    const host = createWebuiHost({ Notification: undefined });
    await expect(host.notify("t", "b")).resolves.toBe(false);
  });
});

describe("webuiHost.pickDirectory / setBadge", () => {
  it("pickDirectory 恒 null（webui 无原生选择器）", async () => {
    const host = createWebuiHost({ Notification: undefined });
    await expect(host.pickDirectory()).resolves.toBeNull();
  });

  it("setBadge no-op 不抛错", async () => {
    const host = createWebuiHost({ Notification: undefined });
    await expect(host.setBadge(3)).resolves.toBeUndefined();
    await expect(host.setBadge(0)).resolves.toBeUndefined();
  });
});

describe("接口形状", () => {
  it("三个方法齐备（HostAdapter 契约）", () => {
    const host = createWebuiHost({ Notification: undefined });
    expect(typeof host.notify).toBe("function");
    expect(typeof host.pickDirectory).toBe("function");
    expect(typeof host.setBadge).toBe("function");
  });

  it("构造器调用无副作用", () => {
    expect(() => createWebuiHost()).not.toThrow();
  });
});
