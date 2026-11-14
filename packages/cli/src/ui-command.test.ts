/**
 * `applift ui` 生命周期单测：注入 fake（fetch/spawn/open）验证 detach spawn、幂等只开浏览器、--stop 链路。
 * 不真起服务、不真开浏览器。
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type * as cp from "node:child_process";

import { startUi, stopUi, DEFAULT_UI_PORT, validatePortArg } from "./ui-command.js";
type SpawnCall = { cmd: string; args: string[]; opts: SpawnOptions; child: ChildProcess };

/** spawn 桩：记录每次调用并回填可断言的 fake child（含 unref 桩） */
function spawnStub(onSpawn?: () => void): { impl: typeof cp.spawn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const impl = ((cmd: string, args: string[], opts: SpawnOptions) => {
    const unref = vi.fn();
    const child = { unref } as unknown as ChildProcess; // 桩只实现被测路径用到的 unref
    calls.push({ cmd, args, opts, child });
    onSpawn?.();
    return child;
  }) as unknown as typeof cp.spawn;
  return { impl, calls };
}

function fakeFetch(urls: { health?: () => boolean; shutdown?: () => boolean }): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    const ok = url.endsWith("/api/health")
      ? (urls.health?.() ?? false)
      : url.endsWith("/api/shutdown")
        ? (urls.shutdown?.() ?? true)
        : false;
    return new Response(JSON.stringify({ ok }), {
      status: ok ? 200 : 503,
    }) as unknown as globalThis.Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("startUi", () => {
  it("冷启动：detach spawn server 入口 + 等健康 + 写端口文件 + 开浏览器", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ui-cmd-"));
    const portFile = join(dir, "ui.port");
    // 冷启动语义：spawn 前健康必不通，spawn 后（首轮轮询）就绪
    let healthy = false;
    const { fetchImpl } = fakeFetch({ health: () => healthy });
    const spawn = spawnStub(() => {
      healthy = true; // 桩 server “进程”起后健康即通
    });
    const openImpl = vi.fn();
    await startUi(
      { port: 47888, open: true },
      {
        portFile,
        serverEntry: "/fake/server/main.mjs",
        fetchImpl,
        spawnImpl: spawn.impl,
        openImpl,
      },
    );
    expect(spawn.calls).toHaveLength(1);
    const call = spawn.calls[0];
    if (!call) throw new Error("spawn 未被调用");
    expect(call.cmd).toBe(process.execPath);
    expect(call.args).toEqual(["/fake/server/main.mjs", "--port", "47888"]);
    expect(call.opts.detached).toBe(true);
    expect(call.opts.stdio).toBe("ignore");
    expect(vi.mocked(call.child.unref as () => void)).toHaveBeenCalled();
    expect(await readFile(portFile, "utf8")).toBe("47888");
    expect(openImpl).toHaveBeenCalledWith("http://127.0.0.1:47888");
    await rm(dir, { recursive: true, force: true });
  });

  it("幂等：端口文件 + health 通 → 不 spawn，只开浏览器", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ui-cmd-"));
    const portFile = join(dir, "ui.port");
    await writeFile(portFile, "47999", "utf8");
    const { fetchImpl } = fakeFetch({ health: () => true });
    const spawn = spawnStub();
    const openImpl = vi.fn();
    await startUi(
      { port: DEFAULT_UI_PORT, open: true },
      { portFile, fetchImpl, spawnImpl: spawn.impl, openImpl, serverEntry: "/x" },
    );
    expect(spawn.calls).toHaveLength(0);
    expect(openImpl).toHaveBeenCalledWith("http://127.0.0.1:47999");
    await rm(dir, { recursive: true, force: true });
  });

  it("健康超时：抛错不写端口文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ui-cmd-"));
    const portFile = join(dir, "ui.port");
    const { fetchImpl } = fakeFetch({ health: () => false });
    const logs: string[] = [];
    await expect(
      startUi(
        { port: 47888, open: false },
        {
          portFile,
          serverEntry: "/fake",
          fetchImpl,
          spawnImpl: spawnStub().impl,
          healthTimeoutMs: 10,
        },
        (m) => logs.push(m),
      ),
    ).rejects.toThrow(/超时/);
    await expect(readFile(portFile, "utf8")).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });

  it("--no-open：不起浏览器命令", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ui-cmd-"));
    const portFile = join(dir, "ui.port");
    const { fetchImpl } = fakeFetch({ health: () => true });
    const openImpl = vi.fn();
    await startUi(
      { port: 47888, open: false },
      { portFile, serverEntry: "/fake", fetchImpl, spawnImpl: spawnStub().impl, openImpl },
    );
    expect(openImpl).not.toHaveBeenCalled();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("stopUi", () => {
  it("POST /api/shutdown 并删除端口文件", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ui-cmd-"));
    const portFile = join(dir, "ui.port");
    await writeFile(portFile, "47888", "utf8");
    const { fetchImpl, calls } = fakeFetch({ shutdown: () => true });
    const logs: string[] = [];
    await stopUi({ portFile, fetchImpl }, (m) => logs.push(m));
    expect(calls).toContain("POST http://127.0.0.1:47888/api/shutdown");
    await expect(readFile(portFile, "utf8")).rejects.toThrow();
    expect(logs[0]).toContain("47888");
    await rm(dir, { recursive: true, force: true });
  });

  it("无端口文件：提示而非报错", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ui-cmd-"));
    const { fetchImpl } = fakeFetch({});
    const logs: string[] = [];
    await stopUi({ portFile: join(dir, "none"), fetchImpl }, (m) => logs.push(m));
    expect(logs[0]).toContain("没有运行中");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("validatePortArg（F1：非法端口 spawn 前拒绝）", () => {
  it.each([Number.NaN, 70000, -1, 0, 47600.5])("拒绝 %s", (v) => {
    expect(() => validatePortArg(v as number)).toThrow(/--port 非法/);
  });

  it("合法端口原样通过", () => {
    expect(validatePortArg(1)).toBe(1);
    expect(validatePortArg(47600)).toBe(47600);
    expect(validatePortArg(65535)).toBe(65535);
  });
});
