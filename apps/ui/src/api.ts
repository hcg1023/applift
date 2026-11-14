/**
 * 服务端协议客户端（阶段二定案契约，接线以此为准）：
 * - REST：GET/POST /api/projects、DELETE /api/projects/:id
 * - WS：下行 snapshot/feed/task/tasks/task.end；上行 confirm/task.cancel
 * - 连接态：connectionState（connected/reconnecting）+ onConnectionChange 订阅
 * 协议解析与状态合并为纯逻辑（单测覆盖）；传输层可注入（测试/浏览器双环境）。
 */

export interface ChannelSnapshot {
  channel: string;
  platform: string;
  state: string;
  live?: boolean;
  reason?: string;
  error?: string;
  fetchedAt: string;
}

export interface ProjectSnapshot {
  projectId: string;
  channels: ChannelSnapshot[];
  fetchedAt: string;
  /** false = CLI 不可用（工程查不到状态） */
  ok: boolean;
}

export interface FeedEvent {
  id: string;
  ts: number;
  projectId: string;
  channel: string;
  kind: "state_change";
  from: string;
  to: string;
}

export interface ProjectEntry {
  id: string;
  name: string;
  path: string;
  addedAt: number;
}

export type TaskEvent = { type?: string } & Record<string, unknown>;

export interface ArchivedTask {
  taskId: string;
  projectId: string;
  platform: string;
  events: TaskEvent[];
  startedAt: number;
  endedAt: number;
  code: number;
}

/** beta --dry-run 报告（CLI BetaDryRunReport 契约透传） */
export interface JudgementReport {
  platform: string;
  provider: string | null;
  recommendation: "ota" | "native" | "uncertain" | null;
  confidence: string | null;
  evidence: Array<{ path: string; rule: string; note?: string }>;
  note: string;
}

/** GET /api/fs/list 单层子目录（hasConfig = 目录内含 applift.config.ts） */
export interface FsEntry {
  name: string;
  path: string;
  hasConfig: boolean;
}

/** GET /api/fs/roots 浏览起始根（home + 常见父目录，仅真实存在项） */
export interface FsRoot {
  name: string;
  path: string;
}

export type DownMessage =
  | { t: "snapshot"; data: ProjectSnapshot }
  | { t: "feed"; data: FeedEvent }
  | { t: "task"; taskId: string; data: TaskEvent }
  | { t: "tasks"; data: ArchivedTask[] }
  | { t: "task.end"; taskId: string; code: number };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function parseSnapshot(v: unknown): ProjectSnapshot | null {
  if (!isObj(v) || typeof v.projectId !== "string" || !Array.isArray(v.channels)) return null;
  const channels: ChannelSnapshot[] = [];
  for (const c of v.channels) {
    if (!isObj(c) || typeof c.channel !== "string") return null;
    channels.push({
      channel: c.channel,
      platform: typeof c.platform === "string" ? c.platform : "unknown",
      state: typeof c.state === "string" ? c.state : "unknown",
      live: typeof c.live === "boolean" ? c.live : undefined,
      reason: typeof c.reason === "string" ? c.reason : undefined,
      error: typeof c.error === "string" ? c.error : undefined,
      fetchedAt: typeof c.fetchedAt === "string" ? c.fetchedAt : "",
    });
  }
  return {
    projectId: v.projectId,
    channels,
    fetchedAt: typeof v.fetchedAt === "string" ? v.fetchedAt : "",
    ok: v.ok !== false,
  };
}

function parseFeed(v: unknown): FeedEvent | null {
  if (
    !isObj(v) ||
    typeof v.id !== "string" ||
    typeof v.ts !== "number" ||
    typeof v.projectId !== "string" ||
    typeof v.channel !== "string" ||
    typeof v.from !== "string" ||
    typeof v.to !== "string"
  ) {
    return null;
  }
  return {
    id: v.id,
    ts: v.ts,
    projectId: v.projectId,
    channel: v.channel,
    kind: "state_change",
    from: v.from,
    to: v.to,
  };
}

function parseArchived(v: unknown): ArchivedTask[] | null {
  if (!Array.isArray(v)) return null;
  const out: ArchivedTask[] = [];
  for (const t of v) {
    if (
      !isObj(t) ||
      typeof t.taskId !== "string" ||
      typeof t.projectId !== "string" ||
      typeof t.platform !== "string" ||
      !Array.isArray(t.events) ||
      typeof t.startedAt !== "number" ||
      typeof t.endedAt !== "number" ||
      typeof t.code !== "number"
    ) {
      return null;
    }
    out.push({
      taskId: t.taskId,
      projectId: t.projectId,
      platform: t.platform,
      events: t.events as TaskEvent[],
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      code: t.code,
    });
  }
  return out;
}

