import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { AppliftRunner, findGlobalApplift, resolveAppliftBin, toSpawnCommand } from "./runner.js";
import { join } from "node:path";
import { request } from "node:http";
import { startUiServer } from "./http.js";
import { WsChannel } from "./ws.js";
import { createAppliftRoutes, cliBinPath } from "./routes.js";
import { createAvailabilityProber, type Availability } from "./applift-install.js";
import WebSocket from "ws";

const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function tmpDir(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

/** 可执行桩脚本（带 shebang；回显一行后退出 0） */
async function exeStub(dir: string, name: string, stdout: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, `#!/bin/sh\necho ${JSON.stringify(stdout)}\n`, "utf8");
  await chmod(p, 0o755);
  return p;
}

describe("resolveAppliftBin 检索链", () => {
  it("优先级：APPLIFT_CLI_BIN env > 工程 node_modules/.bin > PATH > null", async () => {
    const root = await tmpDir("bin-chain-");
    const proj = join(root, "proj");
    const globalBin = join(root, "globalbin");
    await mkdir(join(proj, "node_modules", ".bin"), { recursive: true });
    await mkdir(globalBin, { recursive: true });
    const projBin = await exeStub(join(proj, "node_modules", ".bin"), "applift", "0.1.0");
    const globalPath = await exeStub(globalBin, "applift", "0.2.0");
    const envBin = join(root, "cli", "dist", "bin.mjs");

    // 全空 → null（cwd 无工程 bin 且 PATH 无 applift；env 未设）
    expect(resolveAppliftBin(root, { cliBinEnv: "", pathEnv: root })).toEqual({
      bin: null,
      source: null,
    });

    // 仅全局（cwd 仍无工程 bin）
    expect(resolveAppliftBin(root, { cliBinEnv: "", pathEnv: globalBin })).toEqual({
      bin: [globalPath],
      source: "global",
    });

    // 工程 > 全局
    expect(resolveAppliftBin(proj, { cliBinEnv: "", pathEnv: globalBin })).toEqual({
      bin: [projBin],
      source: "project",
    });

    // env 最高（cwd 有工程 bin 也压不过）；空串视为未设
    expect(resolveAppliftBin(proj, { cliBinEnv: "  ", pathEnv: globalBin })).toEqual({
      bin: [projBin],
      source: "project",
    });
    expect(resolveAppliftBin(proj, { cliBinEnv: envBin, pathEnv: globalBin })).toEqual({
      bin: [process.execPath, envBin],
      source: "env",
    });
  });

  it("findGlobalApplift：PATH 无 applift 时 null；可注入 pathEnv", async () => {
    expect(findGlobalApplift(await tmpDir("empty-path-"))).toBeNull();
  });

  it("F2 toSpawnCommand：win32 下 .cmd/.bat 与裸 npm/npx 经 cmd.exe /c；其余平台原样 [未实机]", () => {
    // win32：批处理 shim / npm / npx → cmd.exe /c 形态（Node 无 shell 直 spawn EINVAL/ENOENT）
    expect(toSpawnCommand(["C:\\x\\applift.cmd", "--version"], "win32")).toEqual([
      "cmd.exe",
      "/c",
      "C:\\x\\applift.cmd",
      "--version",
    ]);
    expect(toSpawnCommand(["npm", "install", "-g", "@applift/cli"], "win32")).toEqual([
      "cmd.exe",
      "/c",
      "npm",
      "install",
      "-g",
      "@applift/cli",
    ]);
    // 可执行文件（.exe）与非 win32 平台原样
    expect(toSpawnCommand(["C:\\x\\applift.exe"], "win32")).toEqual(["C:\\x\\applift.exe"]);
    expect(toSpawnCommand(["npm", "install"], "darwin")).toEqual(["npm", "install"]);
    expect(toSpawnCommand([], "win32")).toEqual([]);
  });
});

