import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StatusAggregator, clampIntervalSettings } from "./aggregator.js";
import type { FeedEvent, ProjectSnapshot } from "./aggregator.js";
import { startUiServer } from "./http.js";
import {
  ProjectRegistry,
  atomicWriteFile,
  defaultSettingsPath,
  defaultStorePath,
} from "./registry.js";
import {
  cliBinPath,
  createAppliftRoutes,
  createFsRoutes,
  createSettingsRoutes,
  createTaskRoutes,
  isLocalHostHeader,
  sendJson,
} from "./routes.js";
import { createAvailabilityProber } from "./applift-install.js";
import { AppliftRunner, resolveAppliftBin } from "./runner.js";
import type { ValidateReport } from "./routes.js";
import { WsChannel } from "./ws.js";

export { startUiServer } from "./http.js";
export type { UiServerHandle, UiServerOptions } from "./http.js";
export {
  ProjectRegistry,
  atomicWriteFile,
  defaultSettingsPath,
  defaultStorePath,
} from "./registry.js";
export type { ProjectEntry } from "./registry.js";
export {
  createAppliftRoutes,
  createFsRoutes,
  createProjectRoutes,
  createTaskRoutes,
  sanitizeBetaArgs,
  validateProject,
  cliBinPath,
} from "./routes.js";
export type {
  ApiHandler,
  AppliftRoutesOptions,
  BetaDryRunReport,
  FsEntry,
  FsRoot,
  ProjectRoutesOptions,
  TaskRoutesOptions,
  ValidateReport,
} from "./routes.js";
export { WsChannel } from "./ws.js";
export type { HostAdapter } from "./host.js";
export type { ArchivedTask, TaskEvent } from "./ws.js";
export { StatusAggregator, clampIntervalSettings } from "./aggregator.js";
export type { ChannelSnapshot, FeedEvent, ProjectSnapshot } from "./aggregator.js";
export {
  AppliftRunner,
  resolveAppliftBin,
  findGlobalApplift,
  findProjectApplift,
} from "./runner.js";
export type { ResolvedBin } from "./runner.js";
export { createAvailabilityProber } from "./applift-install.js";
export type { AppliftSource, Availability, AvailabilityProberOptions } from "./applift-install.js";

/** 组合服务句柄：http + ws + aggregator 一体启停 */
export interface ComposedServer {
  port: number;
  /** 优雅关闭：停 aggregator 定时器 → ws → http 监听（POST /api/shutdown 同链路） */
  close: () => Promise<void>;
  aggregator: StatusAggregator;
  ws: WsChannel;
}

export interface CreateServerOptions {
  /** 0 = 自动分配 */
  port?: number;
  /** 前端静态资源根目录；缺省 = 本包 dist/public（T7 构建产物；不存在时静态 404，服务照常起） */
  staticDir?: string;
  registry?: ProjectRegistry;
  /** cwd → runner；缺省与 routes.ts validate 同源：node + 本仓库 CLI bin */
  runnerFactory?: (cwd: string) => AppliftRunner;
  /** 轮询档位持久化路径；缺省 defaultSettingsPath()。测试必须注入临时路径（否则读到开发机真实 settings.json，默认档断言会挂） */
  settingsPath?: string;
  /** 添加项目校验注入（e2e）；缺省 validateProject */
  validate?: (path: string) => Promise<ValidateReport>;
  /** npm 命令形态（e2e 桩注入；默认 PATH 上的 npm——安装任务与 npm view 共用） */
  npmBin?: string | string[];
}

/** 前端静态资源缺省目录：dist/public（源码期 src → ../public 不存在，构建后 dist/public 同深度） */
export function defaultStaticDir(): string {
  return fileURLToPath(new URL("./public", import.meta.url));
}

export function defaultRunnerFactory(cwd: string): AppliftRunner {
  // 调用点收敛到检索链：env > 工程 node_modules/.bin > PATH；全缺（开发直跑且未装）回落仓库 dist
  const resolved = resolveAppliftBin(cwd);
  const bin = resolved.bin ?? [process.execPath, cliBinPath()];
  return new AppliftRunner({ cwd, bin });
}

