/**
 * createServer 组合层集成测：真 registry/aggregator/ws + 桩 runner。
 * 覆盖：REST(/api/health /api/projects) + 静态 + ws 同端口可用；POST /api/shutdown 一键关停。
 */
import http from "node:http";
import net from "node:net";
import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { createServer, type ComposedServer } from "./index.js";
import { ProjectRegistry } from "./registry.js";
import type { AppliftRunner } from "./runner.js";

const servers: ComposedServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close().catch(() => {})));
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function tmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "composed-"));
  dirs.push(d);
  return d;
}

/** 桩 runner：status --json 回一份健康报告；spawnStream 立即成功退出 */
function stubRunner(): AppliftRunner {
  return {
    run: async (args: string[]) => ({
      code: 0,
      stdout:
        args[0] === "status"
          ? JSON.stringify({
              fetchedAt: "2026-11-14T00:00:00.000Z",
              results: [{ channel: "pgyer", platform: "android", state: "uploaded", live: false }],
            })
          : "",
      stderr: "",
    }),
    spawnStream: () => ({ kill: () => {}, done: Promise.resolve({ code: 0 }) }),
  } as unknown as AppliftRunner;
}

describe("createServer 组合层", () => {
  it("REST + 静态 + ws 同端口可用，shutdown 一键关停", async () => {
    const dir = await tmpDir();
    await writeFile(join(dir, "index.html"), "<html>ui</html>", "utf8");
    const registry = new ProjectRegistry(join(dir, "projects.json"));
    await registry.add(dir);
    const server = await createServer({
      port: 0,
      staticDir: dir,
      registry,
      runnerFactory: () => stubRunner(),
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    // REST：health + projects
    const health = await fetch(`${base}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });
    const projects = await fetch(`${base}/api/projects`);
    expect(projects.status).toBe(200);

    // 静态托管
    const html = await fetch(`${base}/`);
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("ui");

    // ws 同端口升级 + 连接触发 aggregator 前台档
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const { promise: opened, resolve: resolveOpen } = Promise.withResolvers<void>();
    ws.on("open", resolveOpen);
    await opened;
    expect(server.aggregator).toBeDefined();
    ws.close();

    // F2：Host 校验——恶意页面 no-cors POST（外域 Host）403 拒绝且不关停
    // （fetch 会按 spec 静默丢弃 Host 禁改头，故走 node:http 原生请求）
    const evilStatus = await new Promise<number>((resolveStatus, rejectStatus) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: server.port,
          path: "/api/shutdown",
          method: "POST",
          headers: { Host: "evil.com" },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolveStatus(res.statusCode ?? 0));
        },
      );
      req.on("error", rejectStatus);
      req.end();
    });
    expect(evilStatus).toBe(403);
    const stillAlive = await fetch(`${base}/api/health`);
    expect(stillAlive.status).toBe(200);

    // shutdown：localhost Host 放行，200 响应后端口不可再达（全链路 close）
    const shutdownStatus = await new Promise<number>((resolveStatus, rejectStatus) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: server.port,
          path: "/api/shutdown",
          method: "POST",
          headers: { Host: `localhost:${server.port}` },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolveStatus(res.statusCode ?? 0));
        },
      );
      req.on("error", rejectStatus);
      req.end();
    });
    expect(shutdownStatus).toBe(200);
    // 真实时钟轮询（集成测例外：关停由服务端异步完成且经真实 TCP 体现，假 timer 驱动不了 socket 事件）
    const refused = async (): Promise<boolean> =>
      new Promise((r) => {
        const sock = net.connect(server.port, "127.0.0.1");
        sock.once("error", () => r(true));
        sock.once("connect", () => {
          sock.destroy();
          r(false);
        });
      });
    let gone = false;
    for (let i = 0; i < 50 && !gone; i++) {
      gone = await refused();
      if (!gone) await new Promise((r) => setTimeout(r, 100));
    }
    expect(gone).toBe(true);
  });

  it("staticDir 缺省指向 dist/public（不存在时服务照常起，静态 404）", async () => {
    const dir = await tmpDir();
    const server = await createServer({
      port: 0,
      staticDir: join(dir, "no-such-public"),
      registry: new ProjectRegistry(join(dir, "projects.json")),
      runnerFactory: () => stubRunner(),
    });
    servers.push(server);
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(res.status).toBe(404);
    const health = await fetch(`http://127.0.0.1:${server.port}/api/health`);
    expect(health.status).toBe(200);
  });

  it("I-1 冷启动即时刷新：createServer 后不等定时器即有 snapshot；health 透出 refreshIntervalMs", async () => {
    const dir = await tmpDir();
    await writeFile(join(dir, "index.html"), "<html>ui</html>", "utf8");
    const registry = new ProjectRegistry(join(dir, "projects.json"));
    await registry.add(dir);
    let statusCalls = 0;
    const runnerFactory = (): AppliftRunner => {
      statusCalls++;
      return stubRunner();
    };
    const server = await createServer({
      registry,
      runnerFactory,
      staticDir: dir,
      port: 0,
      // 测试封闭性：注入临时 settings.json，避免读到开发机真实档位（默认档断言会挂）
      settingsPath: join(dir, "settings.json"),
    });
    servers.push(server);

    // 启动即发起一轮（不等前台档默认 5min 定时器）
    await vi.waitFor(() => expect(statusCalls).toBeGreaterThan(0));

    // 首个 WS 连接即刻拿到缓存 snapshot（连接即回放，不等下一轮轮询）
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    ws.on("message", (raw) => {
      if (String(raw).includes('"t":"snapshot"')) resolve();
    });
    ws.once("error", reject);
    await promise;
    ws.close();

    // health 带服务端当前档位间隔（前台档默认 5min）
    const health = (await (await fetch(`http://127.0.0.1:${server.port}/api/health`)).json()) as {
      refreshIntervalMs?: number;
    };
    expect(health.refreshIntervalMs).toBe(5 * 60_000);
  });
});
