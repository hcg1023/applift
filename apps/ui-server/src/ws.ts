import { randomUUID } from "node:crypto";
import type { Server, IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { AppliftRunner, RunningTask } from "./runner.js";
import type { FeedEvent, ProjectSnapshot } from "./aggregator.js";
/** 任务事件 = 阶段一 OutEvent 原样转发（packages/cli/src/events.ts 契约） */
export type TaskEvent = { type?: string } & Record<string, unknown>;

/** 已归档任务（result / 退出后入 ring buffer，重连回看用） */
export interface ArchivedTask {
  taskId: string;
  projectId: string;
  platform: string;
  events: TaskEvent[];
  startedAt: number;
  endedAt: number;
  code: number;
}

/** ring buffer 容量 */
const ARCHIVE_MAX = 20;
/** 确认看门狗默认：10 分钟（与 CLI EventChannel confirmTimeoutMs 同款语义） */
const DEFAULT_CONFIRM_TIMEOUT_MS = 10 * 60_000;
/** WS 挂载路径：独立于静态路由，升级请求按 path 过滤，不劫持其他升级 */
const WS_PATH = "/ws";
/** 上行消息大小上限：协议消息最大几十字节，1MiB 已远超需求（防异常客户端撑爆内存） */
const MAX_PAYLOAD_BYTES = 1024 * 1024;

/**
 * Origin 校验（I-2）：浏览器必须来自本机页面，否则任意网页可读全量广播 + 代确认发版。
 * 允许 http://127.0.0.1[:port] 与 http://localhost[:port]（port 缺省或与服务端口一致）；
 * 无 Origin 的非浏览器客户端（node:ws / curl 等）放行。
 */
export function isAllowedOrigin(origin: string, serverPort: number): boolean {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:") return false;
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return false;
  return u.port === "" || u.port === String(serverPort);
}

interface ActiveTask {
  taskId: string;
  projectId: string;
  platform: string;
  events: TaskEvent[];
  startedAt: number;
}

type UpMessage =
  | { t: "confirm"; taskId: string; id: string; value: string }
  | { t: "task.cancel"; taskId: string };

function parseUp(raw: unknown): UpMessage | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const m = raw as Record<string, unknown>;
  if (
    m.t === "confirm" &&
    typeof m.taskId === "string" &&
    typeof m.id === "string" &&
    // 阶段一 InEvent 契约 value:string（events.ts 按非 string 丢弃）；布尔→choice 映射归前端 UI
    typeof m.value === "string"
  ) {
    return { t: "confirm", taskId: m.taskId, id: m.id, value: m.value };
  }
  if (m.t === "task.cancel" && typeof m.taskId === "string") {
    return { t: "task.cancel", taskId: m.taskId };
  }
  return undefined;
}

/**
 * 前端唯一实时通道：状态快照 / 动态推送广播 + beta 发版任务 NDJSON 双向桥。
 * 挂载在 T1 的 http.Server 上（path=/ws 过滤升级请求）。
 */
export class WsChannel {
  private readonly runnerFactory: (cwd: string) => AppliftRunner;
  private readonly onConnectionsChange?: (count: number) => void;
  private wss: WebSocketServer | undefined;
  private readonly clients = new Set<WebSocket>();
  /** 最近一次各项目快照：新连接立即补发，无需等下一轮轮询 */
  private readonly lastSnapshots = new Map<string, ProjectSnapshot>();
  private readonly activeTasks = new Map<
    string,
    { task: ActiveTask; handle: RunningTask; clearConfirmTimer: () => void }
  >();
  private archive: ArchivedTask[] = [];

  constructor(deps: {
    runnerFactory: (cwd: string) => AppliftRunner;
    onConnectionsChange?: (count: number) => void;
  }) {
    this.runnerFactory = deps.runnerFactory;
    this.onConnectionsChange = deps.onConnectionsChange;
  }

