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
import { readArtifactVersion } from "../version/artifact.js";
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
import { createPushyApi, PUSHY_TOKEN_KEY } from "./pushy-api.js";

export interface RnUpdateOptions {
  /** 各平台的 app 记录号（如 harmony: 34166）；未声明的平台不启用热更 */
  harmony?: number;
  android?: number;
  ios?: number;
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

/** pushy 官方测试包约定：与正式同源码、仅版本号偏移（major+1000，如 1.6.0→1001.6.0） */
const BETA_VERSION_OFFSET = 1000;

/** 正式 promote 的内置默认灰度比例（100 = 全量）。promote 语义是"测试通道已验证、发正式"，
 *  全量是常态、灰度是显式选择（--rollout 或 rnUpdate({ defaultRollout })），不藏在配置后面 */
const DEFAULT_ROLLOUT = 100;

/** 生成测试包偏移版本号（major+1000）；非数字开头版本号无法偏移，显式报错 */
export function betaPackageVersion(versionName: string): string {
  const m = /^(\d+)(\..+)?$/.exec(versionName);
  if (!m) {
    throw new Error(
      `versionName「${versionName}」非 X.Y.Z 形态，无法按 major+${BETA_VERSION_OFFSET} 生成测试包偏移版本`,
    );
  }
  return `${Number(m[1]!) + BETA_VERSION_OFFSET}${m[2] ?? ""}`;
}

function platformAppId(opts: RnUpdateOptions, platform: string): number {
  const id = (opts as Record<string, unknown>)[platform];
  if (typeof id !== "number") {
    throw new Error(
      `平台 ${platform} 未配置热更 app 记录：rnUpdate({ ${platform}: <appId> })（在 applift.config.ts 的插件参数里声明）`,
    );
  }
  return id;
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

/** 服务端取号：该 versionName 下已有热更名 {ver}-patch.N 的最大 N → next = N+1（首版 N=0 → 1） */
function nextPatchNumber(names: Array<{ name: string }>, versionName: string): number {
  const re = new RegExp(`^${versionName.replace(/\./g, "\\.")}-patch\\.(\\d+)$`);
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
/** 发布新热更的公共骨架：客户端/appId/版本号/ppk 探测 + 服务端取号（publishToBeta/publishToProd 共用） */
async function preparePublish(
  opts: RnUpdateOptions,
  cli: PushyCli | undefined,
  ctx: PublishContext,
): Promise<{ client: PushyCli; appId: number; versionName: string; ppk: string; name: string }> {
  const client = resolvePushyClient(opts, cli, ctx.credentials);
  const appId = platformAppId(opts, ctx.platform);
  const versionName = currentVersionName(ctx);
  const ppk = await resolvePpk(opts, ctx);
  const existing = await client.versions(appId);
  const name = `${versionName}-patch.${nextPatchNumber(existing, versionName)}`;
  return { client, appId, versionName, ppk, name };
}

/** provider 构造（cli 注入点见 resolvePushyClient） */
export function makeRnUpdateProvider(opts: RnUpdateOptions, cli?: PushyCli): UpdateProvider {
  return {
    id: "rn-update",
    frameworks: ["rn"],
    // 已配置 app 记录号的平台即已接入热更；其余平台路由直接走原生
    platforms: (["harmony", "android", "ios"] as const).filter((k) => typeof opts[k] === "number"),
    judge: (diff: string[], ctx: FrameworkContext) => judgeDelivery(diff, ctx, opts),
    async publishToBeta(ctx: PublishContext) {
      const { client, appId, versionName, ppk, name } = await preparePublish(opts, cli, ctx);
      const r = await client.publish({
        appId,
        ppk,
        platform: ctx.platform,
        name,
        description: ctx.note,
        // 测试通道绑定偏移版本（major+1000）——只有装着测试包的设备能收到
        packageVersion: betaPackageVersion(versionName),
      });
      return { versionName: name, versionId: r.versionId };
    },
    async publishToProd(ctx: PublishContext) {
      const { client, appId, versionName, ppk, name } = await preparePublish(opts, cli, ctx);
      // 灰度比例优先级：--rollout 旗标 > rnUpdate({ defaultRollout }) > 内置默认 100（全量）
      const rollout = ctx.rollout ?? opts.defaultRollout ?? DEFAULT_ROLLOUT;
      const r = await client.publish({
        appId,
        ppk,
        platform: ctx.platform,
        name,
        description: ctx.note,
        // 直接发正式：绑当前工程版本（正式原生线，非偏移测试线）
        packageVersion: versionName,
        rollout,
      });
      return {
        versionName: name,
        versionId: r.versionId,
        ...(rollout !== undefined ? { rollout } : {}),
      };
    },
    async promoteToProd(ctx: PublishContext) {
      const client = resolvePushyClient(opts, cli, ctx.credentials);
      const appId = platformAppId(opts, ctx.platform);
      const versionName = currentVersionName(ctx);
      const existing = await client.versions(appId);
      const candidates = existing
        .map((v) => {
          const m = v.name.match(
            new RegExp(`^${versionName.replace(/\./g, "\\.")}-patch\\.(\\d+)$`),
          );
          return m ? { ...v, n: Number(m[1]) } : null;
        })
        .filter((x): x is { id: number; hash: string; name: string; n: number } => x !== null)
        .sort((a, b) => b.n - a.n);
      const latest = candidates[0];
      // 无可 promote 返回 null（契约语义）：调用方转 publishToProd 直接发正式
      if (!latest) return null;
      // 灰度比例优先级：--rollout 旗标 > rnUpdate({ defaultRollout }) > 内置默认 100（全量）
      const rollout = ctx.rollout ?? opts.defaultRollout ?? DEFAULT_ROLLOUT;
      await client.rebind({ appId, versionId: latest.id, packageVersion: versionName, rollout });
      return { versionName: latest.name, ...(rollout !== undefined ? { rollout } : {}) };
    },
  };
}

/** 渠道 → 平台映射（热更已接入的平台；基线上传按此路由） */
const CHANNEL_PLATFORM: Record<string, string> = {
  agc: "harmony",
};

/** rnUpdate 插件工厂：注册完整 provider（判定 + beta 发布 + promote）+ 原生发版自动基线。
 *  cli 注入点：测试 mock / 特殊 transport；缺省 OpenAPI 客户端（token 来自 ctx.credentials）。 */
export function rnUpdate(opts: RnUpdateOptions = {}, cli?: PushyCli): AppliftPlugin {
  const provider = makeRnUpdateProvider(opts, cli);
  return {
    name: "rn-update",
    "update:register"(providers: UpdateProvider[]) {
      providers.push(provider);
    },
    // stage:after 的 result 自带 artifactPath（core 补齐的接口字段），无插件级状态、并发天然安全
    async "stage:after"(
      result: { channel: string; ok: boolean; artifactPath?: string },
      hookCtx: HookContext,
    ) {
      const platform = CHANNEL_PLATFORM[result.channel];
      if (!result.ok || !platform || !result.artifactPath) return;
      const appId = (opts as Record<string, unknown>)[platform];
      if (typeof appId !== "number") return; // 平台未配置热更，不上传
      try {
        // 基线版本号从产物读取（旧链路服务端从包内解析，API 化后由调用方显式传入）
        const versionName = readArtifactVersion(result.artifactPath)?.versionName;
        if (!versionName)
          throw new Error(
            `未能从产物读出 versionName：${result.artifactPath}（readArtifactVersion 不支持该格式？）`,
          );
        await resolvePushyClient(opts, cli, hookCtx.credentials).uploadApp(
          appId,
          result.artifactPath,
          versionName,
        );
      } catch (e) {
        // 基线上传失败不阻断发布主流程（发版已成功）；提示人工补传
        process.stderr.write(`⚠ pushy 基线上传失败（请人工补传）：${(e as Error).message}\n`);
      }
    },
  };
}
