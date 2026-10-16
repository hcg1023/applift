import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Channel,
  ChannelContext,
  ReleasePlanEntry,
  ReviewStatus,
  StageResult,
  SubmitResult,
} from "./channel.js";
import type { HistoryEvent } from "./history.js";
import { runStage, runSubmit, type PipelineInput, type PipelineSummary } from "./pipeline.js";
import { PluginHost, type HookContext, type QypubPlugin } from "./plugin.js";
import { makeTestCtx } from "./test-utils.js";
import { sleep } from "./util.js";

/** 测试替身渠道：实现 Channel 接口，plan/stage/submit 均为 vi.fn 便于断言调用 */
function fakeChannel(spec: {
  id: string;
  label?: string;
  canStage?: boolean;
  artifactVersion?: string;
  planThrows?: boolean;
  stage?: () => Promise<StageResult>;
  submit?: () => Promise<SubmitResult>;
}): Channel {
  const { id } = spec;
  return {
    id,
    label: spec.label ?? `${id}-label`,
    capabilities: { stage: spec.canStage ?? true, submit: true, scheduled: false, status: false },
    plan: vi.fn(async (_ctx: ChannelContext): Promise<ReleasePlanEntry> => {
      if (spec.planThrows) throw new Error(`plan-boom-${id}`);
      return {
        channel: id,
        platform: "android",
        artifactVersion: spec.artifactVersion ?? "1.2.3",
        action: "stage+submit",
        afterApproval: "auto-publish",
      };
    }),
    stage: vi.fn(
      spec.stage ?? (async (): Promise<StageResult> => ({ ok: true, ref: `${id}-stage-ref` })),
    ),
    submit: vi.fn(
      spec.submit ?? (async (): Promise<SubmitResult> => ({ ok: true, ref: `${id}-submit-ref` })),
    ),
    status: vi.fn(async (): Promise<ReviewStatus> => ({ state: "unknown" })),
  };
}

/** makeTestCtx 产物的命名契约：事件收集器 + 渠道上下文 */
interface TestCtx {
  events: Array<{ type: string; [k: string]: unknown }>;
  ctx: ChannelContext;
}

