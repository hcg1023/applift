/**
 * rn-update 插件：react-native-update（pushy/cresc/自建服务端）的 applift UpdateProvider 实现。
 * 判定引擎为纯函数（五形态完备性见测试头注释）；发布链路 = ppk 产物入口 / 测试通道 / promote / 原生基线。
 * ppk 是构建产物（pushy bundle = metro + hermesc，完整构建链）：由项目先行产出
 * （npm script / CI），applift 只探测/接收——不 spawn 构建命令（架构不变量 1）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readProjectVersions } from "../version/project.js";
import { readArtifactBuildTime, readArtifactVersion } from "../version/artifact.js";
import {
  assertBetaVersionSupported,
  betaVersionName,
  DEFAULT_BETA_VERSION_CONFIG,
} from "../version/beta-version.js";
import type { BetaVersionConfig } from "../config/schema.js";
import { collectReleaseDiff } from "../update.js";
import { findArtifacts } from "../framework.js";
import type {
  DeliveryJudgement,
  FrameworkContext,
  PublishContext,
  UpdateProvider,
} from "../update.js";
import type { AppliftPlugin, HookContext } from "../plugin.js";
import type { PushyCli } from "./pushy-api.js";
import { createPushyApi, readDepVersions, PUSHY_TOKEN_KEY } from "./pushy-api.js";

/**
 * 平台 appId 配置：单 appId（隔离靠版本名）或双 appId（内测/正式各一个 pushy 应用记录）。
 * 双 appId 时 promoteToProd 无法 rebind（跨 appId 的 versionId 不通用），退化为同一 ppk 重发。
 */
export type AppIdConfig = number | { prod: number; beta: number };

export interface RnUpdateOptions {
  /** 各平台的 app 记录号（如 harmony: 34166）；未声明的平台不启用热更 */
  harmony?: AppIdConfig;
  android?: AppIdConfig;
  ios?: AppIdConfig;
  /** 补丁目录（patch-package 约定默认 patches/，项目可覆盖） */
  patchDir?: string;
  /** 正式发布默认灰度比例（缺省 100 全量——promote 语义是"验证后发正式"，灰度是显式选择；
   *  优先级：--rollout 旗标 > 此配置 > 内置默认） */
  defaultRollout?: number;
  /** pushy/cresc 服务端 API 根（自建 cresc 传入，如 https://cresc.example.com/api）；缺省 pushy 官方 */
  serverUrl?: string;
  /** 各平台 ppk 产物探测 pattern（相对项目根，glob）；缺省 pushy 官方输出约定
   *  .pushy/output/{platform}.*.ppk。探测取 mtime 最新；--artifact 显式指定时跳过探测与护栏 */
  ppkPatterns?: Partial<Record<"harmony" | "android" | "ios", string[]>>;
}

/** ppk 探测内置默认：pushy CLI 官方输出约定（tempDir .pushy + output/{platform}.${time}.ppk；
 *  cresc 同构，仅目录 .cresc.temp 不同——用 cresc 的项目在 ppkPatterns 覆盖） */
const DEFAULT_PPK_PATTERNS: Record<"harmony" | "android" | "ios", string[]> = {
  harmony: [".pushy/output/harmony.*.ppk"],
  android: [".pushy/output/android.*.ppk"],
  ios: [".pushy/output/ios.*.ppk"],
};

/** 项目原生目录：任一命中即必须原生发版 */
const NATIVE_DIRS = ["harmony/", "ios/", "android/"];

/** 根级构建/身份配置：改变产物生成方式或应用标识，保守判原生 */
const NATIVE_ROOT_FILES = new Set([
  "app.json",
  "react-native.config.js",
  "react-native.config.cjs",
  "metro.config.js",
  "metro.config.cjs",
  "metro.config.ts",
  "babel.config.js",
  "babel.config.cjs",
]);

type FileVerdict = {
  kind: "js" | "native" | "uncertain" | "dep-analysis";
  rule: string;
  note?: string;
};

