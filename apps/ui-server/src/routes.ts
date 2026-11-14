import { AppliftRunner } from "./runner.js";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ProjectRegistry, type ProjectEntry } from "./registry.js";

/** applift validate --json 的结构化结果（关注字段子集，透传 report 给前端） */
export interface ValidateReport {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

/** 命中并完成响应返回 true；未命中返回 false 交回静态托管 */
export type ApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** 本仓库 CLI 入口：apps/ui-server/src → ../../../packages/cli/dist/bin.mjs（构建后 dist 同深度） */
export function cliBinPath(): string {
  return fileURLToPath(new URL("../../../packages/cli/dist/bin.mjs", import.meta.url));
}
const VALIDATE_TIMEOUT_MS = 60_000; // validate 为只读探测（findUp/config 解析），60s 远超正常耗时

export async function validateProject(path: string): Promise<ValidateReport> {
  // 本仓库 CLI 入口直连（不经 npx）：ui-server 与 CLI 同仓发布，避免 npx 解析不确定性
  const runner = new AppliftRunner({ bin: [process.execPath, cliBinPath()] }); // 数组形态：路径含空格不被切分
  const { code, stdout, stderr } = await runner.run(["validate", path, "--json"], {
    timeoutMs: VALIDATE_TIMEOUT_MS,
  });
  try {
    return JSON.parse(stdout) as ValidateReport;
  } catch {
    return {
      ok: false,
      error: `applift validate 输出无法解析（exit=${code}）${stderr.trim()}`,
    };
  }
}

async function readJsonBody(req: IncomingMessage): Promise<{ path?: string } | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as { path?: string };
  } catch {
    return null;
  }
}

export interface ProjectRoutesOptions {
  registry: ProjectRegistry;
  /** 测试可注入；默认 spawn 本仓库 CLI dist */
  validate?: (path: string) => Promise<ValidateReport>;
}

/** /api/projects 增删改查路由；约定：本模块不捕获未命中路径 */
export function createProjectRoutes(opts: ProjectRoutesOptions): ApiHandler {
  const validate = opts.validate ?? validateProject;
  const { registry } = opts;
  return async (req, res) => {
    const url = (req.url ?? "").split("?")[0] ?? "";
    const method = req.method ?? "GET";

    if (url === "/api/projects" || url === "/api/projects/") {
      if (method === "GET") {
        sendJson(res, 200, { ok: true, projects: registry.list() });
        return true;
      }
      if (method === "POST") {
        const body = await readJsonBody(req);
        const rawPath: unknown = body?.path;
        const path = typeof rawPath === "string" ? rawPath.trim() : "";
        if (!path) {
          sendJson(res, 400, { ok: false, error: "path is required" });
          return true;
        }
        const report = await validate(path);
        if (!report.ok) {
          sendJson(res, 400, { ok: false, error: report.error ?? "validation failed", report });
          return true;
        }
        const entry: ProjectEntry = await registry.add(path);
        sendJson(res, 200, { ok: true, project: entry });
        return true;
      }
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return true;
    }

    const deleteMatch = /^\/api\/projects\/([^/]+)$/.exec(url);
    if (deleteMatch && method === "DELETE") {
      // 畸形百分号编码（如 /%zz）按未命中处理 → 404，不冒泡 500
      let id = "";
      try {
        id = decodeURIComponent(deleteMatch[1] ?? "");
      } catch {
        // 保持 removed=false 语义
      }
      const removed = id !== "" && registry.remove(id);
      sendJson(
        res,
        removed ? 200 : 404,
        removed ? { ok: true } : { ok: false, error: "not found" },
      );
      return true;
    }

    return false;
  };
}