function makePipelineInput(
  channels: Channel[],
  opts: {
    concurrency?: number;
    plugins?: PluginHost;
    confirm?: PipelineInput["confirm"];
    historySink?: PipelineInput["historySink"];
  } = {},
): { input: PipelineInput; ctxs: Map<string, TestCtx> } {
  const ctxs = new Map<string, TestCtx>();
  const contexts = new Map<string, ChannelContext>();
  for (const ch of channels) {
    const made = makeTestCtx({ artifactPath: `/tmp/${ch.id}-release.apk` });
    ctxs.set(ch.id, made);
    contexts.set(ch.id, made.ctx);
  }
  return {
    input: {
      channels,
      contexts,
      confirm: opts.confirm ?? (async () => true),
      concurrency: opts.concurrency ?? 4,
      cwd: "/project",
      plugins: opts.plugins,
      historySink: opts.historySink,
    },
    ctxs,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("runStage", () => {
  it("并发执行：同时运行数不超过 concurrency，全部渠道入汇总", async () => {
    vi.useFakeTimers();
    let active = 0;
    let peak = 0;
    const channels = ["a", "b", "c", "d"].map((id) =>
      fakeChannel({
        id,
        stage: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await sleep(10);
          active -= 1;
          return { ok: true, ref: `${id}-ref` };
        },
      }),
    );
    const { input } = makePipelineInput(channels, { concurrency: 2 });
    const running = runStage(input);
    await vi.advanceTimersByTimeAsync(30);
    const summary = await running;
    expect(peak).toBe(2);
    expect(summary.stage.map((e) => e.channel).sort()).toEqual(["a", "b", "c", "d"]);
    expect(summary.stage.every((e) => e.ok)).toBe(true);
    expect(summary.submit).toEqual([]);
  });

  it("正常路径：每渠道产生 ok 条目并保留 plan 元数据（platform/action/afterApproval）", async () => {
    const a = fakeChannel({ id: "a", artifactVersion: "2.0.0" });
    const { input } = makePipelineInput([a]);
    const summary = await runStage(input);
    expect(summary.stage).toHaveLength(1);
    expect(summary.stage[0]?.plan).toEqual({
      channel: "a",
      platform: "android",
      artifactVersion: "2.0.0",
      action: "stage+submit",
      afterApproval: "auto-publish",
    });
    expect(summary.stage[0]).toMatchObject({
      channel: "a",
      label: "a-label",
      ok: true,
      stageError: undefined,
    });
    expect(vi.mocked(a.stage).mock.calls).toHaveLength(1);
  });

  it("stage:before 返回 false → 跳过该渠道（不发 stage、无汇总条目）并 emit warn", async () => {
    const gate: QypubPlugin = {
      name: "gate",
      "stage:before"(_ctx, hctx) {
        return hctx.channel === "b" ? false : undefined;
      },
    };
    const a = fakeChannel({ id: "a" });
    const b = fakeChannel({ id: "b" });
    const { input, ctxs } = makePipelineInput([a, b], { plugins: new PluginHost([gate]) });
    const summary = await runStage(input);
    expect(vi.mocked(a.stage).mock.calls).toHaveLength(1);
    expect(vi.mocked(b.stage).mock.calls).toHaveLength(0);
    expect(summary.stage.map((e) => e.channel)).toEqual(["a"]);
    expect(ctxs.get("b")?.events).toContainEqual({
      type: "warn",
      message: "被插件跳过（stage:before 拦截）",
    });
  });

  it("stage:before 返回新 ctx → stage 与 plan 均收到改写后的上下文", async () => {
    const rewrite: QypubPlugin = {
      name: "rewrite",
      "stage:before"(ctx) {
        return { ...ctx, artifactPath: "/tmp/patched.apk", updateDescription: "内测" };
      },
    };
    const a = fakeChannel({ id: "a" });
    const { input } = makePipelineInput([a], { plugins: new PluginHost([rewrite]) });
    await runStage(input);
    expect(vi.mocked(a.stage).mock.calls[0]?.[0]).toMatchObject({
      artifactPath: "/tmp/patched.apk",
      updateDescription: "内测",
    });
    expect(vi.mocked(a.plan).mock.calls[0]?.[0]?.updateDescription).toBe("内测");
  });

  it("capabilities.stage=false → 不调 stage，返回明确错误文案（plan 元数据仍完整）", async () => {
    const xiaomi = fakeChannel({ id: "xiaomi", canStage: false });
    const { input } = makePipelineInput([xiaomi]);
    const summary = await runStage(input);
    expect(vi.mocked(xiaomi.stage).mock.calls).toHaveLength(0);
    expect(summary.stage).toHaveLength(1);
    expect(summary.stage[0]).toMatchObject({
      channel: "xiaomi",
      ok: false,
      stageError: "该渠道不支持只传包（上传与提审一体）",
    });
    expect(summary.stage[0]?.plan.channel).toBe("xiaomi");
  });

  it("stage 抛异常 → 捕获入汇总，plan 兜底不丢", async () => {
    const bad = fakeChannel({
      id: "bad",
      stage: async () => {
        throw new Error("上传炸了");
      },
    });
    const { input } = makePipelineInput([bad]);
    const summary = await runStage(input);
    expect(summary.stage[0]).toMatchObject({ channel: "bad", ok: false, stageError: "上传炸了" });
    expect(summary.stage[0]?.plan.artifactVersion).toBe("1.2.3");
  });

  it("stage 抛异常 → 失败也落历史（historySink 收到 ok:false 的 stage 事件，含 artifactVersion）", async () => {
    const bad = fakeChannel({
      id: "bad",
      stage: async () => {
        throw new Error("上传炸了");
      },
    });
    const events: HistoryEvent[] = [];
    const { input } = makePipelineInput([bad], { historySink: (e) => events.push(e) });
    await runStage(input);
    expect(events).toEqual([
      { channel: "bad", action: "stage", ok: false, artifactVersion: "1.2.3" },
    ]);
  });

  it("plan 抛异常 → 汇总条目携带 safePlan 兜底计划（artifactVersion 为空）", async () => {
    const ch = fakeChannel({ id: "noplan", planThrows: true });
    const { input } = makePipelineInput([ch]);
    const summary = await runStage(input);
    expect(summary.stage[0]?.ok).toBe(true);
    expect(summary.stage[0]?.plan).toEqual({
      channel: "noplan",
      platform: "android",
      artifactVersion: "",
      action: "stage+submit",
      afterApproval: "auto-publish",
    });
  });

  it("contexts 缺失的渠道被静默跳过", async () => {
    const a = fakeChannel({ id: "a" });
    const orphan = fakeChannel({ id: "orphan" });
    const { input } = makePipelineInput([a, orphan]);
    input.contexts.delete("orphan");
    const summary = await runStage(input);
    expect(summary.stage.map((e) => e.channel)).toEqual(["a"]);
    expect(vi.mocked(orphan.stage).mock.calls).toHaveLength(0);
  });

  it("stage:after 逐渠道触发，notify 收到 stage 汇总（含 cwd）", async () => {
    const afters: Array<{
      channel: string;
      ok: boolean;
      ref?: string;
      error?: string;
      hctx: HookContext;
    }> = [];
    const notifies: Array<{ summary: PipelineSummary; hctx: HookContext }> = [];
    const spy: QypubPlugin = {
      name: "spy",
      "stage:after"(result, hctx) {
        afters.push({
          channel: result.channel,
          ok: result.ok,
          ref: result.ref,
          error: result.error,
          hctx,
        });
      },
      notify(summary, hctx) {
        notifies.push({ summary, hctx });
      },
    };
    const a = fakeChannel({ id: "a" });
    const b = fakeChannel({ id: "b" });
    const { input } = makePipelineInput([a, b], { plugins: new PluginHost([spy]) });
    const summary = await runStage(input);
    expect(afters.map((s) => s.channel).sort()).toEqual(["a", "b"]);
    expect(afters[0]).toMatchObject({ ok: true, ref: expect.any(String) });
    expect(notifies).toHaveLength(1);
    expect(notifies[0]?.hctx.cwd).toBe("/project");
    expect(notifies[0]?.summary).toEqual({ stage: summary.stage, submit: [] });
  });

  it("stage 成功且带 historySink：事件含 ref，artifactVersion 为空时省略", async () => {
    const a = fakeChannel({ id: "a", artifactVersion: "" });
    const events: HistoryEvent[] = [];
    const { input } = makePipelineInput([a], { historySink: (e) => events.push(e) });
    await runStage(input);
    expect(events).toEqual([
      { channel: "a", action: "stage", ok: true, ref: "a-stage-ref", artifactVersion: undefined },
    ]);
  });

  it("stage 抛异常且带 historySink：artifactVersion 为空时省略", async () => {
    const bad = fakeChannel({
      id: "bad",
      artifactVersion: "",
      stage: async () => {
        throw new Error("上传炸了");
      },
    });
    const events: HistoryEvent[] = [];
    const { input } = makePipelineInput([bad], { historySink: (e) => events.push(e) });
    await runStage(input);
    expect(events).toEqual([
      { channel: "bad", action: "stage", ok: false, artifactVersion: undefined },
    ]);
  });
});

describe("runSubmit", () => {
  it("正常路径：confirm 收到计划 → stage 成功后 submit，汇总 ok", async () => {
    const a = fakeChannel({ id: "a", artifactVersion: "3.1.4" });
    const confirmPlans: ReleasePlanEntry[][] = [];
    const { input } = makePipelineInput([a], {
      confirm: async (plans) => {
        confirmPlans.push(plans);
        return true;
      },
    });
    const summary = await runSubmit(input, { skipStage: false });
    expect(confirmPlans).toEqual([
      [
        {
          channel: "a",
          platform: "android",
          artifactVersion: "3.1.4",
          action: "stage+submit",
          afterApproval: "auto-publish",
        },
      ],
    ]);
    expect(vi.mocked(a.stage).mock.calls).toHaveLength(1);
    expect(vi.mocked(a.submit).mock.calls).toHaveLength(1);
    expect(summary.stage).toEqual([]);
    expect(summary.submit[0]).toMatchObject({
      channel: "a",
      label: "a-label",
      ok: true,
      submitError: undefined,
    });
    expect(summary.submit[0]?.plan).toBe(confirmPlans[0]?.[0]);
  });

  it("plan:before 修改计划 → confirm 与汇总均拿到改写后的计划", async () => {
    const modifier: QypubPlugin = {
      name: "modifier",
      "plan:before"(plans) {
        return plans.map((p) => ({ ...p, notes: "改过的" }));
      },
    };
    const a = fakeChannel({ id: "a" });
    const confirmPlans: ReleasePlanEntry[][] = [];
    const { input } = makePipelineInput([a], {
      plugins: new PluginHost([modifier]),
      confirm: async (plans) => {
        confirmPlans.push(plans);
        return true;
      },
    });
    const summary = await runSubmit(input, { skipStage: true });
    expect(confirmPlans[0]?.[0]?.notes).toBe("改过的");
    expect(summary.submit[0]?.plan.notes).toBe("改过的");
  });

  it("plan:before 删除某渠道计划 → 汇总条目回退改写前计划，plan 永不为 undefined", async () => {
    const pruner: QypubPlugin = {
      name: "pruner",
      "plan:before"(plans) {
        return plans.filter((p) => p.channel !== "b");
      },
    };
    const a = fakeChannel({ id: "a" });
    const b = fakeChannel({ id: "b", artifactVersion: "9.9.9" });
    const { input } = makePipelineInput([a, b], { plugins: new PluginHost([pruner]) });
    const summary = await runSubmit(input, { skipStage: true });
    expect(vi.mocked(b.submit).mock.calls).toHaveLength(1);
    expect(summary.submit.find((e) => e.channel === "b")?.plan).toEqual({
      channel: "b",
      platform: "android",
      artifactVersion: "9.9.9",
      action: "stage+submit",
      afterApproval: "auto-publish",
    });
    expect(summary.submit.every((e) => e.plan !== undefined)).toBe(true);
  });

  it("plan:before 返回 false → 抛错且不触任何渠道", async () => {
    const gate: QypubPlugin = {
      name: "gate",
      "plan:before"() {
        return false;
      },
    };
    const a = fakeChannel({ id: "a" });
    const confirm = vi.fn(async () => true);
    const { input } = makePipelineInput([a], { plugins: new PluginHost([gate]), confirm });
    await expect(runSubmit(input, { skipStage: false })).rejects.toThrow(
      "计划被插件拦截（plan:before 返回 false）",
    );
    expect(vi.mocked(a.stage).mock.calls).toHaveLength(0);
    expect(vi.mocked(a.submit).mock.calls).toHaveLength(0);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("submit:before 返回 false → 抛错且未 confirm 未提审", async () => {
    const gate: QypubPlugin = {
      name: "gate",
      "submit:before"() {
        return false;
      },
    };
    const a = fakeChannel({ id: "a" });
    const confirm = vi.fn(async () => true);
    const { input } = makePipelineInput([a], { plugins: new PluginHost([gate]), confirm });
    await expect(runSubmit(input, { skipStage: false })).rejects.toThrow(
      "提审被插件拦截（submit:before 返回 false）",
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(vi.mocked(a.submit).mock.calls).toHaveLength(0);
  });

  it("confirm 拒绝 → 抛“未做任何变更”，stage/submit 均未执行", async () => {
    const a = fakeChannel({ id: "a" });
    const { input } = makePipelineInput([a], { confirm: async () => false });
    await expect(runSubmit(input, { skipStage: false })).rejects.toThrow(
      "用户取消了提审（未做任何变更）",
    );
    expect(vi.mocked(a.stage).mock.calls).toHaveLength(0);
    expect(vi.mocked(a.submit).mock.calls).toHaveLength(0);
  });

  it("skipStage=true → 跳过 stage 直接 submit", async () => {
    const a = fakeChannel({ id: "a" });
    const { input } = makePipelineInput([a]);
    const summary = await runSubmit(input, { skipStage: true });
    expect(vi.mocked(a.stage).mock.calls).toHaveLength(0);
    expect(vi.mocked(a.submit).mock.calls).toHaveLength(1);
    expect(summary.submit[0]?.ok).toBe(true);
  });

  it("skipStage=false 且 capabilities.stage=false → 静默跳过 stage 直接 submit", async () => {
    const xiaomi = fakeChannel({ id: "xiaomi", canStage: false });
    const { input } = makePipelineInput([xiaomi]);
    const summary = await runSubmit(input, { skipStage: false });
    expect(vi.mocked(xiaomi.stage).mock.calls).toHaveLength(0);
    expect(vi.mocked(xiaomi.submit).mock.calls).toHaveLength(1);
    expect(summary.submit[0]?.ok).toBe(true);
  });

  it("stage 失败 → 短路不入 submit，错误记入 stageError", async () => {
    const a = fakeChannel({ id: "a", stage: async () => ({ ok: false, error: "上传超时" }) });
    const { input } = makePipelineInput([a]);
    const summary = await runSubmit(input, { skipStage: false });
    expect(vi.mocked(a.submit).mock.calls).toHaveLength(0);
    expect(summary.submit[0]).toMatchObject({ channel: "a", ok: false, stageError: "上传超时" });
    expect(summary.submit[0]?.submitError).toBeUndefined();
  });

  it("stage 抛异常 → 走 catch 分支记 submitError", async () => {
    const a = fakeChannel({
      id: "a",
      stage: async () => {
        throw new Error("stage-throw");
      },
    });
    const { input } = makePipelineInput([a]);
    const summary = await runSubmit(input, { skipStage: false });
    expect(summary.submit[0]).toMatchObject({ ok: false, submitError: "stage-throw" });
    expect(summary.submit[0]?.stageError).toBeUndefined();
    expect(vi.mocked(a.submit).mock.calls).toHaveLength(0);
  });

  it("submit 返回失败 → 汇总记录 submitError", async () => {
    const a = fakeChannel({
      id: "a",
      submit: async () => ({ ok: false, error: "审核单创建失败" }),
    });
    const { input } = makePipelineInput([a]);
    const summary = await runSubmit(input, { skipStage: true });
    expect(summary.submit[0]).toMatchObject({
      channel: "a",
      ok: false,
      submitError: "审核单创建失败",
    });
  });

  it("submit 抛异常 → 捕获记 submitError", async () => {
    const a = fakeChannel({
      id: "a",
      submit: async () => {
        throw new Error("submit-throw");
      },
    });
    const { input } = makePipelineInput([a]);
    const summary = await runSubmit(input, { skipStage: true });
    expect(summary.submit[0]).toMatchObject({ ok: false, submitError: "submit-throw" });
  });

  it("submit 阶段 stage:before 拦截 → 条目 ok:false、submitError=被插件跳过", async () => {
    const gate: QypubPlugin = {
      name: "gate",
      "stage:before"(_ctx, hctx) {
        return hctx.channel === "b" ? false : undefined;
      },
    };
    const a = fakeChannel({ id: "a" });
    const b = fakeChannel({ id: "b" });
    const { input } = makePipelineInput([a, b], { plugins: new PluginHost([gate]) });
    const summary = await runSubmit(input, { skipStage: false });
    expect(summary.submit.find((e) => e.channel === "b")).toMatchObject({
      ok: false,
      submitError: "被插件跳过",
    });
    expect(vi.mocked(b.stage).mock.calls).toHaveLength(0);
    expect(vi.mocked(b.submit).mock.calls).toHaveLength(0);
    expect(summary.submit.find((e) => e.channel === "a")?.ok).toBe(true);
  });

  it("plan 抛异常 → safePlan 兜底计划进入 confirm", async () => {
    const a = fakeChannel({ id: "a", planThrows: true });
    const confirmPlans: ReleasePlanEntry[][] = [];
    const { input } = makePipelineInput([a], {
      confirm: async (plans) => {
        confirmPlans.push(plans);
        return true;
      },
    });
    await runSubmit(input, { skipStage: true });
    expect(confirmPlans).toEqual([
      [
        {
          channel: "a",
          platform: "android",
          artifactVersion: "",
          action: "stage+submit",
          afterApproval: "auto-publish",
        },
      ],
    ]);
  });

  it("contexts 缺失的渠道不入计划也不提审", async () => {
    const a = fakeChannel({ id: "a" });
    const orphan = fakeChannel({ id: "orphan" });
    const confirmPlans: ReleasePlanEntry[][] = [];
    const { input } = makePipelineInput([a, orphan], {
      confirm: async (plans) => {
        confirmPlans.push(plans);
        return true;
      },
    });
    input.contexts.delete("orphan");
    await runSubmit(input, { skipStage: true });
    expect(confirmPlans.map((p) => p.map((e) => e.channel))).toEqual([["a"]]);
    expect(vi.mocked(orphan.submit).mock.calls).toHaveLength(0);
  });

  it("submit:after 与 notify 收到同一份最终汇总", async () => {
    const afters: Array<{ summary: PipelineSummary; hctx: HookContext }> = [];
    const notifies: Array<{ summary: PipelineSummary; hctx: HookContext }> = [];
    const spy: QypubPlugin = {
      name: "spy",
      "submit:after"(summary, hctx) {
        afters.push({ summary, hctx });
      },
      notify(summary, hctx) {
        notifies.push({ summary, hctx });
      },
    };
    const a = fakeChannel({ id: "a" });
    const { input } = makePipelineInput([a], { plugins: new PluginHost([spy]) });
    await runSubmit(input, { skipStage: true });
    expect(afters).toHaveLength(1);
    expect(notifies).toHaveLength(1);
    expect(notifies[0]?.hctx.cwd).toBe("/project");
  });

  it("带 historySink：stage 成功与 submit 成功各落一条（artifactVersion 为空时省略）", async () => {
    const a = fakeChannel({ id: "a", artifactVersion: "" });
    const events: HistoryEvent[] = [];
    const { input } = makePipelineInput([a], { historySink: (e) => events.push(e) });
    const summary = await runSubmit(input, { skipStage: false });
    expect(summary.submit[0]?.ok).toBe(true);
    expect(events).toEqual([
      { channel: "a", action: "stage", ok: true, ref: "a-stage-ref", artifactVersion: undefined },
      { channel: "a", action: "submit", ok: true, ref: "a-submit-ref", artifactVersion: undefined },
    ]);
  });
});
