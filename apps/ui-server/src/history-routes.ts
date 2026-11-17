/**
 * 项目发版历史 API：GET /api/projects/:id/history——读全局 ~/.applift/history.jsonl，
 * 过滤 cwd = 项目路径，按 ts 倒序返回（前端时间线消费）。
 * 存量条目无 phase（0.14 前记录）：按启发式推导——rn-update（热更 provider）+ artifactVersion
 * 含测试孪生基线（如 4.0.1000-patch.N）→ beta 热更；asc 提交 → release；推导不出 → undefined（前端按「发版」展示）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HistoryEntry } from "@applift/core";
import { readEntries } from "@applift/core";
import { ProjectRegistry } from "./registry.js";
import { sendJson } from "./routes.js";
export interface HistoryRow {
  ts: number;
  channel: string;
  action: HistoryEntry["action"];
  ok: boolean;
  artifactVersion: string | null;
  /** beta 内测 / release 正式；存量推导不出 = null（前端降级「发版」） */
  phase: "beta" | "release" | null;
  platform: string | null;
}

/** 存量 phase 启发式：0.14 前的条目无 phase 字段——热更 provider 按版本名基线分（测试孪生=beta），asc 提交=release */
export function derivePhase(e: HistoryEntry): "beta" | "release" | null {
  if (e.phase === "beta" || e.phase === "release") return e.phase;
  if (e.channel === "rn-update") {
    // 测试孪生基线（patch+1000 形态，如 4.0.1000-patch.1）= beta 热更；正式线（4.0.0-patch.N）= release 热更
    const m = /^(\d+)\.(\d+)\.(\d+)-patch\./.exec(e.artifactVersion ?? "");
    if (m !== null) return Number(m[3]) >= 1000 ? "beta" : "release";
    return null;
  }
  if (e.channel === "asc") return "release";
  // pgyer/agc beta 段渠道（旧记录多为内测上传）；无法确证 → null
  return null;
}

/** API 处理器工厂（registry 注入；Host 校验不适用——只读 GET 同 /api/projects） */
export function createProjectHistoryRoutes(opts: {
  registry: ProjectRegistry;
  historyPath?: string;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const m = /^\/api\/projects\/([^/]+)\/history$/.exec(url.pathname);
    if (m === null || req.method !== "GET") return false;
    const entry = opts.registry.get(decodeURIComponent(m[1] ?? ""));
    if (entry === undefined) {
      sendJson(res, 404, { ok: false, error: "project not found" });
      return true;
    }
    const rows: HistoryRow[] = readEntries(undefined, opts.historyPath)
      .filter((e) => e.cwd === entry.path)
      .sort((a, b) => b.ts - a.ts)
      .map((e) => ({
        ts: e.ts,
        channel: e.channel,
        action: e.action,
        ok: e.ok,
        artifactVersion: e.artifactVersion ?? null,
        phase: derivePhase(e),
        platform: e.platform ?? null,
      }));
    sendJson(res, 200, { ok: true, entries: rows });
    return true;
  };
}