/** 组合入口：registry + aggregator + ws + 静态托管 + /api/shutdown 一体装配 */
export async function createServer(opts: CreateServerOptions = {}): Promise<ComposedServer> {
  const registry = opts.registry ?? new ProjectRegistry(defaultStorePath());
  const runnerFactory = opts.runnerFactory ?? defaultRunnerFactory;
  const aggregator = new StatusAggregator({
    registry,
    runnerFactory,
    onSnapshot: (s: ProjectSnapshot) => ws.broadcastSnapshot(s),
    onFeed: (e: FeedEvent) => ws.broadcastFeed(e),
  });
  // 启动读取 settings.json（注册表同目录）：上次 PUT /api/settings 的档位跨重启保留；缺失/损坏回落默认档
  const settingsPath = opts.settingsPath ?? defaultSettingsPath();
  try {
    const saved = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      foregroundMs?: unknown;
      backgroundMs?: unknown;
    };
    const applied = clampIntervalSettings(saved.foregroundMs, saved.backgroundMs);
    aggregator.setIntervals(applied.foregroundMs, applied.backgroundMs);
  } catch {
    // 默认档
  }
  let prevConnections = 0;
  const ws = new WsChannel({
    // cwd 由 startBetaTask 调用方传入（REST 路由按 registry 解析项目目录）
    runnerFactory,
    onConnectionsChange: (count) => {
      aggregator.setVisible(count > 0);
      // 首连（0→1）即时刷新：spec「聚焦即刷新」——不等下一轮定时器（前台档最短也有 1min 空窗）
      if (count > 0 && prevConnections === 0) aggregator.refreshNow().catch(() => {});
      prevConnections = count;
    },
  });
  // 检索链探测器（版本探测 60s 缓存；npm view 10s 超时置 null）
  const availabilityProber = createAvailabilityProber(
    opts.npmBin === undefined ? {} : { npmBin: opts.npmBin },
  );
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    aggregator.stop();
    await ws.close();
    await server.close();
  };
  const server = await startUiServer({
    port: opts.port,
    validate: opts.validate,
    staticDir: opts.staticDir ?? defaultStaticDir(),
    // 「重新检查」toast 的服务端真话：当前档位（前台/后台）实际轮询间隔
    healthInfo: () => ({ refreshIntervalMs: aggregator.currentIntervalMs() }),
    registry,
    extraApiHandlers: [
      // GET /api/fs/roots + /api/fs/list：服务端目录浏览器（webui 添加项目点选路径）
      createFsRoutes(),
      createSettingsRoutes({
        setIntervals: (fg, bg) => aggregator.setIntervals(fg, bg),
        settingsPath,
      }),
      // POST /api/tasks/beta + /api/tasks/dry-run：发版向导入口（T8）——registry 查项目拿 cwd
      createTaskRoutes({
        registry,
        runnerFactory,
        startBetaTask: (projectId, platform, taskOpts) =>
          ws.startBetaTask(projectId, platform, taskOpts),
      }),
      // GET /api/applift/availability + POST /api/applift/install|update-global：检索链与引导安装（Tauri 壳 §2）
      createAppliftRoutes({
        availability: (cwd) => availabilityProber.get(cwd),
        startInstallTask: (o) =>
          ws.startInstallTask({
            runner: new AppliftRunner({ bin: opts.npmBin ?? "npm" }),
            ...o,
            // 任务结束（无论成败）失效版本缓存：前端立即重拉 availability 拿新版本
            onDone: () => availabilityProber.invalidate(),
          }),
      }),
      // POST /api/refresh：托盘「立即刷新」——触发一轮立即轮询（并发安全：refreshNow 合并同轮）；
      // Host 校验同 shutdown（本机写入口）
      async (req, res) => {
        if (req.method !== "POST" || !req.url?.startsWith("/api/refresh")) return false;
        if (!isLocalHostHeader(req)) {
          sendJson(res, 403, { ok: false, error: "forbidden host" });
          return true;
        }
        sendJson(res, 200, { ok: true });
        // 即刻响应；快照/动态经 WS 广播到达（不等待轮询完成）
        void aggregator.refreshNow().catch(() => {});
        return true;
      },
      // POST /api/shutdown：仅本机可达（http 层固定监听 127.0.0.1）；`applift ui --stop` 消费
      async (req, res) => {
        if (req.method !== "POST" || !req.url?.startsWith("/api/shutdown")) return false;
        if (!isLocalHostHeader(req)) {
          sendJson(res, 403, { ok: false, error: "forbidden host" });
          return true;
        }
        sendJson(res, 200, { ok: true });
        void close();
        return true;
      },
    ],
  });
  // 先于项目路由注册？不——startUiServer 内 registry 路由先入列，shutdown 靠前缀区分，无冲突
  ws.attach(server.httpServer);
  aggregator.setVisible(true); // 启动即开前台档轮询（无连接后转后台档）
  // 冷启动即时一轮：首轮快照进 lastSnapshots 缓存，首个连接即刻有数据（不等定时器）
  aggregator.refreshNow().catch(() => {});
  return { port: server.port, close, aggregator, ws };
}
