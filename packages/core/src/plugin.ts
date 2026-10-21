/**
 * applift 插件系统 —— vite/rollup 风格：配置里声明 plugins 数组，钩子可拦截可修改。
 *
 * 钩子语义（全部支持 async）：
 *   返回 false          → 拦截该动作（如 'submit:before' 返回 false 阻止提审）
 *   返回同类型对象       → 替换（如 'plan:before' 返回修改后的计划）
 *   返回 undefined/void → 透传
 *
 * 内置生命周期：
 *   'config:resolved'  配置合并完成后（最后修改配置的机会）
 *   'channel:register' 注册渠道（自定义平台/商店的扩展点）
 *   'plan:before'      计划生成前（可改 ReleasePlanEntry 列表）
 *   'stage:before'     单渠道传包前（可改 ChannelContext；返回 false 跳过该渠道）
 *   'stage:after'      单渠道传包后
 *   'submit:before'    提审前（安全闸门扩展点：返回 false 拦截提审）
 *   'submit:after'     提审后
 *   'notify'           全部完成后的通知钩子（钉钉/企微/webhook…）
 */
import type { Channel, ChannelContext, ReleasePlanEntry } from "./channel.js";
import type { PipelineSummary } from "./pipeline.js";
import type { ProjectConfig, GlobalConfig } from "./config/schema.js";
import type { ChannelRegistry } from "./channel.js";
import type { FrameworkAdapter } from "./framework.js";
import type { UpdateProvider } from "./update.js";

export interface HookContext {
  /** 触发钩子的渠道 id（channel 级钩子才有） */
  channel?: string;
  /** 项目根目录 */
  cwd: string;
  /** 该渠道已解析的 profile 凭据（stage/submit 级钩子才有；供基线上传类插件读服务端 token） */
  credentials?: Readonly<Record<string, string>>;
}

export interface AppliftPlugin {
  name: string;
  "config:resolved"?(
    config: ProjectConfig,
    ctx: HookContext,
  ): Promise<ProjectConfig | void> | ProjectConfig | void;
  "channel:register"?(registry: ChannelRegistry, ctx: HookContext): Promise<void> | void;
  /** 注册自定义框架适配器（detect/artifactPatterns——扩展新框架的入口，与渠道扩展对称） */
  "framework:register"?(adapters: FrameworkAdapter[], ctx: HookContext): Promise<void> | void;
  /** 注册热更能力 provider（beta/release 投递路由的消费方，与框架/渠道扩展对称） */
  "update:register"?(providers: UpdateProvider[], ctx: HookContext): Promise<void> | void;
  "plan:before"?(
    plans: ReleasePlanEntry[],
    ctx: HookContext,
  ): Promise<ReleasePlanEntry[] | false | void> | ReleasePlanEntry[] | false | void;
  "stage:before"?(
    channelCtx: ChannelContext,
    ctx: HookContext,
  ): Promise<ChannelContext | false | void> | ChannelContext | false | void;
  "stage:after"?(
    result: { channel: string; ok: boolean; ref?: string; error?: string; artifactPath?: string },
    ctx: HookContext,
  ): Promise<void> | void;
  "submit:before"?(
    plans: ReleasePlanEntry[],
    ctx: HookContext,
  ): Promise<ReleasePlanEntry[] | false | void> | ReleasePlanEntry[] | false | void;
  "submit:after"?(summary: PipelineSummary, ctx: HookContext): Promise<void> | void;
  notify?(summary: PipelineSummary, ctx: HookContext): Promise<void> | void;
}

export type PluginHookName = Exclude<keyof AppliftPlugin, "name">;

export class PluginHost {
  constructor(private readonly plugins: AppliftPlugin[]) {}

  /**
   * 顺序执行某钩子；支持「链式替换」（返回对象则替换后继续传给下一插件）与「拦截」（返回 false 立即中止）。
   * 信任边界：返回值按 T 强转、不做形状校验（vite 同款取舍）——插件作者自负其责，
   * 坏形状会在后续消费点显式抛错，宿主不代为静默兜底。
   * @returns {[被拦截?, 最终值]} false 表示被某插件拦截
   */
  async apply<T>(
    hook: PluginHookName,
    value: T,
    ctx: HookContext,
  ): Promise<{ blocked: boolean; value: T }> {
    let current = value;
    for (const plugin of this.plugins) {
      const fn = plugin[hook] as
        | ((v: T, c: HookContext) => Promise<T | false | void> | T | false | void)
        | undefined;
      if (!fn) continue;
      const r = await fn(current, ctx);
      if (r === false) return { blocked: true, value: current };
      if (r !== undefined && r !== null) current = r as T;
    }
    return { blocked: false, value: current };
  }

  /** 无返回值钩子（register/after/notify）顺序广播 */
  async broadcast(hook: PluginHookName, ctx: HookContext, arg?: unknown): Promise<void> {
    for (const plugin of this.plugins) {
      const fn = plugin[hook] as ((a: unknown, c: HookContext) => unknown) | undefined;
      if (!fn) continue;
      await fn(arg, ctx);
    }
  }
}

/**
 * defineConfig —— vite 同款体验：applift.config.ts 导出时提供类型提示。
 * plugins 中允许嵌套工厂函数（如 dingtalkNotify({...}) 直接返回插件对象）。
 */
export interface AppliftUserConfig extends Partial<ProjectConfig> {
  plugins?: Array<AppliftPlugin | (() => AppliftPlugin)>;
}

export function defineConfig(config: AppliftUserConfig): AppliftUserConfig {
  return config;
}

/** 解析用户配置中的插件（工厂惰性求值），供 PluginHost 构造 */
export function resolvePlugins(userConfig: AppliftUserConfig): AppliftPlugin[] {
  return (userConfig.plugins ?? []).map((p) => (typeof p === "function" ? p() : p));
}

export type { Channel, ChannelContext, ReleasePlanEntry, PipelineSummary, GlobalConfig };
