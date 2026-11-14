import { AppliftRunner } from "./runner.js";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ProjectRegistry, atomicWriteFile, type ProjectEntry } from "./registry.js";
import { clampIntervalSettings } from "./aggregator.js";
import type { Availability } from "./applift-install.js";

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

/** CLI bin 定位：`applift ui` spawn server 时经 APPLIFT_CLI_BIN 传入真实 bin 绝对路径（发布安装布局下仓库相对路径不存在）；
 *  env 短路直读（不走检索链 PATH 扫描——内部 validate/轮询不依赖用户全局安装）；env 缺席（开发直跑）回落本仓库 dist */
export function cliBinPath(): string {
  const fromEnv = process.env.APPLIFT_CLI_BIN;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
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

/** 请求体大小上限：超限 413 并中止读取（防滥用 body 占内存） */
const MAX_BODY_BYTES = 1024 * 1024;

type JsonBody = { path?: string; projectId?: string; platform?: string; args?: unknown };

async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<JsonBody | { tooLarge: true } | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) {
      res.setHeader("connection", "close"); // 响应后由 server 关连接（keep-alive 会挂着连接不放）
      sendJson(res, 413, { ok: false, error: `request body exceeds ${MAX_BODY_BYTES} bytes` });
      req.destroy(); // 中止剩余读取
      return { tooLarge: true };
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonBody;
  } catch {
    return null;
  }
}

export interface ProjectRoutesOptions {
  registry: ProjectRegistry;
  /** 测试可注入；默认 spawn 本仓库 CLI dist */
  validate?: (path: string) => Promise<ValidateReport>;
}

/** Host 校验（与 /api/shutdown 同款）：浏览器页面可对任意地址发 no-cors 写请求（DNS rebinding 同理），仅认本机 Host */
function isLocalHostHeader(req: IncomingMessage): boolean {
  const hostname = (req.headers.host ?? "").split(":")[0];
  return hostname === "127.0.0.1" || hostname === "localhost";
}

