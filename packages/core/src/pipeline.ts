/**
 * 发布编排引擎：构建计划 → 确认协议 → 并发执行 → 汇总。
 * headless：确认通过注入的 confirm 回调完成（CLI 用 clack/弹窗），core 不碰终端。
 * 插件：可选 PluginHost，在 plan/stage/submit 生命周期触发钩子（可拦截可修改）。
 */
import path from "node:path";
import type { Channel, ChannelContext, ReleasePlanEntry } from "./channel.js";
import type { HistoryEvent } from "./history.js";
import type { PluginHost } from "./plugin.js";

export interface PipelineInput {
  channels: Channel[];
  contexts: Map<string, ChannelContext>;
  /** L2/L3 门槛确认回调；返回 false 中止 */
  confirm: (plan: ReleasePlanEntry[]) => Promise<boolean>;
  concurrency: number;
  cwd: string;
  /** 插件宿主：plan/stage/submit 生命周期钩子（可拦截可修改） */
  plugins?: PluginHost;
  /** 发版历史钩子：stage/submit 每渠道落一条（CLI 注入，core 不碰文件系统） */
  historySink?: (e: HistoryEvent) => void;
}

export interface PipelineSummaryEntry {
  channel: string;
  label: string;
  ok: boolean;
  stageError?: string;
  submitError?: string;
  plan: ReleasePlanEntry;
}

export interface PipelineSummary {
  stage: PipelineSummaryEntry[];
  submit: PipelineSummaryEntry[];
}

async function runLimited<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      await fn(item);
    }
  });
  await Promise.all(workers);
}

/** 错误消息（带一层 cause 解包：fetch 网络层的真实原因如 NotReadableError 藏在 cause 里） */
function errText(e: unknown): string {
  if (e instanceof Error) {
    const cause = e.cause instanceof Error ? `（${e.cause.message}）` : "";
    return `${e.message}${cause}`;
  }
  return String(e);
}

/** stage 阶段：并发传包到各渠道草稿（不提审）；'stage:before' 返回 false 跳过该渠道 */
export async function runStage(input: PipelineInput): Promise<PipelineSummary> {
  const plugins = input.plugins;
  const summary: PipelineSummaryEntry[] = [];
  await runLimited(input.channels, input.concurrency, async (channel) => {
    const ctx = input.contexts.get(channel.id);
    if (!ctx) return;
    let effectiveCtx = ctx;
    if (plugins) {
      const r = await plugins.apply("stage:before", ctx, { channel: channel.id, cwd: input.cwd });
      if (r.blocked) {
        ctx.emit({ type: "warn", message: "被插件跳过（stage:before 拦截）" });
        return;
      }
      effectiveCtx = r.value;
    }
    try {
      const r = channel.capabilities.stage
        ? await channel.stage(effectiveCtx)
        : { ok: false, error: "该渠道不支持只传包（上传与提审一体）" };
      // plan 先算：stage:after 需要 platform 才能把基线上传到正确的 pushy 应用记录
      //（.app 同属 iOS 与鸿蒙整包，扩展名不可靠；渠道映射只覆盖 agc）
      const plan = await safePlan(channel, effectiveCtx);
      if (plugins)
        await plugins.broadcast(
          "stage:after",
          { channel: channel.id, cwd: input.cwd, credentials: effectiveCtx.credentials },
          {
            channel: channel.id,
            ok: r.ok,
            ref: r.ref,
            error: r.error,
            artifactPath: effectiveCtx.artifactPath,
            platform: plan.platform,
            target: "prod",
          },
        );
      summary.push({
        channel: channel.id,
        label: channel.label,
        ok: r.ok,
        stageError: r.error,
        plan,
      });
      input.historySink?.({
        channel: channel.id,
        action: "stage",
        ok: r.ok,
        ref: r.ref,
        artifactVersion: plan.artifactVersion || undefined,
      });
    } catch (e) {
      const plan = await safePlan(channel, effectiveCtx);
      summary.push({
        channel: channel.id,
        label: channel.label,
        ok: false,
        stageError: errText(e),
        plan,
      });
      input.historySink?.({
        channel: channel.id,
        action: "stage",
        ok: false,
        artifactVersion: plan.artifactVersion || undefined,
      });
    }
  });
  if (plugins)
    await plugins.broadcast("notify", { cwd: input.cwd }, { stage: summary, submit: [] });
  return { stage: summary, submit: [] };
}

