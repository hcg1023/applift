import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { startUiServer } from "./http.js";
import { cliBinPath } from "./routes.js";
import { ProjectRegistry } from "./registry.js";
import type { ProjectEntry } from "./registry.js";

const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function mkdtempStatic(html: string, extra?: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ui-server-"));
  tmpDirs.push(dir);
  await writeFile(join(dir, "index.html"), html, "utf8");
  for (const [name, content] of Object.entries(extra ?? {})) {
    await writeFile(join(dir, name), content, "utf8");
  }
  return dir;
}

describe("startUiServer", () => {
  it("健康检查 + 静态托管", async () => {
    const dir = await mkdtempStatic("<html>hi</html>");
    const srv = await startUiServer({ staticDir: dir, port: 0 });
    const health = await fetch(`http://127.0.0.1:${srv.port}/api/health`).then((r) => r.json());
    expect(health).toEqual({ ok: true, version: expect.any(String) });
    const html = await fetch(`http://127.0.0.1:${srv.port}/`).then((r) => r.text());
    expect(html).toContain("hi");
    await srv.close();
  });

  it("绑定 127.0.0.1（非 0.0.0.0）", async () => {
    const dir = await mkdtempStatic("<html>x</html>");
    const srv = await startUiServer({ staticDir: dir, port: 0 });
    expect(srv.httpServer.address()).toMatchObject({ address: "127.0.0.1" });
    await srv.close();
  });

  it("静态文件按扩展名给 MIME；未知路径 404", async () => {
    const dir = await mkdtempStatic("<html>i</html>", { "app.js": "console.log(1)" });
    const srv = await startUiServer({ staticDir: dir, port: 0 });
    const js = await fetch(`http://127.0.0.1:${srv.port}/app.js`);
    expect(js.status).toBe(200);
    // MIME 按扩展名给出；nosniff 是叠加的安全头而非替换 content-type
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(js.headers.get("x-content-type-options")).toBe("nosniff");
    const miss = await fetch(`http://127.0.0.1:${srv.port}/nope.txt`);
    expect(miss.status).toBe(404);
    await srv.close();
  });

  it("POST body >1MiB → 413 并中止读取", async () => {
    const dir = await mkdtempStatic("<html>x</html>");
    const registry = new ProjectRegistry(join(dir, "projects.json"));
    const srv = await startUiServer({ staticDir: dir, port: 0, registry });
    const { port } = srv;
    const { promise, resolve, reject } = Promise.withResolvers<number>();
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/api/projects", method: "POST" },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", (err: NodeJS.ErrnoException) => {
      // 服务端中止读取后客户端写侧可能先见 EPIPE/ECONNRESET——响应已到达即视为成功
      if (err.code === "EPIPE" || err.code === "ECONNRESET") resolve(413);
      else reject(err);
    });
    req.write("x".repeat(2 * 1024 * 1024));
    req.end();
    expect(await promise).toBe(413);
    await srv.close();
  });

  it("close 后端口不再服务", async () => {
    const dir = await mkdtempStatic("<html>c</html>");
    const srv = await startUiServer({ staticDir: dir, port: 0 });
    const { port } = srv;
    await srv.close();
    await expect(fetch(`http://127.0.0.1:${port}/api/health`)).rejects.toThrow();
  });
});

// fetch 会先归一化点段，测不到服务端守卫——用 http.request 发原始 path
async function rawGet(port: number, path: string): Promise<number> {
  return new Promise((resolveGet, rejectGet) => {
    const req = httpRequest({ host: "127.0.0.1", port, path }, (res) => {
      res.resume();
      res.on("end", () => resolveGet(res.statusCode ?? 0));
    });
    req.on("error", rejectGet);
    req.end();
  });
}

async function rawDelete(port: number, path: string): Promise<number> {
  return new Promise((resolveDelete, rejectDelete) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "DELETE" }, (res) => {
      res.resume();
      res.on("end", () => resolveDelete(res.statusCode ?? 0));
    });
    req.on("error", rejectDelete);
    req.end();
  });
}

