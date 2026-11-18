// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UiClient, UiState, type ProjectSnapshot } from "./api.js";
import { PageCtxProvider, type PageCtx } from "./state.js";
import { ConfirmCard } from "./pages/Release.js";
import ProjectPage from "./pages/Project.js";
import SettingsPage from "./pages/Settings.js";
import InstallBlock from "./InstallBlock.js";
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
  isWindowVisible: () => true,
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
    const client = { applyIntervals, availability: vi.fn(async () => null) } as unknown as UiClient;
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
    const client = {
      applyIntervals: vi.fn(async () => {}),
      availability: vi.fn(async () => null),
    } as unknown as UiClient;
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

describe("AddProjectDialog 目录浏览器（webui）", () => {
  const HOST = {
    notify: vi.fn(),
    pickDirectory: vi.fn(async () => null),
    setBadge: vi.fn(),
    isWindowVisible: () => true,
  };

  function fsClient(
    over: Partial<Record<"fsRoots" | "fsList" | "addProject" | "availability", unknown>> = {},
  ) {
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
    render(withCtx(<AddProjectDialog onClose={vi.fn()} />, client));
    await screen.findByText("📁 proj");
    const row = document.querySelector('.fs-row[data-name="proj"]')!;
    expect(row.querySelector(".fs-badge")!.textContent).toBe("applift 工程");
    fireEvent.click(row.querySelector("button[data-pick]")!);
    await waitFor(() => expect(client.addProject).toHaveBeenCalledWith("/tmp/home/proj"));
  });

  it("浏览：普通目录点击进入下一层（fsList 换目录）", async () => {
    const client = fsClient();
    render(withCtx(<AddProjectDialog onClose={vi.fn()} />, client));
    await screen.findByText("📁 plain");
    fireEvent.click(screen.getByText("📁 plain"));
    await waitFor(() => expect(client.fsList).toHaveBeenCalledWith("/tmp/home/plain"));
  });

  it("添加失败（validate 不通过）→ toast 报错且弹层不关", async () => {
    const toastEl = document.createElement("div");
    toastEl.id = "toast";
    document.body.append(toastEl);
    const client = fsClient({
      addProject: vi.fn(async () => {
        throw new Error("no applift.config.ts");
      }),
      availability: vi.fn(async () => ({
        nodeVersion: "v22.0.0",
        nodeOk: true,
        sources: [{ kind: "global", path: "/usr/local/bin/applift", version: "0.14.0" }],
        latest: null,
      })),
    });
    const onClose = vi.fn();
    render(withCtx(<AddProjectDialog onClose={onClose} />, client));
    // 浏览器点选 applift 工程的「选择」按钮 → add 失败
    await screen.findByText("📁 proj");
    fireEvent.click(document.querySelector('.fs-row[data-name="proj"] .fs-pick')!);
    await waitFor(() => expect(toastEl.textContent).toContain("no applift.config.ts"));
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector("#addProjectDlg")).not.toBeNull();
    toastEl.remove();
  });
});

describe("AddProjectDialog 加固（错误态/重试/竞态）", () => {
  const HOST = {
    notify: vi.fn(),
    pickDirectory: vi.fn(async () => null),
    setBadge: vi.fn(),
    isWindowVisible: () => true,
  };

  it("fsList 失败 → 错误态 + 重试再拉", async () => {
    const client = {
      fsRoots: vi.fn(async () => [{ name: "主目录", path: "/tmp/home" }]),
      fsList: vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValue([]),
      addProject: vi.fn(),
    } as unknown as UiClient;
    render(withCtx(<AddProjectDialog onClose={vi.fn()} />, client));
    await waitFor(() =>
      expect(document.querySelector("#fsList")!.textContent).toContain("目录读取失败：boom"),
    );
    fireEvent.click(document.querySelector("#fsList .btn")!);
    await waitFor(() => expect(client.fsList).toHaveBeenCalledTimes(2));
  });

  it("fsRoots 失败 → 起始根错误态 + 重试", async () => {
    const client = {
      fsRoots: vi.fn().mockRejectedValueOnce(new Error("root down")).mockResolvedValue([]),
      fsList: vi.fn(),
      addProject: vi.fn(),
    } as unknown as UiClient;
    render(withCtx(<AddProjectDialog onClose={vi.fn()} />, client));
    await waitFor(() =>
      expect(document.querySelector("#rootsError")!.textContent).toContain("root down"),
    );
    fireEvent.click(document.querySelector("#rootsError .btn")!);
    await waitFor(() => expect(client.fsRoots).toHaveBeenCalledTimes(2));
  });

  it("目录快速切换竞态：迟到旧响应不覆盖新目录结果", async () => {
    const home = Promise.withResolvers<Array<{ name: string; path: string; hasConfig: boolean }>>();
    const subdir =
      Promise.withResolvers<Array<{ name: string; path: string; hasConfig: boolean }>>();
    const client = {
      fsRoots: vi.fn(async () => [{ name: "主目录", path: "/tmp/home" }]),
      // /tmp/home 两次请求复用同一（已 resolve 的）promise；子目录请求挂起
      fsList: vi.fn((dir: string) => (dir === "/tmp/home" ? home.promise : subdir.promise)),
      addProject: vi.fn(),
    } as unknown as UiClient;
    render(withCtx(<AddProjectDialog onClose={vi.fn()} />, client));
    home.resolve([{ name: "plain", path: "/tmp/home/plain", hasConfig: false }]);
    await screen.findByText("📁 plain");
    fireEvent.click(screen.getByText("📁 plain")); // /tmp/home/plain（seq 2，挂起）
    // 面包屑跳回 /tmp/home（seq 3，复用已解 promise 立即应用）
    fireEvent.click(document.querySelectorAll("#fsCrumb button")[1]!);
    await screen.findByText("📁 plain");
    subdir.resolve([]); // seq 2 迟到——不得覆盖 seq 3 的结果
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector("#fsList")!.textContent).toContain("📁 plain");
    expect(client.fsList).toHaveBeenCalledTimes(3);
  });
});