function classifyPath(file: string, opts: RnUpdateOptions): FileVerdict {
  if (NATIVE_DIRS.some((d) => file.startsWith(d))) {
    return { kind: "native", rule: "原生目录" };
  }
  const patchDir = opts.patchDir ?? "patches";
  if (file.startsWith(`${patchDir}/`)) {
    return { kind: "native", rule: `补丁目录（${patchDir}/）` };
  }
  if (NATIVE_ROOT_FILES.has(file)) {
    return { kind: "native", rule: "构建/身份配置" };
  }
  if (file === "package.json") {
    return { kind: "dep-analysis", rule: "依赖变更" };
  }
  if (file === "package-lock.json") {
    return { kind: "uncertain", rule: "lockfile 变更（依赖树内部变化）" };
  }
  if (file.startsWith("src/")) {
    return { kind: "js", rule: "JS 层" };
  }
  return { kind: "uncertain", rule: "未知路径（灰区）" };
}

/** 读取 package.json 的依赖集合（deps + devDeps 的 name→range 映射） */
function readDeps(file: string): Record<string, string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(file, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return {};
  }
}

/** node_modules 原生信号检测：true=含原生实现；false=纯 JS；null=无法检测（包未安装） */
function hasNativeSignal(cwd: string, name: string): boolean | null {
  // RNOH 平行包必然携带原生实现
  if (name.startsWith("@react-native-ohos/")) return true;
  const root = path.join(cwd, "node_modules", name);
  const pkgFile = path.join(root, "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8")) as Record<string, unknown>;
    if ("react-native" in pkg || "harmony" in pkg) return true;
  } catch {
    // 包未安装（node_modules 缺失）：无法检测，交由调用方按 uncertain 处理
    return null;
  }
  const dir = fs.readdirSync(root, { withFileTypes: true });
  if (dir.some((e) => e.isFile() && e.name.endsWith(".podspec"))) return true;
  return fs.existsSync(path.join(root, "android", "build.gradle"));
}

/** 锚点..当前的 package.json 依赖对比：返回变更包名列表（无锚点返回 null） */
function changedPackages(cwd: string, anchor: string | undefined): string[] | null {
  if (!anchor) return null;
  const old = readDepsFromGit(cwd, anchor);
  const cur = readDeps(path.join(cwd, "package.json"));
  if (old === null) return null;
  const changed: string[] = [];
  for (const [name, range] of Object.entries(cur)) {
    if (!(name in old) || old[name] !== range) changed.push(name);
  }
  for (const name of Object.keys(old)) {
    if (!(name in cur)) changed.push(name);
  }
  return changed;
}

function readDepsFromGit(cwd: string, ref: string): Record<string, string> | null {
  const r = spawnSync("git", ["show", `${ref}:package.json`], { cwd, encoding: "utf8" });
  if (r.status !== 0) return null;
  try {
    const pkg = JSON.parse(r.stdout) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return null;
  }
}

/**
 * 判定引擎：diff 能否走热更。
 * 五形态完备性：新原生实体必现于 原生目录/依赖(原生包)/补丁/构建配置/JS——前四判原生，纯 JS 判热更，其余灰区。
 */