describe("路径穿越守卫（原始 path）", () => {
  it.each([["/%2e%2e/%2e%2e/etc/passwd"], ["/foo/..%5c..%5c/etc/passwd"], ["//etc/passwd"]])(
    "%s → 404",
    async (path) => {
      const dir = await mkdtempStatic("<html>t</html>");
      const srv = await startUiServer({ staticDir: dir, port: 0 });
      expect(await rawGet(srv.port, path)).toBe(404);
      await srv.close();
    },
  );

  it("畸形百分号序列 /%zz → 404（非 500）", async () => {
    const dir = await mkdtempStatic("<html>m</html>");
    const srv = await startUiServer({ staticDir: dir, port: 0 });
    expect(await rawGet(srv.port, "/%zz")).toBe(404);
    await srv.close();
  });

  // 哨兵文件回归：staticRoot 外层放 secret.txt，反斜杠逃逸必须被 `..` 守卫拦下。
  // 若移除守卫，resolve 会把 /..\secret.txt 归一化到父目录 → 200 泄漏（实证会变红）。
  it("哨兵文件：/..%5csecret.txt 逃逸 staticRoot → 404", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ui-server-sentinel-"));
    tmpDirs.push(parent);
    await writeFile(join(parent, "secret.txt"), "top-secret", "utf8");
    const dir = join(parent, "static");
    await mkdir(dir);
    await writeFile(join(dir, "index.html"), "<html>s</html>", "utf8");
    const srv = await startUiServer({ staticDir: dir, port: 0 });
    expect(await rawGet(srv.port, "/..%5csecret.txt")).toBe(404);
    await srv.close();
  });
});

