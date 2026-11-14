import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { join } from "node:path";
import { startUiServer } from "./http.js";
import { createTaskRoutes, type BetaDryRunReport } from "./routes.js";
import { ProjectRegistry } from "./registry.js";
import { AppliftRunner, type RunResult } from "./runner.js";

const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** dry-run 桩：断言入参形状（beta <platform> --dry-run --json）并回固定报告 */
const DRY_RUN_REPORT: BetaDryRunReport = {
  platform: "android",
  provider: "stub-update",
  recommendation: "ota",
  confidence: "high",
  evidence: [{ path: "src/a.ts", rule: "JS 层" }],
  note: "判定：ota（high）",
};

/** runner 桩：不 spawn，直接回放 run 结果并记录调用 */
function recordingRunner(
  calls: Array<{ args: string[]; cwd?: string }>,
  cwd: string,
  result: RunResult,
): AppliftRunner {
  const r = new AppliftRunner({ cwd });
  r.run = (args) => {
    calls.push({ args, cwd });
    return Promise.resolve(result);
  };
  return r;
}

describe("任务路由（POST /api/tasks/beta + /api/tasks/dry-run）", () => {
  it("dry-run：runner 收 [beta,platform,--dry-run,--json] + 项目 cwd；报告透传", async () => {
    const calls: Array<{ args: string[]; cwd?: string }> = [];
    const storeDir = await mkdtemp(join(tmpdir(), "tasks-test-"));
    tmpDirs.push(storeDir);
    const projDir = join(storeDir, "my-app");
    await mkdir(projDir, { recursive: true });
    const registry = new ProjectRegistry(join(storeDir, "projects.json"));
    const entry = await registry.add(projDir);

    const okResult: RunResult = {
      code: 0,
      stdout: JSON.stringify(DRY_RUN_REPORT),
      stderr: "",
    };
    const runnerFactory = (cwd: string): AppliftRunner => recordingRunner(calls, cwd, okResult);

    const staticDir = await mkdtemp(join(tmpdir(), "tasks-static-"));
    tmpDirs.push(staticDir);
    await writeFile(join(staticDir, "index.html"), "<html>t</html>", "utf8");
    const srv = await startUiServer({
      staticDir,
      registry,
      extraApiHandlers: [
        createTaskRoutes({ registry, runnerFactory, startBetaTask: () => "never" }),
      ],
    });

    const res = await fetch(`http://127.0.0.1:${srv.port}/api/tasks/dry-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: entry.id, platform: "android" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; report: BetaDryRunReport };
    expect(body.ok).toBe(true);
    expect(body.report.recommendation).toBe("ota");
    expect(body.report.evidence[0]?.path).toBe("src/a.ts");
    expect(calls).toEqual([{ args: ["beta", "android", "--dry-run", "--json"], cwd: projDir }]);
    await srv.close();
  });

  it("beta：cwd 解析 + --delivery 白名单透传（旗标自动补）；其余 args 400", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "tasks-test2-"));
    tmpDirs.push(storeDir);
    const projDir = join(storeDir, "app2");
    await mkdir(projDir, { recursive: true });
    const registry = new ProjectRegistry(join(storeDir, "projects.json"));
    const entry = await registry.add(projDir);

    const started: Array<{ projectId: string; platform: string; cwd: string; args?: string[] }> =
      [];
    const staticDir = await mkdtemp(join(tmpdir(), "tasks-static2-"));
    tmpDirs.push(staticDir);
    await writeFile(join(staticDir, "index.html"), "<html>t</html>", "utf8");
    const srv = await startUiServer({
      staticDir,
      registry,
      extraApiHandlers: [
        createTaskRoutes({
          registry,
          runnerFactory: (cwd) => new AppliftRunner({ cwd }),
          startBetaTask: (projectId, platform, opts) => {
            started.push({ projectId, platform, ...opts });
            return `task-${started.length}`;
          },
        }),
      ],
    });
    const base = `http://127.0.0.1:${srv.port}`;

    // 白名单内：--delivery native → 旗标前缀拼接透传
    const res = await fetch(`${base}/api/tasks/beta`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: entry.id,
        platform: "harmony",
        args: ["--delivery", "native"],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; taskId: string };
    expect(body).toEqual({ ok: true, taskId: "task-1" });
    expect(started).toEqual([
      {
        projectId: entry.id,
        platform: "harmony",
        cwd: projDir,
        args: ["--interactive-events", "--delivery", "native"],
      },
    ]);

    // 白名单外（--yes / --note / 未知旗标）→ 400，任务不发起
    for (const bad of [
      ["--yes"],
      ["--note", "x"],
      ["--delivery", "uncertain"],
      ["--cwd", "/etc"],
    ]) {
      const r = await fetch(`${base}/api/tasks/beta`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: entry.id, platform: "android", args: bad }),
      });
      expect(r.status, `args=${bad.join(",")}`).toBe(400);
    }
    expect(started).toHaveLength(1);
    await srv.close();
  });

  it("Host 校验：非本机 Host → 403 不发起（与 shutdown 同款）", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "tasks-test5-"));
    tmpDirs.push(storeDir);
    const registry = new ProjectRegistry(join(storeDir, "projects.json"));
    const entry = await registry.add(join(storeDir, "app5"));
    const started: string[] = [];
    const staticDir = await mkdtemp(join(tmpdir(), "tasks-static5-"));
    tmpDirs.push(staticDir);
    await writeFile(join(staticDir, "index.html"), "<html>t</html>", "utf8");
    const srv = await startUiServer({
      staticDir,
      registry,
      extraApiHandlers: [
        createTaskRoutes({
          registry,
          runnerFactory: (cwd) => new AppliftRunner({ cwd }),
          startBetaTask: (_p, plat) => {
            started.push(plat);
            return "t";
          },
        }),
      ],
    });

    // fetch 按 spec 静默丢弃 Host 禁改头——用 node:http 原生请求带伪造 Host
    const evil = await new Promise<{ status: number; body: { ok: boolean } }>((resolve) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: srv.port,
          path: "/api/tasks/beta",
          method: "POST",
          headers: { host: "evil.com", "content-type": "application/json" },
        },
        (r) => {
          let d = "";
          r.on("data", (c) => (d += c));
          r.on("end", () => resolve({ status: r.statusCode ?? 0, body: JSON.parse(d) }));
        },
      );
      req.end(JSON.stringify({ projectId: entry.id, platform: "android" }));
    });
    expect(evil.status).toBe(403);
    expect(evil.body.ok).toBe(false);
    // dry-run 同款防护
    const evil2 = await new Promise<number>((resolve) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: srv.port,
          path: "/api/tasks/dry-run",
          method: "POST",
          headers: { host: "evil.example", "content-type": "application/json" },
        },
        (r) => resolve(r.statusCode ?? 0),
      );
      req.end(JSON.stringify({ projectId: entry.id, platform: "android" }));
    });
    expect(evil2).toBe(403);
    expect(started).toHaveLength(0);
    await srv.close();
  });

  it("未知项目 404；非法平台 400；非 POST 405", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "tasks-test3-"));
    tmpDirs.push(storeDir);
    const registry = new ProjectRegistry(join(storeDir, "projects.json"));
    const entry = await registry.add(join(storeDir, "app3"));

    const staticDir = await mkdtemp(join(tmpdir(), "tasks-static3-"));
    tmpDirs.push(staticDir);
    await writeFile(join(staticDir, "index.html"), "<html>t</html>", "utf8");
    const srv = await startUiServer({
      staticDir,
      registry,
      extraApiHandlers: [
        createTaskRoutes({
          registry,
          runnerFactory: (cwd) => new AppliftRunner({ cwd }),
          startBetaTask: () => "x",
        }),
      ],
    });
    const base = `http://127.0.0.1:${srv.port}`;

    const miss = await fetch(`${base}/api/tasks/beta`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "nope", platform: "android" }),
    });
    expect(miss.status).toBe(404);

    const badPlat = await fetch(`${base}/api/tasks/beta`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: entry.id, platform: "windows" }),
    });
    expect(badPlat.status).toBe(400);

    const get = await fetch(`${base}/api/tasks/beta`);
    expect(get.status).toBe(405);
    await srv.close();
  });

  it("dry-run 输出不可解析 → 502 带 error", async () => {
    const storeDir = await mkdtemp(join(tmpdir(), "tasks-test4-"));
    tmpDirs.push(storeDir);
    const projDir = join(storeDir, "app4");
    await mkdir(projDir, { recursive: true });
    const registry = new ProjectRegistry(join(storeDir, "projects.json"));
    const entry = await registry.add(projDir);

    const staticDir = await mkdtemp(join(tmpdir(), "tasks-static4-"));
    tmpDirs.push(staticDir);
    await writeFile(join(staticDir, "index.html"), "<html>t</html>", "utf8");
    const srv = await startUiServer({
      staticDir,
      registry,
      extraApiHandlers: [
        createTaskRoutes({
          registry,
          runnerFactory: () =>
            new AppliftRunner({
              bin: [process.execPath, "-e", 'process.stdout.write("not json");process.exit(1)'],
            }),
          startBetaTask: () => "x",
        }),
      ],
    });

    const res = await fetch(`http://127.0.0.1:${srv.port}/api/tasks/dry-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: entry.id, platform: "ios" }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("无法解析");
    await srv.close();
  });
});
