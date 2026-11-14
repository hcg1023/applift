import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

  it("beta：registry 解析 cwd → startBetaTask（args 透传校验）；返回 taskId", async () => {
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
            return "task-1";
          },
        }),
      ],
    });

    const res = await fetch(`http://127.0.0.1:${srv.port}/api/tasks/beta`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: entry.id,
        platform: "harmony",
        args: ["--note", "测试"],
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
        args: ["--interactive-events", "--note", "测试"],
      },
    ]);

    // 非字符串 args → 丢弃用户参数（旗标仍自动补）
    const res2 = await fetch(`http://127.0.0.1:${srv.port}/api/tasks/beta`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: entry.id, platform: "android", args: ["--note", 42] }),
    });
    expect(res2.status).toBe(200);
    expect(started[1]).toMatchObject({ args: ["--interactive-events"] });
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
