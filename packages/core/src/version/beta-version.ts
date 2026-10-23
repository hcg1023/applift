/**
 * 测试版本名策略（beta）：把「测试包版本名必须与正式包不同」收敛成纯函数。
 *
 * 为什么需要它：pushy 的热更路由只有 (appId, platform, packageVersion) 三元组，
 * packageVersion 就是原生 versionName 字符串。没有分发轨道概念的 OTA 服务，
 * 测试线与正式线只能靠「版本名字符串不同」或「两个 appId」隔离。
 *
 * 三种模式：
 * - offset：段偏移（默认 patch+1000，4.0.0 → 4.0.1000）。三段纯数字，iOS/Android/鸿蒙全通。
 * - suffix：semver prerelease（4.0.0-beta）。iOS 的 TestFlight/App Store 硬拒，鸿蒙仅构建期放行。
 * - app-id：版本名不变，隔离交给两个 pushy 应用记录。
 *
 * 平台能力表只表达「官方口径」：官方不支持的组合直接报错，不静默降级。
 */
import type { BetaVersionConfig } from "../config/schema.js";

export type PrereleasePolicy = "allow" | "warn" | "reject";

export interface PlatformVersionCaps {
  /** versionName 允许的最大数字段数 */
  maxSegments: number;
  /** prerelease 后缀（-beta.1）的官方态度 */
  prerelease: PrereleasePolicy;
  /** 官方口径说明（进报错/告警文案） */
  note: string;
}

export const PLATFORM_VERSION_CAPS: Record<string, PlatformVersionCaps> = {
  ios: {
    maxSegments: 3,
    prerelease: "reject",
    note: "TestFlight / App Store 要求 1–3 段非负整数",
  },
  android: { maxSegments: 4, prerelease: "allow", note: "Gradle 不校验，商店要求数字点分" },
  harmony: {
    maxSegments: 4,
    prerelease: "warn",
    note: "官方文档要求仅由数字和点构成（构建期 schema 实测放行）",
  },
};

export const DEFAULT_BETA_VERSION_CONFIG: BetaVersionConfig = {
  mode: "offset",
  segment: "patch",
  delta: 1000,
};

export interface BetaVersionContext {
  /** 工程 versionName（正式号，如 4.0.0） */
  base: string;
  config?: BetaVersionConfig;
  platform: string;
}

/** 平台能力查表：只认自有键，避免 platform="constructor" 拿到原型上的函数 */
function capsOf(platform: string): PlatformVersionCaps | undefined {
  return Object.hasOwn(PLATFORM_VERSION_CAPS, platform)
    ? PLATFORM_VERSION_CAPS[platform]
    : undefined;
}

interface VersionShape {
  segments: number;
  prerelease?: string;
}

/** 拆 versionName：数字段数 + prerelease（4.0.0-beta.1 → 3 段 + "beta.1"） */
function shapeOf(name: string): VersionShape | null {
  const m = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(name.trim());
  if (!m) return null;
  return { segments: m[1]!.split(".").length, ...(m[2] ? { prerelease: m[2] } : {}) };
}

/** 完整检查（段数 + prerelease 政策）；返回问题描述，null = 可用 */
export function checkVersionNameShape(name: string, platform: string): string | null {
  const caps = capsOf(platform);
  const shape = shapeOf(name);
  if (!shape) return `versionName「${name}」不是「数字段 + 可选 prerelease」形态`;
  if (!caps) return null; // 未知平台不设限（native-* 等）
  if (shape.segments > caps.maxSegments)
    return `${platform} 的 versionName 最多 ${caps.maxSegments} 段数字（${caps.note}）：${name}`;
  if (shape.prerelease && caps.prerelease === "reject")
    return `${platform} 的 versionName 不支持 prerelease 后缀（${caps.note}）：${name}`;
  return null;
}

/**
 * 派生测试版本名。
 * 硬约束（段数超限 / iOS prerelease）直接抛错；harmony 的 prerelease 只告警（见 assertBetaVersionSupported）。
 */
export function betaVersionName(ctx: BetaVersionContext): string {
  const config = ctx.config ?? DEFAULT_BETA_VERSION_CONFIG;
  const name = deriveName(ctx, config);
  const caps = capsOf(ctx.platform);
  const shape = shapeOf(name);
  if (!shape) throw new Error(`派生出的 versionName「${name}」不是合法版本号形态`);
  if (caps) {
    if (shape.segments > caps.maxSegments)
      throw new Error(
        `${ctx.platform} 的 versionName 最多 ${caps.maxSegments} 段数字（${caps.note}）：${name}` +
          `——改用 version.beta.mode=offset（segment=patch）或 app-id`,
      );
    if (shape.prerelease && caps.prerelease === "reject")
      throw new Error(
        `${ctx.platform} 的 versionName 不支持 prerelease 后缀（${caps.note}）：${name}` +
          `——改用 version.beta.mode=offset（segment=patch）或 app-id`,
      );
  }
  return name;
}

function deriveName(ctx: BetaVersionContext, config: BetaVersionConfig): string {
  if (config.mode === "app-id") return ctx.base;
  if (config.mode === "suffix") {
    const template = config.template ?? "{base}-beta";
    // 只支持 {base} 占位：序号类模板需要持久化状态，会破坏「编号全派生」
    if (template.includes("{n}"))
      throw new Error(
        `version.beta.template 不支持 {n}（需要递增序号请用 mode=offset）：${template}`,
      );
    return template.replace(/\{base\}/g, ctx.base);
  }
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(ctx.base);
  if (!m)
    throw new Error(
      `工程 versionName「${ctx.base}」不是 X.Y.Z：version.beta.mode=offset 需要三段数字作为基线`,
    );
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  const delta = config.delta ?? 1000;
  if (!Number.isInteger(delta) || delta <= 0)
    throw new Error(
      `version.beta.delta 必须是正整数（收到 ${String(delta)}）——否则测试包与正式版无法区分`,
    );
  return (config.segment ?? "patch") === "major"
    ? `${major + delta}.${minor}.${patch}`
    : `${major}.${minor}.${patch + delta}`;
}

/**
 * 平台支持性校验：返回告警（不阻断）；官方硬拒的组合抛错。
 * 供发布前调用——配置错在发版前暴露，不留到上传被拒。
 */
export function assertBetaVersionSupported(ctx: BetaVersionContext): string[] {
  const config = ctx.config ?? DEFAULT_BETA_VERSION_CONFIG;
  const warnings: string[] = [];
  if (config.mode === "app-id") return warnings;
  const caps = capsOf(ctx.platform);
  if (!caps) return warnings;
  if (config.mode === "suffix" && caps.prerelease !== "allow") {
    const msg = `${ctx.platform} 的 versionName ${caps.note}：version.beta.mode=suffix 在该平台不可用`;
    if (caps.prerelease === "reject")
      throw new Error(`${msg}——改用 mode=offset（segment=patch）或 app-id`);
    warnings.push(`${msg}（构建期放行，建议改用 offset）`);
  }
  // 即便手工把 base 写成带后缀，也在这里兜底提醒
  return warnings;
}
