import { afterAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { AppliftRunner, type RunResult } from "./runner.js";
import { ProjectRegistry } from "./registry.js";
import { type FeedEvent, type ProjectSnapshot, StatusAggregator } from "./aggregator.js";

const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `ui-server-agg-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

/** 假 runner：按 cwd 返回可编程的 StatusReport */
function fakeRunnerFactory(
  responses: Map<string, () => RunResult>,
): (cwd: string) => AppliftRunner {
  return (cwd: string) =>
    ({
      run: async () => {
        const fn = responses.get(cwd);
        if (!fn) return { code: 1, stdout: "", stderr: `no fake for ${cwd}` };
        return fn();
      },
    }) as unknown as AppliftRunner;
}

function statusJson(results: object[]): string {
  return JSON.stringify({ fetchedAt: new Date().toISOString(), results }) + "\n";
}

/** 手动假时钟：收集 interval 注册，tick 推进 */
function fakeTimers() {
  const intervals = new Map<number, { fn: () => void; delay: number }>();
  let nextId = 1;
  let now = 1_000_000;
  return {
    timers: {
      setInterval: ((fn: () => void, delay?: number) => {
        const id = nextId++;
        intervals.set(id, { fn, delay: delay ?? 0 });
        return id;
      }) as unknown as typeof setInterval,
      clearInterval: ((id: number) => {
        intervals.delete(id);
      }) as unknown as typeof clearInterval,
    },
    /** 推进虚拟时间，触发所有到期的 interval（一次性触发，不模拟长期循环） */
    async tick(ms: number) {
      const firedBefore = snapshots.length;
      now += ms;
      for (const [, t] of intervals)
        if (ms >= t.delay) {
          await t.fn();
          // 回调里是 void refreshNow()：轮转 macrotask 直到快照真正落地（await 真实信号而非定长等待）
          for (let i = 0; i < 1000 && snapshots.length === firedBefore; i++)
            await new Promise(setImmediate);
        }
    },
    activeIntervalCount() {
      return intervals.size;
    },
    activeDelay(): number | undefined {
      return [...intervals.values()][0]?.delay;
    },
    /** 当前唯一 interval 的句柄 id（区分"幂等保留"与"重建后恰好剩 1 个"） */
    activeId(): number | undefined {
      return [...intervals.keys()][0];
    },
  };
}

async function setup(prefix: string, projectPaths: string[]) {
  const dir = await tempDir(prefix);
  const registry = new ProjectRegistry(join(dir, "projects.json"));
  for (const p of projectPaths) await registry.add(p);
  return { dir, registry };
}

const snapshots: ProjectSnapshot[] = [];
const feed: FeedEvent[] = [];
const clock = fakeTimers();

function makeAggregator(
  registry: ProjectRegistry,
  baselinePath: string,
  responses: Map<string, () => RunResult>,
  timers = clock.timers,
) {
  snapshots.length = 0;
  feed.length = 0;
  return new StatusAggregator({
    registry,
    runnerFactory: fakeRunnerFactory(responses),
    onSnapshot: (s) => snapshots.push(s),
    onFeed: (e) => feed.push(e),
    baselinePath,
    timers,
  });
}

describe("StatusAggregator", () => {
  it("refreshNow 串行跑全部项目并产出快照", async () => {
    const { dir, registry } = await setup("serial", ["/tmp/p1", "/tmp/p2"]);
    const responses = new Map<string, () => RunResult>([
      [
        "/tmp/p1",
        () => ({
          code: 0,
          stdout: statusJson([
            {
              channel: "pgyer",
              platform: "android",
              state: "reviewing",
              fetchedAt: new Date().toISOString(),
            },
          ]),
          stderr: "",
        }),
      ],
      [
        "/tmp/p2",
        () => ({
          code: 0,
          stdout: statusJson([
            {
              channel: "agc",
              platform: "harmony",
              state: "approved",
              live: true,
              fetchedAt: new Date().toISOString(),
            },
          ]),
          stderr: "",
        }),
      ],
    ]);
    const agg = makeAggregator(registry, join(dir, "state-history.jsonl"), responses);
    await agg.refreshNow();
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every((s) => s.ok)).toBe(true);
    expect(
      snapshots.find((s) => s.projectId === registry.list().find((e) => e.path === "/tmp/p1")!.id),
    ).toMatchObject({
      ok: true,
      channels: [{ channel: "pgyer", state: "reviewing" }],
    });
  });

  it("CLI 非零退出码 → ok=false 不 throw；解析失败同理", async () => {
    const { dir, registry } = await setup("fail", ["/tmp/bad", "/tmp/garbage"]);
    const responses = new Map<string, () => RunResult>([
      ["/tmp/bad", () => ({ code: 1, stdout: "", stderr: "boom" })],
      ["/tmp/garbage", () => ({ code: 0, stdout: "not json{", stderr: "" })],
    ]);
    const agg = makeAggregator(registry, join(dir, "state-history.jsonl"), responses);
    await expect(agg.refreshNow()).resolves.toBeUndefined();
    expect(snapshots).toHaveLength(2);
    expect(snapshots.every((s) => !s.ok)).toBe(true);
    expect(snapshots.every((s) => Array.isArray(s.channels))).toBe(true);
  });

  it("状态跃迁 → FeedEvent + baseline 落盘；重启后从 baseline 恢复并检测跃迁", async () => {
    const { dir, registry } = await setup("transition", ["/tmp/tr"]);
    const baselinePath = join(dir, "state-history.jsonl");
    const mk = (state: string) =>
      new Map<string, () => RunResult>([
        [
          "/tmp/tr",
          () => ({
            code: 0,
            stdout: statusJson([
              {
                channel: "asc",
                platform: "ios",
                state,
                live: state === "approved",
                fetchedAt: new Date().toISOString(),
              },
            ]),
            stderr: "",
          }),
        ],
      ]);

    const agg = makeAggregator(registry, baselinePath, mk("reviewing"));
    await agg.refreshNow();
    expect(feed).toHaveLength(0); // 首轮无基线 → 不发事件

    await agg.refreshNow(); // 同状态 → 无事件
    expect(feed).toHaveLength(0);

    const agg2 = makeAggregator(registry, baselinePath, mk("approved"));
    await agg2.refreshNow(); // 重启恢复基线：reviewing → approved
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      projectId: registry.list().find((e) => e.path === "/tmp/tr")!.id,
      channel: "asc",
      kind: "state_change",
      from: "reviewing",
      to: "approved",
    });
    expect(typeof feed[0]!.ts).toBe("number");
    expect(feed[0]!.id).toBeTruthy();

    const agg3 = makeAggregator(registry, baselinePath, mk("rejected"));
    await agg3.refreshNow(); // 再重启：approved → rejected
    expect(feed.filter((e) => e.from === "approved" && e.to === "rejected")).toHaveLength(1);

    const lines = (await readFile(baselinePath, "utf8")).trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });

  it("onSnapshot 抛错不炸进程：refreshNow 照常 resolve、轮次不降级、下一轮照常", async () => {
    const { dir, registry } = await setup("cb-throw", ["/tmp/cb"]);
    const baselinePath = join(dir, "state-history.jsonl");
    const responses = new Map<string, () => RunResult>([
      [
        "/tmp/cb",
        () => ({
          code: 0,
          stdout: statusJson([
            {
              channel: "pgyer",
              platform: "android",
              state: "reviewing",
              fetchedAt: new Date().toISOString(),
            },
          ]),
          stderr: "",
        }),
      ],
    ]);
    const calls: string[] = [];
    const agg = new StatusAggregator({
      registry,
      runnerFactory: fakeRunnerFactory(responses),
      onSnapshot: (s) => {
        calls.push(s.projectId);
        throw new Error("subscriber boom");
      },
      onFeed: () => {},
      baselinePath,
    });
    await expect(agg.refreshNow()).resolves.toBeUndefined();
    await expect(agg.refreshNow()).resolves.toBeUndefined();
    expect(calls.length).toBeGreaterThanOrEqual(2); // 回调每轮都被调用（抛错被隔离而非跳过）
    // 轮次本身不降级：baseline 已落盘说明走的是 ok=true 成功路径
    const lines = (await readFile(baselinePath, "utf8")).trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it("runnerFactory 同步抛错 → 降级 ok=false 快照不 throw", async () => {
    const { dir, registry } = await setup("factory-throw", ["/tmp/factory"]);
    const shots: ProjectSnapshot[] = [];
    const agg = new StatusAggregator({
      registry,
      runnerFactory: () => {
        throw new Error("factory boom");
      },
      onSnapshot: (s) => shots.push(s),
      onFeed: () => {},
      baselinePath: join(dir, "state-history.jsonl"),
    });
    await expect(agg.refreshNow()).resolves.toBeUndefined();
    expect(shots).toHaveLength(1);
    expect(shots[0]!.ok).toBe(false);
  });

  it("setIntervals 非有限值回落默认档（不产生 0ms 间隔）", async () => {
    const { dir, registry } = await setup("nan", ["/tmp/nan"]);
    const clock2 = fakeTimers();
    const agg = makeAggregator(
      registry,
      join(dir, "state-history.jsonl"),
      new Map(),
      clock2.timers,
    );
    agg.setIntervals(Number.NaN, Number.NaN);
    agg.setVisible(true);
    expect(clock2.activeDelay()).toBe(5 * 60_000);
    agg.setVisible(false);
    expect(clock2.activeDelay()).toBe(60 * 60_000);
  });

  it("同档 setVisible 幂等：interval 句柄不重建（不重置倒计时）", async () => {
    const { dir, registry } = await setup("idempotent", ["/tmp/idem"]);
    const clock2 = fakeTimers();
    const agg = makeAggregator(
      registry,
      join(dir, "state-history.jsonl"),
      new Map(),
      clock2.timers,
    );
    agg.setVisible(true);
    const fgId = clock2.activeId();
    agg.setVisible(true);
    expect(clock2.activeId()).toBe(fgId);
    agg.setVisible(false);
    const bgId = clock2.activeId();
    expect(bgId).not.toBe(fgId);
    agg.setVisible(false);
    expect(clock2.activeId()).toBe(bgId);
  });

  it("ok=false 的轮次不参与跃迁对比（不产生噪音事件）", async () => {
    const { dir, registry } = await setup("ok-false", ["/tmp/noise"]);
    const baselinePath = join(dir, "state-history.jsonl");
    const good = () => ({
      code: 0,
      stdout: statusJson([
        {
          channel: "pgyer",
          platform: "android",
          state: "reviewing",
          fetchedAt: new Date().toISOString(),
        },
      ]),
      stderr: "",
    });
    const agg = makeAggregator(registry, baselinePath, new Map([["/tmp/noise", good]]));
    await agg.refreshNow();

    const bad = new Map([["/tmp/noise", () => ({ code: 1, stdout: "", stderr: "cli down" })]]);
    const aggBad = makeAggregator(registry, baselinePath, bad);
    await aggBad.refreshNow();

    const recovered = new Map([["/tmp/noise", good]]);
    const aggRe = makeAggregator(registry, baselinePath, recovered);
    await aggRe.refreshNow(); // 恢复后状态未变 → 无事件
    expect(feed).toHaveLength(0);
  });

  it("setVisible 档位切换 + clamp 护栏 + 定时触发刷新", async () => {
    const { dir, registry } = await setup("tiers", ["/tmp/tier"]);
    const responses = new Map<string, () => RunResult>([
      [
        "/tmp/tier",
        () => ({
          code: 0,
          stdout: statusJson([
            {
              channel: "pgyer",
              platform: "android",
              state: "reviewing",
              fetchedAt: new Date().toISOString(),
            },
          ]),
          stderr: "",
        }),
      ],
    ]);
    const clock2 = fakeTimers();
    const agg = makeAggregator(
      registry,
      join(dir, "state-history.jsonl"),
      responses,
      clock2.timers,
    );
    agg.setIntervals(30_000, 16 * 60_000); // fg=30s < 1min → clamp 到 60s；bg 合法
    agg.setVisible(true);
    expect(clock2.activeIntervalCount()).toBe(1);
    expect(clock2.activeDelay()).toBe(60_000);

    const before = snapshots.length;
    await clock2.tick(60_000);
    expect(snapshots.length).toBe(before + 1);

    agg.setVisible(false);
    expect(clock2.activeDelay()).toBe(16 * 60_000);
    agg.setIntervals(2 * 60_000, 5 * 60_000); // bg=5min < 15min → clamp 到 15min，当前在后台档立即生效
    expect(clock2.activeDelay()).toBe(15 * 60_000);

    agg.setVisible(true); // 回前台用 fg 档
    expect(clock2.activeDelay()).toBe(2 * 60_000);
    agg.setVisible(true); // 幂等
    expect(clock2.activeIntervalCount()).toBe(1);
  });

  it("baselinePath 默认指向 ui-server 数据目录", async () => {
    const { registry } = await setup("default-path", []);
    const agg = new StatusAggregator({
      registry,
      runnerFactory: fakeRunnerFactory(new Map()),
      onSnapshot: () => {},
      onFeed: () => {},
    });
    expect(agg.baselinePath).toContain("applift-ui");
    expect(agg.baselinePath.endsWith("state-history.jsonl")).toBe(true);
  });

  it("并发 refreshNow 合并为单轮（限频安全）", async () => {
    const { dir, registry } = await setup("concurrent", ["/tmp/c1"]);
    let calls = 0;
    const slow = new Map<string, () => RunResult>([
      [
        "/tmp/c1",
        () => {
          calls++;
          return {
            code: 0,
            stdout: statusJson([
              {
                channel: "pgyer",
                platform: "android",
                state: "reviewing",
                fetchedAt: new Date().toISOString(),
              },
            ]),
            stderr: "",
          };
        },
      ],
    ]);
    const agg = makeAggregator(registry, join(dir, "state-history.jsonl"), slow);
    const [a, b] = [agg.refreshNow(), agg.refreshNow()];
    await Promise.all([a, b]);
    expect(calls).toBe(1);
  });
});

/** 真 CLI dist 是否已构建（裸仓/未 build 时跳过冒烟，与 runner.test 同款护栏） */
function existsCliDist(): boolean {
  return existsSync(fileURLToPath(new URL("../../../packages/cli/dist/bin.mjs", import.meta.url)));
}

describe.skipIf(!existsCliDist())("真 CLI 桩工程冒烟（dist 未构建则跳过）", () => {
  it("无凭据桩工程 → ok=false 快照不 throw", async () => {
    const dir = await tempDir("real-cli");
    const projDir = join(dir, "stub-project");
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, "applift.config.ts"),
      "export default { android: { stores: { pgyer: { target: 'com.example.stub' } } } }",
      "utf8",
    );
    const registry = new ProjectRegistry(join(dir, "projects.json"));
    await registry.add(projDir);
    const binMjs = fileURLToPath(new URL("../../../packages/cli/dist/bin.mjs", import.meta.url));
    const bin = `${process.execPath} ${binMjs}`;
    const shots: ProjectSnapshot[] = [];
    const agg = new StatusAggregator({
      registry,
      runnerFactory: (cwd) => new AppliftRunner({ cwd, bin }),
      onSnapshot: (s) => shots.push(s),
      onFeed: () => {},
      baselinePath: join(dir, "state-history.jsonl"),
    });
    await expect(agg.refreshNow()).resolves.toBeUndefined();
    expect(shots).toHaveLength(1);
    // 无凭据 → CLI 报错退出：快照降级 ok=false，不 throw
    expect(shots[0]!.ok === false || shots[0]!.channels.every((c) => c.state === "unknown")).toBe(
      true,
    );
  });
});
