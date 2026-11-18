import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import AddProjectDialog from "../AddProjectDialog.js";
import { classify, type HistoryEntry } from "../api.js";
import { freshness, iconStyle, relTime, toast } from "../util.js";
import { isTauriEnv } from "../host.tauri.js";
import { usePageCtx, useUiTick } from "../state.js";

function latestText(
  feed: Array<{ projectId: string; channel: string; from: string; to: string; ts: number }>,
  projectId: string,
): string {
  const ev = feed.find((e) => e.projectId === projectId);
  if (ev === undefined) return "暂无动态";
  return `${ev.channel} ${classify(ev.from).label} → ${classify(ev.to).label} · ${relTime(ev.ts)}`;
}

/** ⋯ 菜单弹出（portal 到 body；锚点 rect 定位，点击外部关闭） */
function ProjectMenu({
  anchor,
  onClose,
  onAction,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  onAction: (act: "recheck" | "remove") => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos] = useState(() => {
    const rect = anchor.getBoundingClientRect();
    return { left: rect.left, top: rect.bottom + 4 };
  });
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node) !== true) onClose();
    };
    document.addEventListener("click", close, true);
    return () => document.removeEventListener("click", close, true);
  }, [onClose]);
  return createPortal(
    <div ref={ref} className="ov-menu-pop" style={{ left: pos.left, top: pos.top }}>
      <button
        data-act="recheck"
        onClick={() => {
          onClose();
          onAction("recheck");
        }}
      >
        重新检查
      </button>
      <button
        data-act="remove"
        className="danger"
        onClick={() => {
          onClose();
          onAction("remove");
        }}
      >
        移除项目
      </button>
    </div>,
    document.body,
  );
}

interface CardCounts {
  ok: number;
  wait: number;
  err: number;
}

/** 状态徽章：被拒 > 审核中 > 全部正常 */
function StatusBadge({ c }: { c: CardCounts }) {
  if (c.err > 0)
    return (
      <span className="st c-err" style={{ fontSize: "11.5px" }}>
        <span className="dot d-err" />
        {c.err} 被拒
      </span>
    );
  if (c.wait > 0)
    return (
      <span className="st c-wait" style={{ fontSize: "11.5px" }}>
        <span className="dot d-wait" />
        {c.wait} 审核中
      </span>
    );
  if (c.ok > 0)
    return (
      <span className="st c-ok" style={{ fontSize: "11.5px" }}>
        <span className="dot d-ok" />
        全部正常
      </span>
    );
  return null;
}

