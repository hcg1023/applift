/**
 * 项目发版历史 API：GET /api/projects/:id/history——读全局 ~/.applift/history.jsonl，
 * 过滤 cwd = 项目路径，按 ts 倒序返回（前端时间线消费）。
 * 存量条目无 phase（0.14 前记录）：按 action 推导（rn-update stage=内测热更/submit=正式热更；
 * asc submit=正式提审）——见 derivePhase。
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

/** 存量 phase 推导（0.14 前条目无 phase 字段）——按 action，可靠信号：
 * - rn-update（热更 provider）：stage = publishToBeta（内测热更）、submit = promote/publishToProd（正式热更）。
 *   版本基线只作旁证不作判据：双基线（4.0.1000 测试孪生）落地前的内测热更绑原生基线
 *   （4.0.0-patch.N），按版本推导会把这批内测误标正式（实测 25 条全错）。
 * - asc：submit = 提审（正式）；stage = 上传（TestFlight 内测 / 正式 stage 上传二义，不猜 → null）。
 * - 其余渠道（pgyer/agc 上传）无确证 → null（前端按「发版」展示）。 */
export function derivePhase(e: HistoryEntry): "beta" | "release" | null {
  if (e.phase === "beta" || e.phase === "release") return e.phase;
  if (e.channel === "rn-update") return e.action === "stage" ? "beta" : "release";
  if (e.channel === "asc") return e.action === "submit" ? "release" : null;
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
