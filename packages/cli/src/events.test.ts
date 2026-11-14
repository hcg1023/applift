import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventChannel } from "./events.js";

describe("EventChannel", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("构造时自动发送 hello（protocol:1, cli=包版本）", () => {
    const lines: string[] = [];
    new EventChannel((l) => lines.push(l), { input: new PassThrough() });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      type: "hello",
      protocol: 1,
      cli: "0.13.0",
    });
  });

  it("emit 序列化为 NDJSON 单行", () => {
    const lines: string[] = [];
    const ch = new EventChannel((l) => lines.push(l), {
      input: new PassThrough(),
    });
    ch.emit({ type: "hello", protocol: 1, cli: "0.13.0" });
    ch.emit({ type: "stage", stage: "judge" });
    ch.emit({ type: "log", level: "info", msg: "hi" });
    expect(lines).toHaveLength(4); // hello x2 + stage + log
    expect(lines.every((l) => (l.match(/\n/g) ?? []).length === 1)).toBe(true);
    expect(JSON.parse(lines[3]!)).toEqual({ type: "log", level: "info", msg: "hi" });
  });

  it("confirm：回写合法值 → 解析返回", async () => {
    const inputs = new PassThrough();
    const ch = new EventChannel(() => {}, { input: inputs });
    const p = ch.confirm("delivery", "投递方式", [
      { value: "ota", label: "热更", recommended: true },
      { value: "native", label: "整包" },
    ]);
    inputs.write(JSON.stringify({ type: "confirm", id: "delivery", value: "ota" }) + "\n");
    await expect(p).resolves.toBe("ota");
  });

  it("confirm：非法 value → error log 并继续等待", async () => {
    const inputs = new PassThrough();
    const lines: string[] = [];
    const ch = new EventChannel((l) => lines.push(l), { input: inputs });
    const p = ch.confirm("delivery", "投递方式", [
      { value: "ota", label: "热更" },
      { value: "native", label: "整包" },
    ]);
    inputs.write(JSON.stringify({ type: "confirm", id: "delivery", value: "bad" }) + "\n");
    inputs.write(JSON.stringify({ type: "confirm", id: "delivery", value: "native" }) + "\n");
    await expect(p).resolves.toBe("native");
    const errLog = lines.find((l) => l.includes('"level":"error"'));
    expect(errLog).toBeTruthy();
  });

  it("stdin 坏行 → emit error log 后继续", async () => {
    const inputs = new PassThrough();
    const lines: string[] = [];
    const ch = new EventChannel((l) => lines.push(l), { input: inputs });
    const p = ch.confirm("x", "q", [{ value: "a", label: "A" }]);
    inputs.write("not-json\n");
    inputs.write(JSON.stringify({ type: "confirm", id: "x", value: "a" }) + "\n");
    await expect(p).resolves.toBe("a");
    const errLog = lines.find((l) => l.includes('"level":"error"'));
    expect(errLog).toBeTruthy();
  });

  it("confirm 超时 → ConfirmTimeout（假时钟）", async () => {
    vi.useFakeTimers();
    const ch = new EventChannel(() => {}, {
      input: new PassThrough(),
      confirmTimeoutMs: 1000,
    });
    const p = ch.confirm("x", "q", [{ value: "a", label: "A" }]);
    vi.advanceTimersByTime(1001);
    await expect(p).rejects.toThrow(/确认超时/);
  });

  it("stdin EOF（readline close）→ reject 全部 pending（stdin 已关闭）", async () => {
    const inputs = new PassThrough();
    const ch = new EventChannel(() => {}, { input: inputs, confirmTimeoutMs: 60_000 });
    const p1 = ch.confirm("a", "一", [{ value: "y", label: "Y" }]);
    const p2 = ch.confirm("b", "二", [{ value: "n", label: "N" }]);
    const e1 = p1.catch((e: unknown) => e);
    const e2 = p2.catch((e: unknown) => e);
    inputs.end(); // stdin EOF → readline close
    await expect(e1).resolves.toMatchObject({ message: "stdin 已关闭" });
    await expect(e2).resolves.toMatchObject({ message: "stdin 已关闭" });
  });

  it("confirm 默认超时 10 分钟", async () => {
    vi.useFakeTimers();
    const ch = new EventChannel(() => {}, { input: new PassThrough() });
    const p = ch.confirm("x", "q", [{ value: "a", label: "A" }]);
    vi.advanceTimersByTime(10 * 60_000 - 1);
    vi.advanceTimersByTime(2);
    await expect(p).rejects.toThrow(/600000ms/);
  });
});
