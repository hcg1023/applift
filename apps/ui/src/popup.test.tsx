// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  UiClient,
  UiState,
  type ChannelSnapshot,
  type FeedEvent,
  type ProjectSnapshot,
} from "./api.js";
import type { TauriInvoke } from "./host.tauri.js";
import { PageCtxProvider, type PageCtx } from "./state.js";
import PopupPage from "./pages/Popup.js";
import type { HostAdapter } from "./host.js";
import { markFeedReadIfVisible } from "./util.js";

/** jsdom window 无 __TAURI_INTERNALS__ 的 DOM 类型：命名常量承载壳注入面（非内联断言） */
function setTauriInternals(invoke?: TauriInvoke): void {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  if (invoke === undefined) {
    delete w.__TAURI_INTERNALS__;
  } else {
    w.__TAURI_INTERNALS__ = { invoke };
  }
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  setTauriInternals(undefined);
});

const host: HostAdapter = {
  notify: vi.fn(async () => true),
  pickDirectory: vi.fn(async () => null),
  setBadge: vi.fn(async () => {}),
  isWindowVisible: () => true,
};

const navigate = vi.fn();

function withCtx(client: UiClient): React.ReactElement {
  const ctx: PageCtx = { client, navigate, host };
  return (
    <PageCtxProvider value={ctx}>
      <PopupPage />
    </PageCtxProvider>
  );
}

const chans = (states: string[]): ChannelSnapshot[] =>
  states.map((state, i) => ({
    channel: `ch-${i}`,
    platform: "android",
    state,
    fetchedAt: new Date().toISOString(),
  }));

const snap = (projectId: string, states: string[], ok = true): ProjectSnapshot => ({
  projectId,
  channels: chans(states),
  fetchedAt: new Date().toISOString(),
  ok,
});

const feedEv = (id: string, projectId: string, ts = Date.now()): FeedEvent => ({
  id,
  ts,
  projectId,
  channel: "xiaomi",
  kind: "state_change",
  from: "reviewing",
  to: "approved",
});

function clientWith(projects: Array<{ id: string; name: string }>): UiClient {
  const state = new UiState();
  state.projects = projects.map((p, i) => ({
    id: p.id,
    name: p.name,
    path: `/tmp/${p.id}`,
    addedAt: i,
  }));
  return new UiClient({ state });
}

