import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/** 运行中的长任务句柄（发版流）：取消 kill、stdin 交互、完成信号 */
export interface RunningTask {
  pid: number;
  /** 终止整棵进程组（SIGTERM）；幂等，进程已退出时静默 */
  kill(): void;
  done: Promise<{ code: number }>;
  /** 向子进程 stdin 写一行（自动补 \n）；子进程已退出则静默丢弃 */
  stdinWrite(line: string): void;
}

/** applift 检索链解析结果：bin = 直接 spawn 的命令形态（数组防路径空格被切分） */
export interface ResolvedBin {
  bin: string[] | null;
  source: "env" | "project" | "global" | null;
}

/** Windows 可执行扩展（POSIX 无扩展名在前） */
const EXE_EXTS = process.platform === "win32" ? ["", ".cmd", ".exe"] : [""];

function firstExisting(dir: string, name: string): string | null {
  for (const ext of EXE_EXTS) {
    const p = join(dir, `${name}${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

/** 检索链可注入环境（测试不污染全局 process.env；缺省用当前进程环境） */
export interface ResolveEnv {
  /** APPLIFT_CLI_BIN 值；undefined = 未设 */
  cliBinEnv?: string;
  /** PATH 值；undefined = process.env.PATH */
  pathEnv?: string;
}

/** PATH 上找 applift（不 spawn，直接扫目录；找不到 = null） */
export function findGlobalApplift(pathEnv?: string): string | null {
  const path = pathEnv ?? process.env.PATH ?? "";
  for (const dir of path.split(process.platform === "win32" ? ";" : ":")) {
    if (dir.trim() === "") continue;
    const found = firstExisting(dir, "applift");
    if (found !== null) return found;
  }
  return null;
}

/** 工程目录内找 node_modules/.bin/applift；不存在 = null */
export function findProjectApplift(cwd: string): string | null {
  return firstExisting(join(cwd, "node_modules", ".bin"), "applift");
}

/**
 * applift 检索链（Tauri 壳 §2 用户裁决）：APPLIFT_CLI_BIN env > 工程 node_modules/.bin > PATH > null。
 * env 形态 = [node, bin.mjs]（`applift ui` 传入的是仓库 dist 脚本路径）；project/global 是可执行 shim，直接 spawn。
 */
export function resolveAppliftBin(cwd?: string, env: ResolveEnv = {}): ResolvedBin {
  const fromEnv = env.cliBinEnv ?? process.env.APPLIFT_CLI_BIN;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return { bin: [process.execPath, fromEnv.trim()], source: "env" };
  }
  if (cwd !== undefined) {
    const project = findProjectApplift(cwd);
    if (project !== null) return { bin: [project], source: "project" };
  }
  const global = findGlobalApplift(env.pathEnv);
  if (global !== null) return { bin: [global], source: "global" };
  return { bin: null, source: null };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// -- 能力门禁（工程内旧版 CLI 自动降级全局）---------------------------------

/** UI 机读面最低版本：doctor --json / status --json wrapped / beta --dry-run --json 全集 */
export const MIN_CAPABLE_VERSION = "0.14.0";

/** 三段语义版本比较：a<b 负 / 相等 0 / a>b 正（版本格式受控，无 prerelease 场景；非版本串按最小处理） */
export function compareSemver(a: string, b: string): number {
  const pa = /^(\d+)\.(\d+)\.(\d+)/.exec(a.trim())?.slice(1).map(Number) ?? [0, 0, 0];
  const pb = /^(\d+)\.(\d+)\.(\d+)/.exec(b.trim())?.slice(1).map(Number) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (pa[i]! !== pb[i]!) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

export interface CapableBin {
  bin: string[];
  source: "env" | "project" | "global" | "fallback";
  version: string | null;
  capable: boolean;
  /** 候选中因能力不足被跳过的（诊断/引导文案用） */
  skipped: Array<{ source: "env" | "project" | "global"; version: string | null }>;
}

/** 检索链全部候选（存在性）：env > project > global（与 resolveAppliftBin 同序） */
export function binCandidates(
  cwd?: string,
  env: ResolveEnv = {},
): Array<{ bin: string[]; source: "env" | "project" | "global" }> {
  const out: Array<{ bin: string[]; source: "env" | "project" | "global" }> = [];
  const fromEnv = env.cliBinEnv ?? process.env.APPLIFT_CLI_BIN;
  if (fromEnv !== undefined && fromEnv.trim() !== "")
    out.push({ bin: [process.execPath, fromEnv.trim()], source: "env" });
  if (cwd !== undefined) {
    const project = findProjectApplift(cwd);
    if (project !== null) out.push({ bin: [project], source: "project" });
  }
  const global = findGlobalApplift(env.pathEnv);
  if (global !== null) out.push({ bin: [global], source: "global" });
  return out;
}

/** 能力解析缓存：候选集为键（bin 路径变 = 失效），TTL 内复用（轮询每轮免重复 spawn --version） */
const capableCache = new Map<string, { at: number; res: CapableBin }>();
const CAPABLE_TTL_MS = 60_000;

/**
 * 能力门禁检索链：候选逐个 `--version`（3s 超时），首个 ≥ MIN_CAPABLE_VERSION 胜出——
 * 工程内 0.12/0.13 等无 UI 机读面的旧版不再阻塞状态查询，自动降级 PATH 全局；
 * 全部不足时返回首个候选（维持现状跑真命令暴露真实错误）+ capable:false + skipped 明细。
 * env 候选视为显式用户意图，不做版本门禁（注入什么用什么）。
 */
export async function resolveCapableBin(cwd?: string, env: ResolveEnv = {}): Promise<CapableBin> {
  const candidates = binCandidates(cwd, env);
  const key = JSON.stringify([cwd ?? "", process.execPath, candidates.map((c) => c.bin.join(" "))]);
  const hit = capableCache.get(key);
  if (hit !== undefined && Date.now() - hit.at < CAPABLE_TTL_MS) return hit.res;
  const skipped: CapableBin["skipped"] = [];
  for (const c of candidates) {
    const runner = new AppliftRunner({ bin: c.bin });
    const { stdout } = await runner.run(["--version"], { timeoutMs: 3_000 });
    const version = /^v?(\d+\.\d+\.\d+.*)$/m.exec(stdout.trim())?.[1] ?? null;
    if (c.source === "env") {
      // env = 显式意图：直接采用（版本仅记录）
      const res: CapableBin = { bin: c.bin, source: "env", version, capable: true, skipped };
      capableCache.set(key, { at: Date.now(), res });
      return res;
    }
    if (version !== null && compareSemver(version, MIN_CAPABLE_VERSION) >= 0) {
      const res: CapableBin = { bin: c.bin, source: c.source, version, capable: true, skipped };
      capableCache.set(key, { at: Date.now(), res });
      return res;
    }
    skipped.push({ source: c.source, version });
  }
  // 全候选不足：无候选返回空 bin（调用方自行兜底）；有候选给首个（真命令真错误）
  const res: CapableBin =
    candidates.length > 0
      ? { ...candidates[0]!, version: null, capable: false, skipped: skipped.slice(1) }
      : { bin: [], source: "fallback", version: null, capable: false, skipped: [] };
  capableCache.set(key, { at: Date.now(), res });
  return res;
}

/** 超时终止的退出码（GNU timeout(1) 惯例） */
const EXIT_TIMEOUT = 124;
/** 启动失败的退出码（shell 惯例：command not found） */
const EXIT_SPAWN_ERROR = 127;
/** 其余兜底：被信号杀死等 exitCode 为 null 时保证非零 */
const EXIT_SIGNAL_FALLBACK = 1;
/** run() 单流（stdout/stderr 各自）累积上限：防失控子进程把内存吃爆 */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
/** kill 升级窗口：SIGTERM 后仍存活则 SIGKILL */
const KILL_ESCALATE_MS = 5_000;

/** 累积带截断：超上限保留前缀 + 截断标记，其后丢弃 */
function capSink(chunks: Buffer[]): (chunk: Buffer) => void {
  let total = 0;
  let capped = false;
  return (chunk: Buffer) => {
    if (capped) return;
    if (total + chunk.length > MAX_OUTPUT_BYTES) {
      chunks.push(chunk.subarray(0, MAX_OUTPUT_BYTES - total));
      chunks.push(
        Buffer.from(`\n[applift-runner] 输出超过 ${MAX_OUTPUT_BYTES} 字节已截断\n`, "utf8"),
      );
      capped = true;
      return;
    }
    total += chunk.length;
    chunks.push(chunk);
  };
}

/** 子进程 PATH：node 自身目录前置——工程/全局命中的 applift 是 shim（shebang `env node` 或 sh 内嵌 node），
 *  GUI 宿主（Tauri 壳/launchd）的 PATH 常缺 node 安装目录，shim 直 spawn 会 127（env: node: No such file or directory）。
 *  前置 dirname(process.execPath) 后 shebang/sh 内部的 node 解析必中（js/sh shim 通吃，无需识别 shim 类型）。 */
function childEnv(): NodeJS.ProcessEnv {
  const path = process.env.PATH ?? "";
  const nodeDir = dirname(process.execPath);
  if (path.split(delimiter).includes(nodeDir)) return { ...process.env };
  return { ...process.env, PATH: [nodeDir, path].filter((s) => s !== "").join(delimiter) };
}

/** 杀整棵子树：spawn detached 已把子树放进以 pid 为 pgid 的新进程组，负 pid 即组内全体（组杀仅 POSIX；win32 降级单进程杀） */
function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  const groupKill = (sig: NodeJS.Signals): boolean => {
    if (child.pid === undefined) return false;
    try {
      process.kill(-child.pid, sig);
      return true;
    } catch {
      return false; // 组已消亡（ESRCH）或平台不支持组杀
    }
  };
  if (groupKill(signal)) {
    if (signal === "SIGTERM") {
      // 升级：SIGTERM 后 5s 仍存活（吞信号/不可中断 sleep）→ SIGKILL 组杀；close 到达即清，unref 不阻进程退出
      const escalate = setTimeout(() => {
        if (!groupKill("SIGKILL")) child.kill("SIGKILL");
      }, KILL_ESCALATE_MS);
      escalate.unref();
      child.once("close", () => clearTimeout(escalate));
    }
    return;
  }
  child.kill(signal); // 回退杀单进程
}

/** Windows 批处理扩展：Node 无 shell 直 spawn 会 EINVAL，须经 cmd.exe /c 间接执行 */
const WIN_BATCH_EXTS = [".cmd", ".bat"] as const;

/**
 * spawn 命令归一化：win32 下命令本身是 .cmd/.bat（npm shim、检索链解出的 applift.cmd）
 * 或裸 npm/npx 时，改经 `cmd.exe /c <cmd>` 形态执行（Node spawn 无 shell 时这些形态直跑必失败）。
 * 纯函数便于平台注入测试（无真 Windows 环境）。[未实机] 分支仅静态覆盖。
 */
export function toSpawnCommand(
  bin: string[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== "win32" || bin.length === 0) return bin;
  const [cmd, ...rest] = bin;
  if (cmd === undefined) return bin;
  const lower = cmd.toLowerCase();
  const isBatch = WIN_BATCH_EXTS.some((e) => lower.endsWith(e));
  const isNpmShim = cmd === "npm" || cmd === "npx";
  if (isBatch || isNpmShim) return ["cmd.exe", "/c", cmd, ...rest];
  return bin;
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
   * @param opts.bin 命令形态两种：字符串按空白切分（"npx applift" → 命令 npx + 固定参数 applift，
   *   含空白的路径勿用此形态）；数组原样直用（[process.execPath, "/path/with space/bin.mjs"]）。
   *   缺省 "npx applift"：在 cwd 工程上下文里解析该工程本地安装的 applift。
   *   测试注入 node 桩脚本：数组形态最稳。
   */
  constructor(opts: { cwd?: string; bin?: string | string[] } = {}) {
    const bin = opts.bin ?? "npx applift";
    const parts = typeof bin === "string" ? bin.trim().split(/\s+/) : bin;
    // win32 归一化：.cmd/.bat 与裸 npm/npx 经 cmd.exe /c（无 shell 直 spawn EINVAL/ENOENT）
    const normalized = toSpawnCommand(parts.length > 0 ? parts : [""]);
    this.command = normalized[0] ?? "";
    this.prefixArgs = normalized.slice(1);
    this.cwd = opts.cwd;
  }

  /** 一次性执行：收满 stdout/stderr 后返回；timeoutMs 到点杀整组并返回非零 + 超时说明 */
  run(args: string[], opts: { timeoutMs?: number } = {}): Promise<RunResult> {
    const { promise, resolve } = Promise.withResolvers<RunResult>();
    const child = spawn(this.command, [...this.prefixArgs, ...args], {
      cwd: this.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: childEnv(),
      windowsHide: true, // win32 下 cmd.exe /c 包装命令不弹控制台窗口 [未实机]
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const onOut = capSink(out);
    const onErr = capSink(err);
    child.stdout?.on("data", (chunk: Buffer) => onOut(chunk));
    child.stderr?.on("data", (chunk: Buffer) => onErr(chunk));
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

  /** 长任务流式执行：stdout 按行 NDJSON → onLine；stderr 行与解析失败 → onError；
   *  onStdoutText 可选：stdout 非 NDJSON 行改走文本回调（npm install 等纯文本 stdout 场景），未提供时维持 onError */
  spawnStream(
    args: string[],
    handlers: {
      onLine: (e: object) => void;
      onError: (s: string) => void;
      onStdoutText?: (s: string) => void;
    },
  ): RunningTask {
    const child = spawn(this.command, [...this.prefixArgs, ...args], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: childEnv(),
      windowsHide: true, // win32 下 cmd.exe /c 包装命令不弹控制台窗口 [未实机]
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
      const onText = handlers.onStdoutText;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed !== null && typeof parsed === "object") handlers.onLine(parsed);
        else if (onText !== undefined) onText(line);
        else handlers.onError(`NDJSON 行非对象: ${line}`);
      } catch {
        if (onText !== undefined) onText(line);
        else handlers.onError(`无法解析 NDJSON 行: ${line}`);
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
