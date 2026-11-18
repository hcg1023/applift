/**
 * GET /api/fs/roots + /api/fs/list（服务端目录浏览器）：
 * 临时目录桩——一层子目录 + applift.config.ts 高亮标记；不存在/文件路径 → 400；
 * 外域 Host（恶意页/DNS rebinding 探测本机目录拓扑）→ 403。
 */
import http from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ComposedServer } from "./index.js";
import { ProjectRegistry } from "./registry.js";

const servers: ComposedServer[] = [];
const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close().catch(() => {})));
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("Host 校验（fs/roots + fs/list）", () => {
  it("外域 Host → 403（浏览器页面可对任意地址发 GET 探测本机目录）", async () => {
    const dir = await tmpDir();
    const server = await createServer({
      port: 0,
      registry: new ProjectRegistry(join(dir, "projects.json")),
    });
    servers.push(server);
    for (const path of ["/api/fs/roots", `/api/fs/list?dir=${encodeURIComponent(dir)}`]) {
      const { promise, resolve, reject } = Promise.withResolvers<number>();
      const req = http.request(
        { host: "127.0.0.1", port: server.port, path, headers: { host: "evil.com" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
      expect(await promise).toBe(403);
    }
  });
});

async function tmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "fs-routes-"));
  dirs.push(d);
  return d;
}

async function startServer(): Promise<string> {
  const dir = await tmpDir();
  const server = await createServer({
    port: 0,
    registry: new ProjectRegistry(join(dir, "projects.json")),
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

describe("GET /api/fs/roots", () => {
  it("返回存在的起始根（home 本身必在；含路径字段）", async () => {
    const base = await startServer();
    const res = await fetch(`${base}/api/fs/roots`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      roots: Array<{ name: string; path: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.roots.length).toBeGreaterThan(0);
    expect(body.roots[0]!.path.startsWith("/")).toBe(true);
  });
});

describe("GET /api/fs/list", () => {
  it("列一层子目录并标记 applift 工程（hasConfig）；文件不出现", async () => {
    const base = await startServer();
    const dir = await tmpDir();
    await mkdir(join(dir, "plain"));
    await mkdir(join(dir, "proj"));
    await writeFile(join(dir, "proj", "applift.config.ts"), "export default {}", "utf8");
    await writeFile(join(dir, "file.txt"), "x", "utf8");

    const res = await fetch(`${base}/api/fs/list?dir=${encodeURIComponent(dir)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      entries: Array<{ name: string; path: string; hasConfig: boolean }>;
    };
    expect(body.ok).toBe(true);
    expect(body.entries.map((e) => e.name)).toEqual(["plain", "proj"]); // 按名排序、文件被滤掉
    expect(body.entries.find((e) => e.name === "proj")!.hasConfig).toBe(true);
    expect(body.entries.find((e) => e.name === "plain")!.hasConfig).toBe(false);
  });

  it("指向目录的符号链接可进入；悬空符号链接被跳过（不 500）", async () => {
    const base = await startServer();
    const dir = await tmpDir();
    await mkdir(join(dir, "real"));
    await symlink(join(dir, "real"), join(dir, "linked"));
    await symlink(join(dir, "nowhere"), join(dir, "dangling"));

    const res = await fetch(`${base}/api/fs/list?dir=${encodeURIComponent(dir)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ name: string }> };
    expect(body.entries.map((e) => e.name)).toEqual(["linked", "real"]);
  });

  it("目录不存在 / 指到文件 / 缺 dir 参数 → 400", async () => {
    const base = await startServer();
    const dir = await tmpDir();

    const missing = await fetch(`${base}/api/fs/list?dir=${encodeURIComponent(join(dir, "nope"))}`);
    expect(missing.status).toBe(400);

    const filePath = join(dir, "afile");
    await writeFile(filePath, "x", "utf8");
    const file = await fetch(`${base}/api/fs/list?dir=${encodeURIComponent(filePath)}`);
    expect(file.status).toBe(400);

    const empty = await fetch(`${base}/api/fs/list`);
    expect(empty.status).toBe(400);

    const blank = await fetch(`${base}/api/fs/list?dir=`);
    expect(blank.status).toBe(400);
  });

  it("非 GET → 405", async () => {
    const base = await startServer();
    const res = await fetch(`${base}/api/fs/list?dir=/tmp`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});
