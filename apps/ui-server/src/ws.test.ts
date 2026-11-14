import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { type RawData, type WebSocket as WsSocket } from "ws";
import { startUiServer, type UiServerHandle } from "./http.js";
import { AppliftRunner } from "./runner.js";
import { WsChannel } from "./ws.js";
import type { FeedEvent, ProjectSnapshot } from "./aggregator.js";

/** ws 下行消息（服务端 → 客户端协议） */
type Down =
  | { t: "snapshot"; data: ProjectSnapshot }
  | { t: "feed"; data: FeedEvent }
  | { t: "task"; taskId: string; data: { type?: string } & Record<string, unknown> }
  | { t: "task.end"; taskId: string; code: number }
  | { t: "tasks"; data: unknown[] };

/** ws 上行消息（客户端 → 服务端协议） */
type Up =
  | { t: "confirm"; taskId: string; id: string; value: boolean }
  | { t: "task.cancel"; taskId: string };

const tmpDirs: string[] = [];
const servers: UiServerHandle[] = [];
const channels: WsChannel[] = [];
afterAll(async () => {
  await Promise.all(channels.map((c) => c.close()));
  await Promise.all(servers.map((s) => s.close()));
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function tmpFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ws-test-"));
  tmpDirs.push(dir);
  const p = join(dir, name);
  await writeFile(p, content, "utf8");
  return p;
}

/** 收件箱：等一条满足谓词的下行消息（复用已到的历史，不漏发） */
function connect(port: number): {
  ws: WsSocket;
  next: (pred: (m: Down) => boolean, ms?: number) => Promise<Down>;
} {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const inbox: Down[] = [];
  const waiters: { pred: (m: Down) => boolean; resolve: (m: Down) => void }[] = [];
  ws.on("message", (raw: RawData) => {
    const m = JSON.parse(String(raw)) as Down;
    inbox.push(m);
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) waiters.splice(i, 1)[0]?.resolve(m);
  });
  return {
    ws,
    next: (pred, ms = 5000) => {
      const hit = inbox.find(pred);
      if (hit) return Promise.resolve(hit);
      const { promise, resolve, reject } = Promise.withResolvers<Down>();
      const timer = setTimeout(() => reject(new Error("等待 ws 消息超时")), ms);
      waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
      timer.unref?.();
      return promise;
    },
  };
}

function openSocket(port: number): Promise<WsSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const { promise, resolve, reject } = Promise.withResolvers<WsSocket>();
  ws.once("open", () => resolve(ws));
  ws.once("error", reject);
  return promise;
}

async function mkStaticDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ws-static-"));
  tmpDirs.push(dir);
  await writeFile(join(dir, "index.html"), "<html>ok</html>", "utf8");
  return dir;
}

async function setup(bin?: string): Promise<{ port: number; channel: WsChannel }> {
  const server = await startUiServer({ port: 0, staticDir: await mkStaticDir() });
  servers.push(server);
  const channel = new WsChannel({ runnerFactory: () => new AppliftRunner(bin ? { bin } : {}) });
  channel.attach(server.httpServer);
  channels.push(channel);
  return { port: server.port, channel };
}

const snapshot = (projectId: string): ProjectSnapshot => ({
  projectId,
  channels: [],
  fetchedAt: "t1",
  ok: true,
});