describe("引导安装块（InstallBlock 三态 + 添加项目联动）", () => {
  const HOST = {
    notify: vi.fn(),
    pickDirectory: vi.fn(async () => null),
    setBadge: vi.fn(),
    isWindowVisible: () => true,
  };

  /** 可控安装桩客户端：installApplift 返回固定 taskId，emitTask/emitEnd 手推事件 */
  function installClient(extra: Record<string, unknown> = {}) {
    const taskFns = new Set<(ev: Record<string, unknown>) => void>();
    const endFns = new Set<(tid: string, code: number) => void>();
    return {
      installApplift: vi.fn(async () => "install:t1"),
      onInstallTask: vi.fn((fn: (ev: Record<string, unknown>) => void) => {
        taskFns.add(fn);
        return () => taskFns.delete(fn);
      }),
      onTaskEnd: vi.fn((fn: (tid: string, code: number) => void) => {
        endFns.add(fn);
        return () => endFns.delete(fn);
      }),
      taskEndCode: vi.fn(() => undefined),
      emitTask: (ev: Record<string, unknown>) => {
        for (const fn of taskFns) fn(ev);
      },
      emitEnd: (code: number) => {
        for (const fn of endFns) fn("install:t1", code);
      },
      ...extra,
    } as unknown as UiClient & {
      emitTask: (e: Record<string, unknown>) => void;
      emitEnd: (c: number) => void;
    };
  }

  it("三态：ready 发起 → running 日志滚动 → 成功回 ready 并回调 onDone(true)", async () => {
    const client = installClient();
    const onDone = vi.fn();
    render(<InstallBlock client={client} label="安装到全局" onDone={onDone} />);
    const block = document.querySelector("#installBlock")!;
    expect(block.getAttribute("data-install")).toBe("ready");

    fireEvent.click(document.querySelector("#installBtn")!);
    expect(block.getAttribute("data-install")).toBe("running");
    expect(client.installApplift).toHaveBeenCalledWith(false);

    client.emitTask({ type: "install.log", level: "info", msg: "added 1 package" });
    await waitFor(() =>
      expect(document.querySelector("#installLog")!.textContent).toContain("added 1 package"),
    );
    client.emitTask({ type: "install.result", ok: true, code: 0 });
    client.emitEnd(0);
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(true));
    expect(block.getAttribute("data-install")).toBe("ready");
  });

  it("失败态：exit≠0 → failed 可重试，重试再走一轮发起", async () => {
    const client = installClient();
    render(<InstallBlock client={client} label="安装到全局" onDone={vi.fn()} />);
    fireEvent.click(document.querySelector("#installBtn")!);
    await waitFor(() => expect(client.installApplift).toHaveBeenCalled());
    client.emitTask({ type: "install.result", ok: false, code: 1 });
    client.emitEnd(1);
    const block = document.querySelector("#installBlock")!;
    await waitFor(() => expect(block.getAttribute("data-install")).toBe("failed"));
    expect(screen.getByText("安装失败，可重试")).toBeTruthy();

    fireEvent.click(screen.getByText("重试"));
    await waitFor(() => expect(client.installApplift).toHaveBeenCalledTimes(2));
    expect(block.getAttribute("data-install")).toBe("running");
  });

  it("添加失败且 sources 全空 → 未检测到 applift 块；安装成功自动重试 add", async () => {
    const client = installClient({
      fsRoots: vi.fn(async () => [{ name: "主目录", path: "/tmp" }]),
      fsList: vi.fn(async () => [{ name: "proj", path: "/tmp/proj", hasConfig: true }]),
      addProject: vi.fn().mockRejectedValueOnce(new Error("applift 不可用")).mockResolvedValueOnce({
        id: "p9",
        name: "proj",
        path: "/tmp/proj",
      }),
      availability: vi.fn(async () => ({
        nodeVersion: "v18.0.0",
        nodeOk: false,
        sources: [],
        latest: null,
      })),
    });
    render(withCtx(<AddProjectDialog onClose={vi.fn()} />, client));
    // 浏览器点选触发 add（fsList 返回一个 applift 工程）
    await screen.findByText("📁 proj");
    fireEvent.click(document.querySelector('.fs-row[data-name="proj"] .fs-pick')!);

    const hint = await waitFor(() => {
      const el = document.querySelector("#installHint");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(hint.textContent).toContain("未检测到 applift");
    expect(hint.textContent).toContain("v18.0.0");
    expect(hint.textContent).toContain("Node ≥ 20");

    fireEvent.click(document.querySelector("#installBtn")!);
    await waitFor(() => expect(client.installApplift).toHaveBeenCalled());
    client.emitTask({ type: "install.result", ok: true, code: 0 });
    client.emitEnd(0);
    // 安装成功 → 自动重试 validate（第二次 add 成功）
    await waitFor(() => expect(client.addProject).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(client.availability).toHaveBeenCalledTimes(1));
  });
});
