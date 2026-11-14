import { AppliftRunner, resolveAppliftBin } from "./runner.js";
import { fileURLToPath } from "node:url";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ProjectRegistry, atomicWriteFile, type ProjectEntry } from "./registry.js";
import { clampIntervalSettings } from "./aggregator.js";
import type { Availability } from "./applift-install.js";

/** 仅存在性探测（浏览器的 applift 工程高亮标记） */
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

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

/** CLI bin 定位（检索链兜底）：APPLIFT_CLI_BIN env > 工程node_modules/.bin > PATH > 本仓库 dist（开发直跑）。
 *  打包壳（Tauri resources）下仓库相对路径不存在——添加项目校验必须走检索链才能在用户全局/工程内命中。 */
export function validateBin(path: string): string[] {
  return resolveAppliftBin(path).bin ?? [process.execPath, cliBinPath()];
}

/** env 短路直读（不走检索链 PATH 扫描）；env 缺席回落本仓库 dist */
export function cliBinPath(): string {
  const fromEnv = process.env.APPLIFT_CLI_BIN;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
  return fileURLToPath(new URL("../../../packages/cli/dist/bin.mjs", import.meta.url));
}
const VALIDATE_TIMEOUT_MS = 20_000; // validate 正常 <5s；超时/旧版都快速落降级（GUI 子进程环境下偶发 shim 挂起）

/** applift 配置文件名集合（降级探测用；与 CLI config 装载的候选文件对齐） */
const CONFIG_FILE_NAMES = [
  "applift.config.ts",
  "applift.config.mts",
  "applift.config.js",
  "applift.config.mjs",
  "applift.config.cjs",
  "applift.config.json",
] as const;

/** 旧版 CLI（<0.13 无 validate 命令）降级：目录内存在 applift 配置文件即认工程。
 *  检索链命中工程内旧版时 validate 不可用——添加项目不应被工程锁定的 CLI 版本阻塞（状态/发版仍用工程版本）。 */
export async function validateByConfigProbe(path: string): Promise<ValidateReport> {
  for (const name of CONFIG_FILE_NAMES) {
    if (await fileExists(join(path, name))) {
      return { ok: true, configFound: true, framework: null, appliftAvailable: true };
    }
  }
  return { ok: false, error: "目录内无 applift 配置文件（applift.config.ts 等）" };
}

export async function validateProject(path: string): Promise<ValidateReport> {
  // CLI 定位走检索链（工程 > 全局；env 短路）：bin 数组直接执行（不经 npx）——路径含空格不被切分
  const runner = new AppliftRunner({ bin: validateBin(path) });
  const { code, stdout, stderr } = await runner.run(["validate", path, "--json"], {
    timeoutMs: VALIDATE_TIMEOUT_MS,
  });
  try {
    return JSON.parse(stdout) as ValidateReport;
  } catch {
    // CLI <0.13 无 validate（unknown command）或 GUI 子进程环境 shim 挂起超时——配置文件探测降级，
    // 添加项目不被工程锁定的 CLI 版本/宿主环境阻塞（状态/发版仍用工程版本）
    if (
      code !== 0 &&
      (/unknown command ['"]validate['"]/.test(stderr) || stderr.includes("命令超时"))
    ) {
      return validateByConfigProbe(path);
    }
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

/** Host 校验（/api/shutdown、/api/refresh 等本机写入口同款）：浏览器页面可对任意地址发 no-cors 写请求（DNS rebinding 同理），仅认本机 Host */
export function isLocalHostHeader(req: IncomingMessage): boolean {
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

// -- 服务端目录浏览器（webui「添加项目」：code-server 式一层一层点选）------------------

/** GET /api/fs/list?dir=<abs>：列一层子目录；hasConfig = 目录内存在 applift.config.ts */
export interface FsEntry {
  name: string;
  path: string;
  hasConfig: boolean;
}

/** GET /api/fs/roots：浏览起始根（home 本身 + 常见父目录；只返回真实存在的） */
export interface FsRoot {
  name: string;
  path: string;
}

const FS_ROOT_CANDIDATES: ReadonlyArray<{ name: string; sub: string | null }> = [
  { name: "主目录", sub: null },
  { name: "桌面", sub: "Desktop" },
  { name: "文档", sub: "Documents" },
  { name: "下载", sub: "Downloads" },
];

/** Host 校验（同 /api/projects 写款）：浏览器页面可对任意地址发 GET（DNS rebinding/恶意页探测本机目录拓扑），仅认本机 Host */
export function createFsRoutes(): ApiHandler {
  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const isRoots = url.pathname === "/api/fs/roots";
    const isList = url.pathname === "/api/fs/list";
    if (!isRoots && !isList) return false;
    if (req.method !== "GET") {
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return true;
    }
    if (!isLocalHostHeader(req)) {
      sendJson(res, 403, { ok: false, error: "forbidden host" });
      return true;
    }

    if (isRoots) {
      const home = homedir();
      const roots: FsRoot[] = [];
      for (const c of FS_ROOT_CANDIDATES) {
        const path = c.sub === null ? home : join(home, c.sub);
        try {
          const st = await stat(path);
          if (st.isDirectory()) roots.push({ name: c.name, path });
        } catch {
          // 候选不存在（无桌面/下载目录的机器）直接略过
        }
      }
      sendJson(res, 200, { ok: true, roots });
      return true;
    }

    const dir = (url.searchParams.get("dir") ?? "").trim();
    if (dir === "") {
      sendJson(res, 400, { ok: false, error: "dir is required" });
      return true;
    }
    let names: string[];
    try {
      const st = await stat(dir); // 存在性 + 必须是目录（文件/坏路径 → 400）
      if (!st.isDirectory()) throw new Error("not a directory");
      names = await readdir(dir);
    } catch {
      sendJson(res, 400, { ok: false, error: `目录不可读或不存在：${dir}` });
      return true;
    }
    // 一层子目录（含指到目录的符号链接；stat 失败——悬空链接/循环——由 readdir/stat 自然略过）
    const entries: FsEntry[] = [];
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      const path = join(dir, name);
      let isDir: boolean;
      try {
        isDir = (await stat(path)).isDirectory();
      } catch {
        continue; // 悬空符号链接等不可 stat 项跳过
      }
      if (!isDir) continue;
      // applift 工程标记只在子目录内探测（非目录项已被跳过，省一次无谓 stat）
      const hasConfig = await fileExists(join(path, "applift.config.ts"));
      entries.push({ name, path, hasConfig });
    }
    sendJson(res, 200, { ok: true, dir, entries });
    return true;
  };
}