describe("WsChannel", () => {
  it("静态路由不受 ws 升级影响；snapshot/feed 广播到已连接客户端", async () => {
    const { port, channel } = await setup();
    const client = connect(port);
    await new Promise<void>((r) =>
      client.ws.readyState === 1 ? r() : client.ws.once("open", () => r()),
    );

    channel.broadcastSnapshot(snapshot("p1"));
    channel.broadcastFeed({
      id: "e1",
      ts: 1,
      projectId: "p1",
      channel: "pgyer",
      kind: "state_change",
      from: "none",
      to: "live",
    });

    const snap = await client.next((m) => m.t === "snapshot");
    expect(snap.t === "snapshot" && snap.data.projectId).toBe("p1");
    const feed = await client.next((m) => m.t === "feed");
    expect(feed.t === "feed" && feed.data.to).toBe("live");
    client.ws.close();
  });

  it("连接数 0↔1 驱动 onConnectionsChange（前台/后台档位切换）", async () => {
    const spy = vi.fn();
    const server = await startUiServer({ port: 0, staticDir: await mkStaticDir() });
    servers.push(server);
    const channel = new WsChannel({
      runnerFactory: () => new AppliftRunner(),
      onConnectionsChange: spy,
    });
    channel.attach(server.httpServer);
    channels.push(channel);

    const ws = await openSocket(server.port);
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith(1));
    ws.close();
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith(0));
  });

  it("beta 任务：事件广播 + confirm 回写子进程 stdin + result 归档", async () => {
    const stdinLog = await tmpFile("stdin.log", "");
    // 桩 bin：发 hello；收到一行 stdin 后记文件、回显 log + result 退出
    const stub = await tmpFile(
      "confirm-stub.cjs",
      `process.stdout.write(JSON.stringify({type:"hello",version:"stub"})+"\\n");
const fs=require("fs");
let buf="";
process.stdin.setEncoding("utf8");
process.stdin.on("data",(d)=>{buf+=d;let i;while((i=buf.indexOf("\\n"))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);
  fs.appendFileSync(${JSON.stringify(stdinLog)},line+"\\n");
  process.stdout.write(JSON.stringify({type:"log",message:"echo:"+line})+"\\n");
  process.stdout.write(JSON.stringify({type:"result",ok:true})+"\\n");
  process.exit(0);}});
setInterval(()=>{},60000);`,
    );
    const { port, channel } = await setup(`node ${stub}`);
    const client = connect(port);

    const taskId = channel.startBetaTask("p1", "android", {});
    expect(typeof taskId).toBe("string");

    const hello = await client.next((m) => m.t === "task" && m.data.type === "hello");
    if (hello.t === "task") expect(hello.taskId).toBe(taskId);

    // 客户端回 confirm → 桩进程 stdin 收到阶段一 InEvent 原文
    const up: Up = { t: "confirm", taskId, id: "chk1", value: true };
    client.ws.send(JSON.stringify(up));
    await client.next((m) => m.t === "task" && m.data.type === "result");
    await vi.waitFor(async () => {
      const text = await readFile(stdinLog, "utf8");
      expect(text.trim()).toBe(JSON.stringify({ type: "confirm", id: "chk1", value: true }));
    });
    client.ws.close();
  });

  it("task.cancel 杀掉运行中任务（非零退出归档）", async () => {
    const stub = await tmpFile(
      "hang-stub.cjs",
      `process.stdout.write(JSON.stringify({type:"hello"})+"\\n");
setInterval(()=>{},60000);`,
    );
    const { port, channel } = await setup(`node ${stub}`);
    const client = connect(port);
    const taskId = channel.startBetaTask("p1", "harmony", {});
    await client.next((m) => m.t === "task");
    const cancel: Up = { t: "task.cancel", taskId };
    client.ws.send(JSON.stringify(cancel));
    await client.next((m) => m.t === "task.end" && m.taskId === taskId);
    const archived = channel.archivedTasks().find((a) => a.taskId === taskId);
    expect(archived?.code).not.toBe(0);
    client.ws.close();
  });

  it("result 后归档 ring buffer，重连回看最近任务", async () => {
    const stub = await tmpFile(
      "fast-stub.cjs",
      `process.stdout.write(JSON.stringify({type:"hello"})+"\\n");
process.stdout.write(JSON.stringify({type:"result",ok:true})+"\\n");`,
    );
    const { port, channel } = await setup(`node ${stub}`);
    const c1 = connect(port);
    const taskId = channel.startBetaTask("p1", "android", {});
    await c1.next((m) => m.t === "task" && m.data.type === "result");
    await c1.next((m) => m.t === "task.end");
    c1.ws.close();

    // 新连接：首包 tasks 携带归档任务（含全部事件）
    const c2 = connect(port);
    const archive = await c2.next((m) => m.t === "tasks");
    interface ArchivedShape {
      taskId: string;
      code: number;
      events: { type?: string }[];
    }
    const found = (archive.t === "tasks" ? (archive.data as ArchivedShape[]) : []).find(
      (a) => a.taskId === taskId,
    );
    expect(found).toBeDefined();
    expect(found?.events.map((e) => e.type)).toEqual(["hello", "result"]);
    expect(found?.code).toBe(0);
    c2.ws.close();
  });

  it("ring buffer 只保留最近 20 条", async () => {
    const stub = await tmpFile(
      "fast-stub.cjs",
      `process.stdout.write(JSON.stringify({type:"result",ok:true})+"\\n");`,
    );
    const { channel } = await setup(`node ${stub}`);
    for (let i = 0; i < 25; i++) channel.startBetaTask(`p${i}`, "android", {});
    await vi.waitFor(() => expect(channel.archivedTasks()).toHaveLength(20));
  });
});
