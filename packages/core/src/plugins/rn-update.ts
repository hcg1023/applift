/**
 * rn-update 插件：react-native-update（pushy/cresc/自建服务端）的 applift UpdateProvider 实现。
 * 判定引擎为纯函数（五形态完备性见测试头注释）；发布链路 = ppk 构建 / 测试通道 / promote / 原生基线。
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readProjectVersions } from "../version/project.js";
import type {
  DeliveryJudgement,
  FrameworkContext,
  PublishContext,
  UpdateProvider,
} from "../update.js";
import type { AppliftPlugin, ChannelContext } from "../plugin.js";
import type { PushyCli } from "./pushy-cli.js";
import { createPushyCli } from "./pushy-cli.js";

export interface RnUpdateOptions {
  /** 各平台的 app 记录号（如 harmony: 34166）；未声明的平台不启用热更 */
  harmony?: number;
  android?: number;
  ios?: number;
  /** 补丁目录（patch-package 约定默认 patches/，项目可覆盖） */
  patchDir?: string;
  /** 正式发布默认灰度比例 */
  defaultRollout?: number;
}

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
const TEST_VERSION_OFFSET = 1000;

/** 生成测试包偏移版本号（major+1000）；非数字开头版本号无法偏移，显式报错 */
export function testPackageVersion(versionName: string): string {
  const m = /^(\d+)(\..+)?$/.exec(versionName);
  if (!m) {
    throw new Error(
      `versionName「${versionName}」非 X.Y.Z 形态，无法按 major+${TEST_VERSION_OFFSET} 生成测试包偏移版本`,
    );
  }
  return `${Number(m[1]!) + TEST_VERSION_OFFSET}${m[2] ?? ""}`;
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

/** provider 构造（cli 注入点：测试 mock / 将来直连 API） */
export function makeRnUpdateProvider(
  opts: RnUpdateOptions,
  cli: PushyCli = createPushyCli(),
): UpdateProvider {
  return {
    id: "rn-update",
    frameworks: ["rn"],
    // 已配置 app 记录号的平台即已接入热更；其余平台路由直接走原生
    platforms: (["harmony", "android", "ios"] as const).filter((k) => typeof opts[k] === "number"),
    judge: (diff: string[], ctx: FrameworkContext) => judgeDelivery(diff, ctx, opts),
    async publishToTest(ctx: PublishContext) {
      const appId = platformAppId(opts, ctx.platform);
      const versionName = currentVersionName(ctx);
      const existing = await cli.versions(appId);
      const name = `${versionName}-patch.${nextPatchNumber(existing, versionName)}`;
      const ppk = await cli.bundle(ctx.platform, ctx.cwd);
      const r = await cli.publish({
        appId,
        ppk,
        platform: ctx.platform,
        name,
        description: ctx.note,
        // 测试通道绑定偏移版本（major+1000）——只有装着测试包的设备能收到
        packageVersion: testPackageVersion(versionName),
      });
      return { versionName: name, versionId: r.versionId };
    },
    async promoteToProd(ctx: PublishContext) {
      const appId = platformAppId(opts, ctx.platform);
      const versionName = currentVersionName(ctx);
      const existing = await cli.versions(appId);
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
      if (!latest) {
        const patchNames = existing
          .map((v) => v.name)
          .filter((n) => /-patch\.\d+$/.test(n))
          .slice(0, 5);
        throw new Error(
          `测试通道没有 ${versionName}-patch.N 热更版本可供 promote${
            patchNames.length > 0
              ? `（现存：${patchNames.join(", ")}${existing.length > 5 ? " …" : ""}）`
              : ""
          }：先 applift beta 发布测试热更并验证`,
        );
      }
      const rollout = ctx.rollout ?? opts.defaultRollout;
      await cli.rebind({ appId, versionId: latest.id, packageVersion: versionName, rollout });
      return { versionName: latest.name, ...(rollout !== undefined ? { rollout } : {}) };
    },
  };
}

/** 渠道 → 平台映射（热更已接入的平台；基线上传按此路由） */
const CHANNEL_PLATFORM: Record<string, string> = {
  agc: "harmony",
};

/** rnUpdate 插件工厂：注册完整 provider（判定 + 测试发布 + promote）+ 原生发版自动基线。
 *  cli 注入点：测试 mock / 将来进程内直连 API。 */
export function rnUpdate(
  opts: RnUpdateOptions = {},
  cli: PushyCli = createPushyCli(),
): AppliftPlugin {
  const provider = makeRnUpdateProvider(opts, cli);
  return {
    name: "rn-update",
    "update:register"(providers: UpdateProvider[]) {
      providers.push(provider);
    },
    // stage:after 的 result 自带 artifactPath（core 补齐的接口字段），无插件级状态、并发天然安全
    async "stage:after"(result: { channel: string; ok: boolean; artifactPath?: string }) {
      const platform = CHANNEL_PLATFORM[result.channel];
      if (!result.ok || !platform || !result.artifactPath) return;
      const appId = (opts as Record<string, unknown>)[platform];
      if (typeof appId !== "number") return; // 平台未配置热更，不上传
      try {
        await cli.uploadApp(appId, result.artifactPath);
      } catch (e) {
        // 基线上传失败不阻断发布主流程（发版已成功）；提示人工补传
        process.stderr.write(`⚠ pushy 基线上传失败（请人工补传）：${(e as Error).message}\n`);
      }
    },
  };
}
