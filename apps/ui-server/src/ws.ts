import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
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
/** WS 挂载路径：独立于静态路由，升级请求按 path 过滤，不劫持其他升级 */
const WS_PATH = "/ws";

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
  private readonly activeTasks = new Map<string, { task: ActiveTask; handle: RunningTask }>();
  private archive: ArchivedTask[] = [];

  constructor(deps: {
    runnerFactory: (cwd: string) => AppliftRunner;
    onConnectionsChange?: (count: number) => void;
  }) {
    this.runnerFactory = deps.runnerFactory;
    this.onConnectionsChange = deps.onConnectionsChange;
  }

  attach(httpServer: Server): void {
    this.wss = new WebSocketServer({ server: httpServer, path: WS_PATH });
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
   */
  startBetaTask(
    projectId: string,
    platform: string,
    opts: { args?: string[]; cwd: string },
  ): string {
    const taskId = randomUUID();
    const runner = this.runnerFactory(opts.cwd);
    const task: ActiveTask = { taskId, projectId, platform, events: [], startedAt: Date.now() };
    const handle = runner.spawnStream(["beta", platform, ...(opts.args ?? [])], {
      onLine: (e) => {
        const ev = e as TaskEvent;
        task.events.push(ev);
        this.broadcast({ t: "task", taskId, data: ev });
      },
      // stderr / 解析失败：按阶段一 log 事件契约 {type:"log", level, msg} 转发，前端不丢诊断信息
      onError: (s) => {
        const ev: TaskEvent = { type: "log", level: "error", msg: s };
        task.events.push(ev);
        this.broadcast({ t: "task", taskId, data: ev });
      },
    });
    this.activeTasks.set(taskId, { task, handle });
    handle.done.then(({ code }) => {
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
      // 阶段一 InEvent 原文写 stdin
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
