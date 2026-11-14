import { describe, expect, it } from "vitest";
import {
  UiClient,
  UiState,
  classify,
  encodeCancel,
  encodeConfirm,
  parseDown,
  type ProjectSnapshot,
} from "./api.js";

const snap = (projectId: string, states: string[]): ProjectSnapshot => ({
  projectId,
  channels: states.map((state, i) => ({
    channel: `ch-${i}`,
    platform: "android",
    state,
    fetchedAt: "2026-11-14T02:00:00.000Z",
  })),
  fetchedAt: "2026-11-14T02:00:00.000Z",
  ok: true,
});

describe("parseDown", () => {
  it("解析 snapshot / feed / task / tasks / task.end", () => {
    expect(parseDown(JSON.stringify({ t: "snapshot", data: snap("p1", ["approved"]) }))).toEqual({
      t: "snapshot",
      data: snap("p1", ["approved"]),
    });
    const feed = {
      t: "feed",
      data: {
        id: "e1",
        ts: 1,
        projectId: "p1",
        channel: "asc",
        kind: "state_change",
        from: "reviewing",
        to: "approved",
      },
    };
    expect(parseDown(JSON.stringify(feed))).toEqual(feed);
    expect(
      parseDown(JSON.stringify({ t: "task", taskId: "t1", data: { type: "log", msg: "hi" } })),
    ).toEqual({ t: "task", taskId: "t1", data: { type: "log", msg: "hi" } });
    expect(parseDown(JSON.stringify({ t: "tasks", data: [] }))).toEqual({ t: "tasks", data: [] });
    expect(parseDown(JSON.stringify({ t: "task.end", taskId: "t1", code: 0 }))).toEqual({
      t: "task.end",
      taskId: "t1",
      code: 0,
    });
  });

  it("畸形输入返回 null", () => {
    expect(parseDown("not json")).toBeNull();
    expect(parseDown(JSON.stringify({ t: "nope" }))).toBeNull();
    expect(parseDown(JSON.stringify({ t: "snapshot", data: { projectId: "p" } }))).toBeNull();
    expect(
      parseDown(JSON.stringify({ t: "snapshot", data: { ...snap("p", []), channels: "x" } })),
    ).toBeNull();
    expect(
      parseDown(JSON.stringify({ t: "feed", data: { id: "e", ts: 1, projectId: "p" } })),
    ).toBeNull();
    expect(parseDown(JSON.stringify({ t: "task", data: {} }))).toBeNull();
    expect(parseDown(JSON.stringify({ t: "task.end", taskId: "t" }))).toBeNull();
    expect(parseDown(JSON.stringify({ t: "tasks", data: "x" }))).toBeNull();
  });
});

describe("上行编码", () => {
  it("confirm 字符串 value / task.cancel", () => {
    expect(encodeConfirm("t1", "q1", "yes")).toBe(
      JSON.stringify({ t: "confirm", taskId: "t1", id: "q1", value: "yes" }),
    );
    expect(encodeCancel("t1")).toBe(JSON.stringify({ t: "task.cancel", taskId: "t1" }));
  });
});

describe("classify", () => {
  it("state → 展示键", () => {
    expect(classify("approved").key).toBe("ok");
    expect(classify("reviewing").key).toBe("wait");
    expect(classify("rejected").key).toBe("err");
    expect(classify("unknown").key).toBe("off");
    expect(classify("whatever").label).toBe("未知");
  });
});

describe("UiState", () => {
  it("快照合并与计数", () => {
    const s = new UiState();
    s.apply({ t: "snapshot", data: snap("p1", ["approved", "reviewing", "rejected"]) });
    s.apply({ t: "snapshot", data: snap("p1", ["approved", "approved", "reviewing"]) });
    expect(s.counts("p1")).toEqual({ ok: 2, wait: 1, err: 0, off: 0, total: 3 });
  });

  it("ok=false 快照不可用且不计数", () => {
    const s = new UiState();
    s.apply({
      t: "snapshot",
      data: { projectId: "p1", channels: [], fetchedAt: "x", ok: false },
    });
    expect(s.unavailable("p1")).toBe(true);
    expect(s.counts("p1").total).toBe(0);
  });

  it("feed 前插去重并封顶；latestFor 取最新", () => {
    const s = new UiState();
    const ev = (id: string, ts: number) => ({
      id,
      ts,
      projectId: "p1",
      channel: "asc",
      kind: "state_change" as const,
      from: "reviewing",
      to: "approved",
    });
    s.apply({ t: "feed", data: ev("e2", 2) });
    s.apply({ t: "feed", data: ev("e1", 1) });
    s.apply({ t: "feed", data: ev("e2", 2) }); // 重连补发去重
    expect(s.feed.map((e) => e.id)).toEqual(["e2", "e1"]);
    expect(s.latestFor("p1")?.id).toBe("e2");
    expect(s.latestFor("other")).toBeUndefined();
  });

  it("tasks 归档覆盖；task.end 不清事件（归档由 tasks 补齐）", () => {
    const s = new UiState();
    s.apply({ t: "tasks", data: [] });
    s.apply({
      t: "tasks",
      data: [
        {
          taskId: "t1",
          projectId: "p1",
          platform: "android",
          events: [],
          startedAt: 1,
          endedAt: 2,
          code: 0,
        },
      ],
    });
    expect(s.archivedTasks.length).toBe(1);
    s.apply({ t: "task.end", taskId: "t1", code: 0 });
    expect(s.archivedTasks.length).toBe(1);
  });
});

