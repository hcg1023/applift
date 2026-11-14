import { fileURLToPath } from "node:url";
import { StatusAggregator } from "./aggregator.js";
import type { FeedEvent, ProjectSnapshot } from "./aggregator.js";
import { startUiServer } from "./http.js";
import { ProjectRegistry, defaultStorePath } from "./registry.js";
import { cliBinPath, sendJson } from "./routes.js";
import { AppliftRunner } from "./runner.js";
import { WsChannel } from "./ws.js";

export { startUiServer } from "./http.js";
export type { UiServerHandle, UiServerOptions } from "./http.js";
export { ProjectRegistry, defaultStorePath } from "./registry.js";
export type { ProjectEntry } from "./registry.js";
export { createProjectRoutes, validateProject, cliBinPath } from "./routes.js";
export type { ApiHandler, ProjectRoutesOptions, ValidateReport } from "./routes.js";
export { WsChannel } from "./ws.js";
export type { ArchivedTask, TaskEvent } from "./ws.js";
export { StatusAggregator } from "./aggregator.js";
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
  const ws = new WsChannel({
    // WsChannel 任务无 cwd 语境（beta 在前端选中项目的 cwd 执行属后续路由职责），暂以服务进程 cwd 起跑
    runnerFactory: () => runnerFactory(process.cwd()),
    onConnectionsChange: (count) => aggregator.setVisible(count > 0),
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
    registry,
    // POST /api/shutdown：仅本机可达（http 层固定监听 127.0.0.1）；`applift ui --stop` 消费
    apiHandler: (req, res) => {
      if (req.method !== "POST" || !req.url?.startsWith("/api/shutdown"))
        return Promise.resolve(false);
      sendJson(res, 200, { ok: true });
      void close();
      return Promise.resolve(true);
    },
  });
  // 先于项目路由注册？不——startUiServer 内 registry 路由先入列，shutdown 靠前缀区分，无冲突
  ws.attach(server.httpServer);
  aggregator.setVisible(true); // 启动即开前台档轮询（无连接后转后台档）
  return { port: server.port, close, aggregator, ws };
}
