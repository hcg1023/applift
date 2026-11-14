import { spawn, type ChildProcess } from "node:child_process";

/** 运行中的长任务句柄（发版流）：取消 kill、stdin 交互、完成信号 */
export interface RunningTask {
  pid: number;
  /** 终止整棵进程组（SIGTERM）；幂等，进程已退出时静默 */
  kill(): void;
  done: Promise<{ code: number }>;
  /** 向子进程 stdin 写一行（自动补 \n）；子进程已退出则静默丢弃 */
  stdinWrite(line: string): void;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 超时终止的退出码（GNU timeout(1) 惯例） */
const EXIT_TIMEOUT = 124;
/** 启动失败的退出码（shell 惯例：command not found） */
const EXIT_SPAWN_ERROR = 127;
/** 其余兜底：被信号杀死等 exitCode 为 null 时保证非零 */
const EXIT_SIGNAL_FALLBACK = 1;

/** 杀整棵子树：spawn detached 已把子树放进以 pid 为 pgid 的新进程组，负 pid 即组内全体 */
function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // 组已消亡（ESRCH）或平台不支持组杀 → 回退杀单进程
    }
  }
  child.kill(signal);
}

/**
 * ui-server 与 applift CLI 的统一子进程层：一次性 run（validate/status 轮询）
 * 与流式 spawnStream（发版任务 NDJSON 事件流）共用一套定位/kill/退出码兜底语义。
 */
export class AppliftRunner {
  private readonly cwd: string | undefined;
  private readonly command: string;
  private readonly prefixArgs: string[];

  /**
   * @param opts.bin 命令串，按空白切分（"npx applift" → 命令 npx + 固定参数 applift）。
   *   缺省 "npx applift"：在 cwd 工程上下文里解析该工程本地安装的 applift。
   *   测试注入 node 桩脚本：`${process.execPath} /path/to/stub.mjs`（路径需无空白）。
   */
  constructor(opts: { cwd?: string; bin?: string } = {}) {
    const parts = (opts.bin ?? "npx applift").trim().split(/\s+/);
    this.command = parts[0] ?? "";
    this.prefixArgs = parts.slice(1);
    this.cwd = opts.cwd;
  }

  /** 一次性执行：收满 stdout/stderr 后返回；timeoutMs 到点杀整组并返回非零 + 超时说明 */
  run(args: string[], opts: { timeoutMs?: number } = {}): Promise<RunResult> {
    const { promise, resolve } = Promise.withResolvers<RunResult>();
    const child = spawn(this.command, [...this.prefixArgs, ...args], {
      cwd: this.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    let timedOut = false;
    const timer =
      opts.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            killProcessGroup(child);
          }, opts.timeoutMs)
        : undefined;
    let settled = false;
    const settle = (r: RunResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); // undefined 时按 spec 为 no-op
      resolve(r);
    };
    child.on("error", (spawnErr) =>
      settle({
        code: EXIT_SPAWN_ERROR,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: `无法启动 ${this.command}：${String(spawnErr)}`,
      }),
    );
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderrBase = Buffer.concat(err).toString("utf8");
      if (timedOut) {
        settle({
          code: EXIT_TIMEOUT,
          stdout,
          stderr: `${stderrBase}${stderrBase && !stderrBase.endsWith("\n") ? "\n" : ""}[applift-runner] 命令超时（${String(opts.timeoutMs)}ms）已终止: ${[this.command, ...this.prefixArgs, ...args].join(" ")}`,
        });
        return;
      }
      settle({ code: code ?? EXIT_SIGNAL_FALLBACK, stdout, stderr: stderrBase });
    });
    return promise;
  }

  /** 长任务流式执行：stdout 按行 NDJSON → onLine；stderr 行与解析失败 → onError */
  spawnStream(
    args: string[],
    handlers: { onLine: (e: object) => void; onError: (s: string) => void },
  ): RunningTask {
    const child = spawn(this.command, [...this.prefixArgs, ...args], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const { promise, resolve } = Promise.withResolvers<{ code: number }>();
    let settled = false;
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve({ code });
    };

    // 行缓冲：多字节跨 chunk 由 setEncoding 兜住；无换行结尾的残余行在流结束时冲刷
    const makeLineReader = (onLine: (line: string) => void) => {
      let buffer = "";
      return {
        push(chunk: string): void {
          buffer += chunk;
          let idx = buffer.indexOf("\n");
          while (idx >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (line.trim()) onLine(line);
            idx = buffer.indexOf("\n");
          }
        },
        flush(): void {
          if (buffer.trim()) onLine(buffer);
          buffer = "";
        },
      };
    };
    const stdoutLines = makeLineReader((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed !== null && typeof parsed === "object") handlers.onLine(parsed);
        else handlers.onError(`NDJSON 行非对象: ${line}`);
      } catch {
        handlers.onError(`无法解析 NDJSON 行: ${line}`);
      }
    });
    const stderrLines = makeLineReader((line) => handlers.onError(line));

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => stdoutLines.push(chunk));
    child.stdout?.on("end", () => stdoutLines.flush());
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => stderrLines.push(chunk));
    child.stderr?.on("end", () => stderrLines.flush());

    // 子进程退出后写 stdin 会 EPIPE：吞掉，别击穿 server 事件循环
    child.stdin?.on("error", () => {});

    child.on("error", (spawnErr) => {
      handlers.onError(`无法启动 ${this.command}：${String(spawnErr)}`);
      settle(EXIT_SPAWN_ERROR);
    });
    child.on("close", (code) => {
      stdoutLines.flush();
      stderrLines.flush();
      settle(code ?? EXIT_SIGNAL_FALLBACK);
    });

    return {
      pid: child.pid ?? -1,
      kill: () => killProcessGroup(child),
      done: promise,
      stdinWrite: (line: string) => {
        const stdin = child.stdin;
        if (stdin === null || stdin.destroyed || stdin.writableEnded) return;
        stdin.write(`${line}\n`);
      },
    };
  }
}
