import type { Server } from "node:http";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { ProjectRegistry } from "./registry.js";
import { createProjectRoutes, sendJson, type ApiHandler } from "./routes.js";

export interface UiServerHandle {
  /** 实际监听端口（port: 0 时由系统分配） */
  port: number;
  /** 优雅关闭：停监听并等待存量连接排空 */
  close: () => Promise<void>;
  /** 原生 http.Server 实例，供后续任务挂路由 / ws 升级 */
  httpServer: Server;
}

export interface UiServerOptions {
  /** 0 = 自动分配 */
  port?: number;
  /** 前端静态资源根目录 */
  staticDir: string;
  /** 项目注册表（含持久化路径）；提供后挂 /api/projects REST 路由 */
  registry?: ProjectRegistry;
  /** 额外 API 路由（多个，按序尝试）；先于静态托管执行（/api/projects 之外的扩展点） */
  apiHandler?: ApiHandler;
  /** 追加路由（apiHandler 之后的扩展点；T8 任务路由） */
  extraApiHandlers?: ApiHandler[];
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

const VERSION = "0.1.0";

/** 解析静态路径：拒绝越界（..），目录落 index.html；返回 null 表示 404 */
async function resolveStatic(staticRoot: string, urlPath: string): Promise<string | null> {
  let clean: string;
  try {
    clean = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  } catch {
    return null; // 畸形百分号序列（如 /%zz）按 404 处理，不冒泡成 500
  }
  const safe = normalize(clean).replaceAll("\\", "/");
  if (safe.includes("..")) return null;
  const abs = resolve(staticRoot, `.${sep}${safe}`);
  if (!abs.startsWith(resolve(staticRoot) + sep) && abs !== resolve(staticRoot)) return null;
  try {
    const s = await stat(abs);
    if (s.isDirectory()) {
      const index = join(abs, "index.html");
      return (await stat(index).then(
        (x) => x.isFile(),
        () => false,
      ))
        ? index
        : null;
    }
    return s.isFile() ? abs : null;
  } catch {
    return null;
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  staticRoot: string,
  apiHandlers: ApiHandler[],
): Promise<void> {
  if (req.method === "GET" && (req.url === "/api/health" || req.url === "/api/health/")) {
    sendJson(res, 200, { ok: true, version: VERSION });
    return;
  }
  for (const apiHandler of apiHandlers) {
    if (await apiHandler(req, res)) return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { ok: false, error: "method not allowed" });
    return;
  }
  const file = await resolveStatic(staticRoot, req.url ?? "/");
  if (!file) {
    sendJson(res, 404, { ok: false, error: "not found" });
    return;
  }
  const mime = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const data = await readFile(file);
  res.writeHead(200, { "content-type": mime });
  res.end(req.method === "HEAD" ? undefined : data);
}

export async function startUiServer(opts: UiServerOptions): Promise<UiServerHandle> {
  const staticRoot = resolve(opts.staticDir);
  const apiHandlers: ApiHandler[] = [];
  if (opts.registry) apiHandlers.push(createProjectRoutes({ registry: opts.registry }));
  if (opts.apiHandler) apiHandlers.push(opts.apiHandler);
  apiHandlers.push(...(opts.extraApiHandlers ?? []));
  const httpServer = createServer((req, res) => {
    handle(req, res, staticRoot, apiHandlers).catch((err: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(err) });
      else res.destroy();
    });
  });
  const {
    promise: listening,
    resolve: resolveListen,
    reject: rejectListen,
  } = Promise.withResolvers<void>();
  httpServer.once("error", rejectListen);
  httpServer.listen(opts.port ?? 0, "127.0.0.1", () => resolveListen());
  try {
    await listening;
  } catch (err) {
    httpServer.close();
    throw err;
  }
  const addr = httpServer.address();
  if (addr === null || typeof addr === "string") {
    httpServer.close();
    throw new Error(`unexpected server address: ${String(addr)}`);
  }
  return {
    port: addr.port,
    httpServer,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        httpServer.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}