/** 下行消息解析；非 JSON / 结构不符 → null（与 ws.ts 上行解析同样静默丢弃语义） */
export function parseDown(raw: string): DownMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(parsed)) return null;
  switch (parsed.t) {
    case "snapshot": {
      const data = parseSnapshot(parsed.data);
      return data ? { t: "snapshot", data } : null;
    }
    case "feed": {
      const data = parseFeed(parsed.data);
      return data ? { t: "feed", data } : null;
    }
    case "task":
      return typeof parsed.taskId === "string" && isObj(parsed.data)
        ? { t: "task", taskId: parsed.taskId, data: parsed.data as TaskEvent }
        : null;
    case "tasks": {
      const data = parseArchived(parsed.data);
      return data ? { t: "tasks", data } : null;
    }
    case "task.end":
      return typeof parsed.taskId === "string" && typeof parsed.code === "number"
        ? { t: "task.end", taskId: parsed.taskId, code: parsed.code }
        : null;
    default:
      return null;
  }
}

export function encodeConfirm(taskId: string, id: string, value: string): string {
  return JSON.stringify({ t: "confirm", taskId, id, value });
}

export function encodeCancel(taskId: string): string {
  return JSON.stringify({ t: "task.cancel", taskId });
}

export type ConnectionState = "connected" | "reconnecting";

export type StateKey = "ok" | "wait" | "err" | "off";

/** CLI status 契约（channel.d.ts ReviewStatus）：approved/reviewing/rejected/unknown */
export function classify(state: string): { key: StateKey; label: string } {
  switch (state) {
    case "approved":
      return { key: "ok", label: "已上架" };
    case "reviewing":
      return { key: "wait", label: "审核中" };
    case "rejected":
      return { key: "err", label: "被拒" };
    default:
      return { key: "off", label: "未知" };
  }
}

const FEED_MAX = 200;
/** 前端状态合并：快照按 projectId 覆盖，feed 前插去重封顶 */
export class UiState {
  projects: ProjectEntry[] = [];
  readonly snapshots = new Map<string, ProjectSnapshot>();
  feed: FeedEvent[] = [];
  archivedTasks: ArchivedTask[] = [];
  private readonly feedIds = new Set<string>();

  apply(m: DownMessage): void {
    switch (m.t) {
      case "snapshot":
        this.snapshots.set(m.data.projectId, m.data);
        break;
      case "feed":
        if (this.feedIds.has(m.data.id)) break;
        this.feedIds.add(m.data.id);
        // ts 降序插入：实时事件按发生序到达（新的在后），补发/乱序也能稳定排列
        let i = 0;
        while (i < this.feed.length && this.feed[i]!.ts >= m.data.ts) i += 1;
        this.feed.splice(i, 0, m.data);
        if (this.feed.length > FEED_MAX) {
          const dropped = this.feed.splice(FEED_MAX);
          for (const e of dropped) this.feedIds.delete(e.id);
        }
        break;
      case "tasks":
        this.archivedTasks = m.data;
        break;
      default:
        break; // task / task.end：发版任务流一期骨架不展开，协议已校验入站
    }
  }

  snapshot(projectId: string): ProjectSnapshot | undefined {
    return this.snapshots.get(projectId);
  }

  /** ok=false → 卡片灰化「不可用」 */
  unavailable(projectId: string): boolean {
    const s = this.snapshots.get(projectId);
    return s !== undefined && !s.ok;
  }

  counts(projectId: string): { ok: number; wait: number; err: number; off: number; total: number } {
    const c = { ok: 0, wait: 0, err: 0, off: 0, total: 0 };
    const s = this.snapshots.get(projectId);
    if (s === undefined || !s.ok) return c;
    for (const ch of s.channels) {
      c[classify(ch.state).key] += 1;
      c.total += 1;
    }
    return c;
  }

  latestFor(projectId: string): FeedEvent | undefined {
    return this.feed.find((e) => e.projectId === projectId);
  }
}

