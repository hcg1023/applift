/**
 * 热更能力契约：applift 的第三维扩展（framework × channel 之外的 update 维度）。
 *
 * provider 与 framework 绑定（如 react-native-update 只服务 RN 工程），由插件经
 * 'update:register' 注册；beta/release 管线的投递路由（热更 vs 原生包）消费 judge 结果，
 * 只做推荐与证据展示，最终投递方式由用户在确认界面拍板（CI 非交互时 uncertain 即中止）。
 */
import { spawnSync } from "node:child_process";
import { latestVersionAnchor } from "./version/git.js";
import type { FrameworkAdapter } from "./framework.js";

/** 判定结论：推荐值 + 置信度 + 逐文件证据（透明可审计，不是黑盒） */
export interface DeliveryJudgement {
  recommendation: "ota" | "native" | "uncertain";
  confidence: "high" | "medium" | "low";
  evidence: Array<{ path: string; rule: string; note: string }>;
}

/** judge 的上下文：core 已解析的生效 framework（声明式），provider 不自行探测工程结构 */
export interface FrameworkContext {
  cwd: string;
  framework: FrameworkAdapter;
  /** 上个发版锚点 tag（依赖变更对比 git show 用）；无锚点时缺省 */
  anchor?: string;
}

export interface UpdateProvider {
  id: string;
  /** 支持的 framework adapter id（如 ['rn']）；与项目声明的 framework 不匹配时 core 不采纳 */
  frameworks: string[];
  /** 已接入热更的平台（如 ['harmony']）；缺省视为全部。未接入平台的路由直接走原生 */
  platforms?: string[];
  /** 判定本次 diff 能否走热更（diff = 上个发版锚点到工作区的文件列表，含未提交与未跟踪） */
  judge(diff: string[], ctx: FrameworkContext): Promise<DeliveryJudgement> | DeliveryJudgement;
  /** release 热更路径（必选）：直接发热更正式——ppk 产物入口（--artifact/探测）→ 发布绑正式原生版本 + 灰度。
   *  无内测流程的 provider 只实现此方法即可独立完成正式热更发布（热更不依赖 beta） */
  publishToProd(ctx: PublishContext): Promise<{
    versionName: string;
    versionId: number;
    rollout?: number;
  }>;
  /** beta 热更路径（可选）：热更包发测试通道（测试设备验证用）；无内测流程的 provider 不实现
   *  （beta 判定 ota 时报错引导直接 release） */
  publishToBeta?(ctx: PublishContext): Promise<{ versionName: string; versionId: number }>;
  /** release 热更路径（可选）：测试通道最新已验证热更 promote 到正式（重绑正式原生版本 + 灰度）。
   *  返回 null = 测试通道无可 promote（调用方转 publishToProd 直接发布） */
  promoteToProd?(ctx: PublishContext): Promise<{ versionName: string; rollout?: number } | null>;
}

export interface DeliveryRoute {
  provider: UpdateProvider;
  judgement: DeliveryJudgement;
}

/** 发布上下文：判定/发布共用（platform 为本次发布目标平台） */
export interface PublishContext extends FrameworkContext {
  platform: string;
  /** 更新说明（热更版本的 description） */
  note?: string;
  /** release 热更的灰度比例（CLI 确认时收集；缺省用 provider 默认） */
  rollout?: number;
  /** 已解析 profile 凭据（热更 provider 读服务端 token，如 PUSHY_API_TOKEN；dry-run 路径缺省） */
  credentials?: Readonly<Record<string, string>>;
  /** 显式指定的热更 ppk（--artifact 透传；热更产物入口，与原生 --artifact 对称） */
  artifact?: string;
}

/**
 * 投递路由：按当前 framework 匹配 provider 并执行判定。
 * - 无 provider / 无匹配 → null（走原生包路径，原始行为不受影响）
 * - 多个 provider 匹配同一 framework → 配置错误（一个框架一个热更实现）
 * 结论是推荐值：最终投递方式由用户在确认界面拍板，CI 非交互时 uncertain 中止
 */
export async function routeDelivery(
  providers: UpdateProvider[],
  ctx: FrameworkContext,
  diff: string[],
  platform?: string,
): Promise<DeliveryRoute | null> {
  const matched = providers.filter(
    (p) =>
      p.frameworks.includes(ctx.framework.id) &&
      (!platform || !p.platforms || p.platforms.includes(platform)),
  );
  if (matched.length === 0) return null;
  if (matched.length > 1) {
    throw new Error(
      `多个热更 provider 匹配 framework「${ctx.framework.id}」：${matched
        .map((p) => p.id)
        .join(", ")}——一个框架只应有一个热更实现`,
    );
  }
  const provider = matched[0]!;
  return { provider, judgement: await provider.judge(diff, ctx) };
}

/**
 * 收集上个发版锚点到工作区的变更文件列表。锚点 = 最新 semver tag 或最新 `chore(release):`
 * bump commit 取新者（见 git.ts latestVersionAnchor）——bump 声明后未 release 的窗口内，
 * 判定不会把 bump 自己写入的版本文件误判为原生改动。
 * 含未提交改动与未跟踪文件（pushy bundle 打包的是工作区内容，判定口径必须一致）。
 * 无锚点 / 非 git 仓库 → null（调用方按 uncertain 处理，不猜）。
 */
export async function collectReleaseDiff(cwd: string): Promise<string[] | null> {
  const anchor = latestVersionAnchor(cwd);
  if (!anchor) return null;
  // anchor..HEAD 只含已提交：改为 anchor（对比工作区）+ 未跟踪清单，二者合并去重
  const r = spawnSync("git", ["diff", "--name-only", anchor.ref], { cwd, encoding: "utf8" });
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0 || untracked.status !== 0) return null;
  const files = [...r.stdout.split("\n"), ...untracked.stdout.split("\n")].map((l) => l.trim());
  return [...new Set(files)].filter(Boolean);
}
