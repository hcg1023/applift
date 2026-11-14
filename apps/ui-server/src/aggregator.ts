import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AppliftRunner } from "./runner.js";
import type { ProjectRegistry } from "./registry.js";

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
  /** false = CLI 不可用（非零退出且 stdout 无法解析出 StatusReport） */
  ok: boolean;
}

export type FeedEvent = {
  id: string;
  ts: number;
  projectId: string;
  channel: string;
  kind: "state_change";
  from: string;
  to: string;
};

export interface AggregatorTimers {
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

/** status --json 的 StatusReport（阶段一 lifecycle.ts 契约） */
interface StatusReport {
  fetchedAt?: string;
  results?: Array<Partial<ChannelSnapshot>>;
}

/** 档位护栏：前台最短 1min，后台最短 15min（防误配打爆渠道 API） */
const FG_MIN_MS = 60_000;
const BG_MIN_MS = 15 * 60_000;
const FG_DEFAULT_MS = 5 * 60_000;
const BG_DEFAULT_MS = 60 * 60_000;
/** 单项目 status 子进程超时 */
const STATUS_TIMEOUT_MS = 120_000;

const clamp = (v: number, min: number) => Math.max(v, min);

function defaultBaselinePath(): string {
  return join(homedir(), "Library", "Application Support", "applift-ui", "state-history.jsonl");
}

export class StatusAggregator {
  readonly baselinePath: string;
  private readonly registry: ProjectRegistry;
  private readonly runnerFactory: (cwd: string) => AppliftRunner;
  private readonly onSnapshot: (s: ProjectSnapshot) => void;
  private readonly onFeed: (e: FeedEvent) => void;
  private readonly timers: AggregatorTimers;
  private fgMs = FG_DEFAULT_MS;
  private bgMs = BG_DEFAULT_MS;
  private visible = true;
  private timerId: NodeJS.Timeout | undefined;
  /** (projectId \t channel) → 最近一次有效 state（内存即重启恢复自 baseline 文件） */
  private lastState = new Map<string, string>();
  private refreshInFlight: Promise<void> | undefined;

  constructor(deps: {
    registry: ProjectRegistry;
    runnerFactory: (cwd: string) => AppliftRunner;
    onSnapshot: (s: ProjectSnapshot) => void;
    onFeed: (e: FeedEvent) => void;
    baselinePath?: string;
    timers?: AggregatorTimers;
  }) {
    this.registry = deps.registry;
    this.runnerFactory = deps.runnerFactory;
    this.onSnapshot = deps.onSnapshot;
    this.onFeed = deps.onFeed;
    this.baselinePath = deps.baselinePath ?? defaultBaselinePath();
    this.timers = deps.timers ?? ({ setInterval, clearInterval } as AggregatorTimers);
    this.loadBaseline();
  }