  attach(httpServer: Server): void {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      this.onConnectionsChange?.(this.clients.size);
      // 补发缓存快照 + 运行中任务累积事件（重连恢复确认 UI）+ 归档任务
      for (const s of this.lastSnapshots.values()) this.send(ws, { t: "snapshot", data: s });
      for (const { task } of this.activeTasks.values()) {
        for (const ev of task.events) this.send(ws, { t: "task", taskId: task.taskId, data: ev });
      }
      this.send(ws, { t: "tasks", data: this.archive });
      ws.on("message", (raw) => this.onMessage(String(raw)));
      ws.on("close", () => {
        this.clients.delete(ws);
        this.onConnectionsChange?.(this.clients.size);
      });
    });
    // 升级前置 Origin 校验（noServer 手动路由：path 过滤沿用，不劫持其他升级）
    httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const wss = this.wss;
      if (wss === undefined || req.url !== WS_PATH) {
        socket.destroy();
        return;
      }
      const origin = req.headers.origin;
      if (origin !== undefined) {
        const addr = httpServer.address();
        const port = addr !== null && typeof addr === "object" ? addr.port : undefined;
        if (port === undefined || !isAllowedOrigin(origin, port)) {
          // socket.end 而非 write+destroy：先 flush 响应再关，客户端才能收到 403
          socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          return;
        }
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });
  }

  /** Aggregator.onSnapshot → 全体连接广播 + 缓存 */
  broadcastSnapshot(s: ProjectSnapshot): void {
    this.lastSnapshots.set(s.projectId, s);
    this.broadcast({ t: "snapshot", data: s });
  }

  /** Aggregator.onFeed → 全体连接广播 */
  broadcastFeed(e: FeedEvent): void {
    this.broadcast({ t: "feed", data: e });
  }

  /**
   * 启动 beta 发版任务：cwd = 前端选中项目目录（registry 解析；T8 落定，不再用服务进程 cwd）。
   * spawnStream("beta", platform, ...opts.args)，NDJSON 行广播全部连接；
   * result / 退出后归档（ring buffer 最近 20 条）。
   * confirm_required 起看门狗（默认 10min，注入可缩短）：超时无回写 → 广播 warn log + kill——
   * CLI 侧同款超时会因 stdin 监听不关而挂死，桥层兜底是正确分层；任一 confirm 上行或进程退出即清。
   */
  startBetaTask(
    projectId: string,
    platform: string,
    opts: { args?: string[]; cwd: string; confirmTimeoutMs?: number },
  ): string {
    const taskId = randomUUID();
    const runner = this.runnerFactory(opts.cwd);
    const timeoutMs = opts.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
    const task: ActiveTask = { taskId, projectId, platform, events: [], startedAt: Date.now() };
    let confirmTimer: NodeJS.Timeout | undefined;
    const clearConfirmTimer = (): void => {
      if (confirmTimer !== undefined) {
        clearTimeout(confirmTimer);
        confirmTimer = undefined;
      }
    };
    const handle = runner.spawnStream(["beta", platform, ...(opts.args ?? [])], {
      onLine: (e) => {
        const ev = e as TaskEvent;
        task.events.push(ev);
        this.broadcast({ t: "task", taskId, data: ev });
        if (ev.type === "confirm_required") {
          confirmTimer = setTimeout(() => {
            const timeoutEv: TaskEvent = {
              type: "log",
              level: "warn",
              msg: `确认超时（${timeoutMs / 1000} 秒无回写）已自动取消任务`,
            };
            task.events.push(timeoutEv);
            this.broadcast({ t: "task", taskId, data: timeoutEv });
            handle.kill();
          }, timeoutMs);
          confirmTimer.unref?.();
        }
      },
      // stderr / 解析失败：按阶段一 log 事件契约 {type:"log", level, msg} 转发，前端不丢诊断信息
      onError: (s) => {
        const ev: TaskEvent = { type: "log", level: "error", msg: s };
        task.events.push(ev);
        this.broadcast({ t: "task", taskId, data: ev });
      },
    });
    this.activeTasks.set(taskId, { task, handle, clearConfirmTimer });
    handle.done.then(({ code }) => {
      clearConfirmTimer();
      this.activeTasks.delete(taskId);
      this.archive.push({
        taskId,
        projectId,
        platform,
        events: task.events,
        startedAt: task.startedAt,
        endedAt: Date.now(),
        code,
      });
      if (this.archive.length > ARCHIVE_MAX) this.archive = this.archive.slice(-ARCHIVE_MAX);
      this.broadcast({ t: "task.end", taskId, code });
    });
    return taskId;
  }

  /** 归档任务快照（测试 / 回看） */
  archivedTasks(): ArchivedTask[] {
    return [...this.archive];
  }

  /** 优雅关闭：杀运行中任务、断开全部客户端、停升级服务 */
  async close(): Promise<void> {
    const wss = this.wss;
    if (!wss) return;
    for (const { handle } of this.activeTasks.values()) handle.kill();
    for (const ws of this.clients) ws.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    this.clients.clear();
    this.wss = undefined;
  }

  private onMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // 非 JSON 上行静默丢弃
    }
    const msg = parseUp(parsed);
    if (msg === undefined) return;
    const entry = this.activeTasks.get(msg.taskId);
    if (entry === undefined) return;
    if (msg.t === "confirm") {
      // 任一 confirm 上行即清看门狗（阶段一 InEvent 原文写 stdin）
      entry.clearConfirmTimer();
      entry.handle.stdinWrite(JSON.stringify({ type: "confirm", id: msg.id, value: msg.value }));
    } else {
      entry.handle.kill();
    }
  }

  private broadcast(m: unknown): void {
    for (const ws of this.clients) this.send(ws, m);
  }

  private send(ws: WebSocket, m: unknown): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
  }
}