/**
 * Tauri 壳注入的服务端口：壳加载内嵌 asset（非 ui-server 同源），就绪后带
 * `?serverPort=<n>` 导航回 index；浏览器直访 ui-server 时无此参数=同源不变。
 */
export function shellServerPort(search: string): number | null {
  const raw = new URLSearchParams(search).get("serverPort");
  const n = raw === null ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}

export interface Transport {
  send(raw: string): void;
  close(): void;
}

export type SocketFactory = (
  url: string,
  onMessage: (raw: string) => void,
  onClose: () => void,
) => Transport;

/** 浏览器默认传输：原生 WebSocket */
const browserSocket: SocketFactory = (url, onMessage, onClose) => {
  const ws = new WebSocket(url);
  ws.onmessage = (ev) => onMessage(String(ev.data));
  ws.onclose = onClose;
  return {
    send: (raw) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(raw);
    },
    close: () => ws.close(),
  };
};

export interface UiClientOptions {
  httpBase?: string;
  wsUrl?: string;
  fetchImpl?: typeof fetch;
  socketFactory?: SocketFactory;
  state?: UiState;
}

/** REST + WS 一体客户端：start() 拉 REST 项目表并连 WS，消息并入 UiState 后广播 onChange */
export class UiClient {
  readonly state: UiState;
  private readonly httpBase: string;
  private readonly wsUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly socketFactory: SocketFactory;
  private readonly listeners = new Set<() => void>();
  /** 任务事件直通订阅（发版向导消费；与 listeners 不同：带 payload、不触发全页重渲） */
  private readonly taskListeners = new Set<(taskId: string, ev: TaskEvent) => void>();
  private readonly taskEndListeners = new Set<(taskId: string, code: number) => void>();
  private readonly connListeners = new Set<(s: ConnectionState) => void>();
  private socket: Transport | undefined;
  private reconnectTimer: number | undefined;
  private closed = false;
  private connState: ConnectionState = "reconnecting";
  /** 近期 task.end 缓存（taskId→code，插入序环形 ≤20）：REST 尚未回填 taskId 时先到的 task.end 不丢（I-4 竞态） */
  private readonly recentTaskEnds = new Map<string, number>();

  constructor(opts: UiClientOptions = {}) {
    const loc = typeof location === "object" ? location : undefined;
    // Tauri 壳：asset 非同源，端口由壳经 ?serverPort 注入（fetch/WS 显式绝对地址）
    const port = shellServerPort(loc?.search ?? "");
    this.httpBase =
      opts.httpBase ??
      (port !== null ? `http://127.0.0.1:${port}` : (loc?.origin ?? "http://127.0.0.1:47600"));
    this.wsUrl =
      opts.wsUrl ??
      (port !== null
        ? `ws://127.0.0.1:${port}/ws`
        : loc
          ? `ws://${loc.host}/ws`
          : "ws://127.0.0.1:47600/ws");
    // 直接传 fetch 会脱离 window 上下文（Illegal invocation）
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
    this.socketFactory = opts.socketFactory ?? browserSocket;
    this.state = opts.state ?? new UiState();
  }

  /** 当前连接态：connected = WS 活跃收信；reconnecting = 断连重试中 */
  get connectionState(): ConnectionState {
    return this.connState;
  }

