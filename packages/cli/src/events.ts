import readline from "node:readline";
import type { Readable } from "node:stream";
import pkg from "../package.json" with { type: "json" };

export type OutEvent =
  | { type: "hello"; protocol: 1; cli: string }
  | { type: "stage"; stage: string }
  | {
      type: "judgement";
      platform: string;
      recommendation: "ota" | "native" | "uncertain" | null;
      confidence: string | null;
      provider: string | null;
      evidence: Array<{ path: string; rule: string; note?: string }>;
    }
  | {
      type: "confirm_required";
      id: string;
      question: string;
      choices: Array<{ value: string; label: string; recommended?: boolean }>;
    }
  | { type: "progress"; stage: string; channel?: string; pct?: number; msg?: string }
  | { type: "log"; level: "info" | "warn" | "error"; msg: string }
  | { type: "result"; ok: boolean; summary: Record<string, unknown>; error?: string };

type InEvent = { type: "confirm"; id: string; value: string };

export class ConfirmTimeout extends Error {
  constructor(id: string, timeoutMs: number) {
    super(`确认超时：id=${id}（${timeoutMs}ms 内未收到合法回写）`);
    this.name = "ConfirmTimeout";
  }
}

interface Pending {
  values: Set<string>;
  resolve: (value: string) => void;
  reject: (err: unknown) => void;
  timer: NodeJS.Timeout;
}

export interface EventChannelOptions {
  input?: Readable;
  confirmTimeoutMs?: number;
}

export class EventChannel {
  readonly #write: (line: string) => void;
  readonly #confirmTimeoutMs: number;
  readonly #rl: readline.Interface;
  readonly #pending = new Map<string, Pending>();
  /** close() 后为 true：EOF 再新建确认直接 reject（不再等 10min 超时） */
  #closed = false;
  constructor(write: (line: string) => void, opts: EventChannelOptions = {}) {
    this.#write = write;
    this.#confirmTimeoutMs = opts.confirmTimeoutMs ?? 10 * 60_000;
    this.emit({ type: "hello", protocol: 1, cli: pkg.version });
    this.#rl = readline.createInterface({ input: opts.input ?? process.stdin });
    this.#rl.on("line", (line) => this.#onLine(line));
    this.#rl.on("close", () => {
      this.#closed = true;
      // stdin EOF（父进程断开/误关）：pending 确认永远等不到回写，全部 reject 而非悬挂到超时
      for (const p of this.#pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error("stdin 已关闭"));
      }
      this.#pending.clear();
    });
  }

  /** 关闭 stdin 监听：readline 持有 stdin 引用会阻止进程自然退出（子进程模式发完 result 后调用） */
  close(): void {
    this.#closed = true;
    this.#rl.close();
  }
  emit(e: OutEvent): void {
    this.#write(JSON.stringify(e) + "\n");
  }

  confirm(
    id: string,
    question: string,
    choices: Array<{ value: string; label: string; recommended?: boolean }>,
  ): Promise<string> {
    // 同 id 串扰防护：上一个同名确认未回写前再发起 = 协议侧 bug，fail-fast（先于 emit，不污染事件流）
    if (this.#pending.has(id))
      return Promise.reject(new Error(`确认 ${id} 重复发起：上一确认尚未回写`));
    // stdin 已关闭（EOF/close()）：新确认永远等不到回写，直接失败而非悬挂到超时
    if (this.#closed) return Promise.reject(new Error("stdin 已关闭"));
    this.emit({ type: "confirm_required", id, question, choices });
    // ES2023 lib 无 Promise.withResolvers 类型——executor 形式
    return new Promise<string>((resolve, reject) => {
      const timer: NodeJS.Timeout = setTimeout(() => {
        this.#pending.delete(id);
        reject(new ConfirmTimeout(id, this.#confirmTimeoutMs));
      }, this.#confirmTimeoutMs);
      this.#pending.set(id, {
        values: new Set(choices.map((c) => c.value)),
        resolve,
        reject,
        timer,
      });
    });
  }

  #onLine(line: string): void {
    let e: InEvent;
    try {
      e = JSON.parse(line) as InEvent;
    } catch {
      this.emit({ type: "log", level: "error", msg: `事件流收到无法解析的输入行：${line}` });
      return;
    }
    if (e?.type !== "confirm" || typeof e.id !== "string" || typeof e.value !== "string") {
      this.emit({ type: "log", level: "error", msg: `事件流收到未知事件：${line}` });
      return;
    }
    const p = this.#pending.get(e.id);
    if (!p) return;
    if (!p.values.has(e.value)) {
      this.emit({
        type: "log",
        level: "error",
        msg: `确认 ${e.id} 收到非法值 ${e.value}，合法值：${[...p.values].join(", ")}`,
      });
      return;
    }
    clearTimeout(p.timer);
    this.#pending.delete(e.id);
    p.resolve(e.value);
  }
}
