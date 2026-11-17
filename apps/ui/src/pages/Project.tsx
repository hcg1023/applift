import { useEffect, useState } from "react";
import { classify, type ChannelSnapshot, type HistoryEntry } from "../api.js";
import { freshness, relTime, toast } from "../util.js";
import { usePageCtx, useUiTick } from "../state.js";

const FILTERS: Array<{ key: string; label: string }> = [
  { key: "all", label: "全部渠道" },
  { key: "ok", label: "已上架" },
  { key: "wait", label: "审核中" },
  { key: "err", label: "被拒" },
];

/** 被拒原因展开行（复制按钮 → 剪贴板 + toast） */
function RejectDetail({ ch }: { ch: ChannelSnapshot }) {
  const text = ch.reason ?? ch.error ?? "";
  return (
    <div className="row detail" style={{ background: "rgba(255,59,48,.05)", cursor: "default" }}>
      <div className="row-sub" style={{ margin: 0, color: "var(--label)" }}>
        {text}
      </div>
      <button
        className="btn btn-sec"
        data-copy={text}
        style={{ marginLeft: "auto", padding: "4px 12px", fontSize: "12px" }}
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          toast("已复制");
        }}
      >
        复制原因
      </button>
    </div>
  );
}

/** 项目详情：摘要卡筛选 + 渠道列表 + 被拒展开 */
export default function ProjectPage({ id }: { id: string }) {
  const { client, navigate } = usePageCtx();
  useUiTick();
  const [filter, setFilter] = useState("all");
  const [expandedKey, setExpandedKey] = useState<string | undefined>(undefined);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);

  useEffect(() => {
    setHistory(null);
    void client
      .projectHistory(id)
      .then(setHistory)
      .catch(() => setHistory([])); // 拉取失败按空历史展示（不打断详情页）
  }, [client, id]);

  const proj = client.state.projects.find((p) => p.id === id);
  const snap = client.state.snapshot(id);

  if (proj === undefined) {
    return (
      <section className="page" id="page-project">
        <div className="state-box">
          <div className="big">？</div>
          <div>项目不存在或已被移除</div>
          <div className="act">
            <button className="btn btn-sec" id="backOv" onClick={() => navigate("#/overview")}>
              返回总览
            </button>
          </div>
        </div>
      </section>
    );
  }

  const counts = client.state.counts(id);
  const nums: Record<string, number> = {
    all: counts.total,
    ok: counts.ok,
    wait: counts.wait,
    err: counts.err,
  };

  let list: React.ReactNode;
  if (snap === undefined) {
    list = (
      <div className="state-box">
        <div className="spin" />
        正在获取渠道状态…
      </div>
    );
  } else if (!snap.ok) {
    list = (
      <div className="state-box">
        <div className="big">!</div>
        <div>工程状态查不到（CLI 校验失败或依赖未安装）</div>
        <div className="row-sub" style={{ marginTop: "6px" }}>
          终端运行 <span className="mono">applift doctor</span> 排查
        </div>
      </div>
    );
  } else {
    const items = snap.channels.filter(
      (ch) => filter === "all" || classify(ch.state).key === filter,
    );
    list =
      items.length === 0 ? (
        <div className="state-box">
          <div className="big">—</div>
          <div>没有匹配该筛选的渠道</div>
        </div>
      ) : (
        <div className="group" id="statusList">
          {items.map((ch) => {
            const st = classify(ch.state);
            const fresh = freshness(snap.fetchedAt);
            const key = `${id}\t${ch.channel}`;
            const hasDetail = ch.reason !== undefined || ch.error !== undefined;
            // 仅「全部渠道」视图下行内展开被拒原因（筛选视图下保持列表紧凑）
            const expanded = filter === "all" && hasDetail && expandedKey === key;
            return (
              <div key={ch.channel}>
                <div
                  className="row clickable"
                  data-ch={ch.channel}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (!hasDetail) return;
                    setExpandedKey((prev) => (prev === key ? undefined : key));
                  }}
                >
                  <div className="row-main">
                    <div className="row-title">
                      {ch.channel}{" "}
                      <span style={{ fontWeight: 400, color: "var(--label-3)", fontSize: "12px" }}>
                        {ch.platform}
                      </span>
                    </div>
                    {hasDetail ? <div className="row-sub" style={{ display: "none" }} /> : null}
                  </div>
                  <span className={`st c-${st.key}`}>
                    <span className={`dot d-${st.key}`} />
                    {st.label}
                  </span>
                  <span className={`fresh${fresh.warn ? " fresh-warn" : ""}`}>{fresh.text}</span>
                  {hasDetail ? <span className="chev">▾</span> : null}
                </div>
                {expanded ? <RejectDetail ch={ch} /> : null}
              </div>
            );
          })}
        </div>
      );
  }

  return (
    <section className="page" id="page-project">
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <button
          className="btn btn-sec"
          id="backOv"
          style={{ padding: "5px 12px" }}
          onClick={() => navigate("#/overview")}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            style={{ verticalAlign: "-2px" }}
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
          总览
        </button>
        <button
          className="btn btn-primary"
          id="goRelease"
          style={{ padding: "6px 14px" }}
          onClick={() => navigate(`#/release?project=${encodeURIComponent(id)}`)}
        >
          发版
        </button>
      </div>
      <h1 style={{ display: "flex", alignItems: "center", gap: 10 }}>{proj.name}</h1>
      <p className="page-sub mono">
        {proj.path} · 更新于{" "}
        {snap === undefined ? "—" : relTime(Date.parse(snap.fetchedAt) || Date.now())}
      </p>
      <div className="summary" id="summary">
        {FILTERS.map((f) => (
          <div
            key={f.key}
            className={`sum-card${filter === f.key ? " selected" : ""}`}
            data-filter={f.key}
            role="button"
            tabIndex={0}
            onClick={() => setFilter(f.key)}
          >
            <div className={`sum-num${f.key === "all" ? "" : ` c-${f.key}`}`}>
              {nums[f.key] ?? 0}
            </div>
            <div className="sum-label">{f.label}</div>
          </div>
        ))}
      </div>
      {list}
      <div className="hist-head">
        <h2>发版历史</h2>
        {history !== null ? (
          <span className="hist-counts">
            <span className="hc">
              <b className="c-blue">{history.filter((e) => e.phase === "beta").length}</b>内测
            </span>
            <span className="hc">
              <b className="c-green">{history.filter((e) => e.phase === "release").length}</b>正式
            </span>
          </span>
        ) : null}
      </div>
      {history === null ? (
        <div className="hist-empty">加载中…</div>
      ) : history.length === 0 ? (
        <div className="hist-empty">
          本项目还没有 applift 发版记录（用 applift 发的版才进历史；商店后台手动发的版看上方渠道状态）。
        </div>
      ) : (
        <div className="hist-list" id="historyList">
          {history.slice(0, 50).map((e, i) => (
            <div key={`${e.ts}-${i}`} className="hist-row">
              <span className={`hist-phase${e.phase === null ? " unknown" : ` ${e.phase}`}`}>
                {e.phase === "beta" ? "内测" : e.phase === "release" ? "正式" : "发版"}
              </span>
              <span className="hist-channel mono">{e.channel}</span>
              <span className="hist-version mono">{e.artifactVersion ?? "—"}</span>
              <span className="hist-action">
                {e.action === "stage" ? "上传" : "提审"}
                {e.platform !== null ? ` · ${e.platform}` : ""}
              </span>
              <span className={`hist-ok${e.ok ? "" : " err"}`}>{e.ok ? "成功" : "失败"}</span>
              <span className="hist-time">{relTime(e.ts)}</span>
            </div>
          ))}
        </div>
      )}
      <p className="note">历史只记 applift 发起的发版；渠道状态是远端实时查询，二者互补。</p>
    </section>
  );
}
