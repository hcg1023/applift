import { useEffect, useRef, useState } from "react";
import type { TaskEvent, UiClient } from "./api.js";

/** 安装块三态：ready（发起按钮）→ running（日志滚动 + spinner）→ failed（可重试） */
type Phase = "ready" | "running" | "failed";

/**
 * applift 引导安装/更新执行块（Tauri 壳 §2 前端消费）：
 * 发起 POST /api/applift/install|update-global → 订阅 install: 任务事件（install.log 行滚动、
 * install.result 终态）→ task.end 收尾回调 onDone(ok)。失败留在 failed 态可重试。
 */
export default function InstallBlock({
  client,
  update = false,
  label,
  onDone,
  id = "installBlock",
}: {
  client: UiClient;
  update?: boolean;
  label: string;
  /** 任务终态回调（ok = install.result ok / exit 0）；仅每次尝试结束触发一次 */
  onDone?: (ok: boolean) => void;
  id?: string;
}) {
  const [phase, setPhase] = useState<Phase>("ready");
  const [logs, setLogs] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement>(null);
  // 退订句柄跨 attempt 存活（attempt 间保持订阅无害：taskId 过滤兜底），卸载时统一退订
  const offsRef = useRef<Array<() => void>>([]);
  useEffect(() => {
    const offs = offsRef.current;
    return () => {
      for (const off of offs) off();
    };
  }, []);

  // 日志追加即滚到底（用户看最新进度行）
  useEffect(() => {
    const el = logRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const start = async (): Promise<void> => {
    if (phase === "running") return;
    setPhase("running");
    setLogs([]);
    let taskId: string | null = null;
    let resultOk = false;
    let ended = false;
    const offTask = client.onInstallTask((ev: TaskEvent) => {
      if (ev.type === "install.log") {
        const msg = typeof ev.msg === "string" ? ev.msg : "";
        if (msg !== "") setLogs((ls) => [...ls.slice(-199), msg]);
      } else if (ev.type === "install.result") {
        resultOk = ev.ok === true;
      }
    });
    const offEnd = client.onTaskEnd((tid, code) => {
      if (taskId !== null && tid === taskId) finish(resultOk || code === 0);
    });
    offsRef.current.push(offTask, offEnd);
    const finish = (ok: boolean): void => {
      if (ended) return;
      ended = true;
      offTask();
      offEnd();
      setPhase(ok ? "ready" : "failed");
      onDone?.(ok);
    };
    try {
      taskId = await client.installApplift(update);
      // REST 回填前 task.end 已到的竞态：查近期退出码缓存
      const early = client.taskEndCode(taskId);
      if (early !== undefined) finish(resultOk || early === 0);
    } catch (err) {
      setLogs((ls) => [...ls, `发起失败：${err instanceof Error ? err.message : String(err)}`]);
      finish(false);
    }
  };

  return (
    <div className="state-box install-block" id={id} data-install={phase}>
      {phase === "running" ? (
        <>
          <div className="install-head">
            <span className="spin" />
            {update ? "更新中" : "安装中"}…
          </div>
          <pre className="install-log" id="installLog" ref={logRef}>
            {logs.join("\n")}
          </pre>
        </>
      ) : phase === "failed" ? (
        <>
          <div className="install-head install-fail">
            {update ? "更新失败，可重试" : "安装失败，可重试"}
          </div>
          {logs.length > 0 ? (
            <pre className="install-log" id="installLog" ref={logRef}>
              {logs.slice(-10).join("\n")}
            </pre>
          ) : null}
          <button className="btn btn-primary" onClick={() => void start()}>
            重试
          </button>
        </>
      ) : (
        <button className="btn btn-primary" id="installBtn" onClick={() => void start()}>
          {label}
        </button>
      )}
    </div>
  );
}