describe("createAvailabilityProber", () => {
  it("工程+全局双源、版本探测 60s 缓存、latest 获取", async () => {
    const root = await tmpDir("avail-");
    const proj = join(root, "proj");
    const globalBin = join(root, "globalbin");
    await mkdir(join(proj, "node_modules", ".bin"), { recursive: true });
    await mkdir(globalBin, { recursive: true });
    await exeStub(join(proj, "node_modules", ".bin"), "applift", "0.1.0");
    await exeStub(globalBin, "applift", "0.2.0");

    const probe = vi.fn(async (bin: string[]) =>
      bin.join(" ").includes("globalbin") ? "0.2.0" : "0.1.0",
    );
    const prober = createAvailabilityProber({
      probeVersion: probe,
      fetchLatest: async () => "0.14.2",
      pathEnv: globalBin,
    });

    const a1 = await prober.get(proj);
    expect(a1.nodeVersion).toBe(process.version);
    expect(a1.nodeOk).toBe(true);
    expect(a1.latest).toBe("0.14.2");
    expect(a1.sources).toEqual([
      { kind: "project", path: join(proj, "node_modules", ".bin", "applift"), version: "0.1.0" },
      { kind: "global", path: join(globalBin, "applift"), version: "0.2.0" },
    ]);
    // 缓存：第二次 get 不重复探测
    await prober.get(proj);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("无来源空列表；npm view 失败/超时 → latest null 不拖垮整体", async () => {
    const prober = createAvailabilityProber({
      fetchLatest: async () => null,
      pathEnv: await tmpDir("no-applift-path-"),
    });
    const a = await prober.get();
    expect(a.sources).toEqual([]);
    expect(a.latest).toBeNull();
  });

  it("F1 invalidate：安装结束失效缓存，立即重探测拿新版本", async () => {
    const root = await tmpDir("avail-inv-");
    const proj = join(root, "proj");
    await mkdir(join(proj, "node_modules", ".bin"), { recursive: true });
    await exeStub(join(proj, "node_modules", ".bin"), "applift", "0.1.0");

    let version = "0.1.0";
    const prober = createAvailabilityProber({
      probeVersion: async () => version,
      fetchLatest: async () => "0.14.2",
    });
    expect((await prober.get(proj)).sources[0]?.version).toBe("0.1.0");
    // 缓存生效：探测源已升级也拿旧值
    version = "0.15.0";
    expect((await prober.get(proj)).sources[0]?.version).toBe("0.1.0");
    // invalidate 后重探测拿新值
    prober.invalidate();
    expect((await prober.get(proj)).sources[0]?.version).toBe("0.15.0");
  });
});

describe("WsChannel.startInstallTask", () => {
  it("事件流：install.log(stderr) → install.result(ok) → task.end；taskId 前缀 install:", async () => {
    const root = await tmpDir("install-");
    // npm 桩：stderr 一行 + stdout 纯文本一行后退出 0
    const stub = join(root, "npm-stub.cjs");
    await writeFile(
      stub,
      `process.stderr.write("npm warn deprecated\\n");process.stdout.write("added 1 package\\n");process.exit(0);`,
      "utf8",
    );
    const server = await startUiServer({ port: 0, staticDir: await tmpDir("static-") });
    const channel = new WsChannel({ runnerFactory: () => new AppliftRunner() });
    channel.attach(server.httpServer);

    type Down = { t: string; taskId?: string; data?: Record<string, unknown> };
    const events: Down[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const { promise: opened, resolve: openedResolve } = Promise.withResolvers<void>();
    ws.once("open", () => openedResolve());
    ws.on("message", (raw) => events.push(JSON.parse(String(raw)) as Down));
    await opened;

    const taskId = channel.startInstallTask({ runner: new AppliftRunner({ bin: `node ${stub}` }) });
    expect(taskId.startsWith("install:")).toBe(true);

    await vi.waitFor(() => {
      const logErr = events.find(
        (e) => e.t === "task" && e.data?.type === "install.log" && e.data?.level === "error",
      );
      const logInfo = events.find(
        (e) => e.t === "task" && e.data?.type === "install.log" && e.data?.level === "info",
      );
      const result = events.find((e) => e.t === "task" && e.data?.type === "install.result");
      const end = events.find((e) => e.t === "task.end" && e.taskId === taskId);
      expect(logErr).toBeDefined();
      expect(logInfo).toBeDefined();
      expect(result?.data?.ok).toBe(true);
      expect(end).toBeDefined();
    });
    ws.close();
    await channel.close();
    await server.close();
  });

  it("去重：进行中再发起抛错（含既有 taskId）", async () => {
    const root = await tmpDir("install2-");
    const stub = join(root, "hang.cjs");
    await writeFile(
      stub,
      `process.stderr.write("installing\\n");setInterval(()=>{},60000);`,
      "utf8",
    );
    const server = await startUiServer({ port: 0, staticDir: await tmpDir("static2-") });
    const channel = new WsChannel({ runnerFactory: () => new AppliftRunner() });
    channel.attach(server.httpServer);
    const runner = new AppliftRunner({ bin: `node ${stub}` });
    const taskId = channel.startInstallTask({ runner });
    expect(() => channel.startInstallTask({ runner, update: true })).toThrowError(
      new RegExp(taskId.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    // 清理：杀掉挂起任务
    await channel.close();
    await server.close();
  });

  it("F3 看门狗：短超时注入 → warn log + kill + result(ok:false) + onDone；去重位释放", async () => {
    const root = await tmpDir("install3-");
    const stub = join(root, "hang2.cjs");
    await writeFile(stub, `setInterval(()=>{},60000);`, "utf8");
    const server = await startUiServer({ port: 0, staticDir: await tmpDir("static3-") });
    const channel = new WsChannel({ runnerFactory: () => new AppliftRunner() });
    channel.attach(server.httpServer);

    type Down = { t: string; taskId?: string; data?: Record<string, unknown> };
    const events: Down[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const { promise: opened, resolve: openedResolve } = Promise.withResolvers<void>();
    ws.once("open", () => openedResolve());
    ws.on("message", (raw) => events.push(JSON.parse(String(raw)) as Down));
    await opened;

    let onDoneCalls = 0;
    const taskId = channel.startInstallTask({
      runner: new AppliftRunner({ bin: `node ${stub}` }),
      timeoutMs: 150,
      onDone: () => {
        onDoneCalls += 1;
      },
    });

    await vi.waitFor(() => {
      const warn = events.find(
        (e) => e.t === "task" && e.data?.type === "install.log" && e.data?.level === "warn",
      );
      const result = events.find(
        (e) => e.t === "task" && e.taskId === taskId && e.data?.type === "install.result",
      );
      expect(warn).toBeDefined();
      expect(result?.data?.ok).toBe(false);
      expect(events.find((e) => e.t === "task.end" && e.taskId === taskId)).toBeDefined();
      expect(onDoneCalls).toBe(1);
    });
    // 去重位已释放：可再次发起
    const second = channel.startInstallTask({
      runner: new AppliftRunner({ bin: `node ${stub}` }),
      timeoutMs: 150,
    });
    expect(second).not.toBe(taskId);
    ws.close();
    await channel.close();
    await server.close();
  });

  it("F3 onDone：任务正常成功结束也触发（缓存失效接线语义）", async () => {
    const root = await tmpDir("install4-");
    const stub = join(root, "ok.cjs");
    await writeFile(stub, `process.exit(0);`, "utf8");
    const server = await startUiServer({ port: 0, staticDir: await tmpDir("static4-") });
    const channel = new WsChannel({ runnerFactory: () => new AppliftRunner() });
    channel.attach(server.httpServer);
    const { promise, resolve } = Promise.withResolvers<void>();
    channel.startInstallTask({
      runner: new AppliftRunner({ bin: `node ${stub}` }),
      onDone: resolve,
    });
    await promise;
    await channel.close();
    await server.close();
  });

  it("R2-F1 confirm 上行不解除 install 看门狗（仍按时触发 kill）", async () => {
    const root = await tmpDir("install5-");
    const stub = join(root, "hang5.cjs");
    await writeFile(stub, `setInterval(()=>{},60000);`, "utf8");
    const server = await startUiServer({ port: 0, staticDir: await tmpDir("static5-") });
    const channel = new WsChannel({ runnerFactory: () => new AppliftRunner() });
    channel.attach(server.httpServer);

    type Down = { t: string; taskId?: string; data?: Record<string, unknown> };
    const events: Down[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const { promise: opened, resolve: openedResolve } = Promise.withResolvers<void>();
    ws.once("open", () => openedResolve());
    ws.on("message", (raw) => events.push(JSON.parse(String(raw)) as Down));
    await opened;

    const taskId = channel.startInstallTask({
      runner: new AppliftRunner({ bin: `node ${stub}` }),
      timeoutMs: 300,
    });
    // 恶意/误发 confirm 上行：不得清掉 install 看门狗
    ws.send(JSON.stringify({ t: "confirm", taskId, id: "chk1", value: "ota" }));
    await vi.waitFor(() => {
      const warn = events.find(
        (e) => e.t === "task" && e.data?.type === "install.log" && e.data?.level === "warn",
      );
      const end = events.find((e) => e.t === "task.end" && e.taskId === taskId);
      expect(warn).toBeDefined();
      expect(end).toBeDefined();
    });
    ws.close();
    await channel.close();
    await server.close();
  });
});

describe("R2-F3 cliBinPath env trim", () => {
  it("带空白的 APPLIFT_CLI_BIN 返回 trim 后路径", () => {
    const saved = process.env.APPLIFT_CLI_BIN;
    process.env.APPLIFT_CLI_BIN = "  /opt/applift/bin.mjs\n";
    try {
      expect(cliBinPath()).toBe("/opt/applift/bin.mjs");
    } finally {
      if (saved === undefined) delete process.env.APPLIFT_CLI_BIN;
      else process.env.APPLIFT_CLI_BIN = saved;
    }
  });
});

describe("applift 路由", () => {
  async function setupRoute(opts?: {
    availability?: (cwd?: string) => Promise<Availability>;
    startInstallTask?: (o: { update?: boolean }) => string;
  }) {
    const availability =
      opts?.availability ??
      (async () => ({
        nodeVersion: "v22.0.0",
        nodeOk: true,
        sources: [],
        latest: "0.14.2",
      }));
    const startInstallTask =
      opts?.startInstallTask ??
      ((o) => (o.update === true ? "install:update-1" : "install:plain-1"));
    const staticDir = await tmpDir("route-static-");
    await writeFile(join(staticDir, "index.html"), "<html>t</html>", "utf8");
    const srv = await startUiServer({
      staticDir,
      extraApiHandlers: [createAppliftRoutes({ availability, startInstallTask })],
    });
    return srv;
  }

  /** 指定 Host 头的裸请求 */
  function rawReq(
    port: number,
    method: string,
    path: string,
    host: string,
  ): Promise<{ status: number; body: string }> {
    const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
    const req = request(
      { host: "127.0.0.1", port, method, path, headers: { host }, setHost: false },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
    return promise;
  }

  it("GET availability：透传探测结果 + path 查询参；无 Host 校验（外源 Host 也 200）", async () => {
    const seenCwd: Array<string | undefined> = [];
    const srv = await setupRoute({
      availability: async (cwd) => {
        seenCwd.push(cwd);
        return { nodeVersion: "v22.0.0", nodeOk: true, sources: [], latest: "0.15.0" };
      },
    });
    const base = `http://127.0.0.1:${srv.port}`;
    const res = await fetch(`${base}/api/applift/availability?path=/tmp/some-proj`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      nodeVersion: "v22.0.0",
      nodeOk: true,
      sources: [],
      latest: "0.15.0",
    });
    expect(seenCwd).toEqual(["/tmp/some-proj"]);
    const foreign = await rawReq(srv.port, "GET", "/api/applift/availability", "evil.example");
    expect(foreign.status).toBe(200);
    await srv.close();
  });

  it("POST install / update-global：Host 校验 403 + 正常发起透传 update 旗标", async () => {
    const started: Array<{ update?: boolean }> = [];
    const srv = await setupRoute({
      startInstallTask: (o) => {
        started.push(o);
        return `install:tid-${started.length}`;
      },
    });
    const base = `http://127.0.0.1:${srv.port}`;

    const forbidden = await rawReq(srv.port, "POST", "/api/applift/install", "evil.example");
    expect(forbidden.status).toBe(403);

    const r1 = await fetch(`${base}/api/applift/install`, { method: "POST" });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ ok: true, taskId: "install:tid-1" });

    const r2 = await fetch(`${base}/api/applift/update-global`, { method: "POST" });
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ ok: true, taskId: "install:tid-2" });
    expect(started).toEqual([{ update: false }, { update: true }]);
    await srv.close();
  });

  it("POST install 进行中重复 → 409；availability 非 GET → 405", async () => {
    const srv = await setupRoute({
      startInstallTask: () => {
        throw new Error("已有进行中的安装任务（taskId: install:abc）");
      },
    });
    const base = `http://127.0.0.1:${srv.port}`;
    const r = await fetch(`${base}/api/applift/install`, { method: "POST" });
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error?: string };
    expect(body.error).toContain("install:abc");

    const m = await fetch(`${base}/api/applift/availability`, { method: "POST" });
    expect(m.status).toBe(405);
    await srv.close();
  });
});
