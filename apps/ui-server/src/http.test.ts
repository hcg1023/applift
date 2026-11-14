import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUiServer } from "./http.js";

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
    expect(js.headers.get("content-type")).toContain("text/javascript");
    const miss = await fetch(`http://127.0.0.1:${srv.port}/nope.txt`);
    expect(miss.status).toBe(404);
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
