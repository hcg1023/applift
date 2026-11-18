import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { type RawData, type WebSocket as WsSocket } from "ws";
import { ProjectRegistry } from "./registry.js";
import { AppliftRunner } from "./runner.js";
import { cliBinPath } from "./routes.js";
import { createServer, type ComposedServer } from "./index.js";

/**
 * 真 CLI 桩工程端到端（简报 Step 3）：
 * 阶段一 otaProviderProject fixture（package.json + applift.config.ts 内联 stub-update provider）
 * → 真 createServer + 真 CLI dist bin → REST 发起任务 → WS 收 hello/judgement/confirm_required
 * → confirm 上行回写（stdin 模拟确认）→ result ok → task.end 0。
 * 前置：pnpm -r build（CLI dist 与 ui-server dist 均在）。
 */

const tmpDirs: string[] = [];
const servers: ComposedServer[] = [];
const sockets: WsSocket[] = [];

/** 子进程（真 CLI）的 HOME 隔离：history 写入不落真实 ~/.applift */
const testHome = await mkdtemp(join(tmpdir(), "applift-realcli-home-"));
tmpDirs.push(testHome);
process.env.APPLIFT_HOME = testHome;

afterAll(async () => {
  for (const s of sockets) s.close();
  await Promise.all(servers.map((s) => s.close()));
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** 阶段一 fixture 思路：热更 provider 工程判定 ota + publishToBeta 返回固定版本 */
async function otaProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "applift-realcli-proj-"));
  tmpDirs.push(dir);
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "ota-demo",
      version: "4.0.0",
      dependencies: { "react-native": "0.84.0" },
    }),
  );
  await writeFile(
    join(dir, "applift.config.ts"),
    [
      "import { rnFramework } from '@applift/core';",
      "export default {",
      "  plugins: [rnFramework(), {",
      "    name: 'stub-update',",
      "    'update:register': (providers) => providers.push({",
      "      id: 'stub-update', frameworks: ['rn'],",
      "      judge: () => ({ recommendation: 'ota', confidence: 'high', evidence: [{ path: 'src/a.ts', rule: 'JS 层', note: '' }] }),",
      "      publishToBeta: async () => ({ versionName: '4.0.0-ota.1', versionId: 1 }),",
      "      promoteToProd: async () => ({ versionName: '4.0.0-ota.1' }),",
      "    }),",
      "  }],",
      "};",
    ].join("\n"),
  );
  return dir;
}

function wsCollect(port: number): {
  ws: WsSocket;
  next: (pred: (m: WsMsg) => boolean, ms?: number) => Promise<WsMsg>;
} {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  const inbox: WsMsg[] = [];
  const waiters: { pred: (m: WsMsg) => boolean; resolve: (m: WsMsg) => void }[] = [];
  ws.on("message", (raw: RawData) => {
    const m = JSON.parse(String(raw)) as WsMsg;
    inbox.push(m);
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0]?.resolve(m);
  });
  return {
    ws,
    next: (pred, ms = 30_000) => {
      const hit = inbox.find(pred);
      if (hit) return Promise.resolve(hit);
      const { promise, resolve, reject } = Promise.withResolvers<WsMsg>();
      const timer = setTimeout(() => reject(new Error("等待 ws 消息超时")), ms);
      timer.unref?.();
      waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
      return promise;
    },
  };
}

type WsMsg = {
  t: string;
  taskId?: string;
  code?: number;
  data?: { type?: string } & Record<string, unknown>;
};

describe("真 CLI 桩工程端到端（POST /api/tasks/* + ws 桥 + 真 beta --interactive-events）", () => {
  it("dry-run：真 CLI 判定报告（stub-update provider → ota）", { timeout: 90_000 }, async () => {
    const projDir = await otaProject();
    const storeDir = await mkdtemp(join(tmpdir(), "applift-realcli-store-"));
    tmpDirs.push(storeDir);
    const registry = new ProjectRegistry(join(storeDir, "projects.json"));
    const entry = await registry.add(projDir);
    const server = await createServer({
      port: 0,
      registry,
      runnerFactory: (cwd) => new AppliftRunner({ cwd, bin: [process.execPath, cliBinPath()] }),
    });
    servers.push(server);

    const res = await fetch(`http://127.0.0.1:${server.port}/api/tasks/dry-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: entry.id, platform: "android" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      report: { provider: string | null; recommendation: string | null; note: string };
    };
    expect(body.ok).toBe(true);
    expect(body.report.provider).toBe("stub-update");
    expect(body.report.recommendation).toBe("ota");
  });

  it(
    "beta 任务：hello/judgement/confirm_required → confirm 上行回写 stdin → result ok → task.end 0",
    { timeout: 120_000 },
    async () => {
      const projDir = await otaProject();
      const storeDir = await mkdtemp(join(tmpdir(), "applift-realcli-store2-"));
      tmpDirs.push(storeDir);
      const registry = new ProjectRegistry(join(storeDir, "projects.json"));
      const entry = await registry.add(projDir);
      const server = await createServer({
        port: 0,
        registry,
        runnerFactory: (cwd) => new AppliftRunner({ cwd, bin: [process.execPath, cliBinPath()] }),
      });
      servers.push(server);

      const client = wsCollect(server.port);
      const start = await fetch(`http://127.0.0.1:${server.port}/api/tasks/beta`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: entry.id, platform: "android" }),
      });
      expect(start.status).toBe(200);
      const { taskId } = (await start.json()) as { ok: boolean; taskId: string };

      const isTask = (type: string) => (m: WsMsg) =>
        m.t === "task" && m.taskId === taskId && m.data?.type === type;

      await client.next(isTask("hello"));
      const judge = await client.next(isTask("judgement"));
      if (judge.t === "task" && judge.data !== undefined) {
        expect(judge.data.recommendation).toBe("ota");
        expect(judge.data.provider).toBe("stub-update");
      }
      const confirm = await client.next(isTask("confirm_required"));
      if (confirm.t === "task" && confirm.data !== undefined) {
        expect(confirm.data.id).toBe("delivery");
        const choices = confirm.data.choices as Array<{ value: string; recommended?: boolean }>;
        expect(choices.find((c) => c.value === "ota")?.recommended).toBe(true);
      }

      // 确认回写（UI 协议 → ws 上行 → CLI stdin 阶段一 InEvent 原文）
      client.ws.send(JSON.stringify({ t: "confirm", taskId, id: "delivery", value: "ota" }));

      const result = await client.next(isTask("result"));
      if (result.t === "task" && result.data !== undefined) {
        expect(result.data.ok).toBe(true);
        expect(result.data.summary).toMatchObject({
          versionName: "4.0.0-ota.1",
          channel: "stub-update",
          mode: "ota",
        });
      }
      const end = await client.next((m) => m.t === "task.end" && m.taskId === taskId);
      if (end.t === "task.end") expect(end.code).toBe(0);
    },
  );
});
