// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UiClient, UiState, type ProjectSnapshot } from "./api.js";
import { PageCtxProvider, type PageCtx } from "./state.js";
import { ConfirmCard } from "./pages/Release.js";
import ProjectPage from "./pages/Project.js";
import SettingsPage from "./pages/Settings.js";
import AddProjectDialog from "./AddProjectDialog.js";
import type { HostAdapter } from "./host.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const host: HostAdapter = {
  notify: vi.fn(async () => true),
  pickDirectory: vi.fn(async () => null),
  setBadge: vi.fn(async () => {}),
};

function withCtx(ui: React.ReactElement, client: UiClient): React.ReactElement {
  const ctx: PageCtx = { client, navigate: vi.fn(), host };
  return <PageCtxProvider value={ctx}>{ui}</PageCtxProvider>;
}

const snap = (states: string[]): ProjectSnapshot => ({
  projectId: "p1",
  channels: states.map((state, i) => ({
    channel: `ch-${i}`,
    platform: "android",
    state,
    fetchedAt: new Date().toISOString(),
    reason: state === "rejected" ? `被拒原因-${i}` : undefined,
  })),
  fetchedAt: new Date().toISOString(),
  ok: true,
});

describe("Release 确认卡交互", () => {
  const confirm = {
    type: "confirm_required" as const,
    id: "delivery",
    question: "投递方式",
    choices: [
      { value: "ota", label: "热更（推荐：是）", recommended: true },
      { value: "native", label: "整包" },
    ],
  };

  it("待答态展示问题与选项，点击回传 choice value", () => {
    const onAnswer = vi.fn();
    const exec = { confirm, confirmAnswered: false, confirmValue: undefined };
    render(<ConfirmCard exec={exec as never} onAnswer={onAnswer} />);
    expect(screen.getByText("投递方式")).toBeTruthy();
    fireEvent.click(screen.getByText("热更（推荐：是）"));
    expect(onAnswer).toHaveBeenCalledWith("ota");
  });

  it("已答态回显用户点击项（而非推荐项）", () => {
    const exec = { confirm, confirmAnswered: true, confirmValue: "native" };
    render(<ConfirmCard exec={exec as never} onAnswer={vi.fn()} />);
    const card = document.getElementById("confirmCard")!;
    expect(card.textContent).toContain("已确认");
    expect(card.textContent).toContain("选择：整包");
  });
});

describe("Project 筛选与被拒展开", () => {
  const clientWith = (s: ProjectSnapshot): UiClient => {
    const state = new UiState();
    state.projects = [{ id: "p1", name: "demo", path: "/tmp/demo", addedAt: 0 }];
    state.snapshots.set("p1", s);
    return new UiClient({ state });
  };

  it("摘要卡筛选「被拒」仅留被拒行；重挂载（路由离开）筛选复位", () => {
    const client = clientWith(snap(["approved", "reviewing", "rejected"]));
    const { unmount } = render(withCtx(<ProjectPage id="p1" />, client));
    expect(screen.getByText("ch-0")).toBeTruthy(); // 全部：3 行
    expect(screen.getByText("ch-1")).toBeTruthy();

    fireEvent.click(document.querySelector('.sum-card[data-filter="err"]')!); // 摘要卡筛选
    expect(screen.queryByText("ch-0")).toBeNull();
    expect(screen.queryByText("ch-1")).toBeNull();
    expect(screen.getByText("ch-2")).toBeTruthy();

    unmount(); // 离开详情页 = 页面状态销毁
    render(withCtx(<ProjectPage id="p1" />, client));
    expect(screen.getByText("ch-0")).toBeTruthy(); // 筛选复位回「全部渠道」
  });

  it("被拒行点击展开原因", () => {
    const client = clientWith(snap(["rejected"]));
    render(withCtx(<ProjectPage id="p1" />, client));
    fireEvent.click(screen.getByText("ch-0"));
    expect(document.querySelector(".row.detail")!.textContent).toContain("被拒原因-0");
  });
});

describe("Settings 轮询 clamp", () => {
  it("前台档步长 1 到下界后 toast 护栏且值不再变", () => {
    const el = document.createElement("div");
    el.id = "toast";
    document.body.append(el);
    localStorage.setItem("applift-ui:settings", JSON.stringify({ fgMinutes: 5, bgMinutes: 60 }));
    const applyIntervals = vi.fn(async () => {});
    const client = { applyIntervals } as unknown as UiClient;
    const { rerender } = render(
      withCtx(<SettingsPage theme="auto" onThemeChange={vi.fn()} />, client),
    );
    const fg = document.querySelector('.stepper[data-key="fg"]')!;
    const minus = fg.querySelector('button[data-dir="-1"]')!;
    for (let i = 0; i < 4; i += 1) fireEvent.click(minus);
    expect(fg.querySelector(".val")!.textContent).toBe("1 分钟");

    fireEvent.click(minus); // 下界：clamp 提示 + 不再变化
    expect(el.textContent).toBe("已是最短间隔：1 分钟");
    expect(fg.querySelector(".val")!.textContent).toBe("1 分钟");
    expect(applyIntervals).toHaveBeenCalledTimes(4);
    rerender(withCtx(<SettingsPage theme="auto" onThemeChange={vi.fn()} />, client));
    el.remove();
  });

  it("后台档步长 15，5 → 60 → 15 复位", () => {
    const el = document.createElement("div");
    el.id = "toast";
    document.body.append(el);
    localStorage.setItem("applift-ui:settings", JSON.stringify({ fgMinutes: 5, bgMinutes: 60 }));
    const client = { applyIntervals: vi.fn(async () => {}) } as unknown as UiClient;
    render(withCtx(<SettingsPage theme="auto" onThemeChange={vi.fn()} />, client));
    const bg = document.querySelector('.stepper[data-key="bg"]')!;
    const minus = bg.querySelector('button[data-dir="-1"]')!;
    fireEvent.click(minus); // 60 → 45
    fireEvent.click(minus); // 45 → 30
    fireEvent.click(minus); // 30 → 15（下界）
    expect(bg.querySelector(".val")!.textContent).toBe("15 分钟");
    fireEvent.click(minus);
    expect(el.textContent).toBe("已是最短间隔：15 分钟");
    el.remove();
  });
});