/** submit 阶段：收集计划 → 插件 plan/submit 钩子 → confirm → 并发提审（L3 不可逆） */
export async function runSubmit(
  input: PipelineInput,
  options: { skipStage: boolean },
): Promise<PipelineSummary> {
  const plugins = input.plugins;
  const plans: ReleasePlanEntry[] = [];
  const basePlans = new Map<string, ReleasePlanEntry>();
  const ctxList: Array<{ channel: Channel; ctx: ChannelContext }> = [];
  for (const channel of input.channels) {
    const ctx = input.contexts.get(channel.id);
    if (!ctx) continue;
    const plan = await safePlan(channel, ctx);
    basePlans.set(channel.id, plan);
    plans.push(plan);
    ctxList.push({ channel, ctx });
  }

  if (plugins) {
    const planR = await plugins.apply("plan:before", plans, { cwd: input.cwd });
    if (planR.blocked) throw new Error("计划被插件拦截（plan:before 返回 false）");
    plans.splice(0, plans.length, ...planR.value);
  }

  const submitGate = await plugins?.apply("submit:before", plans, { cwd: input.cwd });
  if (submitGate?.blocked) throw new Error("提审被插件拦截（submit:before 返回 false）");

  const approved = await input.confirm(plans);
  if (!approved) {
    throw new Error("用户取消了提审（未做任何变更）");
  }

  const summary: PipelineSummaryEntry[] = [];
  await runLimited(ctxList, input.concurrency, async ({ channel, ctx }) => {
    try {
      let effectiveCtx = ctx;
      if (plugins) {
        const r = await plugins.apply("stage:before", ctx, { channel: channel.id, cwd: input.cwd });
        if (r.blocked) {
          summary.push({
            channel: channel.id,
            label: channel.label,
            ok: false,
            submitError: "被插件跳过",
            plan: planFor(plans, basePlans, channel.id, ctx.artifactPath),
          });
          return;
        }
        effectiveCtx = r.value;
      }
      let stagedRef: string | undefined;
      if (!options.skipStage && channel.capabilities.stage) {
        const stageResult = await channel.stage(effectiveCtx);
        if (!stageResult.ok) {
          summary.push({
            channel: channel.id,
            label: channel.label,
            ok: false,
            stageError: stageResult.error,
            plan: planFor(plans, basePlans, channel.id, ctx.artifactPath),
          });
          input.historySink?.({
            channel: channel.id,
            action: "stage",
            ok: false,
            ref: stageResult.ref,
          });
          return;
        }
        // stage 成功的 ref 透传给 submit（供渠道复用已上传草稿，如 googleplay 复用 versionCode 免重传）
        stagedRef = stageResult.ref;
        input.historySink?.({
          channel: channel.id,
          action: "stage",
          ok: true,
          ref: stageResult.ref,
          artifactVersion:
            plans.find((p) => p.channel === channel.id)?.artifactVersion || undefined,
        });
        // --submit 一体路径的 stage 同样广播 stage:after（与 runStage 对称；否则基线上传类插件在该路径静默失效）
        if (plugins) {
          const stagedPlan = planFor(plans, basePlans, channel.id, ctx.artifactPath);
          await plugins.broadcast(
            "stage:after",
            { channel: channel.id, cwd: input.cwd, credentials: effectiveCtx.credentials },
            {
              channel: channel.id,
              ok: true,
              ref: stageResult.ref,
              artifactPath: effectiveCtx.artifactPath,
              platform: stagedPlan.platform,
              target: "prod",
            },
          );
        }
      }
      const r = await channel.submit(effectiveCtx, stagedRef);
      summary.push({
        channel: channel.id,
        label: channel.label,
        ok: r.ok,
        submitError: r.error,
        plan: planFor(plans, basePlans, channel.id, ctx.artifactPath),
      });
      input.historySink?.({
        channel: channel.id,
        action: "submit",
        ok: r.ok,
        ref: r.ref,
        artifactVersion: plans.find((p) => p.channel === channel.id)?.artifactVersion || undefined,
      });
    } catch (e) {
      summary.push({
        channel: channel.id,
        label: channel.label,
        ok: false,
        submitError: errText(e),
        plan: planFor(plans, basePlans, channel.id, ctx.artifactPath),
      });
      input.historySink?.({ channel: channel.id, action: "submit", ok: false });
    }
  });
  const result: PipelineSummary = { stage: [], submit: summary };
  if (plugins) {
    await plugins.broadcast("submit:after", { cwd: input.cwd }, result);
    await plugins.broadcast("notify", { cwd: input.cwd }, result);
  }
  return result;
}

async function safePlan(channel: Channel, ctx: ChannelContext): Promise<ReleasePlanEntry> {
  try {
    return await channel.plan(ctx);
  } catch {
    return fallbackPlan(channel.id, ctx.artifactPath);
  }
}

/** 按产物扩展名推断平台（兜底条目用）：.ipa→ios，.hap/.app→harmony，.apk/.aab 及其余→android。
 *  `.app` 在 applift 的分发口径里只会是鸿蒙整包（iOS 上架/内测统一用 .ipa）——
 *  历史实现把它归到 android，会让 stage:after 把鸿蒙基线传到 android 应用记录。 */
function platformOfArtifact(artifactPath: string): "android" | "ios" | "harmony" {
  const ext = path.extname(artifactPath).toLowerCase();
  if (ext === ".ipa") return "ios";
  if (ext === ".hap" || ext === ".app") return "harmony";
  return "android";
}

/** plan 失败/被插件删除时的兜底条目（保 summary.plan 非可选契约；平台按产物推断不再硬编码 android） */
function fallbackPlan(channelId: string, artifactPath: string): ReleasePlanEntry {
  return {
    channel: channelId,
    platform: platformOfArtifact(artifactPath),
    artifactVersion: "",
    action: "stage+submit",
    afterApproval: "auto-publish",
  };
}
/** 汇总条目取计划：plan:before 改写后的 plans 优先，被插件删除时回退改写前快照，永不返回 undefined */
function planFor(
  plans: ReleasePlanEntry[],
  base: Map<string, ReleasePlanEntry>,
  id: string,
  artifactPath: string,
): ReleasePlanEntry {
  return plans.find((p) => p.channel === id) ?? base.get(id) ?? fallbackPlan(id, artifactPath);
}
