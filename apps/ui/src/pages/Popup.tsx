import { classify } from "../api.js";
import { tauriInvoke } from "../host.tauri.js";
import { usePageCtx, useUiTick } from "../state.js";
import { iconStyle, relTime, toast } from "../util.js";

/**
 * 托盘 popup 页（spec §4 / 原型 macOS 菜单栏面板形态）：项目概览行
 * （状态计数 + 异常高亮 + 最新动态一行）+ 底部快捷入口。
 * 行点击/入口在 Tauri 壳经 invoke `open_main` 唤起主窗并导航；
 * 浏览器直开（webui/Playwright）降级为同窗 hash 跳转。
 */
export default function PopupPage() {
  const { client, navigate } = usePageCtx();
  useUiTick();
  /** 壳环境探测一次性（window.__TAURI_INTERNALS__ 常驻） */
  const invoke = tauriInvoke();

  const openMain = (route: string): void => {
    if (invoke !== null) {
      invoke("open_main", { route }).catch((err: unknown) => {
        toast(`打开主窗口失败：${err instanceof Error ? err.message : String(err)}`);
      });
      return;
    }
    navigate(route);
  };

  const projects = client.state.projects;
  const loading = projects.length === 0;

  /** 头部副标题：异常优先（N 个渠道被拒），否则 N 个项目状态正常 */
  const totalErr = projects.reduce(
    (n, p) => n + (client.state.snapshot(p.id)?.ok === true ? client.state.counts(p.id).err : 0),
    0,
  );

  return (
    <div className="pp-root" data-page="popup">
      <div className="pp-head">
        <div className="pp-title">
          applift
          <span className={`sub${totalErr > 0 ? " err" : ""}`}>
            {totalErr > 0 ? `${totalErr} 个渠道被拒` : "状态正常"}
          </span>
        </div>
        <span className={`pp-conn${client.connectionState === "connected" ? "" : " off"}`}>
          {client.connectionState === "connected" ? "已连接" : "重连中…"}
        </span>
      </div>
      {loading ? (
        <div className="state-box pp-loading">
          <div className="spin" />
          正在获取项目与渠道状态…
        </div>
      ) : (
        <div className="pp-rows" id="ppRows">
          {projects.map((p) => {
            const snap = client.state.snapshot(p.id);
            const unavailable = snap !== undefined && !snap.ok;
            const c = client.state.counts(p.id);
            const anomaly = c.err > 0;
            const latest = client.state.latestFor(p.id);
            const latestText =
              latest === undefined
                ? "暂无动态"
                : `${latest.channel} ${classify(latest.from).label} → ${classify(latest.to).label} · ${relTime(latest.ts)}`;
            return (
              <button
                key={p.id}
                type="button"
                className={`pp-row${anomaly ? " anomaly" : ""}${unavailable ? " unavailable" : ""}`}
                data-id={p.id}
                onClick={() => {
                  if (unavailable) {
                    toast("按提示修复后点「重新检查」");
                    return;
                  }
                  openMain(`#/project/${p.id}`);
                }}
              >
                <span
                  className="proj-icon"
                  style={{
                    background: unavailable
                      ? "linear-gradient(135deg,#8e8e93,#636366)"
                      : iconStyle(p.name),
                  }}
                >
                  {p.name.slice(0, 1)}
                </span>
                <span className="pp-main">
                  <span className="pp-name">{p.name}</span>
                  <span className="pp-latest">
                    {unavailable ? "不可用（CLI 校验失败）" : latestText}
                  </span>
                </span>
                {unavailable ? (
                  <span className="pp-state off">不可用</span>
                ) : snap === undefined ? (
                  <span className="pp-state">加载中…</span>
                ) : (
                  <span className="pp-counts">
                    {c.ok > 0 ? <span className="c-ok">{c.ok}</span> : null}
                    {c.wait > 0 ? <span className="c-wait">{c.wait}</span> : null}
                    {c.err > 0 ? <span className="c-err">{c.err}</span> : null}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      <div className="pp-actions">
        <button
          type="button"
          className="pp-act"
          data-act="release"
          onClick={() => openMain("#/release")}
        >
          发一个新版本
        </button>
        <button
          type="button"
          className="pp-act"
          data-act="overview"
          onClick={() => openMain("#/overview")}
        >
          全部动态
        </button>
      </div>
    </div>
  );
}