describe("Popup 项目概览行", () => {
  it("渲染状态计数与最新动态；异常行高亮", () => {
    const client = clientWith([
      { id: "p1", name: "alpha" },
      { id: "p2", name: "beta" },
    ]);
    client.state.snapshots.set("p1", snap("p1", ["approved", "approved", "reviewing"]));
    client.state.snapshots.set("p2", snap("p2", ["rejected"]));
    client.state.apply({ t: "feed", data: feedEv("e1", "p1") });
    render(withCtx(client));

    const row1 = document.querySelector('.pp-row[data-id="p1"]')!;
    expect(row1.querySelector(".pp-name")!.textContent).toBe("alpha");
    expect(row1.querySelector(".pp-counts .c-ok")!.textContent).toBe("2");
    expect(row1.querySelector(".pp-counts .c-wait")!.textContent).toBe("1");
    expect(row1.querySelector(".pp-counts .c-err")).toBeNull();
    expect(row1.querySelector(".pp-latest")!.textContent).toContain("xiaomi 审核中 → 已上架");
    expect(row1.classList.contains("anomaly")).toBe(false);

    const row2 = document.querySelector('.pp-row[data-id="p2"]')!;
    expect(row2.querySelector(".pp-counts .c-err")!.textContent).toBe("1");
    expect(row2.classList.contains("anomaly")).toBe(true); // 被拒渠道存在 → 异常高亮
    expect(document.querySelector(".pp-title .sub")!.textContent).toBe("1 个渠道被拒");
  });

  it("不可用项目：灰化行 + 点击只提示不唤起", () => {
    const client = clientWith([{ id: "p1", name: "dead" }]);
    client.state.snapshots.set("p1", snap("p1", [], false));
    const el = document.createElement("div");
    el.id = "toast";
    document.body.append(el);
    render(withCtx(client));

    const row = document.querySelector('.pp-row[data-id="p1"]')!;
    expect(row.classList.contains("unavailable")).toBe(true);
    expect(row.querySelector(".pp-state")!.textContent).toBe("不可用");
    fireEvent.click(row);
    expect(navigate).not.toHaveBeenCalled();
    expect(el.textContent).toBe("按提示修复后点「重新检查」");
    el.remove();
  });

  it("未连接且无项目：加载态（转圈，不误报空态）", () => {
    render(withCtx(clientWith([])));
    expect(screen.getByText("正在获取项目与渠道状态…")).toBeTruthy();
  });

  it("已连接仍无项目：空态引导（M5）", async () => {
    // 假传输：建立即投递一条合法下行消息 → connectionState=connected（REST 失败不影响判定）
    const client = new UiClient({
      state: new UiState(),
      fetchImpl: (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch,
      socketFactory: (_url, onMessage) => {
        onMessage('{"t":"tasks","data":[]}');
        return { send: () => {}, close: () => {} };
      },
    });
    await client.start().catch(() => {});
    render(withCtx(client));
    expect(client.connectionState).toBe("connected");
    expect(screen.getByText(/还没有项目。到主窗口/)).toBeTruthy();
    expect(screen.queryByText("正在获取项目与渠道状态…")).toBeNull();
    client.stop();
  });
});

describe("在屏已读判定（C1：隐藏存活窗口不清未读）", () => {
  it("hidden 不写 feedRead；visible 且 overview/popup 才写", () => {
    localStorage.setItem("applift-ui:feedRead", "100");
    expect(markFeedReadIfVisible("overview", "hidden")).toBe(false);
    expect(markFeedReadIfVisible("popup", "hidden")).toBe(false);
    expect(localStorage.getItem("applift-ui:feedRead")).toBe("100"); // 未写入
    expect(markFeedReadIfVisible("project", "visible")).toBe(false);
    expect(markFeedReadIfVisible("overview", "visible")).toBe(true);
    expect(markFeedReadIfVisible("popup", "visible")).toBe(true);
    expect(localStorage.getItem("applift-ui:feedRead")).not.toBe("100"); // 已写入
  });
});

describe("Popup 唤起主窗（open_main）", () => {
  it("Tauri 壳：行点击与快捷入口经 invoke open_main 带 route", () => {
    const invoke = vi.fn(async () => undefined);
    setTauriInternals(invoke);
    const client = clientWith([{ id: "p1", name: "alpha" }]);
    client.state.snapshots.set("p1", snap("p1", ["approved"]));

    render(withCtx(client));
    fireEvent.click(document.querySelector('.pp-row[data-id="p1"]')!);
    expect(invoke).toHaveBeenCalledWith("open_main", { route: "#/project/p1" });
    expect(navigate).not.toHaveBeenCalled();

    fireEvent.click(document.querySelector('.pp-act[data-act="release"]')!);
    expect(invoke).toHaveBeenLastCalledWith("open_main", { route: "#/release" });
    fireEvent.click(document.querySelector('.pp-act[data-act="overview"]')!);
    expect(invoke).toHaveBeenLastCalledWith("open_main", { route: "#/overview" });
  });

  it("webui 直开（无壳注入）：降级同窗 hash 跳转", () => {
    const client = clientWith([{ id: "p1", name: "alpha" }]);
    client.state.snapshots.set("p1", snap("p1", ["approved"]));
    render(withCtx(client));

    fireEvent.click(document.querySelector('.pp-row[data-id="p1"]')!);
    expect(navigate).toHaveBeenCalledWith("#/project/p1");
    fireEvent.click(document.querySelector('.pp-act[data-act="release"]')!);
    expect(navigate).toHaveBeenCalledWith("#/release");
  });
});