describe("AddProjectDialog 双路径", () => {
  const HOST = { notify: vi.fn(), pickDirectory: vi.fn(async () => null), setBadge: vi.fn() };

  function fsClient(over: Partial<Record<"fsRoots" | "fsList" | "addProject", unknown>> = {}) {
    return {
      fsRoots: vi.fn(async () => [{ name: "主目录", path: "/tmp/home" }]),
      fsList: vi.fn(async (dir: string) =>
        dir === "/tmp/home"
          ? [
              { name: "plain", path: "/tmp/home/plain", hasConfig: false },
              { name: "proj", path: "/tmp/home/proj", hasConfig: true },
            ]
          : [],
      ),
      addProject: vi.fn(async () => ({ id: "p2", name: "proj", path: "/tmp/home/proj" })),
      ...over,
    } as unknown as UiClient;
  }

  it("浏览：roots 起始 → 子目录列表，applift 工程高亮 + 选择即 add", async () => {
    const client = fsClient();
    render(withCtx(<AddProjectDialog host={HOST} onClose={vi.fn()} />, client));
    await screen.findByText("📁 proj");
    const row = document.querySelector('.fs-row[data-name="proj"]')!;
    expect(row.querySelector(".fs-badge")!.textContent).toBe("applift 工程");
    fireEvent.click(row.querySelector("button[data-pick]")!);
    await waitFor(() => expect(client.addProject).toHaveBeenCalledWith("/tmp/home/proj"));
  });

  it("浏览：普通目录点击进入下一层（fsList 换目录）", async () => {
    const client = fsClient();
    render(withCtx(<AddProjectDialog host={HOST} onClose={vi.fn()} />, client));
    await screen.findByText("📁 plain");
    fireEvent.click(screen.getByText("📁 plain"));
    await waitFor(() => expect(client.fsList).toHaveBeenCalledWith("/tmp/home/plain"));
  });

  it("手输：切 tab → 输入路径 → 添加", async () => {
    const client = fsClient();
    render(withCtx(<AddProjectDialog host={HOST} onClose={vi.fn()} />, client));
    fireEvent.click(document.querySelector('button[data-tab="manual"]')!);
    const input = document.querySelector<HTMLInputElement>("#manualPath")!;
    fireEvent.change(input, { target: { value: "/tmp/home/proj" } });
    fireEvent.click(document.querySelector("#manualAdd")!);
    await waitFor(() => expect(client.addProject).toHaveBeenCalledWith("/tmp/home/proj"));
  });

  it("添加失败（validate 不通过）→ toast 报错且弹层不关", async () => {
    const toastEl = document.createElement("div");
    toastEl.id = "toast";
    document.body.append(toastEl);
    const client = fsClient({
      addProject: vi.fn(async () => {
        throw new Error("no applift.config.ts");
      }),
    });
    const onClose = vi.fn();
    render(withCtx(<AddProjectDialog host={HOST} onClose={onClose} />, client));
    fireEvent.click(document.querySelector('button[data-tab="manual"]')!);
    fireEvent.change(document.querySelector<HTMLInputElement>("#manualPath")!, {
      target: { value: "/tmp/bad" },
    });
    fireEvent.click(document.querySelector("#manualAdd")!);
    await waitFor(() => expect(toastEl.textContent).toContain("no applift.config.ts"));
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector("#addProjectDlg")).not.toBeNull();
    toastEl.remove();
  });

  it("Tauri 环境：浏览 tab 变原生选择器，pickDirectory 结果直达 add", async () => {
    const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: unknown } };
    w.__TAURI_INTERNALS__ = { invoke: vi.fn(async () => true) };
    try {
      const host = { ...HOST, pickDirectory: vi.fn(async () => "/Users/x/proj") };
      const client = fsClient();
      render(withCtx(<AddProjectDialog host={host as never} onClose={vi.fn()} />, client));
      // webui 目录浏览器被收起（无 fsRoots 消费）
      expect(document.querySelector("#fsRoots")).toBeNull();
      fireEvent.click(document.querySelector("#nativePick")!);
      await waitFor(() => expect(client.addProject).toHaveBeenCalledWith("/Users/x/proj"));
    } finally {
      delete w.__TAURI_INTERNALS__;
    }
  });
});
