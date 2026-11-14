import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket, { type RawData, type WebSocket as WsSocket } from "ws";
import { startUiServer, type UiServerHandle } from "./http.js";
import { AppliftRunner } from "./runner.js";
import { WsChannel, isAllowedOrigin } from "./ws.js";
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
  | { t: "confirm"; taskId: string; id: string; value: string }
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

/** 任务 cwd 断言用占位目录（spawn 的是桩 bin，不真读该目录） */
const projDir = "/tmp/applift-ws-test-proj";

async function setup(bin?: string): Promise<{ port: number; channel: WsChannel }> {
  const server = await startUiServer({ port: 0, staticDir: await mkStaticDir() });
  servers.push(server);
  const channel = new WsChannel({
    runnerFactory: (cwd) => {
      if (cwd !== projDir) throw new Error(`unexpected cwd: ${cwd}`);
      return new AppliftRunner(bin ? { bin } : {});
    },
  });
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

    const taskId = channel.startBetaTask("p1", "android", { cwd: projDir });
    expect(typeof taskId).toBe("string");

    const hello = await client.next((m) => m.t === "task" && m.data.type === "hello");
    if (hello.t === "task") expect(hello.taskId).toBe(taskId);

    // 客户端回 confirm → 桩进程 stdin 收到阶段一 InEvent 原文
    const up: Up = { t: "confirm", taskId, id: "chk1", value: "ota" };
    client.ws.send(JSON.stringify(up));
    await client.next((m) => m.t === "task" && m.data.type === "result");
    await vi.waitFor(async () => {
      const text = await readFile(stdinLog, "utf8");
      expect(text.trim()).toBe(JSON.stringify({ type: "confirm", id: "chk1", value: "ota" }));
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
    const taskId = channel.startBetaTask("p1", "harmony", { cwd: projDir });
    await client.next((m) => m.t === "task");
    const cancel: Up = { t: "task.cancel", taskId };
    client.ws.send(JSON.stringify(cancel));
    await client.next((m) => m.t === "task.end" && m.taskId === taskId);
    const archived = channel.archivedTasks().find((a) => a.taskId === taskId);
    expect(archived?.code).not.toBe(0);
    client.ws.close();
  });

  it("确认看门狗：confirm_required 超时无回写 → warn log 广播 + kill（非零退出）", async () => {
    const stub = await tmpFile(
      "pending-stub.cjs",
      `process.stdout.write(JSON.stringify({type:"hello"})+"\\n");
process.stdout.write(JSON.stringify({type:"confirm_required",id:"delivery",question:"投递方式",choices:[{value:"ota",label:"热更"}]})+"\\n");
setInterval(()=>{},60000);`,
    );
    const { port, channel } = await setup(`node ${stub}`);
    const client = connect(port);
    const taskId = channel.startBetaTask("p1", "android", {
      cwd: projDir,
      confirmTimeoutMs: 120,
    });
    await client.next((m) => m.t === "task" && m.data.type === "confirm_required");
    const warn = await client.next(
      (m) => m.t === "task" && m.data.type === "log" && m.data.level === "warn",
    );
    if (warn.t === "task") expect(String(warn.data.msg)).toContain("确认超时");
    await client.next((m) => m.t === "task.end" && m.taskId === taskId);
    const archived = channel.archivedTasks().find((a) => a.taskId === taskId);
    expect(archived?.code).not.toBe(0);
    client.ws.close();
  });

  it("确认看门狗：confirm 上行即清（不误杀）——回写后正常走到 result", async () => {
    const stub = await tmpFile(
      "confirm-fast-stub.cjs",
      `process.stdout.write(JSON.stringify({type:"hello"})+"\\n");
process.stdout.write(JSON.stringify({type:"confirm_required",id:"delivery",question:"投递方式",choices:[{value:"ota",label:"热更"}]})+"\\n");
let buf="";
process.stdin.setEncoding("utf8");
process.stdin.on("data",(d)=>{buf+=d;let i;while((i=buf.indexOf("\\n"))>=0){const l=buf.slice(0,i);buf=buf.slice(i+1);
  process.stdout.write(JSON.stringify({type:"result",ok:true})+"\\n");
  process.exit(0);}});
setInterval(()=>{},60000);`,
    );
    const { port, channel } = await setup(`node ${stub}`);
    const client = connect(port);
    // 150ms 看门狗：confirm 回写必须在其触发前到达并清除
    const taskId = channel.startBetaTask("p1", "android", {
      cwd: projDir,
      confirmTimeoutMs: 150,
    });
    await client.next((m) => m.t === "task" && m.data.type === "confirm_required");
    client.ws.send(JSON.stringify({ t: "confirm", taskId, id: "delivery", value: "ota" }));
    const result = await client.next((m) => m.t === "task" && m.data.type === "result");
    if (result.t === "task") expect(result.data.ok).toBe(true);
    const end = await client.next((m) => m.t === "task.end" && m.taskId === taskId);
    if (end.t === "task.end") expect(end.code).toBe(0);
    // 看门狗已清：不再有 warn log（task 已归档退出）
    const archived = channel.archivedTasks().find((a) => a.taskId === taskId);
    expect(archived?.events.some((e) => e.type === "log" && e.level === "warn")).toBe(false);
    client.ws.close();
  });

  it("任务运行中第二个客户端连接：补发已累积的 task 事件（重连恢复确认 UI）", async () => {
    // 桩 bin：发 hello + confirm_required 后挂住等 stdin
    const stub = await tmpFile(
      "pending-stub.cjs",
      `process.stdout.write(JSON.stringify({type:"hello"})+"\\n");
process.stdout.write(JSON.stringify({type:"confirm_required",id:"chk1",prompt:"渠道?",values:["ota","skip"]})+"\\n");
setInterval(()=>{},60000);`,
    );
    const { port, channel } = await setup(`node ${stub}`);
    const c1 = connect(port);
    const taskId = channel.startBetaTask("p1", "android", { cwd: projDir });
    await c1.next((m) => m.t === "task" && m.data.type === "confirm_required");

    // 重连客户端：补发范围内必须含运行中任务的累积事件（hello + confirm_required，带 taskId）
    const c2 = connect(port);
    const replayed = await c2.next((m) => m.t === "task" && m.data.type === "confirm_required");
    if (replayed.t === "task") expect(replayed.taskId).toBe(taskId);
    const hello = await c2.next((m) => m.t === "task" && m.data.type === "hello");
    if (hello.t === "task") expect(hello.taskId).toBe(taskId);
    const up: Up = { t: "task.cancel", taskId };
    c2.ws.send(JSON.stringify(up));
    await c2.next((m) => m.t === "task.end" && m.taskId === taskId);
    c1.ws.close();
    c2.ws.close();
  });

  it("result 后归档 ring buffer，重连回看最近任务", async () => {
    const stub = await tmpFile(
      "fast-stub.cjs",
      `process.stdout.write(JSON.stringify({type:"hello"})+"\\n");
process.stdout.write(JSON.stringify({type:"result",ok:true})+"\\n");`,
    );
    const { port, channel } = await setup(`node ${stub}`);
    const c1 = connect(port);
    const taskId = channel.startBetaTask("p1", "android", { cwd: projDir });
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
    for (let i = 0; i < 25; i++) channel.startBetaTask(`p${i}`, "android", { cwd: projDir });
    // 25 个 stub spawn 在慢机可能超 vi.waitFor 默认 1s——放宽到 5s（历史 flake，与逻辑无关）
    await vi.waitFor(() => expect(channel.archivedTasks()).toHaveLength(20), { timeout: 5000 });
  });

  it("I-2 Origin 校验：外域 Origin 403 拒连；无 Origin / 本机 Origin 放行", async () => {
    const { port } = await setup();

    const responseStatus = (ws: WsSocket): Promise<number> => {
      const { promise, resolve } = Promise.withResolvers<number>();
      ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.once("error", () => resolve(0)); // 兜底：部分路径直接 error 不带响应
      return promise;
    };
    const opened = (ws: WsSocket): Promise<void> => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      ws.once("open", resolve);
      ws.once("error", reject);
      return promise;
    };

    // 外域网页（可读全量广播 + 代确认发版的攻击面）→ 403
    const evil = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { origin: "http://evil.example" },
    });
    const status = await responseStatus(evil);
    expect(status).toBe(403);
    evil.terminate();

    // 端口不匹配的本机 Origin（http://localhost:其他端口）→ 403
    const evilPort = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { origin: `http://localhost:${port + 1}` },
    });
    const status2 = await responseStatus(evilPort);
    expect(status2).toBe(403);
    evilPort.terminate();

    // 合法本机 Origin（127.0.0.1 与 localhost、带匹配端口）→ 放行
    for (const origin of [
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      "http://localhost",
    ]) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin } });
      await opened(ws);
      ws.close();
    }

    // 无 Origin 的非浏览器客户端（node:ws 默认不带）→ 放行（首个用例的 connect 已隐式覆盖，此处显式）
    const bare = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await opened(bare);
    bare.close();
  });

  it("isAllowedOrigin 单元：协议/主机/端口矩阵", () => {
    expect(isAllowedOrigin("http://127.0.0.1:47600", 47600)).toBe(true);
    expect(isAllowedOrigin("http://localhost:47600", 47600)).toBe(true);
    expect(isAllowedOrigin("http://localhost", 47600)).toBe(true); // 缺省端口放行
    expect(isAllowedOrigin("http://localhost:1", 47600)).toBe(false); // 端口不匹配
    expect(isAllowedOrigin("http://evil.example", 47600)).toBe(false);
    expect(isAllowedOrigin("https://127.0.0.1:47600", 47600)).toBe(false); // 非本机页面协议
    expect(isAllowedOrigin("not a url", 47600)).toBe(false);
  });

  it("任务去重：同 projectId+platform 已有活跃任务 → 拒绝且错误带既有 taskId", async () => {
    const stub = await tmpFile(
      "hang-stub.cjs",
      `process.stdout.write(JSON.stringify({type:"hello"})+"\\n");
setInterval(()=>{},60000);`,
    );
    const { port, channel } = await setup(`node ${stub}`);
    const client = connect(port);
    const taskId = channel.startBetaTask("p1", "android", { cwd: projDir });
    await client.next((m) => m.t === "task");
    // 同项目同平台再发起：抛错带既有 taskId
    expect(() => channel.startBetaTask("p1", "android", { cwd: projDir })).toThrow(
      new RegExp(taskId),
    );
    // 不同平台 / 不同项目不受影响
    expect(() => channel.startBetaTask("p1", "ios", { cwd: projDir })).not.toThrow();
    expect(() => channel.startBetaTask("p2", "android", { cwd: projDir })).not.toThrow();
    // 原任务结束后可再次发起
    client.ws.send(JSON.stringify({ t: "task.cancel", taskId }));
    await client.next((m) => m.t === "task.end" && m.taskId === taskId);
    expect(() => channel.startBetaTask("p1", "android", { cwd: projDir })).not.toThrow();
    client.ws.close();
    await channel.close();
  });
});