describe("/api/projects REST 路由", () => {
  it("POST 合法工程目录 200；GET 列表；DELETE 移除", async () => {
    const staticDir = await mkdtempStatic("<html>p</html>");
    const storeDir = await mkdtemp(join(tmpdir(), "ui-server-store-"));
    tmpDirs.push(storeDir);
    const projDir = join(storeDir, "my-app");
    await mkdir(projDir);
    await writeFile(join(projDir, "applift.config.ts"), "export default {}", "utf8");
    const srv = await startUiServer({
      staticDir,
      registry: new ProjectRegistry(join(storeDir, "projects.json")),
    });
    const base = `http://127.0.0.1:${srv.port}`;

    const added = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: projDir }),
    });
    expect(added.status).toBe(200);
    const addedBody = (await added.json()) as { ok: boolean; project: ProjectEntry };
    expect(addedBody.ok).toBe(true);
    expect(addedBody.project.name).toBe("my-app");

    const list = await fetch(`${base}/api/projects`).then((r) => r.json());
    expect(list).toMatchObject({ ok: true, projects: [{ id: addedBody.project.id }] });

    const removed = await fetch(`${base}/api/projects/${addedBody.project.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    const afterDelete = await fetch(`${base}/api/projects`).then((r) => r.json());
    expect(afterDelete).toMatchObject({ projects: [] });
    await srv.close();
  });

  it("POST 空目录 400 带 error 与 report", async () => {
    const staticDir = await mkdtempStatic("<html>e</html>");
    const emptyDir = await mkdtemp(join(tmpdir(), "ui-server-empty-"));
    tmpDirs.push(emptyDir);
    const srv = await startUiServer({
      staticDir,
      registry: new ProjectRegistry(join(emptyDir, "..", "store", "projects.json")),
    });
    const res = await fetch(`http://127.0.0.1:${srv.port}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: emptyDir }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: string; report: { ok: boolean } };
    expect(body.ok).toBe(false);
    expect(body.error).toBeTruthy();
    expect(body.report.ok).toBe(false);
    await srv.close();
  });

  it("POST 缺 path 400；DELETE 未知 id 404", async () => {
    const staticDir = await mkdtempStatic("<html>v</html>");
    const storeDir = await mkdtemp(join(tmpdir(), "ui-server-store2-"));
    tmpDirs.push(storeDir);
    const srv = await startUiServer({
      staticDir,
      registry: new ProjectRegistry(join(storeDir, "projects.json")),
    });
    const base = `http://127.0.0.1:${srv.port}`;
    const bad = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);
    const miss = await fetch(`${base}/api/projects/none`, { method: "DELETE" });
    expect(miss.status).toBe(404);
    await srv.close();
  });

  it("POST 非字符串 path → 400（非 500）；DELETE 畸形百分号编码 → 404（非 500）", async () => {
    const staticDir = await mkdtempStatic("<html>x</html>");
    const storeDir = await mkdtemp(join(tmpdir(), "ui-server-store3-"));
    tmpDirs.push(storeDir);
    const srv = await startUiServer({
      staticDir,
      registry: new ProjectRegistry(join(storeDir, "projects.json")),
    });
    const base = `http://127.0.0.1:${srv.port}`;

    const badType = await fetch(`${base}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: 123 }),
    });
    expect(badType.status).toBe(400);

    expect(await rawDelete(srv.port, "/api/projects/%zz")).toBe(404);
    await srv.close();
  });
});

describe("cliBinPath（C-1 发布布局 bin 定位）", () => {
  const prev = process.env.APPLIFT_CLI_BIN;
  const restore = (): void => {
    if (prev === undefined) delete process.env.APPLIFT_CLI_BIN;
    else process.env.APPLIFT_CLI_BIN = prev;
  };

  it("APPLIFT_CLI_BIN 存在时优先（`applift ui` spawn server 时注入真实 bin 绝对路径）", () => {
    process.env.APPLIFT_CLI_BIN = "/npm/lib/node_modules/@applift/cli/dist/bin.mjs";
    expect(cliBinPath()).toBe("/npm/lib/node_modules/@applift/cli/dist/bin.mjs");
    restore();
  });

  it("env 缺失回退仓库相对路径（开发布局）；空白 env 视同缺失", () => {
    delete process.env.APPLIFT_CLI_BIN;
    expect(cliBinPath()).toMatch(/packages[\\/]cli[\\/]dist[\\/]bin\.mjs$/);
    process.env.APPLIFT_CLI_BIN = "   ";
    expect(cliBinPath()).toMatch(/packages[\\/]cli[\\/]dist[\\/]bin\.mjs$/);
    restore();
  });
});

describe("/api/projects Host 校验（I-3）", () => {
  it("非 GET 方法外域 Host → 403；GET 不受影响", async () => {
    const staticDir = await mkdtempStatic("<html>h</html>");
    const storeDir = await mkdtemp(join(tmpdir(), "ui-server-host-"));
    tmpDirs.push(storeDir);
    const srv = await startUiServer({
      staticDir,
      registry: new ProjectRegistry(join(storeDir, "projects.json")),
    });

    // node:http 原生请求伪造 Host（fetch 按 spec 静默丢弃 Host 禁改头）
    const raw = (method: string, path: string, host: string): Promise<number> => {
      const { promise, resolve } = Promise.withResolvers<number>();
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: srv.port,
          path,
          method,
          headers: { host, "content-type": "application/json" },
        },
        (r) => resolve(r.statusCode ?? 0),
      );
      req.on("error", () => resolve(0));
      req.end(method === "POST" ? JSON.stringify({}) : undefined);
      return promise;
    };

    expect(await raw("POST", "/api/projects", "evil.example")).toBe(403);
    expect(await raw("DELETE", "/api/projects/x", "evil.example")).toBe(403);
    // GET 只读不受限（外域 Host 也放行——无副作用）
    expect(await raw("GET", "/api/projects", "evil.example")).toBe(200);
    // 本机 Host 写操作放行（过了 Host 关后按正常语义校验 body）
    expect(await raw("POST", "/api/projects", "127.0.0.1")).toBe(400); // path 缺失 → 400（已过 Host 关）
    await srv.close();
  });
});
