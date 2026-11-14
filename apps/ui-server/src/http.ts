import type { Server } from "node:http";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { ProjectRegistry } from "./registry.js";
import { createProjectRoutes, sendJson, type ApiHandler } from "./routes.js";
import pkg from "../package.json" with { type: "json" };

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
  /** /api/health 追加字段（每次请求现算——如当前轮询档位间隔） */
  healthInfo?: () => Record<string, unknown>;
}

/**
 * Tauri 壳 asset origin 白名单（跨平台 webview 域）：macOS/iOS `tauri://localhost`、
 * Windows/Android/Linux `http(s)://tauri.localhost`。CORS 与 WS Origin 校验共用。
 */
export const SHELL_ASSET_ORIGINS: readonly string[] = [
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
];

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

const VERSION = pkg.version;

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
  healthInfo?: () => Record<string, unknown>,
): Promise<void> {
  // CORS：Tauri 壳以 asset 域加载同一份前端，REST 需跨源访问 127.0.0.1。
  // 仅 /api/* 处理（静态资源不经此处）；ACAO 只回显白名单壳 origin（Host 校验防的是
  // DNS rebinding 而非来源——恶意网页直连本机时 Host 必过，来源收敛靠这里），
  // 非白名单 Origin 不下发任何 CORS 头（浏览器默认拦截），预检 204 收口。
  if (req.url?.split("?")[0]?.startsWith("/api/")) {
    const origin = req.headers.origin;
    const fromShell = origin !== undefined && SHELL_ASSET_ORIGINS.includes(origin);
    if (fromShell) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      if (fromShell) {
        res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
        res.setHeader("access-control-allow-headers", "content-type");
      }
      res.writeHead(204);
      res.end();
      return;
    }
  }
  if (req.method === "GET" && (req.url === "/api/health" || req.url === "/api/health/")) {
    sendJson(res, 200, { ok: true, version: VERSION, ...(healthInfo?.() ?? {}) });
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
  res.writeHead(200, { "content-type": mime, "x-content-type-options": "nosniff" });
  res.end(req.method === "HEAD" ? undefined : data);
}

export async function startUiServer(opts: UiServerOptions): Promise<UiServerHandle> {
  const staticRoot = resolve(opts.staticDir);
  const apiHandlers: ApiHandler[] = [];
  if (opts.registry) apiHandlers.push(createProjectRoutes({ registry: opts.registry }));
  if (opts.apiHandler) apiHandlers.push(opts.apiHandler);
  apiHandlers.push(...(opts.extraApiHandlers ?? []));
  const httpServer = createServer((req, res) => {
    handle(req, res, staticRoot, apiHandlers, opts.healthInfo).catch((err: unknown) => {
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
