import { describe, expect, it } from "vitest";
import { appendEntry, type HistoryEntry } from "@applift/core";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.js";
import { ProjectRegistry } from "./registry.js";
import { derivePhase, createProjectHistoryRoutes } from "./history-routes.js";

describe("derivePhase（存量条目启发式）", () => {
  const e = (over: Partial<HistoryEntry>): HistoryEntry => ({
    ts: 0,
    channel: "x",
    action: "stage",
    artifactSha256: "a",
    ok: true,
    cwd: "/p",
    ...over,
  });
  it("显式 phase 直通（0.14+ 记录）", () => {
    expect(derivePhase(e({ phase: "beta" }))).toBe("beta");
    expect(derivePhase(e({ phase: "release" }))).toBe("release");
  });
  it("存量热更按 action：stage=publishToBeta=内测（含双基线落地前绑原生基线的），submit=正式", () => {
    // 双基线（4.0.1000 测试孪生）落地前的内测热更绑原生基线 4.0.0-patch.N——按版本推导会误标正式（实测 25 条全错）
    expect(
      derivePhase(e({ channel: "rn-update", action: "stage", artifactVersion: "4.0.0-patch.31" })),
    ).toBe("beta");
    expect(
      derivePhase(
        e({ channel: "rn-update", action: "stage", artifactVersion: "4.0.1000-patch.1" }),
      ),
    ).toBe("beta");
    expect(
      derivePhase(e({ channel: "rn-update", action: "submit", artifactVersion: "4.0.0-patch.5" })),
    ).toBe("release");
  });
  it("存量 asc：submit=正式提审；stage 上传二义（TestFlight/正式 stage）不猜 → null；其余渠道 → null", () => {
    expect(derivePhase(e({ channel: "asc", action: "submit" }))).toBe("release");
    expect(derivePhase(e({ channel: "asc", action: "stage" }))).toBeNull();
    expect(derivePhase(e({ channel: "pgyer", action: "stage" }))).toBeNull();
  });
});

describe("GET /api/projects/:id/history", () => {
  it("过滤项目 cwd、ts 倒序、字段映射齐全；未知项目 404", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hist-"));
    const hp = join(dir, "history.jsonl");
    appendEntry(
      {
        ts: 100,
        cwd: "/proj-a",
        channel: "rn-update",
        action: "stage",
        artifactSha256: "s1",
        ok: true,
        artifactVersion: "4.0.1000-patch.1",
        phase: "beta",
        platform: "android",
      },
      hp,
    );
    appendEntry(
      {
        ts: 200,
        cwd: "/proj-a",
        channel: "asc",
        action: "submit",
        artifactSha256: "s2",
        ok: false,
      },
      hp,
    );
    appendEntry(
      {
        ts: 300,
        cwd: "/proj-b",
        channel: "pgyer",
        action: "stage",
        artifactSha256: "s3",
        ok: true,
      },
      hp,
    );
    // 损坏行跳过（readEntries 容错契约）
    await writeFile(hp, "not-json\n", { flag: "a" });

    const registry = new ProjectRegistry(join(dir, "projects.json"));
    const added = await registry.add("/proj-a");
    const handler = createProjectHistoryRoutes({ registry, historyPath: hp });

    // 直接以 handler 驱动（不走完整 server——路由逻辑单测；端到端在 e2e）
    const res = {
      statusCode: 0,
      body: "",
      setHeader: () => {},
      end(this: { statusCode: number; body: string }, chunk: string) {
        this.body += chunk;
      },
      writeHead(code: number) {
        this.statusCode = code;
      },
    };
    const ok = await handler(
      { url: `/api/projects/${encodeURIComponent(added.id)}/history`, method: "GET" } as never,
      res as never,
    );
    expect(ok).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { ok: boolean; entries: Array<Record<string, unknown>> };
    expect(body.ok).toBe(true);
    expect(body.entries).toHaveLength(2); // proj-b 与损坏行不进
    expect(body.entries[0]!.ts).toBe(200); // 倒序：新在前
    expect(body.entries[0]).toMatchObject({
      channel: "asc",
      phase: "release",
      platform: null,
      ok: false,
    });
    expect(body.entries[1]).toMatchObject({
      channel: "rn-update",
      phase: "beta",
      platform: "android",
      artifactVersion: "4.0.1000-patch.1",
    });

    // 未知项目 404
    const res404 = { ...res, body: "", statusCode: 0 };
    const handled = await handler(
      { url: "/api/projects/none/history", method: "GET" } as never,
      res404 as never,
    );
    expect(handled).toBe(true);
    expect(res404.statusCode).toBe(404);
  });

  it("挂进 createServer 后可访问（组装面）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hist-srv-"));
    const registry = new ProjectRegistry(join(dir, "projects.json"));
    const added = await registry.add("/proj-c");
    const server = await createServer({
      port: 0,
      registry,
      staticDir: dir,
      historyPath: join(dir, "none.jsonl"),
    });
    const r = await fetch(`http://127.0.0.1:${server.port}/api/projects/${added.id}/history`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { entries: unknown[] };
    expect(body.entries).toEqual([]); // 空历史文件 → 空列表
    await server.close();
  });
});