/** /api/projects 增删改查路由；约定：本模块不捕获未命中路径 */
export function createProjectRoutes(opts: ProjectRoutesOptions): ApiHandler {
  const validate = opts.validate ?? validateProject;
  const { registry } = opts;
  return async (req, res) => {
    const url = (req.url ?? "").split("?")[0] ?? "";
    const method = req.method ?? "GET";

    // Host 校验（与 /api/tasks、/api/shutdown 同款）：写操作仅认本机 Host——浏览器页面可对任意地址发 no-cors POST/DELETE
    const projectsRoute =
      url === "/api/projects" || url === "/api/projects/" || /^\/api\/projects\/[^/]+$/.test(url);
    if (projectsRoute && method !== "GET" && !isLocalHostHeader(req)) {
      sendJson(res, 403, { ok: false, error: "forbidden host" });
      return true;
    }

    if (url === "/api/projects" || url === "/api/projects/") {
      if (method === "GET") {
        sendJson(res, 200, { ok: true, projects: registry.list() });
        return true;
      }
      if (method === "POST") {
        const body = await readJsonBody(req, res);
        if (body !== null && "tooLarge" in body) return true; // 已回 413
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

/** beta --dry-run --json 的 stdout 报告（CLI BetaDryRunReport 契约；只读安全——不进发布分支） */
export interface BetaDryRunReport {
  platform: string;
  provider: string | null;
  recommendation: "ota" | "native" | "uncertain" | null;
  confidence: string | null;
  evidence: Array<{ path: string; rule: string; note?: string }>;
  note: string;
}

export interface TaskRoutesOptions {
  registry: ProjectRegistry;
  /** 测试可注入；缺省与本文件 validate 同源（node + 本仓库 CLI dist） */
  runnerFactory: (cwd: string) => AppliftRunner;
  /** beta 发版任务发起（ws 桥）；返回 taskId */
  startBetaTask: (
    projectId: string,
    platform: string,
    opts: { args?: string[]; cwd: string },
  ) => string;
}

const DRY_RUN_TIMEOUT_MS = 120_000; // 判定含 git diff 采集，大仓冷缓存留余量
const BETA_PLATFORMS: Record<string, true> = { android: true, ios: true, harmony: true };

/** beta 任务 args 放行表：一期只允许投递方式显式（防 --yes/--cwd/--artifact 等旗标注入绕过交互确认） */
export function sanitizeBetaArgs(raw: unknown): { ok: true; args: string[] } | { ok: false } {
  if (raw === undefined) return { ok: true, args: [] };
  if (
    Array.isArray(raw) &&
    raw.length === 2 &&
    raw[0] === "--delivery" &&
    (raw[1] === "ota" || raw[1] === "native")
  ) {
    return { ok: true, args: raw as string[] };
  }
  return { ok: false };
}

/** POST /api/tasks/beta + POST /api/tasks/dry-run：发版向导的服务端入口（T8） */
export function createTaskRoutes(opts: TaskRoutesOptions): ApiHandler {
  const { registry, runnerFactory, startBetaTask } = opts;
  return async (req, res) => {
    const url = (req.url ?? "").split("?")[0] ?? "";
    if (url !== "/api/tasks/beta" && url !== "/api/tasks/dry-run") return false;
    // Host 校验：同 /api/projects 写操作款（见 isLocalHostHeader 注释）
    if (!isLocalHostHeader(req)) {
      sendJson(res, 403, { ok: false, error: "forbidden host" });
      return true;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body !== null && "tooLarge" in body) return true; // 已回 413
    const projectId = typeof body?.projectId === "string" ? body.projectId : "";
    const platform = typeof body?.platform === "string" ? body.platform : "";
    const entry = registry.get(projectId);
    if (entry === undefined) {
      sendJson(res, 404, { ok: false, error: "project not found" });
      return true;
    }
    if (!BETA_PLATFORMS[platform]) {
      sendJson(res, 400, { ok: false, error: "platform must be one of android|ios|harmony" });
      return true;
    }

    if (url === "/api/tasks/beta") {
      const sanitized = sanitizeBetaArgs((body as { args?: unknown } | null)?.args);
      if (!sanitized.ok) {
        sendJson(res, 400, { ok: false, error: "args 仅支持 [--delivery, ota|native]" });
        return true;
      }
      // UI 任务固定事件流模式（NDJSON + stdin 确认回写）；调用方只补白名单业务参数
      let taskId: string;
      try {
        taskId = startBetaTask(projectId, platform, {
          args: ["--interactive-events", ...sanitized.args],
          cwd: entry.path,
        });
      } catch (e) {
        // 同项目同平台已有活跃任务（ws 去重拒绝）：409，error 文案内含既有 taskId
        sendJson(res, 409, { ok: false, error: (e as Error).message });
        return true;
      }
      sendJson(res, 200, { ok: true, taskId });
      return true;
    }

    // dry-run：只读判定预览（不进发布分支）；stdout 纯 JSON 契约
    const runner = runnerFactory(entry.path);
    const { code, stdout, stderr } = await runner.run(["beta", platform, "--dry-run", "--json"], {
      timeoutMs: DRY_RUN_TIMEOUT_MS,
    });
    try {
      const report = JSON.parse(stdout) as BetaDryRunReport;
      sendJson(res, 200, { ok: true, report });
    } catch {
      sendJson(res, 502, {
        ok: false,
        error: `applift beta --dry-run 输出无法解析（exit=${code}）${stderr.trim()}`,
      });
    }
    return true;
  };
}

export interface SettingsRoutesOptions {
  /** 热接入目标：clamp 后立即生效（重建轮询定时器） */
  setIntervals: (foregroundMs: number, backgroundMs: number) => void;
  /** settings.json 路径（注册表同目录；启动读取、PUT 写入） */
  settingsPath: string;
}

/** PUT /api/settings：服务端轮询档位热接入（clamp 复用 aggregator 护栏）+ 持久化 */
export function createSettingsRoutes(opts: SettingsRoutesOptions): ApiHandler {
  const { setIntervals, settingsPath } = opts;
  return async (req, res) => {
    if ((req.url ?? "").split("?")[0] !== "/api/settings") return false;
    if (!isLocalHostHeader(req)) {
      sendJson(res, 403, { ok: false, error: "forbidden host" });
      return true;
    }
    if (req.method !== "PUT") {
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return true;
    }
    const body = await readJsonBody(req, res);
    // 非对象 body（字符串/数字）会让 `in` 抛 TypeError：先判对象再查 tooLarge
    if (body !== null && typeof body === "object" && "tooLarge" in body) return true; // 已回 413
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      // 空/坏 JSON 与非对象 body（"fast"/123/[]）同罪：400，而非静默回落默认档
      sendJson(res, 400, {
        ok: false,
        error: "body 必须是含 foregroundMs/backgroundMs 的 JSON 对象",
      });
      return true;
    }
    const { foregroundMs, backgroundMs } = body as {
      foregroundMs?: unknown;
      backgroundMs?: unknown;
    };
    if (
      (foregroundMs !== undefined && typeof foregroundMs !== "number") ||
      (backgroundMs !== undefined && typeof backgroundMs !== "number")
    ) {
      sendJson(res, 400, { ok: false, error: "foregroundMs/backgroundMs 必须是数字（毫秒）" });
      return true;
    }
    const applied = clampIntervalSettings(foregroundMs, backgroundMs);
    setIntervals(applied.foregroundMs, applied.backgroundMs);
    try {
      await atomicWriteFile(settingsPath, JSON.stringify(applied, null, 2));
    } catch (e) {
      sendJson(res, 500, { ok: false, error: `档位已生效但持久化失败：${(e as Error).message}` });
      return true;
    }
    sendJson(res, 200, { ok: true, settings: applied });
    return true;
  };
}
export interface AppliftRoutesOptions {
  /** 检索链探测（createAvailabilityProber().get） */
  availability: (cwd?: string) => Promise<Availability>;
  /** 引导安装任务发起（ws 桥 startInstallTask 包装）；进行中重复 → 抛错（转 409） */
  startInstallTask: (opts: { update?: boolean }) => string;
}

/** GET /api/applift/availability + POST /api/applift/install | /api/applift/update-global（Tauri 壳 §2 检索链与引导安装） */
export function createAppliftRoutes(opts: AppliftRoutesOptions): ApiHandler {
  const { availability, startInstallTask } = opts;
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const isAvailability = path === "/api/applift/availability";
    const isInstall = path === "/api/applift/install" || path === "/api/applift/update-global";
    if (!isAvailability && !isInstall) return false;

    if (isAvailability) {
      // 只读探测：不做 Host 校验（同 /api/projects GET 语义）
      if (method !== "GET") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return true;
      }
      const cwdRaw = url.searchParams.get("path");
      const cwd = cwdRaw !== null && cwdRaw.trim() !== "" ? cwdRaw.trim() : undefined;
      const data = await availability(cwd);
      sendJson(res, 200, { ok: true, ...data });
      return true;
    }

    // 写操作：Host 校验 + body 上限（同 /api/tasks 款）
    if (!isLocalHostHeader(req)) {
      sendJson(res, 403, { ok: false, error: "forbidden host" });
      return true;
    }
    if (method !== "POST") {
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return true;
    }
    const body = await readJsonBody(req, res);
    if (body !== null && typeof body === "object" && "tooLarge" in body) return true; // 已回 413
    try {
      const taskId = startInstallTask({ update: path === "/api/applift/update-global" });
      sendJson(res, 200, { ok: true, taskId });
    } catch (e) {
      // 同 kind 进行中（ws 去重拒绝）：409，error 文案内含既有 taskId
      sendJson(res, 409, { ok: false, error: (e as Error).message });
    }
    return true;
  };
}
