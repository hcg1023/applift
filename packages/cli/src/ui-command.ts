/**
 * `applift ui`：detach 常驻 UI 服务生命周期管理。
 * - `applift ui [--port <n>] [--no-open]`：幂等启动（已活只开浏览器），否则 spawn 独立 ui-server 进程
 * - `applift ui --stop`：POST /api/shutdown 优雅关闭并清理端口文件
 * 零新依赖：浏览器打开走平台命令（darwin `open` / 其余 `xdg-open`），失败仅告警不阻断。
 */
import { exec, spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import type { Command } from "commander";

/** 固定默认端口：CLI 需先知端口才能探测健康 + 写端口文件（port 0 由系统分配则 CLI 无从得知） */
export const DEFAULT_UI_PORT = 47600;
const HEALTH_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 200;

function appliftHome(): string {
  // 与 @applift/core APPLIFT_HOME 同语义；函数形态便于测试改 env 隔离
  return process.env.APPLIFT_HOME ?? join(homedir(), ".applift");
}

export function defaultPortFile(): string {
  return join(appliftHome(), "ui.port");
}

/** ui-server 独立进程入口（@applift/ui-server 为 runtime dependency，随 CLI 发布安装） */
export function defaultServerEntry(): string {
  const require = createRequire(import.meta.url);
  return require.resolve("@applift/ui-server/main");
}

export interface UiDeps {
  portFile?: string;
  serverEntry?: string;
  /** fetch 替身（默认全局 fetch） */
  fetchImpl?: typeof fetch;
  /** spawn 替身（默认 child_process.spawn） */
  spawnImpl?: typeof spawn;
  /** 浏览器打开替身（默认平台命令 exec） */
  openImpl?: (url: string) => void;
  /** 健康等待上限（默认 5s；测试缩短） */
  healthTimeoutMs?: number;
}

async function isAlive(port: number, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function readSavedPort(portFile: string): Promise<number | null> {
  try {
    const n = Number((await readFile(portFile, "utf8")).trim());
    return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
  } catch {
    return null;
  }
}

function openBrowser(url: string, warn: (msg: string) => void): void {
  const cmd =
    process.platform === "darwin"
      ? `open ${JSON.stringify(url)}`
      : `xdg-open ${JSON.stringify(url)}`;
  exec(cmd, (err) => {
    if (err) warn(`无法自动打开浏览器（${cmd}）：${err.message}，请手动访问 ${url}`);
  });
}

/** `applift ui --stop`：优雅关闭 + 清理端口文件；无运行实例时提示非失败退出 */
export async function stopUi(
  deps: UiDeps = {},
  log: (msg: string) => void = () => {},
): Promise<void> {
  const portFile = deps.portFile ?? defaultPortFile();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const saved = await readSavedPort(portFile);
  if (saved === null) {
    log("没有运行中的 applift ui 服务（端口文件不存在）");
    return;
  }
  try {
    await fetchImpl(`http://127.0.0.1:${saved}/api/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(2000),
    });
    log(`applift ui 已停止（端口 ${saved}）`);
  } finally {
    await rm(portFile, { force: true });
  }
}

export async function startUi(
  opts: { port?: number; open?: boolean },
  deps: UiDeps = {},
  log: (msg: string) => void = () => {},
): Promise<void> {
  const port = opts.port ?? DEFAULT_UI_PORT;
  const portFile = deps.portFile ?? defaultPortFile();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const spawnImpl = deps.spawnImpl ?? spawn;
  const serverEntry = deps.serverEntry ?? defaultServerEntry();
  const openImpl = deps.openImpl ?? ((url: string) => openBrowser(url, (m) => log(`⚠ ${m}`)));
  const url = `http://127.0.0.1:${port}`;

  // 幂等：已活实例只开浏览器（忽略 --port 差异——沿用现活端口，不另起第二实例）
  const saved = await readSavedPort(portFile);
  if (saved !== null && (await isAlive(saved, fetchImpl))) {
    log(`applift ui 已在运行（端口 ${saved}）`);
    if (opts.open !== false) openImpl(`http://127.0.0.1:${saved}`);
    return;
  }

  // 端口被其他进程占用（无端口文件但 health 通）→ 直接视为已活，避免 EADDRINUSE 僵尸 spawn
  if (saved === null && (await isAlive(port, fetchImpl))) {
    await mkdir(dirname(portFile), { recursive: true });
    await writeFile(portFile, String(port), "utf8");
    log(`applift ui 已在运行（端口 ${port}，已补写端口文件）`);
    if (opts.open !== false) openImpl(url);
    return;
  }

  const child = spawnImpl(process.execPath, [serverEntry, "--port", String(port)], {
    detached: true,
    stdio: "ignore",
    // 发布布局下 ui-server 内的仓库相对 cliBinPath() 不存在——把真实 bin 绝对路径带给 server（C-1）
    env: { ...process.env, APPLIFT_CLI_BIN: resolve(process.argv[1] ?? "") },
  });
  child.unref();

  const deadline = Date.now() + (deps.healthTimeoutMs ?? HEALTH_TIMEOUT_MS);
  while (Date.now() < deadline) {
    // ES2023 lib 无 Promise.withResolvers 类型——executor 形式（与 events.ts 同约定）
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    if (await isAlive(port, fetchImpl)) {
      await mkdir(dirname(portFile), { recursive: true });
      await writeFile(portFile, String(port), "utf8");
      log(`applift ui 已启动：${url}`);
      if (opts.open !== false) openImpl(url);
      return;
    }
  }
  throw new Error(
    `ui-server 启动超时（${HEALTH_TIMEOUT_MS}ms 内 /api/health 未就绪，入口 ${serverEntry}）`,
  );
}

/** --port 参数校验：非法值（非整数/越界）在 spawn 前拒绝——否则 server 回落随机端口成不可回收孤儿 */
export function validatePortArg(n: number): number {
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(
      `--port 非法：${String(n)}（需 1-65535 整数；0 不适用——CLI 需固定端口探测健康并写端口文件）`,
    );
  }
  return n;
}

export function registerUiCommand(program: Command): void {
  program
    .command("ui")
    .description("启动 applift UI 控制台（detach 常驻服务 + 打开浏览器；--stop 停止）")
    .option("--port <n>", "监听端口（默认 47600）", (v: string) => Number(v))
    .option("--stop", "停止运行中的 UI 服务")
    .option("--no-open", "不自动打开浏览器（CI/无头场景）")
    .action(async (cmdOpts: { port?: number; stop?: boolean; open?: boolean }) => {
      if (cmdOpts.stop) {
        await stopUi({}, console.log);
        return;
      }
      await startUi(
        { port: validatePortArg(cmdOpts.port ?? DEFAULT_UI_PORT), open: cmdOpts.open },
        {},
        console.log,
      );
    });
}