/** 总览：项目卡网格 + 动态时间线（过滤 chips） */
export default function OverviewPage() {
  const { client, navigate, host } = usePageCtx();
  useUiTick();
  const [feedFilter, setFeedFilter] = useState("all");
  const [showAdd, setShowAdd] = useState(false);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; id: string; name: string } | null>(null);
  /** 添加项目：Tauri 壳一步直达系统目录对话框（选完即加，无中间弹窗）；webui 打开目录浏览器弹层 */
  const openAdd = (): void => {
    if (isTauriEnv()) {
      void (async () => {
        const picked = await host.pickDirectory();
        if (picked === null) return; // 取消
        try {
          await client.addProject(picked);
          toast(`项目已添加：${picked.split("/").pop() ?? picked}`);
        } catch (err) {
          toast(err instanceof Error ? err.message : String(err));
        }
      })();
      return;
    }
    setShowAdd(true);
  };
  // 侧栏「添加项目」事件信号（app.tsx dispatch；已挂载实时响应，无 sessionStorage/重挂载依赖）
  useEffect(() => {
    const open = (): void => setShowAdd(true);
    window.addEventListener("applift-ui:add-project", open);
    return () => window.removeEventListener("applift-ui:add-project", open);
  }, []);

  /** 项目发版历史（总览卡「内测/正式」计数与最近发版行）：懒拉一次，N 个项目并行 */
  const [histories, setHistories] = useState<Map<string, HistoryEntry[]>>(new Map());
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      client.state.projects.map(async (p) => [p.id, await client.projectHistory(p.id)] as const),
    )
      .then((pairs) => {
        if (cancelled) return;
        setHistories(new Map(pairs));
      })
      .catch(() => {}); // 历史拉取失败：计数行不渲染（详情页有完整降级文案）
    return () => {
      cancelled = true;
    };
  }, [client, client.state.projects.length]);

  const projects = client.state.projects;
  const hasSnapshot =
    projects.length > 0 && projects.every((p) => client.state.snapshot(p.id) !== undefined);
  const loading = projects.length === 0 && client.state.feed.length === 0;
  const anyUnavailable = hasSnapshot && projects.some((p) => client.state.unavailable(p.id));

  const onCardClick = (e: React.MouseEvent<HTMLDivElement>, id: string) => {
    if ((e.target as HTMLElement).closest(".ov-menu") !== null) return; // 菜单按钮单独处理
    if (client.state.unavailable(id)) {
      toast("按提示修复后点「重新检查」");
      return;
    }
    navigate(`#/project/${id}`);
  };

  const onMenuAction = async (act: "recheck" | "remove", id: string, name: string) => {
    if (act === "remove") {
      if (!window.confirm(`移除项目「${name}」？不影响工程文件，仅从监控列表删除。`)) return;
      try {
        await client.removeProject(id);
        toast(`已移除 ${name}`);
      } catch (err) {
        toast(`移除失败：${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      // 服务端真话：当前档位实际轮询间隔（前台/后台随连接态切换；连接后亦有即时刷新）
      try {
        const h = await client.health();
        const min = Math.max(1, Math.round((h.refreshIntervalMs ?? 300_000) / 60_000));
        toast(`状态由服务端自动刷新（当前每 ${min} 分钟一轮，页面打开/刷新即即时刷新）`);
      } catch {
        toast("状态由服务端自动刷新，页面打开/刷新即即时刷新");
      }
    }
  };

  const feedItems = client.state.feed
    .filter((e) => feedFilter === "all" || e.projectId === feedFilter)
    .map((e) => {
      const proj = projects.find((p) => p.id === e.projectId);
      const to = classify(e.to);
      return (
        <div
          key={e.id}
          className={`tl-item ${to.key === "ok" ? "ok" : to.key === "err" ? "err" : "info"}`}
          data-proj={e.projectId}
        >
          <div className="tl-time">
            {proj?.name ?? e.projectId} · {relTime(e.ts)}
          </div>
          <div className="tl-txt">
            <b>{e.channel}</b> {classify(e.from).label} → {to.label}
          </div>
        </div>
      );
    });

  return (
    <section className="page" id="page-overview">
      <h1>总览</h1>
      <p className="page-sub">所有项目的渠道状态与最新变化</p>
      {anyUnavailable ? (
        <div className="banner">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M12 9v4M12 17h.01" />
            <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
          </svg>
          <span>
            有项目状态查不到。在终端运行 <span className="cmd">applift doctor</span>{" "}
            排查后自动恢复。
          </span>
        </div>
      ) : null}
      <div className="ov-grid">
        {projects.map((p) => {
          const snap = client.state.snapshot(p.id);
          if (snap === undefined) {
            return (
              <div
                key={p.id}
                className="ov-card"
                data-id={p.id}
                onClick={(e) => onCardClick(e, p.id)}
              >
                <div className="ov-head">
                  <span className="proj-icon" style={{ background: iconStyle(p.name) }}>
                    {p.name.slice(0, 1)}
                  </span>
                  <div className="ov-name">{p.name}</div>
                </div>
                <div className="ov-counts">
                  <span className="oc">状态加载中…</span>
                </div>
              </div>
            );
          }
          if (!snap.ok) {
            return (
              <div
                key={p.id}
                className="ov-card unavailable"
                data-id={p.id}
                onClick={(e) => onCardClick(e, p.id)}
              >
                <div className="ov-head">
                  <span
                    className="proj-icon"
                    style={{ background: "linear-gradient(135deg,#8e8e93,#636366)" }}
                  >
                    {p.name.slice(0, 1)}
                  </span>
                  <div className="ov-name">{p.name}</div>
                  <span className="st c-off" style={{ fontSize: "11.5px" }}>
                    <span className="dot d-off" />
                    不可用
                  </span>
                </div>
                <div className="row-sub" style={{ margin: "10px 0 0" }}>
                  工程状态查不到{snap.error !== undefined && snap.error !== "" ? `：${snap.error}` : "（CLI 校验失败或依赖未安装）"}。
                </div>
              </div>
            );
          }
          const c = client.state.counts(p.id);
          const fresh = freshness(snap.fetchedAt);
          return (
            <div
              key={p.id}
              className="ov-card"
              data-id={p.id}
              onClick={(e) => onCardClick(e, p.id)}
            >
              <div className="ov-head">
                <span className="proj-icon" style={{ background: iconStyle(p.name) }}>
                  {p.name.slice(0, 1)}
                </span>
                <div className="ov-name">{p.name}</div>
                <StatusBadge c={c} />
                <button
                  className="ov-menu"
                  title="项目操作"
                  aria-label="项目操作"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenu({ anchor: e.currentTarget, id: p.id, name: p.name });
                  }}
                >
                  ⋯
                </button>
              </div>
              <div className="ov-counts">
                <span className="oc">
                  <b className="c-ok">{c.ok}</b>已上架
                </span>
                <span className="oc">
                  <b className="c-wait">{c.wait}</b>审核中
                </span>
                <span className="oc">
                  <b className="c-err">{c.err}</b>被拒
                </span>
              </div>
              {(() => {
                const h = histories.get(p.id);
                if (h === undefined || h.length === 0) return null;
                const betaN = h.filter((e) => e.phase === "beta").length;
                const relN = h.filter((e) => e.phase === "release").length;
                const last = h[0]!;
                const ph =
                  last.phase === "beta" ? "内测" : last.phase === "release" ? "正式" : "发版";
                return (
                  <div className="ov-hist">
                    <span className="oh-count">
                      <b className="c-blue">{betaN}</b>内测 · <b className="c-green">{relN}</b>正式
                    </span>
                    <span className="oh-last">
                      最近：{ph} {last.artifactVersion ?? ""}（{relTime(last.ts)}）
                    </span>
                  </div>
                );
              })()}
              <div className="ov-foot">
                <span className={`ov-fresh${fresh.warn ? " fresh-warn" : ""}`}>{fresh.text}</span>
              </div>
            </div>
          );
        })}
        <button className="ov-card add" id="addProject" onClick={openAdd}>
          <div className="ov-add-plus">＋</div>
          <div className="ov-add-txt">添加项目</div>
        </button>
      </div>
      <div className="ov-feed-head">
        <h2>动态</h2>
        <div className="seg-wrap" id="feedFilter" style={{ marginLeft: "auto" }}>
          <button
            className={`seg${feedFilter === "all" ? " active" : ""}`}
            data-pf="all"
            onClick={() => setFeedFilter("all")}
          >
            全部
          </button>
          {projects.map((p) => (
            <button
              key={p.id}
              className={`seg${feedFilter === p.id ? " active" : ""}`}
              data-pf={p.id}
              onClick={() => setFeedFilter(p.id)}
            >
              {p.name}
            </button>
          ))}
        </div>
      </div>
      {loading ? (
        <div className="state-box">
          <div className="spin" />
          正在获取项目与渠道状态…
        </div>
      ) : (
        <div className={`tl${feedItems.length === 0 ? " tl-empty" : ""}`} id="ovFeed">
          {feedItems.length > 0 ? (
            feedItems
          ) : (
            <div className="state-box" style={{ padding: "32px 24px" }}>
              <div className="big">—</div>
              <div>暂无动态；渠道状态发生变化会出现在这里</div>
            </div>
          )}
        </div>
      )}
      <p className="note">项目卡片点进去是渠道明细；动态默认显示全部项目，可按项目过滤。</p>
      {menu !== null ? (
        <ProjectMenu
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          onAction={(act) => void onMenuAction(act, menu.id, menu.name)}
        />
      ) : null}
      {showAdd ? <AddProjectDialog onClose={() => setShowAdd(false)} /> : null}
    </section>
  );
}
