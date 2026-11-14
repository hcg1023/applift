import { useEffect, useReducer, useRef, useState } from "react";
import { UiClient, classify } from "./api.js";
import { webuiHost } from "./host.js";
import { PageCtxProvider, type PageCtx } from "./state.js";
import OverviewPage from "./pages/Overview.js";
import ProjectPage from "./pages/Project.js";
import ReleasePage from "./pages/Release.js";
import SettingsPage from "./pages/Settings.js";
import { applyTheme, loadSettings, saveSettings, toast, type Settings } from "./util.js";

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

const SunIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
  </svg>
);

const NAV_ICONS: Record<string, React.ReactNode> = {
  overview: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  release: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5h0a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  ),
};

/** applift 窗口根组件：hash 路由 + 布局（titlebar/connBanner/sidebar）+ UiClient 生命周期 */
export default function App() {
  const [client] = useState(() => new UiClient());
  const [, tick] = useReducer((n: number) => n + 1, 0);
  const [hash, setHash] = useState(() => location.hash);
  const [theme, setThemeState] = useState<Settings["theme"]>(() => loadSettings().theme);
  /** 首连成功前不显示断连横幅——加载态与连接失败 toast 已覆盖 */
  const everConnected = useRef(false);
  /** 已系统通知过的 feed id（去重） */
  const notifiedFeedId = useRef("");

  const route = parseRoute(hash);

  useEffect(() => {
    const onHash = (): void => setHash(location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const setTheme = (t: Settings["theme"]): void => {
    const s = loadSettings();
    s.theme = t;
    saveSettings(s);
    applyTheme(t);
    setThemeState(t);
  };

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (): void => {
      if (loadSettings().theme === "auto") applyTheme("auto");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  /** 未读通知走 HostAdapter：系统通知失败降级未读列表（notifyState 开关控制） */
  const notifyUnread = (): void => {
    if (!loadSettings().notifyState) return;
    const lastRead = Number(localStorage.getItem("applift-ui:feedRead") ?? "0");
    const unread = client.state.feed.filter((e) => e.ts > lastRead);
    const ev = unread[0];
    if (ev === undefined || ev.id === notifiedFeedId.current) return;
    notifiedFeedId.current = ev.id;
    const proj = client.state.projects.find((p) => p.id === ev.projectId);
    void webuiHost.notify(
      "渠道状态变化",
      `${proj?.name ?? ev.projectId} · ${ev.channel} ${classify(ev.from).label} → ${classify(ev.to).label}`,
    );
  };

  useEffect(() => {
    const offSub = client.subscribe(() => {
      tick();
      notifyUnread(); // feed 事件到达即尝试系统通知（降级语义见 host.notify）
    });
    const offConn = client.onConnectionChange((s) => {
      if (s === "connected") {
        everConnected.current = true;
        notifyUnread();
      }
      tick();
    });
    return () => {
      offSub();
      offConn();
    };
  }, [client]);

  useEffect(() => {
    void client.start().catch((err: unknown) => {
      toast(`连接服务失败：${err instanceof Error ? err.message : String(err)}`);
    });
    // 首次数据到达时间线头部显示「刚刚」——每 30s 轻刷相对时间
    const timer = window.setInterval(tick, 30_000);
    return () => {
      clearInterval(timer);
      client.stop();
    };
  }, [client]);

  /** 未读角标：渲染期按 feedRead 计算；总览在屏即标记已读 */
  const lastRead = Number(localStorage.getItem("applift-ui:feedRead") ?? "0");
  const unread = client.state.feed.filter((e) => e.ts > lastRead).length;
  useEffect(() => {
    if (route.page === "overview") localStorage.setItem("applift-ui:feedRead", String(Date.now()));
  });

  /** 断连横幅/顶栏 pill：首连成功前不显示 */
  const off = everConnected.current && client.connectionState !== "connected";

  const navigate = (h: string): void => {
    location.hash = h;
  };
  const ctx: PageCtx = { client, navigate, host: webuiHost };

  return (
    <PageCtxProvider value={ctx}>
      <div className="window">
        <div className="titlebar">
          <div className="traffic">
            <span className="r" />
            <span className="y" />
            <span className="g" />
          </div>
          <div className="title" id="winTitle">
            {TITLES[route.page] ?? "applift"}
          </div>
          <span className="conn-pill" id="connPill" hidden={!off}>
            重连中…
          </span>
          <button
            className="icon-btn"
            id="themeBtn"
            title="切换外观"
            aria-label="切换深浅外观"
            onClick={() =>
              setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark")
            }
          >
            <SunIcon />
          </button>
        </div>
        <div className="conn-banner" id="connBanner" hidden={!off}>
          <span className="dot d-wait" />
          与本地服务的连接已断开，正在重连（服务重启或休眠后自动恢复；长时间未恢复可运行{" "}
          <span className="cmd">applift ui --stop</span> 后重新启动）。
        </div>
        <div className="body">
          <nav className="sidebar" aria-label="主导航">
            {(["overview", "release", "settings"] as const).map((nav) => (
              <button
                key={nav}
                className={`nav-item${nav === route.page || (nav === "overview" && route.page === "project") ? " active" : ""}`}
                data-nav={nav}
                onClick={() => navigate(`#/${nav}`)}
              >
                {NAV_ICONS[nav]}
                <span className="lbl">
                  {nav === "overview" ? "总览" : nav === "release" ? "发版" : "通用设置"}
                </span>
                {nav === "overview" ? (
                  <span className="nav-badge" id="unreadBadge" hidden={unread === 0}>
                    {unread > 9 ? "9+" : String(unread)}
                  </span>
                ) : null}
              </button>
            ))}
          </nav>
          <main className="content" id="content">
            {route.page === "project" ? (
              <ProjectPage key={route.id} id={route.id ?? ""} />
            ) : route.page === "release" ? (
              <ReleasePage />
            ) : route.page === "settings" ? (
              <SettingsPage theme={theme} onThemeChange={setTheme} />
            ) : (
              <OverviewPage />
            )}
          </main>
        </div>
      </div>
    </PageCtxProvider>
  );
}
