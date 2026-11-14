import { UiClient } from "./api.js";
import { renderOverview, resetOverviewPageState, type PageCtx } from "./pages/overview.js";
import { renderProject, resetProjectPageState } from "./pages/project.js";
import { renderRelease, resetReleasePageState } from "./pages/release.js";
import { renderSettings } from "./pages/settings.js";
import { applyTheme, loadSettings, saveSettings, toast } from "./util.js";
const TITLES: Record<string, string> = {
  overview: "总览",
  project: "项目详情",
  release: "发版",
  settings: "通用设置",
};

interface Route {
  page: "overview" | "project" | "release" | "settings";
  id?: string;
}

function parseRoute(hash: string): Route {
  const m = /^#\/project\/([^/]+)$/.exec(hash);
  if (m !== null) {
    let id = "";
    try {
      id = decodeURIComponent(m[1] ?? "");
    } catch {
      id = "";
    }
    if (id !== "") return { page: "project", id };
  }
  if (hash === "#/release") return { page: "release" };
  if (hash === "#/settings") return { page: "settings" };
  return { page: "overview" };
}

const SUN_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/></svg>`;
const NAV_SVG = {
  overview:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  release:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};

async function main(): Promise<void> {
  const settings = loadSettings();
  applyTheme(settings.theme);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (loadSettings().theme === "auto") applyTheme("auto");
  });

  const client = new UiClient();
  const app = document.getElementById("app")!;
  app.innerHTML = `
    <div class="window">
      <div class="titlebar">
        <div class="traffic"><span class="r"></span><span class="y"></span><span class="g"></span></div>
        <div class="title" id="winTitle">总览</div>
        <button class="icon-btn" id="themeBtn" title="切换外观" aria-label="切换深浅外观">${SUN_SVG}</button>
      </div>
      <div class="body">
        <nav class="sidebar" aria-label="主导航">
          <button class="nav-item" data-nav="overview">${NAV_SVG.overview}<span class="lbl">总览</span><span class="nav-badge" id="unreadBadge" hidden></span></button>
          <button class="nav-item" data-nav="release">${NAV_SVG.release}<span class="lbl">发版</span></button>
          <button class="nav-item" data-nav="settings">${NAV_SVG.settings}<span class="lbl">通用设置</span></button>
        </nav>
        <main class="content" id="content"></main>
      </div>
    </div>`;

  const content = document.getElementById("content")!;
  const ctx: PageCtx = {
    client,
    navigate: (hash: string) => {
      location.hash = hash;
    },
  };

  const render = (): void => {
    const route = parseRoute(location.hash);
    document.getElementById("winTitle")!.textContent = TITLES[route.page] ?? "applift";
    app.querySelectorAll(".nav-item").forEach((n) => {
      const nav = (n as HTMLElement).dataset.nav;
      n.classList.toggle(
        "active",
        nav === route.page || (nav === "overview" && route.page === "project"),
      );
    });
    if (route.page !== "project") resetProjectPageState();
    if (route.page !== "overview" && route.page !== "project") resetOverviewPageState();
    if (route.page !== "release") resetReleasePageState();
    const next =
      route.page === "project"
        ? renderProject(ctx, route.id ?? "")
        : route.page === "release"
          ? renderRelease(ctx)
          : route.page === "settings"
            ? renderSettings(ctx)
            : renderOverview(ctx);
    // 同标记不替换：WS 事件高频重渲会不断 detach DOM，点击类交互落空
    const current = content.firstElementChild;
    if (current === null || current.outerHTML !== next.outerHTML) content.replaceChildren(next);
    updateBadge();
  };

  const updateBadge = (): void => {
    const badge = document.getElementById("unreadBadge");
    if (badge === null) return;
    const lastRead = Number(localStorage.getItem("applift-ui:feedRead") ?? "0");
    const unread = client.state.feed.filter((e) => e.ts > lastRead).length;
    badge.hidden = unread === 0;
    badge.textContent = unread > 9 ? "9+" : String(unread);
    if (parseRoute(location.hash).page === "overview") {
      localStorage.setItem("applift-ui:feedRead", String(Date.now()));
    }
  };

  window.addEventListener("hashchange", render);
  app.querySelector(".sidebar")?.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest(".nav-item") as HTMLElement | null;
    if (item === null) return;
    const nav = item.dataset.nav;
    ctx.navigate(`#/${nav}`);
  });
  document.getElementById("themeBtn")?.addEventListener("click", () => {
    const s = loadSettings();
    s.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    saveSettings(s);
    applyTheme(s.theme);
    // 设置页分段控件同步
    content.querySelectorAll(".seg[data-th]").forEach((seg) => {
      seg.classList.toggle("active", (seg as HTMLElement).dataset.th === s.theme);
    });
  });

  client.subscribe(render);
  render(); // 首帧（加载态）先上屏，避免 REST/WS 慢时空白
  await client.start().catch((err: unknown) => {
    toast(`连接服务失败：${err instanceof Error ? err.message : String(err)}`);
  });
  // 首次数据到达时间线头部显示「刚刚」——每 30s 轻刷相对时间
  window.setInterval(render, 30_000);
}

void main();