  /** 重启恢复：读 state-history.jsonl，每个 key 取最后一条 */
  private loadBaseline(): void {
    let text: string;
    try {
      text = readFileSync(this.baselinePath, "utf8");
    } catch {
      return; // 无基线文件 → 首轮全量不产生事件
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line) as {
          projectId?: string;
          channel?: string;
          to?: string;
          state?: string;
        };
        if (!rec.projectId || !rec.channel) continue;
        const state = rec.to ?? rec.state;
        if (state) this.lastState.set(`${rec.projectId}\t${rec.channel}`, state);
      } catch {
        // 单行损坏 → 跳过，不拖垮整份基线
      }
    }
  }

  /** 当前档位间隔（前台/后台）——公开给 /api/health 透出服务端真话 */
  currentIntervalMs(): number {
    return this.visible ? this.fgMs : this.bgMs;
  }

  private restartTimer(): void {
    if (this.timerId !== undefined) this.timers.clearInterval(this.timerId);
    this.timerId = this.timers.setInterval(() => {
      // 回调/工厂抛错已在 refreshNow 内隔离；此处兜底防拒绝逸出到进程级 unhandledRejection
      this.refreshNow().catch(() => {});
    }, this.currentIntervalMs());
  }

  setVisible(v: boolean): void {
    const tierChanged = v !== this.visible;
    this.visible = v;
    // 首次调用或档位变化才重建定时器；同档幂等（保住 interval 句柄不重置倒计时）
    if (this.timerId === undefined || tierChanged) this.restartTimer();
  }

  /** 停止轮询定时器（优雅关闭链路调用；基线已落盘，重启可恢复） */
  stop(): void {
    if (this.timerId !== undefined) {
      this.timers.clearInterval(this.timerId);
      this.timerId = undefined;
    }
  }

  setIntervals(foregroundMs: number, backgroundMs: number): void {
    // NaN/Infinity 会被 Math.max 原样放过（NaN 间隔 → setInterval 0ms 背靠背打 API），非有限值回落默认档
    this.fgMs = Number.isFinite(foregroundMs) ? clamp(foregroundMs, FG_MIN_MS) : FG_DEFAULT_MS;
    this.bgMs = Number.isFinite(backgroundMs) ? clamp(backgroundMs, BG_MIN_MS) : BG_DEFAULT_MS;
    if (this.timerId !== undefined) this.restartTimer();
  }

  /** 全部项目立即一轮（项目间串行；与进行中的一轮合并，防定时器+手动叠加） */
  refreshNow(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.runOnce().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  private async runOnce(): Promise<void> {
    for (const entry of this.registry.list()) {
      let report: StatusReport | null = null;
      try {
        // 工厂在 try 内：同步抛错同样降级为 ok=false 快照，不打断后续项目
        const runner = this.runnerFactory(entry.path);
        const res = await runner.run(["status", "--json"], {
          timeoutMs: STATUS_TIMEOUT_MS,
        });
        report = this.parseReport(res);
        const ok = res.code === 0 && report !== null;
        const channels = (report?.results ?? []).map((r) => ({
          channel: r.channel ?? "unknown",
          platform: r.platform ?? "unknown",
          state: r.state ?? "unknown",
          live: r.live,
          reason: r.reason,
          error: r.error,
          fetchedAt: r.fetchedAt ?? new Date().toISOString(),
        }));
        const snapshot: ProjectSnapshot = {
          projectId: entry.id,
          channels,
          fetchedAt: report?.fetchedAt ?? new Date().toISOString(),
          ok,
        };
        if (ok) await this.diffAndPersist(snapshot);
        this.emitSnapshot(snapshot);
      } catch {
        // 子进程层异常（spawn 失败、落盘失败等）同样降级为 ok=false 快照；回调抛错不得炸进程
        this.emitSnapshot({
          projectId: entry.id,
          channels: [],
          fetchedAt: new Date().toISOString(),
          ok: false,
        });
      }
    }
  }

  /** 回调隔离：消费端抛错只影响它自己这一条，不逃逸进轮询循环/进程 */
  private emitSnapshot(s: ProjectSnapshot): void {
    try {
      this.onSnapshot(s);
    } catch {
      // 吞掉：ui-server 主进程存活优先于单个订阅者
    }
  }

  /** 非零退出 + stdout 可解析 → 有数据的 ok=false；stdout 无法解析 → null */
  private parseReport(res: { code: number; stdout: string; stderr: string }): StatusReport | null {
    const text = res.stdout.trim();
    if (!text.startsWith("{")) return null;
    try {
      const parsed = JSON.parse(text) as StatusReport;
      return Array.isArray(parsed.results) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** 跃迁检测 + baseline 落盘：unknown 态（渠道错误）不进基线，避免故障期噪音。
   * 顺序：先全部落盘，成功后才更新内存基线并发出 FeedEvent（写失败→异常上抛→该轮降级 ok=false，内存与文件不分叉、事件不重发） */
  private async diffAndPersist(snapshot: ProjectSnapshot): Promise<void> {
    const now = Date.now();
    const entries: Array<{ key: string; state: string }> = [];
    const events: FeedEvent[] = [];
    const lines: string[] = [];
    for (const ch of snapshot.channels) {
      if (ch.state === "unknown") continue;
      const key = `${snapshot.projectId}\t${ch.channel}`;
      const prev = this.lastState.get(key);
      if (prev !== undefined && prev !== ch.state) {
        events.push({
          id: randomUUID(),
          ts: now,
          projectId: snapshot.projectId,
          channel: ch.channel,
          kind: "state_change",
          from: prev,
          to: ch.state,
        });
      }
      entries.push({ key, state: ch.state });
      // 每次有效状态都落一行（含首次 from=to）：重启恢复的完整基线
      lines.push(
        JSON.stringify({
          ts: now,
          projectId: snapshot.projectId,
          channel: ch.channel,
          from: prev ?? ch.state,
          to: ch.state,
        }),
      );
    }
    if (lines.length === 0) return;
    await mkdir(dirname(this.baselinePath), { recursive: true });
    await appendFile(this.baselinePath, lines.join("\n") + "\n", "utf8");
    for (const e of entries) this.lastState.set(e.key, e.state);
    for (const e of events) {
      try {
        this.onFeed(e);
      } catch {
        // 同 emitSnapshot：订阅者抛错不炸进程
      }
    }
  }
}