export function judgeDelivery(
  diff: string[],
  ctx: FrameworkContext,
  opts: RnUpdateOptions,
): DeliveryJudgement {
  const evidence: DeliveryJudgement["evidence"] = [];
  let hasNative = false;
  let hasUncertain = false;
  let hasJs = false;
  if (diff.length === 0) {
    return {
      recommendation: "uncertain",
      confidence: "low",
      evidence: [
        {
          path: "（无 diff）",
          rule: "锚点缺失或无变更",
          note: "无锚点 tag 时无法判定，请人工确认",
        },
      ],
    };
  }
  for (const file of diff) {
    const verdict = classifyPath(file, opts);
    if (verdict.kind === "dep-analysis") {
      // package.json：对比锚点依赖 → 逐包原生信号检测
      const changed = changedPackages(ctx.cwd, ctx.anchor);
      if (changed === null) {
        evidence.push({ path: file, rule: "依赖变更（无锚点）", note: "无法对比，请人工确认" });
        hasUncertain = true;
        continue;
      }
      if (changed.length === 0) {
        evidence.push({
          path: file,
          rule: "构建/身份配置",
          note: "依赖未变（仅元数据），保守判原生",
        });
        hasNative = true;
        continue;
      }
      const signals = changed.map((n) => ({ name: n, signal: hasNativeSignal(ctx.cwd, n) }));
      const nativePkgs = signals.filter((s) => s.signal === true).map((s) => s.name);
      const unknownPkgs = signals.filter((s) => s.signal === null).map((s) => s.name);
      const jsOnly = signals.filter((s) => s.signal === false).map((s) => s.name);
      if (nativePkgs.length > 0) {
        evidence.push({
          path: file,
          rule: "依赖变更（含原生包）",
          note: `原生：${nativePkgs.join(", ")}`,
        });
        hasNative = true;
      } else if (unknownPkgs.length > 0) {
        evidence.push({
          path: file,
          rule: "依赖变更（未安装，无法检测）",
          note: `请先安装依赖再判定：${unknownPkgs.join(", ")}`,
        });
        hasUncertain = true;
      } else {
        evidence.push({
          path: file,
          rule: "依赖变更（纯 JS 包）",
          note: `纯 JS：${jsOnly.join(", ")}`,
        });
        hasJs = true;
      }
      continue;
    }
    evidence.push({ path: file, rule: verdict.rule, note: verdict.note ?? "" });
    if (verdict.kind === "native") hasNative = true;
    else if (verdict.kind === "uncertain") hasUncertain = true;
    else hasJs = true;
  }

  if (hasNative) return { recommendation: "native", confidence: "high", evidence };
  if (hasUncertain) return { recommendation: "uncertain", confidence: "medium", evidence };
  return { recommendation: "ota", confidence: hasJs ? "high" : "low", evidence };
}

/** 正式 promote 的内置默认灰度比例（100 = 全量）。promote 语义是"测试通道已验证、发正式"，
 *  全量是常态、灰度是显式选择（--rollout 或 rnUpdate({ defaultRollout })），不藏在配置后面 */
const DEFAULT_ROLLOUT = 100;

/** 平台 appId（beta 语境优先取双 appId 里的 beta 记录） */
function platformAppId(opts: RnUpdateOptions, platform: string, channel: "beta" | "prod"): number {
  const cfg = (opts as Record<string, unknown>)[platform];
  if (typeof cfg === "number") return cfg;
  if (cfg && typeof cfg === "object") {
    const ids = cfg as Partial<{ prod: number; beta: number }>;
    if (channel === "beta" && typeof ids.beta === "number") return ids.beta;
    if (typeof ids.prod === "number") return ids.prod;
  }
  throw new Error(
    `平台 ${platform} 未配置热更 app 记录：rnUpdate({ ${platform}: <appId> }) 或 rnUpdate({ ${platform}: { prod, beta } })（在 applift.config.ts 的插件参数里声明）`,
  );
}

/** 是否配置了独立的内测 appId（app-id 模式下 promote 无法 rebind） */
function hasDualAppId(opts: RnUpdateOptions, platform: string): boolean {
  const cfg = (opts as Record<string, unknown>)[platform];
  return (
    !!cfg &&
    typeof cfg === "object" &&
    typeof (cfg as { beta?: number }).beta === "number" &&
    (cfg as { beta?: number }).beta !== (cfg as { prod?: number }).prod
  );
}

/** 当前 versionName（readProjectVersions 按 framework 定位工程文件） */
function currentVersionName(ctx: PublishContext): string {
  const versions = readProjectVersions(ctx.cwd, ctx.framework);
  const v = versions.find((x) => x.platform === ctx.platform);
  if (!v?.versionName) {
    throw new Error(
      `未读到平台 ${ctx.platform} 的 versionName（readProjectVersions 无该平台版本文件）`,
    );
  }
  return v.versionName;
}

