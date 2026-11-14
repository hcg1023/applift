import { describe, expect, it } from "vitest";
import {
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
