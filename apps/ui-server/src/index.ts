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
import { cliBinPath, createSettingsRoutes, createTaskRoutes, sendJson } from "./routes.js";
import { AppliftRunner } from "./runner.js";
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
  createProjectRoutes,
  createTaskRoutes,
  sanitizeBetaArgs,
  validateProject,
  cliBinPath,
} from "./routes.js";
export type {
  ApiHandler,
  BetaDryRunReport,
  ProjectRoutesOptions,
  TaskRoutesOptions,
  ValidateReport,
} from "./routes.js";
export { WsChannel } from "./ws.js";
export type { HostAdapter } from "./host.js";
export type { ArchivedTask, TaskEvent } from "./ws.js";
export { StatusAggregator, clampIntervalSettings } from "./aggregator.js";
export type { ChannelSnapshot, FeedEvent, ProjectSnapshot } from "./aggregator.js";
export { AppliftRunner } from "./runner.js";

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
}

/** 前端静态资源缺省目录：dist/public（源码期 src → ../public 不存在，构建后 dist/public 同深度） */
export function defaultStaticDir(): string {
  return fileURLToPath(new URL("./public", import.meta.url));
}

export function defaultRunnerFactory(cwd: string): AppliftRunner {
  // 数组形态：路径含空格不被切分；与 routes.ts validateProject 同源
  return new AppliftRunner({ cwd, bin: [process.execPath, cliBinPath()] });
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
    staticDir: opts.staticDir ?? defaultStaticDir(),
    // 「重新检查」toast 的服务端真话：当前档位（前台/后台）实际轮询间隔
    healthInfo: () => ({ refreshIntervalMs: aggregator.currentIntervalMs() }),
    registry,
    extraApiHandlers: [
      // PUT /api/settings：轮询档位热接入（clamp 护栏 + settings.json 持久化，启动读取）
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
      // POST /api/shutdown：仅本机可达（http 层固定监听 127.0.0.1）；`applift ui --stop` 消费
      (req, res) => {
        if (req.method !== "POST" || !req.url?.startsWith("/api/shutdown"))
          return Promise.resolve(false);
        // Host 校验：浏览器页面可对任意地址发 no-cors POST（DNS rebinding 同理），仅认本机 Host
        const hostname = (req.headers.host ?? "").split(":")[0];
        if (hostname !== "127.0.0.1" && hostname !== "localhost") {
          sendJson(res, 403, { ok: false, error: "forbidden host" });
          return Promise.resolve(true);
        }
        sendJson(res, 200, { ok: true });
        void close();
        return Promise.resolve(true);
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