/** 正则转义：基线名可能来自 suffix 模板（`+` 等元字符），只转义点号会生成错误正则 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 服务端取号：该 versionName 下已有热更名 {ver}-patch.N 的最大 N → next = N+1（首版 N=0 → 1） */
function nextPatchNumber(names: Array<{ name: string }>, versionName: string): number {
  const re = new RegExp(`^${escapeRegExp(versionName)}-patch\\.(\\d+)$`);
  let max = 0;
  for (const { name } of names) {
    const m = name.match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/**
 * 客户端解析：注入了 cli（测试 mock / 特殊 transport）则直用；缺省按凭据构造 OpenAPI 客户端
 * （token 来自 PUSHY_API_TOKEN，bundle 始终走本地 pushy CLI）。
 * fail-fast：token 缺失在本地 bundle 之前报错（不打无谓的 metro 包）。
 */
function resolvePushyClient(
  opts: RnUpdateOptions,
  cli: PushyCli | undefined,
  credentials: Readonly<Record<string, string>> | undefined,
): PushyCli {
  if (cli) return cli;
  const token = credentials?.[PUSHY_TOKEN_KEY];
  if (!token)
    throw new Error(
      `pushy 热更缺少凭据 ${PUSHY_TOKEN_KEY}：在 ~/.applift/credentials.json 对应 profile 配置` +
        `（pushy 网页控制台 → API Token 页创建；CI 可用同名环境变量覆盖）`,
    );
  return createPushyApi({ baseUrl: opts.serverUrl, token });
}

/**
 * ppk 产物入口：--artifact 显式 > ppkPatterns 探测（mtime 最新）。
 * 探测路径强制新鲜度护栏；显式 --artifact 是用户声明「我知道我在发什么」，跳过护栏
 * （与 --delivery ota 的显式覆盖语义一致，同原生 --artifact 不校验产物新旧）。
 */
export async function resolvePpk(opts: RnUpdateOptions, ctx: PublishContext): Promise<string> {
  if (ctx.artifact) return ctx.artifact;
  // provider.platforms 已过滤为配置过 appId 的三端，窄化安全
  const platform = ctx.platform as "harmony" | "android" | "ios";
  const patterns = opts.ppkPatterns?.[platform] ?? DEFAULT_PPK_PATTERNS[platform];
  const ppk = findArtifacts(ctx.cwd, patterns)[0];
  if (!ppk)
    throw new Error(
      `未探测到 ${platform} 的 ppk 热更包（${patterns.join(", ")}）——ppk 是构建产物，` +
        `请先产出（如 npm run ppk:${platform} = pushy bundle --platform ${platform} --no-interactive）再 applift beta，` +
        `或用 --artifact 显式指定 ppk 路径`,
    );
  await assertPpkFresh(ctx.cwd, ppk);
  return ppk;
}

/**
 * 新鲜度护栏：工作区未发布改动（锚点..当前，与判定同口径 collectReleaseDiff）的最新文件
 * mtime 晚于 ppk → 报错——防止忘重新 bundle 把旧 JS 发给测试设备。
 * 无锚点/无 diff/文件已删除（无 mtime 可比）不拦。
 */
async function assertPpkFresh(cwd: string, ppk: string): Promise<void> {
  const diff = await collectReleaseDiff(cwd);
  if (!diff) return;
  let newest = 0;
  let newestFile = "";
  for (const f of diff) {
    try {
      const m = fs.statSync(path.join(cwd, f)).mtimeMs;
      if (m > newest) {
        newest = m;
        newestFile = f;
      }
    } catch {
      // 已删除/改名：无 mtime 可比，跳过
    }
  }
  if (newest > 0 && fs.statSync(ppk).mtimeMs < newest) {
    throw new Error(
      `ppk（${path.basename(ppk)}）早于最新代码改动（${newestFile}）——疑似忘重新 bundle，` +
        `请重新产出 ppk 后再发；确认无误可 --artifact 显式指定跳过此护栏`,
    );
  }
}
/** beta 配置读取（插件在 config:resolved 钩子里捕获；缺省走内置默认） */
export type BetaConfigGetter = () => BetaVersionConfig;

/** 发布新热更的公共骨架：客户端/appId/版本名/ppk 探测 + 服务端取号（publishToBeta/publishToProd 共用） */
async function preparePublish(
  opts: RnUpdateOptions,
  cli: PushyCli | undefined,
  ctx: PublishContext,
  channel: "beta" | "prod",
  getBetaConfig: BetaConfigGetter,
): Promise<{
  client: PushyCli;
  appId: number;
  base: string;
  packageVersion: string;
  ppk: string;
  name: string;
}> {
  const client = resolvePushyClient(opts, cli, ctx.credentials);
  const appId = platformAppId(opts, ctx.platform, channel);
  const base = currentVersionName(ctx);
  // 测试线绑派生版本名（4.0.1000），正式线绑工程版本名（4.0.0）——pushy 只认这个字符串
  const packageVersion =
    channel === "beta"
      ? betaVersionName({ base, config: getBetaConfig(), platform: ctx.platform })
      : base;
  const ppk = await resolvePpk(opts, ctx);
  const existing = await client.versions(appId);
  // 热更名带基线：4.0.1000-patch.1 / 4.0.0-patch.1，promote 后仍可溯源
  const name = `${packageVersion}-patch.${nextPatchNumber(existing, packageVersion)}`;
  return { client, appId, base, packageVersion, ppk, name };
}

/** provider 构造（cli 注入点见 resolvePushyClient；betaConfig 由插件钩子注入） */
export function makeRnUpdateProvider(
  opts: RnUpdateOptions,
  cli?: PushyCli,
  getBetaConfig: BetaConfigGetter = () => DEFAULT_BETA_VERSION_CONFIG,
): UpdateProvider {
  return {
    id: "rn-update",
    frameworks: ["rn"],
    // 已配置 app 记录号的平台即已接入热更；其余平台路由直接走原生
    platforms: (["harmony", "android", "ios"] as const).filter(
      (k) => (opts as Record<string, unknown>)[k] !== undefined,
    ),
    judge: (diff: string[], ctx: FrameworkContext) => judgeDelivery(diff, ctx, opts),
    async publishToBeta(ctx: PublishContext) {
      // 配置缺失先报（与产物/版本读取无关，避免报错信息被下游噪声掩盖）
      platformAppId(opts, ctx.platform, "beta");
      // app-id 模式靠两个应用记录隔离；只有一个 id 时会静默把测试热更发到正式线
      if (getBetaConfig().mode === "app-id" && !hasDualAppId(opts, ctx.platform))
        throw new Error(
          `app-id 模式必须为 ${ctx.platform} 配置两个推送应用记录：rnUpdate({ ${ctx.platform}: { prod, beta } })` +
            `——当前只有单 appId，测试热更会绑到正式线（packageVersion 也与正式相同）`,
        );
      // 官方不支持的策略组合在发布前就报错/告警，不留到上传被拒
      for (const w of assertBetaVersionSupported({
        base: currentVersionName(ctx),
        config: getBetaConfig(),
        platform: ctx.platform,
      }))
        process.stderr.write(`⚠ ${w}\n`);
      const { client, appId, packageVersion, ppk, name } = await preparePublish(
        opts,
        cli,
        ctx,
        "beta",
        getBetaConfig,
      );
      const r = await client.publish({
        appId,
        ppk,
        platform: ctx.platform,
        name,
        description: ctx.note,
        // 测试通道绑定派生版本名——只有装着同版本测试包的设备能收到
        packageVersion,
        deps: readDepVersions(ctx.cwd),
      });
      return { versionName: name, versionId: r.versionId };
    },
    async publishToProd(ctx: PublishContext) {
      const { client, appId, packageVersion, ppk, name } = await preparePublish(
        opts,
        cli,
        ctx,
        "prod",
        getBetaConfig,
      );
      // 灰度比例优先级：--rollout 旗标 > rnUpdate({ defaultRollout }) > 内置默认 100（全量）
      const rollout = ctx.rollout ?? opts.defaultRollout ?? DEFAULT_ROLLOUT;
      const r = await client.publish({
        appId,
        ppk,
        platform: ctx.platform,
        name,
        description: ctx.note,
        // 直接发正式：绑当前工程版本（正式原生线）
        packageVersion,
        rollout,
        deps: readDepVersions(ctx.cwd),
      });
      return {
        versionName: name,
        versionId: r.versionId,
        ...(rollout !== undefined ? { rollout } : {}),
      };
    },
    async promoteToProd(ctx: PublishContext) {
      const config = getBetaConfig();
      // app-id 模式 / 独立内测 appId：跨 appId 的 versionId 不通用，无法 rebind
      // → 返回 null 交回 publishToProd（同一 ppk 重发到正式 appId）
      if (config.mode === "app-id" || hasDualAppId(opts, ctx.platform)) {
        process.stderr.write(
          `⚠ ${ctx.platform} 无法 promote：跨 appId 的 versionId 不通用（app-id/双 appId 模式）` +
            `——转为 publishToProd，同一 ppk 直接发正式应用记录\n`,
        );
        return null;
      }
      const client = resolvePushyClient(opts, cli, ctx.credentials);
      const appId = platformAppId(opts, ctx.platform, "prod");
      const base = currentVersionName(ctx);
      const betaName = betaVersionName({ base, config, platform: ctx.platform });
      const existing = await client.versions(appId);
      const candidates = existing
        .map((v) => {
          const m = v.name.match(new RegExp(`^${escapeRegExp(betaName)}-patch\\.(\\d+)$`));
          return m ? { ...v, n: Number(m[1]) } : null;
        })
        .filter((x): x is { id: number; hash: string; name: string; n: number } => x !== null)
        .sort((a, b) => b.n - a.n);
      const latest = candidates[0];
      // 无可 promote 返回 null（契约语义）：调用方转 publishToProd 直接发正式
      if (!latest) return null;
      // 灰度比例优先级：--rollout 旗标 > rnUpdate({ defaultRollout }) > 内置默认 100（全量）
      const rollout = ctx.rollout ?? opts.defaultRollout ?? DEFAULT_ROLLOUT;
      try {
        await client.rebind({ appId, versionId: latest.id, packageVersion: base, rollout });
      } catch (e) {
        throw new Error(
          `${(e as Error).message}\n提示：promote 需要正式版本 ${base} 的原生基线已上传。` +
            `先执行 applift release ${ctx.platform} --delivery native（只 stage、不含 --submit）生成基线，再重试 promote。`,
        );
      }
      return { versionName: latest.name, ...(rollout !== undefined ? { rollout } : {}) };
    },
  };
}

/** 这条基线属于测试线还是正式线：测试包 versionName 由策略派生，与工程版本名不同。
 *  读不到工程版本时按 prod 处理（保守：宁可少传一条测试基线，也不把测试包灌进正式 app）。 */
function baselineChannel(versionName: string, platform: string, cwd: string): "beta" | "prod" {
  try {
    const versions = readProjectVersions(cwd, null);
    const base = versions.find((v) => v.platform === platform)?.versionName;
    return base && base !== versionName ? "beta" : "prod";
  } catch {
    return "prod";
  }
}

/** 渠道 → 平台兜底映射（新链路优先用 stage:after 透传的 platform；此表仅兼容旧载荷） */
const CHANNEL_PLATFORM: Record<string, string> = {
  agc: "harmony",
};

/** rnUpdate 插件工厂：注册完整 provider（判定 + beta 发布 + promote）+ 原生发版自动基线。
 *  cli 注入点：测试 mock / 特殊 transport；缺省 OpenAPI 客户端（token 来自 ctx.credentials）。
 *  beta 策略由项目配置决定，在 config:resolved 钩子里捕获（不重复声明在插件参数里）。 */
export function rnUpdate(opts: RnUpdateOptions = {}, cli?: PushyCli): AppliftPlugin {
  let betaConfig: BetaVersionConfig = DEFAULT_BETA_VERSION_CONFIG;
  const provider = makeRnUpdateProvider(opts, cli, () => betaConfig);
  // 同一次运行内同 (平台, 版本名) 只传一份基线：test:all 会并发 stage .hap + .app，
  // 两条都传会让服务端面对同名基线（或产生一条假失败告警）
  const uploadedBaselines = new Set<string>();
  return {
    name: "rn-update",
    "config:resolved"(config) {
      betaConfig = config.version?.beta ?? DEFAULT_BETA_VERSION_CONFIG;
    },
    "update:register"(providers: UpdateProvider[]) {
      providers.push(provider);
    },
    // stage:after 的 result 自带 artifactPath（core 补齐的接口字段），无插件级状态、并发天然安全
    async "stage:after"(
      result: {
        channel: string;
        ok: boolean;
        artifactPath?: string;
        platform?: string;
        target?: "beta" | "prod";
      },
      hookCtx: HookContext,
    ) {
      // 优先用 pipeline 透传的 platform（三端接热更后蒲公英也要能传基线）；
      // 旧载荷无 platform 时退回渠道映射（.app 同属 iOS 与鸿蒙整包，不能按扩展名推导）
      const platform = result.platform ?? CHANNEL_PLATFORM[result.channel];
      if (!result.ok || !platform || !result.artifactPath) return;
      if ((opts as Record<string, unknown>)[platform] === undefined) return; // 平台未配置热更，不上传
      try {
        // 基线版本号从产物读取（旧链路服务端从包内解析，API 化后由调用方显式传入）
        const versionName = readArtifactVersion(result.artifactPath)?.versionName;
        if (!versionName)
          throw new Error(
            `未能从产物读出 versionName：${result.artifactPath}（readArtifactVersion 不支持该格式？）`,
          );
        // buildTime 必须与设备上报的编译时间戳精确一致（pushy 服务端不匹配即封锁 6h，
        // 2026-10-26 qy-driver 实证）——读不出时拒绝上传，绝不猜测/使用上传时刻。
        const buildTime = readArtifactBuildTime(result.artifactPath);
        if (!buildTime)
          throw new Error(
            `未能从产物读出 pushy 构建时间戳：${result.artifactPath}（包内缺 meta.json / pushy_build_time？请人工用 pushy CLI 补传基线）`,
          );
        // 显式 target 优先（CLI 的 beta 路径与 release pipeline 都会透传）；
        // 老载荷没有 target 时才退回「版本名 ≠ 工程版本名」的启发式
        const target = result.target ?? baselineChannel(versionName, platform, hookCtx.cwd);
        const appId = platformAppId(opts, platform, target);
        const key = `${platform}:${versionName}`;
        if (uploadedBaselines.has(key)) return;
        uploadedBaselines.add(key);
        const pushy = resolvePushyClient(opts, cli, hookCtx.credentials);
        try {
          await pushy.uploadApp(
            appId,
            result.artifactPath,
            versionName,
            readDepVersions(hookCtx.cwd),
            buildTime,
          );
        } catch (e) {
          // 409 = 同名基线已存在（「版本名或包 hash 重复」）。测试孪生体重建场景
          //（原生依赖修复等，versionName 不变、包内容变）会命中：自动替换旧基线，
          // 安全前提 = 该基线名下无热更版本绑定（删除被绑定的基线会孤儿化热更）。
          if ((e as Error & { status?: number }).status !== 409) throw e;
          const sameName = (await pushy.packages(appId)).filter((p) => p.name === versionName);
          if (sameName.length === 0)
            throw new Error(
              `基线 409 但未发现同名基线（hash 重复？）：${versionName}——请人工核对 pushy 后台`,
            );
          const vers = await pushy.versions(appId);
          const bound = vers.filter(
            (v) =>
              v.packageVersion === versionName ||
              (v.packageVersion === undefined &&
                sameName.some((p) => v.hash === p.hash && v.name === versionName)),
          );
          if (vers.length > 0 && bound.length > 0)
            throw new Error(
              `基线 ${versionName} 已绑定 ${bound.length} 个热更版本，自动替换会使热更孤儿化——` +
                `请人工处理（pushy 后台迁移热更或删除后重发）`,
            );
          if (vers.length > 0 && vers.every((v) => v.packageVersion === undefined))
            throw new Error(
              `服务端未回显热更绑定关系，无法确认 ${versionName} 基线可安全替换——请人工核对后删除重传`,
            );
          for (const p of sameName) await pushy.deletePackage(appId, p.id);
          process.stderr.write(
            `⚠ pushy 基线 ${versionName} 内容已变（同版本名重建），自动删除旧基线 ${sameName
              .map((p) => `#${p.id}(${p.hash})`)
              .join(",")} 并重传\n`,
          );
          await pushy.uploadApp(
            appId,
            result.artifactPath,
            versionName,
            readDepVersions(hookCtx.cwd),
            buildTime,
          );
        }
      } catch (e) {
        uploadedBaselines.delete(
          `${platform}:${readArtifactVersion(result.artifactPath)?.versionName ?? ""}`,
        );
        // 基线上传失败不阻断发布主流程（发版已成功）；提示人工补传
        process.stderr.write(`⚠ pushy 基线上传失败（请人工补传）：${(e as Error).message}\n`);
      }
    },
  };
}