describe("UiClient 任务 REST", () => {
  /** fetch 替身：记录请求并按路由回放响应 */
  const fakeFetch =
    (
      log: Array<{ url: string; method: string; body?: string }>,
      respond: (url: string, body: unknown) => unknown,
    ) =>
    (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      log.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return Promise.resolve(
        new Response(JSON.stringify(respond(url, init?.body)), { status: 200 }),
      );
    };

  it("dryRun：POST /api/tasks/dry-run 带 projectId+platform，返回 report", async () => {
    const log: Array<{ url: string; method: string; body?: string }> = [];
    const report = {
      platform: "android",
      provider: "stub",
      recommendation: "ota" as const,
      confidence: "high",
      evidence: [],
      note: "判定：ota（high）",
    };
    const client = new UiClient({
      httpBase: "http://x",
      fetchImpl: fakeFetch(log, (_u, _b) => ({ ok: true, report })) as unknown as typeof fetch,
      socketFactory: () => ({ send: () => {}, close: () => {} }),
    });
    const r = await client.dryRun("p1", "android");
    expect(r).toEqual(report);
    expect(log).toEqual([
      {
        url: "http://x/api/tasks/dry-run",
        method: "POST",
        body: JSON.stringify({ projectId: "p1", platform: "android" }),
      },
    ]);
  });

  it("startBeta：无 args 不带键；有 args 原样透传；返回 taskId", async () => {
    const log: Array<{ url: string; method: string; body?: string }> = [];
    const client = new UiClient({
      httpBase: "http://x",
      fetchImpl: fakeFetch(log, () => ({ ok: true, taskId: "t-9" })) as unknown as typeof fetch,
      socketFactory: () => ({ send: () => {}, close: () => {} }),
    });
    await expect(client.startBeta("p1", "ios")).resolves.toBe("t-9");
    await expect(client.startBeta("p1", "android", ["--delivery", "ota"])).resolves.toBe("t-9");
    expect(log.map((l) => l.body)).toEqual([
      JSON.stringify({ projectId: "p1", platform: "ios" }),
      JSON.stringify({ projectId: "p1", platform: "android", args: ["--delivery", "ota"] }),
    ]);
  });

  it("服务端 ok:false → 抛 error 文案", async () => {
    const client = new UiClient({
      httpBase: "http://x",
      fetchImpl: (async () =>
        new Response(JSON.stringify({ ok: false, error: "project not found" }), {
          status: 404,
        })) as unknown as typeof fetch,
      socketFactory: () => ({ send: () => {}, close: () => {} }),
    });
    await expect(client.dryRun("nope", "android")).rejects.toThrow("project not found");
  });

  it("onTask/onTaskEnd：task 下行分发；退订后不再收", async () => {
    let push: ((raw: string) => void) | undefined;
    const client = new UiClient({
      httpBase: "http://x",
      fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
      socketFactory: (_url, onMessage) => {
        push = onMessage;
        return { send: () => {}, close: () => {} };
      },
    });
    await client.start();
    // fetchImpl 替身给空对象——refreshProjects 需要 projects 键（undefined → 空）不炸即可
    const seen: Array<[string, unknown]> = [];
    const ends: Array<[string, number]> = [];
    const offTask = client.onTask((taskId, ev) => seen.push([taskId, ev]));
    const offEnd = client.onTaskEnd((taskId, code) => ends.push([taskId, code]));
    push?.(JSON.stringify({ t: "task", taskId: "t1", data: { type: "log", msg: "hi" } }));
    push?.(JSON.stringify({ t: "task.end", taskId: "t1", code: 3 }));
    expect(seen).toEqual([["t1", { type: "log", msg: "hi" }]]);
    expect(ends).toEqual([["t1", 3]]);
    offTask();
    offEnd();
    push?.(JSON.stringify({ t: "task", taskId: "t2", data: { type: "log" } }));
    push?.(JSON.stringify({ t: "task.end", taskId: "t2", code: 0 }));
    expect(seen).toHaveLength(1);
    expect(ends).toHaveLength(1);
  });

  it("connectionState：初始 reconnecting → 收消息 connected → 断连 reconnecting；退订后不再收", async () => {
    let push: ((raw: string) => void) | undefined;
    let drop: (() => void) | undefined;
    const client = new UiClient({
      httpBase: "http://x",
      fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch,
      socketFactory: (_url, onMessage, onClose) => {
        push = onMessage;
        drop = onClose;
        return { send: () => {}, close: () => {} };
      },
    });
    await client.start();
    expect(client.connectionState).toBe("reconnecting");
    const states: string[] = [];
    const off = client.onConnectionChange((s) => states.push(s));
    push?.(JSON.stringify({ t: "tasks", data: [] }));
    expect(client.connectionState).toBe("connected");
    drop?.();
    expect(client.connectionState).toBe("reconnecting");
    expect(states).toEqual(["connected", "reconnecting"]);
    off();
    push?.(JSON.stringify({ t: "tasks", data: [] }));
    drop?.();
    expect(states).toEqual(["connected", "reconnecting"]); // 退订后不再推送
    client.stop();
  });

  it("start() REST 失败仍进 WS 重连循环（错误向上抛，断连自愈由此驱动）", async () => {
    let connects = 0;
    const client = new UiClient({
      httpBase: "http://x",
      fetchImpl: (async () => {
        throw new Error("server down");
      }) as unknown as typeof fetch,
      socketFactory: () => {
        connects += 1;
        return { send: () => {}, close: () => {} };
      },
    });
    await expect(client.start()).rejects.toThrow("server down");
    expect(connects).toBe(1); // 失败也建立了首次 WS 尝试（后续由重连定时器驱动）
    client.stop();
  });
});
