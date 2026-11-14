import { spawn } from "node:child_process";
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
function cliBinPath(): string {
  return fileURLToPath(new URL("../../../packages/cli/dist/bin.mjs", import.meta.url));
}

export function validateProject(path: string): Promise<ValidateReport> {
  const { promise, resolve: resolveValidate } = Promise.withResolvers<ValidateReport>();
  const child = spawn(process.execPath, [cliBinPath(), "validate", path, "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  child.on("error", (err) =>
    resolveValidate({ ok: false, error: `无法启动 applift validate：${String(err)}` }),
  );
  child.on("close", (code) => {
    try {
      resolveValidate(JSON.parse(stdout) as ValidateReport);
    } catch {
      resolveValidate({
        ok: false,
        error: `applift validate 输出无法解析（exit=${code}）${stderr.trim()}`,
      });
    }
  });
  return promise;
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
        const path = body?.path?.trim();
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
      const removed = registry.remove(decodeURIComponent(deleteMatch[1] ?? ""));
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
