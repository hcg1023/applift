import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { FsEntry, FsRoot } from "./api.js";
import type { HostAdapter } from "./host.js";
import { isTauriEnv } from "./host.tauri.js";
import { toast } from "./util.js";
import { usePageCtx } from "./state.js";

/** 面包屑：每段累计路径可点回跳 */
function Crumbs({ dir, onPick }: { dir: string; onPick: (p: string) => void }) {
  const parts = dir.split("/").filter((p) => p !== "");
  return (
    <div className="fs-crumb" id="fsCrumb">
      <button onClick={() => onPick("/")}>/</button>
      {parts.map((p, i) => (
        <button key={`${p}-${i}`} onClick={() => onPick("/" + parts.slice(0, i + 1).join("/"))}>
          {p}
        </button>
      ))}
    </div>
  );
}

/**
 * 添加项目弹层（双路径）：
 * - 浏览 tab：webui = 服务端目录浏览器（GET /api/fs/*：起始根 → 一层层点选，applift 工程高亮）；
 *   Tauri 壳 = 原生目录对话框（host.pickDirectory 真对话框语义）。
 * - 手输 tab：手敲绝对路径备选入口（服务端 add 时 validate）。
 */
export default function AddProjectDialog({
  host,
  onClose,
}: {
  host: HostAdapter;
  onClose: () => void;
}) {
  const { client } = usePageCtx();
  const [tab, setTab] = useState<"browse" | "manual">("browse");
  const [roots, setRoots] = useState<FsRoot[]>([]);
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [manualPath, setManualPath] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    void client
      .fsRoots()
      .then((rs) => {
        setRoots(rs);
        if (rs[0] !== undefined) setDir(rs[0].path);
      })
      .catch((err: unknown) =>
        toast(`目录读取失败：${err instanceof Error ? err.message : String(err)}`),
      );
  }, [client]);

  useEffect(() => {
    if (dir === "") return;
    setEntries(null);
    void client
      .fsList(dir)
      .then(setEntries)
      .catch((err: unknown) =>
        toast(`目录读取失败：${err instanceof Error ? err.message : String(err)}`),
      );
  }, [client, dir]);

  const add = async (path: string): Promise<void> => {
    if (adding) return;
    setAdding(true);
    try {
      await client.addProject(path);
      toast("项目已添加");
      onClose();
    } catch (err) {
      toast(`添加失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAdding(false);
    }
  };

  const nativePick = async (): Promise<void> => {
    const picked = await host.pickDirectory();
    if (picked === null) return;
    await add(picked);
  };

  return createPortal(
    <div className="dlg-overlay" onClick={onClose}>
      <div className="dlg" id="addProjectDlg" onClick={(e) => e.stopPropagation()}>
        <div className="dlg-head">
          <div className="dlg-title">添加项目</div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="seg-wrap dlg-tabs" id="apTabs">
          <button
            className={`seg${tab === "browse" ? " active" : ""}`}
            data-tab="browse"
            onClick={() => setTab("browse")}
          >
            浏览
          </button>
          <button
            className={`seg${tab === "manual" ? " active" : ""}`}
            data-tab="manual"
            onClick={() => setTab("manual")}
          >
            手动输入
          </button>
        </div>
        {tab === "browse" ? (
          <div className="dlg-body">
            {isTauriEnv() ? (
              <div className="state-box" style={{ padding: "24px" }}>
                <button
                  className="btn btn-primary"
                  id="nativePick"
                  onClick={() => void nativePick()}
                >
                  打开系统目录选择器
                </button>
              </div>
            ) : (
              <>
                <div className="fs-roots" id="fsRoots">
                  {roots.map((r) => (
                    <button
                      key={r.path}
                      className={`seg${r.path === dir ? " active" : ""}`}
                      onClick={() => setDir(r.path)}
                    >
                      {r.name}
                    </button>
                  ))}
                </div>
                <Crumbs dir={dir} onPick={setDir} />
                <div className="fs-list" id="fsList">
                  {entries === null ? (
                    <div className="state-box">
                      <div className="spin" />
                      读取目录…
                    </div>
                  ) : entries.length === 0 ? (
                    <div className="state-box">此目录下没有子目录</div>
                  ) : (
                    entries.map((e) => (
                      <div
                        key={e.path}
                        className={`fs-row${e.hasConfig ? " proj" : ""}`}
                        data-name={e.name}
                      >
                        <button className="fs-name" onClick={() => setDir(e.path)} title={e.path}>
                          📁 {e.name}
                        </button>
                        {e.hasConfig ? (
                          <>
                            <span className="fs-badge">applift 工程</span>
                            <button
                              className="btn btn-sec fs-pick"
                              data-pick={e.path}
                              disabled={adding}
                              onClick={() => void add(e.path)}
                            >
                              选择
                            </button>
                          </>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="dlg-body">
            <input
              className="dlg-input"
              id="manualPath"
              placeholder="/absolute/path/to/project（需含 applift.config.ts）"
              value={manualPath}
              onChange={(e) => setManualPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && manualPath.trim() !== "") void add(manualPath.trim());
              }}
            />
            <button
              className="btn btn-primary"
              id="manualAdd"
              disabled={manualPath.trim() === "" || adding}
              onClick={() => void add(manualPath.trim())}
            >
              添加
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
