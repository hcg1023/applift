import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import InstallBlock from "./InstallBlock.js";
import type { Availability, FsEntry, FsRoot } from "./api.js";
import { toast } from "./util.js";
import { usePageCtx } from "./state.js";

/** 面包屑：每段累计路径可点回跳（macOS/Linux "/" 与 Windows "\\" 分隔符均支持） */
function Crumbs({ dir, onPick }: { dir: string; onPick: (p: string) => void }) {
  const sep = dir.includes("\\") ? "\\" : "/";
  const parts = dir.split(/[\\/]/).filter((p) => p !== "");
  const cumulative = (i: number): string =>
    sep === "/" ? "/" + parts.slice(0, i + 1).join("/") : parts.slice(0, i + 1).join("\\") + "\\";
  return (
    <div className="fs-crumb" id="fsCrumb">
      {parts.map((p, i) => (
        <button key={`${p}-${i}`} onClick={() => onPick(cumulative(i))}>
          {i === 0 && sep === "\\" ? `${p}${sep}` : p}
        </button>
      ))}
    </div>
  );
}

/**
 * 添加项目弹层（webui 专用）：服务端目录浏览器——起始根 → 一层层点选，applift 工程高亮，选完即加。
 * Tauri 壳不走本组件：总览「＋ 添加项目」直接调系统目录对话框（Overview.openAdd）。
 */
export default function AddProjectDialog({ onClose }: { onClose: () => void }) {
  const { client } = usePageCtx();
  const [roots, setRoots] = useState<FsRoot[]>([]);
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState<FsEntry[] | null>(null);
  const [rootsError, setRootsError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [avail, setAvail] = useState<Availability | null>(null);
  const lastPath = useRef("");
  const [rootsRetry, setRootsRetry] = useState(0);
  const [listRetry, setListRetry] = useState(0);
  const listSeq = useRef(0);

  useEffect(() => {
    setRootsError(null);
    void client
      .fsRoots()
      .then((rs) => {
        setRoots(rs);
        if (rs[0] !== undefined) setDir(rs[0].path);
      })
      .catch((err: unknown) => setRootsError(err instanceof Error ? err.message : String(err)));
  }, [client, rootsRetry]);

  useEffect(() => {
    if (dir === "") return;
    setEntries(null);
    setListError(null);
    const seq = ++listSeq.current;
    void client
      .fsList(dir)
      .then((es) => {
        if (listSeq.current === seq) setEntries(es);
      })
      .catch((err: unknown) => {
        if (listSeq.current === seq) setListError(err instanceof Error ? err.message : String(err));
      });
  }, [client, dir, listRetry]);

  const add = async (path: string): Promise<void> => {
    if (adding) return;
    setAdding(true);
    lastPath.current = path;
    try {
      await client.addProject(path);
      toast("项目已添加");
      onClose();
    } catch (err) {
      // validate 失败 → 检索链探测：未装 applift（sources 全空）转引导安装块；否则维持 toast 报错
      const av = await client.availability(path).catch(() => null);
      if (av !== null && av.sources.length === 0) setAvail(av);
      else toast(`添加失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setAdding(false);
    }
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
        <div className="dlg-body">
          {rootsError !== null ? (
            <div className="state-box" id="rootsError">
              <div>起始根读取失败：{rootsError}</div>
              <button className="btn btn-sec" onClick={() => setRootsRetry((n) => n + 1)}>
                重试
              </button>
            </div>
          ) : (
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
          )}
          <Crumbs dir={dir} onPick={setDir} />
          <div className="fs-list" id="fsList">
            {listError !== null ? (
              <div className="state-box">
                <div>目录读取失败：{listError}</div>
                <button className="btn btn-sec" onClick={() => setListRetry((n) => n + 1)}>
                  重试
                </button>
              </div>
            ) : entries === null ? (
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
        </div>
        {avail !== null ? (
          <div className="dlg-install" id="installHint">
            <div className="dlg-install-title">未检测到 applift</div>
            <div className="dlg-install-sub">
              Node {avail.nodeVersion}
              {avail.nodeOk ? "" : "（版本过低，引导安装需要 Node ≥ 20）"}
            </div>
            <InstallBlock
              client={client}
              label="安装到全局"
              onDone={(ok) => {
                // 安装成功 → 自动重试 validate（同一目录直接再 add）
                if (ok && lastPath.current !== "") void add(lastPath.current);
              }}
            />
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