  /** 连接态变化订阅（断连/恢复各触发一次；重连重试不重复发） */
  onConnectionChange(fn: (s: ConnectionState) => void): () => void {
    this.connListeners.add(fn);
    return () => this.connListeners.delete(fn);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 任务事件订阅（task 下行原样）；返回退订函数 */
  onTask(fn: (taskId: string, ev: TaskEvent) => void): () => void {
    this.taskListeners.add(fn);
    return () => this.taskListeners.delete(fn);
  }

  /** 任务退出订阅（task.end 下行）；返回退订函数 */
  onTaskEnd(fn: (taskId: string, code: number) => void): () => void {
    this.taskEndListeners.add(fn);
    return () => this.taskEndListeners.delete(fn);
  }

  /** 近期已结束任务的退出码（waitTaskEnd 先查此缓存再挂等待——task.end 可能早于 taskId 回填到达） */
  taskEndCode(taskId: string): number | undefined {
    return this.recentTaskEnds.get(taskId);
  }

  private recordTaskEnd(taskId: string, code: number): void {
    this.recentTaskEnds.set(taskId, code);
    while (this.recentTaskEnds.size > 20) {
      const oldest = this.recentTaskEnds.keys().next().value;
      if (oldest === undefined) break;
      this.recentTaskEnds.delete(oldest);
    }
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private setConn(next: ConnectionState): void {
    if (this.connState === next) return;
    this.connState = next;
    for (const fn of this.connListeners) fn(next);
    this.emit(); // 连接态影响横幅，随全页重渲走
  }

  async start(): Promise<void> {
    try {
      await this.refreshProjects();
    } finally {
      // REST 失败也进 WS 重连循环：断连横幅与自愈恢复由此驱动（错误仍向上抛给调用方）
      this.connect();
    }
  }

  stop(): void {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  private connect(): void {
    if (this.closed) return;
    this.socket = this.socketFactory(
      this.wsUrl,
      (raw) => {
        const m = parseDown(raw);
        if (m === null) return;
        const was = this.connState;
        this.setConn("connected");
        if (was !== "connected" && this.state.projects.length === 0) {
          // I1 自愈：首载 REST 失败时项目表为空——WS 已通则补拉，防总览永久加载态
          void this.refreshProjects().catch(() => {});
        }
        this.state.apply(m);
        if (m.t === "task") for (const fn of this.taskListeners) fn(m.taskId, m.data);
        else if (m.t === "task.end") {
          this.recordTaskEnd(m.taskId, m.code);
          for (const fn of this.taskEndListeners) fn(m.taskId, m.code);
        }
        this.emit();
      },
      () => {
        if (this.closed) return;
        this.setConn("reconnecting");
        this.reconnectTimer = setTimeout(() => this.connect(), 2000);
      },
    );
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchImpl(this.httpBase + path, {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
    const body = (await res.json()) as T & { ok?: boolean; error?: string };
    if (!res.ok || body.ok === false) {
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }
    return body;
  }

  async refreshProjects(): Promise<void> {
    const body = await this.json<{ projects: ProjectEntry[] }>("/api/projects");
    this.state.projects = body.projects ?? [];
    this.emit();
  }

  async addProject(path: string): Promise<ProjectEntry> {
    const body = await this.json<{ project: ProjectEntry }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
    await this.refreshProjects();
    return body.project;
  }

  async removeProject(id: string): Promise<void> {
    await this.json(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
    this.state.snapshots.delete(id);
    await this.refreshProjects();
  }

  /** 判定预览（beta --dry-run --json；只读安全） */
  async dryRun(projectId: string, platform: string): Promise<JudgementReport> {
    const body = await this.json<{ report: JudgementReport }>("/api/tasks/dry-run", {
      method: "POST",
      body: JSON.stringify({ projectId, platform }),
    });
    return body.report;
  }

  /** 发起 beta 发版任务（ws 桥）；返回 taskId（后续 task/task.end 事件按此路由） */
  async startBeta(projectId: string, platform: string, args?: string[]): Promise<string> {
    const body = await this.json<{ taskId: string }>("/api/tasks/beta", {
      method: "POST",
      body: JSON.stringify(args ? { projectId, platform, args } : { projectId, platform }),
    });
    return body.taskId;
  }

  confirm(taskId: string, id: string, value: string): void {
    this.socket?.send(encodeConfirm(taskId, id, value));
  }

  cancel(taskId: string): void {
    this.socket?.send(encodeCancel(taskId));
  }

  /** 服务端轮询档位热接入（PUT /api/settings，毫秒；clamp 在服务端护栏内） */
  async applyIntervals(foregroundMs: number, backgroundMs: number): Promise<void> {
    await this.json("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ foregroundMs, backgroundMs }),
    });
  }
  /** 服务端健康信息（含当前轮询档位间隔 refreshIntervalMs——「重新检查」toast 的服务端真话） */
  async health(): Promise<{ ok: boolean; refreshIntervalMs?: number }> {
    return this.json("/api/health");
  }

  /** 服务端目录浏览器：起始根列表（添加项目弹层首页） */
  async fsRoots(): Promise<FsRoot[]> {
    const body = await this.json<{ roots: FsRoot[] }>("/api/fs/roots");
    return body.roots ?? [];
  }

  /** 服务端目录浏览器：列一层子目录（applift 工程带 hasConfig 高亮标记） */
  async fsList(dir: string): Promise<FsEntry[]> {
    const body = await this.json<{ entries: FsEntry[] }>(
      `/api/fs/list?dir=${encodeURIComponent(dir)}`,
    );
    return body.entries ?? [];
  }
}
