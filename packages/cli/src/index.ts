/**
 * CLI：commander 参数解析 + @clack/prompts 交互 + picocolors 美化。
 * 薄壳——渲染 core 事件流与插件钩子结果，业务全在 core。
 */
// 供 applift.config.ts 导入（裸工程经加载器别名也可用）：CLI 自带，无需目标工程安装依赖
export { defineConfig } from "@applift/core";
import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import fs from "node:fs";
import path from "node:path";
import {
  PgyerChannel,
  HuaweiAndroidChannel,
  XiaomiChannel,
  OppoChannel,
  VivoChannel,
  HonorChannel,
  YybChannel,
  AgcHarmonyChannel,
  AscChannel,
  GooglePlayChannel,
  loadCredentialsLayered,
  resolveProfile,
  resolveProfileFor,
  resolveProfileSource,
  loadProjectConfig,
  loadGlobalConfig,
  registry,
  runStage,
  runSubmit,
  sha256File,
  appendEntry,
  readEntries,
  type HistoryEvent,
  PluginHost,
  resolvePlugins,
  resolveFramework,
  tagReleaseVersion,
  suggestFramework,
  collectReleaseDiff,
  routeDelivery,
  detectBundleIds,
  findArtifacts,
  type UpdateProvider,
  type Channel,
  type ChannelContext,
  type ChannelEvent,
  type ReleasePlanEntry,
  type ProjectConfig,
  humanizeError,
  redactText,
  readArtifactVersion,
  readProjectVersions,
  planBump,
  applyBump,
  type VersionWrite,
  latestSemverTag,
  latestVersionAnchor,
  compareDeclared,
  betaVersionName,
  type BetaVersionConfig,
  type VersionCodeConfig,
  type FrameworkAdapter,
} from "@applift/core";
import { discoverXiaomiIcon, resolveChannelTarget } from "./target.js";

/** 发布链路守卫：framework 必须来自插件声明，未声明直接报错（不静默兜底） */
function requireFramework(cwd: string, extra: FrameworkAdapter[]): FrameworkAdapter {
  const framework = resolveFramework(cwd, extra);
  if (!framework) {
    throw new Error(
      "未声明 framework 插件：在 applift.config.ts 的 plugins 里声明对应框架工厂（如 rnFramework()，import 自 @applift/core/plugins）",
    );
  }
  return framework;
}

/** 热更路由结果：mode=ota 时携带匹配的 provider；explicit=用户显式选定（--delivery 或交互 select） */
interface DeliveryDecision {
  mode: "ota" | "native";
  provider?: UpdateProvider;
  explicit: boolean;
}

/**
 * 投递路由（beta/release 共用）：判定 → 推荐报告 → 确认。
 * - 无 provider 注册 → null（原生路径，原始行为）
 * - --delivery 显式覆盖；--yes（非交互）用推荐值，uncertain 中止；交互时 select 可改选
 */
async function resolveDeliveryMode(
  cwd: string,
  host: PluginHost | undefined,
  framework: FrameworkAdapter,
  opts: { yes: boolean; delivery?: string; json?: boolean; dryRun?: boolean },
  platform?: string,
): Promise<DeliveryDecision | null> {
  const providers: UpdateProvider[] = [];
  await host?.broadcast("update:register", { cwd }, providers);
  // 显式 --delivery ota 是明确意图：provider 未注册 / 平台未接入热更时必须报错，
  // 不允许静默降级为原生分发（CI 写死 --delivery ota 会在错误平台提交原生包且零提示）
  if (opts.delivery === "ota" && providers.length === 0) {
    throw new Error(
      "--delivery ota：未注册任何 update provider（applift.config.ts plugins 里缺 rnUpdate() 等热更插件），无法走热更",
    );
  }
  const diff = await collectReleaseDiff(cwd);
  // 判定 ctx.anchor 与 diff 同锚点（collectReleaseDiff 内部即 latestVersionAnchor）；ref 兼容 tag 名与 sha
  const anchor = diff === null ? undefined : latestVersionAnchor(cwd)?.ref;
  const route = await routeDelivery(providers, { cwd, framework, anchor }, diff ?? [], platform);
  if (!route) {
    if (opts.delivery === "ota") {
      throw new Error(
        `--delivery ota：平台 ${platform ?? "(未指定)"} 未接入热更（provider.platforms 未含该平台），无法走热更`,
      );
    }
    return null;
  }
  const { provider, judgement } = route;
  p.log.info(
    `本次发布判定：${pc.bold(judgement.recommendation)}（confidence: ${judgement.confidence}，by ${provider.id}）`,
  );
  for (const e of judgement.evidence.slice(0, 20)) {
    p.log.message(`  ${pc.dim(e.path)} — ${e.rule}${e.note ? pc.dim(`（${e.note}）`) : ""}`);
  }
  let mode: "ota" | "native";
  let explicit: boolean;
  if (opts.delivery === "ota" || opts.delivery === "native") {
    mode = opts.delivery;
    explicit = true;
  } else if (opts.yes || opts.json || opts.dryRun || !process.stdout.isTTY) {
    // 非交互（--yes / --json / --dry-run / 无 TTY）：用推荐值；灰区必须显式指定，不猜
    if (judgement.recommendation === "uncertain") {
      throw new Error(
        "判定不确定（灰区）：非交互模式无法代答，请用 --delivery ota|native 显式指定投递方式",
      );
    }
    mode = judgement.recommendation;
    explicit = false;
  } else {
    const choice = await p.select({
      message: "投递方式",
      options: [
        {
          value: "ota",
          label: `热更（推荐：${judgement.recommendation === "ota" ? "是" : "否"}）`,
        },
        { value: "native", label: "原生包（直接用现有产物发内测）" },
      ],
    });
    if (p.isCancel(choice)) throw new Error("已取消");
    mode = choice;
    explicit = true; // 交互选择即用户意图（含选原生包：用户看过证据后拍板）
  }
  return { mode, explicit, provider: mode === "ota" ? provider : undefined };
}

const program = new Command("applift");

// JSON import 由打包器内联（tsdown / bun build 均支持），不做运行时文件读取——
// bun --compile 单文件二进制里 import.meta.url 指向 $bunfs 虚拟路径，readFileSync 会 ENOENT
import pkg from "../package.json" with { type: "json" };

program
  .name("applift")
  .description("三端 App 发版工具（内测 / 多商店提审 / 插件扩展）")
  .version(pkg.version);

/**
 * beta 路径的 stage 收尾：与 release 的 runStage 对称，广播 stage:after。
 * beta 不走 pipeline（直接调 channel.stage），不补这一下，rn-update 的基线自动上传
 * 在测试线永远不会触发 —— 测试包没有基线，热更 bind 必然失败。
 */
export async function notifyStageAfter(
  host: PluginHost | undefined,
  channelId: string,
  platform: string,
  ctx: { artifactPath?: string; credentials?: Readonly<Record<string, string>> },
  result: { ok: boolean; ref?: string; error?: string },
  cwd: string,
): Promise<void> {
  try {
    await host?.broadcast(
      "stage:after",
      { channel: channelId, cwd, credentials: ctx.credentials },
      {
        channel: channelId,
        ok: result.ok,
        ref: result.ref,
        error: result.error,
        artifactPath: ctx.artifactPath,
        platform,
        // beta 路径只可能是内测：基线要进 beta 应用记录（双 appId 时不能靠版本名猜）
        target: "beta",
      },
    );
  } catch (e) {
    // 钩子失败不能把「已上传成功」改判成渠道失败（rn-update 自己已 catch，此处防第三方插件）
    process.stderr.write(`⚠ stage:after 插件执行失败（不影响本次上传）：${(e as Error).message}\n`);
  }
}

/**
 * 期望产物版本号（版本语义：beta 的热更平台 = 派生测试版本，release = 工程正式版）。
 * - beta 且平台接入热更（provider.platforms 含之）：按 beta 策略派生（默认 patch+1000，
 *   如 4.0.1000）—— 测试设备装测试包才能收到测试线热更，版本名精确隔离正式用户
 * - release：工程 versionName——测试包/旧版本不能用于正式分发
 * 返回 undefined = 该场景不做版本校验（未接热更平台的 beta、读不到工程版本、策略不适用）
 */
function expectedArtifactVersion(
  cwd: string,
  framework: FrameworkAdapter | null,
  platform: string,
  mode: "beta" | "release",
  hotPlatforms: ReadonlySet<string>,
  betaConfig?: BetaVersionConfig,
): string | undefined {
  const versionName = framework
    ? readProjectVersions(cwd, framework).find((v) => v.platform === platform)?.versionName
    : undefined;
  if (!versionName) return undefined;
  if (mode === "release") return versionName;
  if (!hotPlatforms.has(platform)) return undefined;
  // 派生走 core 的同一纯函数，避免 CLI 与 provider 各写一套（历史漂移点）
  return betaVersionName({ base: versionName, config: betaConfig, platform });
}

/**
 * 按期望版本过滤探测结果（readArtifactVersion 读产物内嵌版本；.ipa 不支持读 → 放行不校验）。
 * 期望 undefined 时透传最新（现状行为）。
 */
function pickArtifactByVersion(
  found: string[],
  expected: string | undefined,
): { artifact?: string; mismatched?: string[] } {
  if (!expected) return { artifact: found[0] };
  const matched = found.filter((f) => readArtifactVersion(f)?.versionName === expected);
  if (matched.length > 0) return { artifact: matched[0] };
  // 读不出版本的产物（.ipa 等）无法校验 → 首个不可校验产物放行
  if (found[0] && readArtifactVersion(found[0]) === undefined) return { artifact: found[0] };
  return { mismatched: found };
}
export function makeContext(
  channel: Channel,
  creds: Record<string, string>,
  target: Record<string, string>,
  artifactPath: string,
  note: string | undefined,
  /** CLI flag 透传的渠道上下文扩展（P2-2：定时上架/提审备注/安装密码） */
  extra: { releaseTime?: string; remark?: string; installPassword?: string } = {},
): ChannelContext {
  const label = pc.bold(channel.label);
  const emit = (event: ChannelEvent) => {
    // 渠道进度写 stderr——保证 --json 的 stdout 纯净（AI/CI 消费契约）；
    // message 可能内嵌渠道响应体切片（含预签名上传 URL）→ 出口统一过 redactText（label 是渠道名，不含凭据）
    if (event.type === "phase") {
      const phaseText =
        {
          auth: pc.blue("鉴权"),
          upload: pc.blue("上传"),
          bind: pc.blue("绑定"),
          wait: pc.yellow("等待"),
          submit: pc.magenta("提审"),
          done: pc.green("完成"),
        }[event.phase] ?? event.phase;
      process.stderr.write(
        `  ${label} ${phaseText}${event.message ? pc.dim(` — ${redactText(event.message)}`) : ""}\n`,
      );
    } else if (event.type === "warn") {
      process.stderr.write(`  ${label} ⚠ ${redactText(event.message)}\n`);
    }
  };
  return {
    credentials: creds,
    target,
    artifactPath,
    updateDescription: note,
    releaseTime: extra.releaseTime,
    remark: extra.remark,
    installPassword: extra.installPassword,
    emit,
  };
}

/** clack 确认：计划表 → confirm。非 TTY 自动拒绝（防御兜底；正常路径由 release 入口门控提前报错） */
async function confirmWithClack(plans: ReleasePlanEntry[]): Promise<boolean> {
  if (!process.stdout.isTTY) return false;
  const rows = plans.map(
    (plan) =>
      `  ${pc.cyan(plan.platform.padEnd(7))} ${pc.bold(plan.channel.padEnd(12))} ${plan.action.padEnd(13)} ${
        plan.afterApproval === "manual"
          ? pc.green("审核通过后手动发布")
          : plan.afterApproval === "scheduled"
            ? pc.yellow("定时上架")
            : pc.red("审核通过后自动上架")
      }`,
  );
  p.log.message(`${pc.bold("┌ 发布计划")} ${pc.dim("────────────────────────────┐")}`);
  for (const r of rows) p.log.message(r);
  p.log.message(`${pc.bold("└───────────────────────────────────┘")}`);
  if (plans.some((x) => x.afterApproval === "auto-publish")) {
    p.log.warn(`${pc.red("⚠")} 提审后审核通过即自动上架，无法撤回（iOS manual 除外）`);
  }
  const yes = await p.confirm({ message: `确认提交以上 ${plans.length} 项？` });
  // Ctrl-C 抛「已取消」而非返回 false：bin 据此退 130（中止≠失败）；false 保留给明确选"否"
  if (p.isCancel(yes)) throw new Error("已取消（Ctrl-C，未做任何变更）");
  return Boolean(yes);
}

let channelsRegistered = false;
function setupChannels(): void {
  // 幂等：同进程多次执行命令（长驻壳 / 测试连跑 use+release）不重复注册（registry 重复注册会抛错）
  if (channelsRegistered) return;
  channelsRegistered = true;
  registry.register(new PgyerChannel());
  registry.register(new HuaweiAndroidChannel());
  registry.register(new XiaomiChannel());
  registry.register(new OppoChannel());
  registry.register(new VivoChannel());
  registry.register(new HonorChannel());
  registry.register(new YybChannel());
  registry.register(new AgcHarmonyChannel());
  registry.register(new AscChannel());
  registry.register(new GooglePlayChannel());
}

interface ReleaseOpts {
  cwd: string;
  stores?: string;
  submit: boolean;
  skipStage: boolean;
  artifact: string;
  note?: string;
  releaseTime?: string;
  remark?: string;
  profile?: string;
  yes: boolean;
  dryRun: boolean;
  autoArtifact: boolean;
  /** 投递方式覆盖：ota | native（缺省按判定推荐） */
  delivery?: string;
  /** 热更正式灰度比例（1-100，配合 --delivery ota） */
  rollout?: string;
  /** 结构化输出（stdout 给机器，渲染抑制） */
  json?: boolean;
}

/** 装载插件宿主与生效配置：c12 只 load 一次；config:resolved 钩子返回值即生效配置（P2-5） */
async function loadPluginHost(
  cwd: string,
): Promise<{ host?: PluginHost; config: ProjectConfig; extraFrameworks: FrameworkAdapter[] }> {
  const { config, raw } = await loadProjectConfig(cwd);
  const plugins = resolvePlugins(raw);
  if (plugins.length === 0) return { config, extraFrameworks: [] };
  const host = new PluginHost(plugins);
  // 插件自定义渠道注册（写 vite 插件的方式扩展自己的平台）
  await host.broadcast("channel:register", { cwd }, registry);
  // 插件自定义框架适配器注册（与渠道扩展对称）
  const extraFrameworks: FrameworkAdapter[] = [];
  await host.broadcast("framework:register", { cwd }, extraFrameworks);
  const r = await host.apply("config:resolved", config, { cwd });
  return { host, config: r.value, extraFrameworks };
}

/** 护栏②：同渠道同 versionName 重复提交警告（history.jsonl 对比；警告不阻断） */
function warnDuplicateVersion(channel: string, artifactPath: string): void {
  const v = readArtifactVersion(artifactPath)?.versionName;
  if (!v) return;
  const dup = readEntries({ channel }).some((e) => e.ok && e.artifactVersion === v);
  if (dup) {
    process.stderr.write(
      pc.yellow(
        `⚠ ${channel} 已提交过版本 ${v}（发版历史）：同版本重复提交可能被渠道拒绝或无法覆盖升级\n`,
      ),
    );
  }
}

/**
 * bump 编排闭环（beta 的 --bump/autoBump 与 version bump 命令共用）：
 * plan → 展示确认 → apply（写文件+changelog+commit）→ 构建涉及平台。
 * bump = 版本声明；tag = 交付封板（默认不打，version --tag 显式开，release 成功后补）。
 * applift 不接管构建，bump 仅写版本事实源。
 */
interface BumpOutcome {
  storeName: string;
  writes: VersionWrite[];
}

async function runBumpOrchestration(args: {
  cwd: string;
  framework: FrameworkAdapter | null;
  config: ProjectConfig;
  bump: boolean | string;
  pre?: string;
  yes?: boolean;
  /** 全局 config.toml 的 assumeYes（与 --yes 同权的 CI 授权，release 路径透传） */
  assumeYes?: boolean;
  /** 限定端（version 命令的 --platform） */
  platforms?: string[];
  /** 代 commit（version 命令 --no-commit / beta 自动 bump 透传；缺省开） */
  commit?: boolean;
  /** 代打 tag（缺省不打——tag 是交付封板标记，归 release 提审成功后补；version 命令 --tag 显式开） */
  tag?: boolean;
}): Promise<BumpOutcome | undefined> {
  if (args.bump === false) return undefined;
  const level = typeof args.bump === "string" && args.bump !== "" ? args.bump : undefined;
  // commit/tag 开关：commit 缺省开（--no-commit 关）；tag 缺省关（--tag 显式开）——
  // bump = 版本声明（写文件 + CHANGELOG + commit），tag = 交付封板，归 release 成功后补打
  const commit = args.commit !== false;
  const tag = args.tag === true;
  const plan = planBump({
    cwd: args.cwd,
    framework: args.framework,
    level,
    pre: args.pre,
    versionCode: args.config.version?.versionCode as VersionCodeConfig | undefined,
    platforms: args.platforms,
  });
  p.intro(pc.bgCyan(pc.black(" applift version · bump ")));
  p.log.info(`发版锚点: ${plan.anchor?.label ?? pc.dim("无（首次，推断退化为 patch 兜底）")}`);
  p.log.info(plan.reason);
  for (const c of plan.currentVersions) {
    const w = plan.writes.find((x) => x.platform === c.platform);
    p.log.step(
      `${c.platform}: ${pc.bold(c.versionName ?? "?")}${c.versionCode ? pc.dim(`+${c.versionCode}`) : ""} → ${pc.green(w?.versionName ?? "?")}${w ? pc.dim(`+${w.versionCode}`) : ""}${c.problem ? pc.yellow(` ⚠ ${c.problem}`) : ""}`,
    );
  }
  // 疑似失败重跑 + --yes（CI 自动重试高发）+ 无显式 level → 拒绝：防止反复失败连烧版本号
  if (args.yes && plan.suspectRerun && !level)
    throw new Error(
      `疑似失败重跑（${plan.reason}）——为防 CI 反复重试烧版本号：显式指定 level/版本号确认继续，或去掉 --bump 参数复用已 bump 版本（beta 无 --no-bump 选项）`,
    );
  p.log.info(`versionCode 策略: ${plan.versionCodeNote}`);
  // 非 TTY（CI/管道）无法完成 clack 交互确认（会挂起），fail-fast 引导 --yes / assumeYes
  if (!(args.yes || args.assumeYes) && !process.stdout.isTTY)
    throw new Error(
      "非交互环境（CI/管道）bump 需 --yes 跳过确认；疑似失败重跑请显式指定 level 或版本号",
    );
  if (!(args.yes || args.assumeYes)) {
    // 文案如实反映将发生的动作：--tag 时会打 tag，默认不打须提示去向
    const effects = commit
      ? tag
        ? "并代 commit + tag"
        : "并代 commit（tag 留待 release 成功后补）"
      : tag
        ? "并打 tag"
        : "";
    const go = await p.confirm({
      message: `确认 bump 到 ${pc.bold(plan.nextVersion)}${effects ? ` ${effects}` : ""}？`,
    });
    if (p.isCancel(go) || !go) throw new Error("已取消（未做任何变更）");
  }
  const applied = applyBump(args.cwd, plan, args.framework, { commit, tag });
  for (const f of applied.changedFiles) p.log.success(`已更新 ${path.relative(args.cwd, f)}`);
  for (const s of applied.skipped) p.log.warn(`跳过 ${s.platform}: ${s.reason}`);
  for (const w of applied.warnings) p.log.warn(w);
  if (applied.committed) p.log.success(`git commit: chore(release): ${plan.nextVersion}`);
  if (applied.tagged) p.log.success(`git tag: v${plan.nextVersion}`);
  else p.log.info(pc.dim(`版本已声明（未打 tag）：release 提审成功后自动补 v${plan.nextVersion}`));
  p.log.info(pc.dim("推送：git push（applift 永不代 push；tag 由 release 成功后补）"));
  return { storeName: plan.storeName, writes: plan.writes };
}
program
  .command("version")
  .description(
    "版本管理：show 各端实况 | bump 声明版本（写工程文件 + CHANGELOG + commit；tag 由 release 成功后补）",
  )
  .argument("[action]", "show（默认）| bump")
  .argument("[level]", "major | minor | patch | prerelease | <semver>（缺省 git 推断）")
  .option("--pre <id>", "prerelease 标识（beta | rc）：挂到目标版本，如 4.1.0-beta.1")
  .option("--platform <list>", "仅限端（逗号分隔：android,ios,harmony,flutter,js,tauri,expo）")
  .option("--no-commit", "只写文件，不代 commit")
  .option("--tag", "声明时同步打 tag（默认不打：tag 是交付标记，release 提审成功后自动补）")
  .option("--yes", "跳过确认（CI）")
  .option("--cwd <dir>", "项目目录", process.cwd())
  .action(
    async (
      action: string | undefined,
      level: string | undefined,
      cmdOpts: {
        pre?: string;
        platform?: string;
        commit?: boolean;
        tag?: boolean;
        yes?: boolean;
        cwd: string;
      },
    ) => {
      const { extraFrameworks: pluginFrameworks, config } = await loadPluginHost(cmdOpts.cwd);
      const framework = resolveFramework(cmdOpts.cwd, pluginFrameworks);
      if (framework) {
        p.log.info(`框架: ${pc.bold(framework.expoAwareLabel?.(cmdOpts.cwd) ?? framework.label)}`);
      } else {
        p.log.warn(
          "未声明 framework 插件：按全部标准位置探测版本文件（发布命令需声明，见 applift.config.ts plugins）",
        );
      }

      if (action !== "bump") {
        // ---- show：各端 versionName/versionCode + 文件 + 发版锚点（tag 或 bump commit 取新者）----
        const versions = readProjectVersions(cmdOpts.cwd, framework);
        if (versions.length === 0)
          throw new Error(
            "未找到任何版本文件（标准形态：build.gradle / pbxproj / app.json5 / pubspec / package.json / tauri.conf）",
          );
        for (const v of versions) {
          p.log.step(
            `${v.platform}: ${pc.bold(v.versionName ?? "?")}${v.versionCode ? pc.dim(`+${v.versionCode}`) : pc.dim("（无 versionCode）")} ${pc.dim(path.relative(cmdOpts.cwd, v.file))}`,
          );
          if (v.problem) p.log.warn(v.problem);
        }
        const anchor = latestVersionAnchor(cmdOpts.cwd);
        p.log.info(
          `发版锚点: ${anchor?.label ?? pc.dim("无（首次 bump 前，推断退化为 patch 兜底）")}`,
        );
        return;
      }

      // ---- bump：复用 runBumpOrchestration 闭环（写文件 + changelog + commit；tag 默认不打）----
      // 全局 config.toml assumeYes 与 --yes 同权（与 release 一致；本批修复：version 命令此前未透传）
      const globalCfg = loadGlobalConfig().config;
      const platforms = cmdOpts.platform
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await runBumpOrchestration({
        cwd: cmdOpts.cwd,
        framework,
        config,
        bump: level ?? true,
        pre: cmdOpts.pre,
        yes: cmdOpts.yes,
        assumeYes: globalCfg.assumeYes,
        platforms,
        commit: cmdOpts.commit,
        tag: cmdOpts.tag === true,
      });
    },
  );

program
  .command("beta")
  .description(
    "内测分发：无参数读 applift.config.ts 的 beta 段并行发布多渠道；beta <platform> 快捷路径（android/ios → 蒲公英；harmony 默认 AGC 测试发布，--via pgyer 改走蒲公英）",
  )
  .argument("[platform]", "android | harmony | ios（缺省读配置 beta 段多渠道并行）")
  .option("--artifact <path>", "产物路径（缺省自动探测最新构建产物）")
  .option("--note <text>", "更新说明")
  .option("--via <target>", "harmony 分发通道：agc（默认，AGC 指定设备测试发布）| pgyer", "agc")
  .option("--install-password <pwd>", "安装密码（蒲公英密码安装）")
  .option(
    "--delivery <mode>",
    "投递方式：ota（热更）| native（原生包）；缺省按判定推荐，CI uncertain 时必须显式",
  )
  .option("--yes", "跳过 bump/发布确认（CI）")
  .option(
    "--bump [level]",
    "判定为原生·需 bump 时自动声明版本（major|minor|patch|<semver>，缺省用推断）；完成后引导重建",
  )
  .option("--cwd <dir>", "项目目录", process.cwd())
  .action(
    async (
      platform: string | undefined,
      cmdOpts: {
        artifact?: string;
        note?: string;
        via?: string;
        installPassword?: string;
        bump?: boolean | string;
        delivery?: string;
        yes?: boolean;
        cwd: string;
      },
    ) => {
      setupChannels();
      const {
        host,
        extraFrameworks: pluginFrameworks,
        config: projCfg,
      } = await loadPluginHost(cmdOpts.cwd);

      // profile 解析链：projects.json 个人选择（applift use）> 项目配置团队默认。
      // 提到热更路由之前：OTA 路径 publishToBeta 的 ctx 也要带凭据（PUSHY_API_TOKEN）。
      // 无凭据文件/无该 profile 时降级为空：纯热更项目可不配渠道凭据，缺键报错延迟到
      // 消费处（OTA → PUSHY_API_TOKEN fail-fast；原生渠道 → 各渠道 required 的精确提示）
      let creds: Record<string, string> = {};
      try {
        creds = resolveProfile(
          loadCredentialsLayered(cmdOpts.cwd),
          resolveProfileFor(cmdOpts.cwd, projCfg.profile),
          KNOWN_CREDENTIAL_KEYS,
        );
      } catch {
        // 原生路径下渠道侧会给出缺哪个键的报错；profile 名拼错可由 doctor 的 profile 来源展示定位
      }

      // ---------- 热更路由（有 UpdateProvider 插件时判定推荐；--delivery 显式覆盖）----------
      // 路由在 bump 之前：热更路径不动原生版本号。无 platform（多渠道并行）时不路由（原生多渠道语义）。
      if (!platform && (cmdOpts.bump !== undefined || projCfg.beta?.autoBump === true))
        p.log.warn(
          "多渠道并行发布（beta 无平台参数）不经过热更判定：--bump / beta.autoBump 不生效",
        );
      if (platform) {
        const fw = requireFramework(cmdOpts.cwd, pluginFrameworks);
        const decision = await resolveDeliveryMode(
          cmdOpts.cwd,
          host,
          fw,
          {
            yes: Boolean(cmdOpts.yes),
            delivery: cmdOpts.delivery,
          },
          platform,
        );
        if (decision?.mode === "ota" && decision.provider) {
          if (cmdOpts.bump !== undefined || projCfg.beta?.autoBump === true)
            p.log.warn("判定为热更（ota）：--bump / beta.autoBump 不生效（热更不动原生版本号）");
          if (!decision.provider.publishToBeta)
            throw new Error(
              `热更 provider「${decision.provider.id}」未提供内测发布（publishToBeta）——该 provider 仅支持正式发布，直接 applift release ${platform}`,
            );
          const r = await decision.provider.publishToBeta({
            cwd: cmdOpts.cwd,
            framework: fw,
            platform,
            note: cmdOpts.note,
            credentials: creds,
            artifact: cmdOpts.artifact ? path.resolve(cmdOpts.artifact) : undefined,
          });
          p.log.success(
            `热更 beta 已发布：${pc.bold(r.versionName)}（测试设备将静默收到，验证后 applift release 发布正式）`,
          );
          // 热更同样进 history（审计断链会让 history/doctor 对热更发布失明）
          appendEntry({
            ts: Date.now(),
            cwd: path.resolve(cmdOpts.cwd), // 绝对路径：审计跨目录可读（用户传 --cwd . 时相对路径无意义）
            artifactSha256: "", // ppk 是先行产出的构建产物（--artifact/探测，路径在 provider 内解析），此处不重复哈希
            channel: decision.provider.id,
            action: "stage",
            ok: true,
            ref: String(r.versionId),
            artifactVersion: r.versionName,
          });
          await host?.broadcast(
            "notify",
            { cwd: cmdOpts.cwd },
            {
              stage: [
                {
                  channel: decision.provider.id,
                  label: `热更测试（${platform}）`,
                  ok: true,
                  plan: {
                    channel: decision.provider.id,
                    platform: platform as ReleasePlanEntry["platform"],
                    artifactVersion: r.versionName,
                    action: "stage-only",
                    afterApproval: "none(beta)",
                  },
                },
              ],
              submit: [],
            },
          );
          return;
        }
        // 判定 native 且非用户显式选择：三态引导（原生·需 bump / 原生·已声明）。
        // 显式选 native（--delivery native 或交互 select）= 用户看过证据后拍板，直接走下方原生内测路径
        if (decision?.mode === "native" && !decision.explicit) {
          const releasedTag = latestSemverTag(cmdOpts.cwd);
          const mine = readProjectVersions(cmdOpts.cwd, fw).find((v) => v.platform === platform);
          const declared = compareDeclared(mine?.versionName, releasedTag);
          if (declared === "unknown")
            p.log.warn(
              `工程版本 ${mine?.versionName ?? "?"} 非 semver，无法与发布 tag 比较——按需 bump 处理`,
            );
          if (declared === "ahead") {
            // 已声明（工程版本领先最近发布 tag）：只需重建 + 重跑，再 bump 会烧版本号
            throw new Error(
              [
                `工程版本 ${mine?.versionName} 已声明（领先最近发布 tag ${releasedTag ?? "（无 tag）"}），无需再 bump：`,
                "  1. 重新构建测试包（产物内嵌派生测试版本）",
                `  2. 重跑: applift beta ${platform} --delivery native`,
                "（重跑发原生包必须 --delivery native 显式指定：正常声明后锚点已推进、判定会推荐热更）",
              ].join("\n"),
            );
          }
          // 原生·需 bump：--bump / beta.autoBump 直接声明（写文件 + CHANGELOG + commit，不打 tag）
          if (cmdOpts.bump !== undefined || projCfg.beta?.autoBump === true) {
            const level =
              typeof cmdOpts.bump === "string" && cmdOpts.bump !== "" ? cmdOpts.bump : undefined;
            const globalCfg = loadGlobalConfig().config;
            await runBumpOrchestration({
              cwd: cmdOpts.cwd,
              framework: fw,
              config: projCfg,
              bump: level ?? true,
              yes: cmdOpts.yes,
              assumeYes: globalCfg.assumeYes,
              commit: true,
              tag: false,
            });
            p.log.info(`下一步：重新构建 ${platform} 测试包（产物内嵌派生测试版本）`);
            p.log.info(`然后重跑: ${pc.cyan(`applift beta ${platform} --delivery native`)}`);
            return;
          }
          let recommend = "";
          try {
            const plan = planBump({
              cwd: cmdOpts.cwd,
              framework: fw,
              versionCode: projCfg.version?.versionCode as VersionCodeConfig | undefined,
            });
            recommend = `\n  推荐版本：${plan.nextVersion}（${plan.reason}）\n`;
          } catch {
            // 推断失败（如各端无 semver 基线）→ 省略推荐行，引导文案仍完整
          }
          throw new Error(
            [
              "本次改动判定为原生发版（含原生代码，无法热更），需要发新原生版本：" + recommend,
              `  1. applift version bump   或   applift beta ${platform} --bump   声明下一版（写文件 + CHANGELOG + commit）`,
              "  2. 重新构建（产物内嵌新版本）",
              `  3. 重跑 applift beta ${platform} --delivery native 发内测`,
              "（已构建新版本包？用 --delivery native 或交互选择「原生包」跳过此引导）",
            ].join("\n"),
          );
        }
        if (
          decision?.mode === "native" &&
          decision.explicit &&
          (cmdOpts.bump !== undefined || projCfg.beta?.autoBump === true)
        )
          p.log.warn(
            "--delivery native 显式走原生发布：--bump / beta.autoBump 不生效（发布以已构建产物为准）",
          );
      }

      const detected = detectBundleIds(cmdOpts.cwd);

      // 已接入热更的平台集合（provider.platforms 并集）：beta 版本感知探测用
      const allProviders: UpdateProvider[] = [];
      await host?.broadcast("update:register", { cwd: cmdOpts.cwd }, allProviders);
      const hotPlatforms = new Set(allProviders.flatMap((p) => p.platforms ?? []));

      /** 产物探测：--artifact 直用（渠道自行校验扩展名）；否则按平台 patterns 找最新且扩展名匹配的产物 */
      const findArtifactFor = (plat: string, exts: string[]): string | undefined => {
        if (cmdOpts.artifact) {
          const explicit = path.resolve(cmdOpts.artifact);
          return exts.includes(path.extname(explicit).toLowerCase()) ? explicit : undefined;
        }
        // 声明性守卫对 --artifact 路径同样生效（防未声明插件静默跑完发布）
        const framework = requireFramework(cmdOpts.cwd, pluginFrameworks);
        const patterns = projCfg.artifacts?.[plat] ?? framework?.artifactPatterns(plat) ?? [];
        const found = findArtifacts(cmdOpts.cwd, patterns).filter((f) =>
          exts.includes(path.extname(f).toLowerCase()),
        );
        // 版本语义：热更平台的 beta 吃派生测试包（快捷路径同款校验）
        const expected = expectedArtifactVersion(
          cmdOpts.cwd,
          framework,
          plat,
          "beta",
          hotPlatforms,
          projCfg.version?.beta,
        );
        const picked = pickArtifactByVersion(found, expected);
        if (expected && picked.mismatched)
          throw new Error(
            `未探测到 ${plat} 测试包 ${expected}（现存 ${picked.mismatched
              .map((f) => path.basename(f))
              .slice(0, 3)
              .join(
                ", ",
              )}）——测试分发的包版本名必须是 ${expected}，请构建测试包后再发，或 --artifact 显式指定`,
          );
        return picked.artifact;
      };

      // ---------- 无 platform：读 config.beta 多渠道并行发布 ----------
      if (!platform) {
        const beta = projCfg.beta;
        if (!beta || (!beta.pgyer && !beta.agc && !beta.testflight)) {
          throw new Error(
            'beta 无参数需要在 applift.config.ts 配置 beta 段（pgyer / "agc" / testflight 至少一个），或用 beta <platform> 快捷路径',
          );
        }
        const PGYER_EXTS: Record<string, string[]> = {
          android: [".apk"],
          ios: [".ipa"],
          harmony: [".hap"],
        };
        const tasks: Array<{ label: string; run: () => Promise<string> }> = [];

        if (beta.pgyer) {
          const pgyer = registry.get("pgyer");
          if (!pgyer) throw new Error("pgyer 渠道未注册");
          for (const plat of beta.pgyer.platforms) {
            tasks.push({
              label: `pgyer(${plat})`,
              run: async () => {
                const exts = PGYER_EXTS[plat] ?? [];
                const artifactPath = findArtifactFor(plat, exts);
                if (!artifactPath)
                  throw new Error(
                    `未找到 ${plat} 构建产物（${exts.join("/")}），先构建或用 --artifact 指定`,
                  );
                const ctx = makeContext(
                  pgyer,
                  creds,
                  resolveChannelTarget("pgyer", projCfg, detected),
                  artifactPath,
                  cmdOpts.note,
                  { installPassword: cmdOpts.installPassword ?? beta.pgyer?.installPassword },
                );
                warnDuplicateVersion("pgyer", artifactPath);
                const r = await pgyer.stage(ctx);
                await notifyStageAfter(host, "pgyer", plat, ctx, r, cmdOpts.cwd);
                if (!r.ok) throw new Error(r.error ?? "上传失败");
                appendEntry({
                  ts: Date.now(),
                  cwd: path.resolve(cmdOpts.cwd),
                  artifactSha256: sha256File(artifactPath),
                  channel: "pgyer",
                  action: "stage",
                  ok: true,
                  ref: r.ref,
                  artifactVersion: readArtifactVersion(artifactPath)?.versionName,
                });
                return `蒲公英 ${path.basename(artifactPath)} 发布成功，扫码即装`;
              },
            });
          }
        }

        if (beta.agc) {
          const agc = registry.get("agc");
          if (!agc) throw new Error("agc 渠道未注册");
          const agcCfg = beta.agc;
          tasks.push({
            label: "agc",
            run: async () => {
              const artifactPath = findArtifactFor("harmony", [".app"]);
              if (!artifactPath)
                throw new Error(
                  "未找到 harmony .app 整包（DevEco「构建 App」产物），先构建或用 --artifact 指定",
                );
              const ctx = makeContext(
                agc,
                creds,
                {
                  ...resolveChannelTarget("agc", projCfg, detected),
                  releaseType: "6",
                  ...(agcCfg.submit ? { submitTest: "true" } : {}),
                  ...(agcCfg.group ? { testGroup: agcCfg.group } : {}),
                  testType: String(agcCfg.testType),
                  // cleanup 默认 true（schema 缺省）；'false' 时渠道跳过旧测试版本清理
                  ...(agcCfg.privacyPolicy ? { privacyPolicy: agcCfg.privacyPolicy } : {}),
                },
                artifactPath,
                cmdOpts.note,
              );
              warnDuplicateVersion("agc", artifactPath);
              const r = await agc.stage(ctx);
              await notifyStageAfter(host, "agc", "harmony", ctx, r, cmdOpts.cwd);
              if (!r.ok) throw new Error(r.error ?? "AGC 测试发布失败");
              appendEntry({
                ts: Date.now(),
                cwd: path.resolve(cmdOpts.cwd),
                artifactSha256: sha256File(artifactPath),
                channel: "agc",
                action: agcCfg.submit ? "submit" : "stage",
                ok: true,
                ref: r.ref,
                artifactVersion: readArtifactVersion(artifactPath)?.versionName,
              });
              return agcCfg.submit
                ? `AGC 测试版本已提交审核（versionId: ${r.ref ?? "?"}）`
                : `AGC 测试版本已就绪（versionId: ${r.ref ?? "?"}，未提审）`;
            },
          });
        }

        if (beta.testflight) {
          const asc = registry.get("asc");
          if (!asc) throw new Error("asc 渠道未注册");
          const tfNote = beta.testflight.note;
          tasks.push({
            label: "testflight",
            run: async () => {
              const artifactPath = findArtifactFor("ios", [".ipa"]);
              if (!artifactPath)
                throw new Error("未找到 ios .ipa 产物，先构建或用 --artifact 指定");
              const ctx = makeContext(
                asc,
                creds,
                resolveChannelTarget("asc", projCfg, detected),
                artifactPath,
                cmdOpts.note ?? tfNote,
              );
              warnDuplicateVersion("asc", artifactPath);
              const r = await asc.stage(ctx);
              await notifyStageAfter(host, "asc", "ios", ctx, r, cmdOpts.cwd);
              if (!r.ok) throw new Error(r.error ?? "上传失败");
              appendEntry({
                ts: Date.now(),
                cwd: path.resolve(cmdOpts.cwd),
                artifactSha256: sha256File(artifactPath),
                channel: "asc",
                action: "stage",
                ok: true,
                ref: r.ref,
                artifactVersion: readArtifactVersion(artifactPath)?.versionName,
              });
              return `TestFlight 上传成功 ${path.basename(artifactPath)}（Apple 处理完成后 TestFlight 可见）`;
            },
          });
        }

        process.stderr.write(`内测多渠道并行发布：${tasks.map((t) => t.label).join("、")}\n`);
        const settled = await Promise.allSettled(tasks.map((t) => t.run()));
        let failed = false;
        settled.forEach((r, i) => {
          const { label } = tasks[i]!;
          if (r.status === "fulfilled") {
            process.stderr.write(`${pc.green("✓")} ${label} — ${r.value}\n`);
          } else {
            failed = true;
            process.stderr.write(
              `${pc.red("✗")} ${label} — ${redactText(String((r.reason as Error)?.message ?? r.reason))}\n`,
            );
          }
        });
        if (failed) process.exitCode = 1;
        return;
      }

      // ---------- 快捷路径：beta <platform> ----------
      let artifactPath = cmdOpts.artifact ? path.resolve(cmdOpts.artifact) : undefined;
      if (!artifactPath) {
        const framework = requireFramework(cmdOpts.cwd, pluginFrameworks);
        const patterns =
          projCfg.artifacts?.[platform] ?? framework?.artifactPatterns(platform) ?? [];
        // 双产物工程防串包（与 release 探测同口径）：AGC 测试发布只收 .app（渠道终验同判），
        // mtime 更新的 internaltesting .hap（刚跑完蒲公英轮）不得抢位——2026-10-25 实测踩坑
        const viaExts = platform === "harmony" && cmdOpts.via !== "pgyer" ? [".app"] : undefined;
        const found = (
          viaExts
            ? findArtifacts(cmdOpts.cwd, patterns).filter((f) =>
                viaExts.includes(path.extname(f).toLowerCase()),
              )
            : findArtifacts(cmdOpts.cwd, patterns)
        ) as string[];
        // 版本语义：热更平台的 beta 吃派生测试包（测试设备收测试线热更）
        const providers: UpdateProvider[] = [];
        await host?.broadcast("update:register", { cwd: cmdOpts.cwd }, providers);
        const hotPlatforms = new Set(providers.flatMap((p) => p.platforms ?? []));
        const expected = expectedArtifactVersion(
          cmdOpts.cwd,
          framework,
          platform,
          "beta",
          hotPlatforms,
          projCfg.version?.beta,
        );
        const picked = pickArtifactByVersion(found, expected);
        if (expected && picked.mismatched)
          throw new Error(
            `未探测到测试包 ${expected}（现存 ${picked.mismatched
              .map((f) => path.basename(f))
              .slice(0, 3)
              .join(
                ", ",
              )}）——测试分发的包版本名必须是 ${expected}，请构建测试包后再发，或 --artifact 显式指定`,
          );
        artifactPath = picked.artifact;
      }
      if (!artifactPath) throw new Error("未找到构建产物：先构建或用 --artifact 指定");
      // bump 启用时对最终发布产物终验（--artifact 显式给旧包也拦得住）
      if (!fs.existsSync(artifactPath)) throw new Error(`产物不存在: ${artifactPath}`);
      const s = p.spinner();

      // harmony 分流：默认 AGC 测试发布（releaseType=6，指定设备内测），--via pgyer 走蒲公英
      if (platform === "harmony" && cmdOpts.via !== "pgyer") {
        const agc = registry.get("agc");
        if (!agc) throw new Error("agc 渠道未注册");
        const target = resolveChannelTarget("agc", projCfg, detected);
        warnDuplicateVersion("agc", artifactPath);
        s.start(`AGC 测试发布 ${path.basename(artifactPath)}`);
        const agcCfg = projCfg.beta?.agc;
        const ctx = makeContext(
          agc,
          creds,
          {
            ...target,
            releaseType: "6",
            ...(agcCfg?.submit ? { submitTest: "true" } : {}),
            ...(agcCfg?.group ? { testGroup: agcCfg.group } : {}),
            testType: String(agcCfg?.testType ?? 3),
            // cleanup 默认 true（schema 缺省）；'false' 时渠道跳过旧测试版本清理
            ...(agcCfg?.privacyPolicy ? { privacyPolicy: agcCfg.privacyPolicy } : {}),
          },
          artifactPath,
          cmdOpts.note,
        );
        const r = await agc.stage({
          ...ctx,
          emit: (e) => {
            if (e.type === "warn") s.message(pc.yellow(`⚠ ${redactText(e.message)}`));
          },
        });
        await notifyStageAfter(host, "agc", platform, ctx, r, cmdOpts.cwd);
        if (r.ok) {
          s.stop(
            agcCfg?.submit
              ? `AGC 测试版本已提交审核 ✓（versionId: ${r.ref ?? "?"}，群组: ${agcCfg.group ?? "默认"}）`
              : `AGC 测试版本已就绪 ${pc.green("✓")}（未提交审核），到控制台「测试」提交并指定测试群组`,
          );
        } else {
          s.stop(`AGC 测试发布失败: ${redactText(r.error ?? "")}`);
          process.exitCode = 1;
        }
        return;
      }

      const pgyer = registry.get("pgyer");
      if (!pgyer) throw new Error("pgyer 渠道未注册");
      warnDuplicateVersion("pgyer", artifactPath);
      s.start(`蒲公英上传 ${path.basename(artifactPath)}`);
      const ctx = makeContext(
        pgyer,
        creds,
        resolveChannelTarget("pgyer", projCfg, detected),
        artifactPath,
        cmdOpts.note,
        { installPassword: cmdOpts.installPassword },
      );
      const r = await pgyer.stage({
        ...ctx,
        emit: (e) => {
          if (e.type === "warn") s.message(pc.yellow(`⚠ ${redactText(e.message)}`));
        },
      });
      await notifyStageAfter(host, "pgyer", platform, ctx, r, cmdOpts.cwd);
      if (r.ok) {
        s.stop(`蒲公英发布成功 ${pc.green("✓")} 扫码即装`);
      } else {
        s.stop(`蒲公英上传失败: ${redactText(r.error ?? "")}`);
        process.exitCode = 1;
      }
    },
  );

program
  .command("release")
  .description(
    "正式发版两段式：不带 --submit 只传包到各家草稿（安全）；--submit = 自动完成传包+确认+提审一条龙（审核通过即上架）",
  )
  .argument("<platform>", "android | harmony | ios")
  .option("--stores <list>", "渠道列表（逗号分隔）；缺省进入交互多选")
  .option("--submit", "提审（L3 不可逆：审核通过自动上架）")
  .option("--skip-stage", "与 --submit 同用：复用已 stage 的包直接提审")
  .option("--artifact <path>", "产物路径；缺省自动探测框架最新构建产物")
  .option("--note <text>", "更新说明")
  .option("--release-time <rfc3339>", "定时上架时间（RFC3339，仅 scheduled 渠道生效）")
  .option("--remark <text>", "提审备注（给审核员）")
  .option(
    "--profile <name>",
    "凭据 profile（最高优先级；缺省走 applift use 个人选择 > 项目配置团队默认）",
  )
  .option("--delivery <mode>", "投递方式：ota（热更 promote）| native（原生上架）；缺省按判定推荐")
  .option("--rollout <pct>", "热更正式灰度比例（1-100，配合 --delivery ota）")
  .option("--cwd <dir>", "项目目录", process.cwd())
  .option("--yes", "CI 无人值守豁免确认")
  .option("--dry-run", "只打印计划")
  .option("--json", "结构化输出（stdout 给机器，渲染抑制）")
  .action(async (platform: string, raw: Record<string, unknown>) => {
    const opts = raw as unknown as ReleaseOpts;
    // rollout 数值与范围校验前移（错误在入口报，不延迟到 pushy 端）
    if (opts.rollout !== undefined) {
      const n = Number(opts.rollout);
      if (Number.isNaN(n) || !Number.isInteger(n) || n < 1 || n > 100) {
        throw new Error(`--rollout 必须是 1-100 的整数，收到 "${opts.rollout}"`);
      }
    }
    const KNOWN_PLATFORMS = ["android", "harmony", "ios", "windows", "macos", "linux"];
    if (!KNOWN_PLATFORMS.includes(platform)) {
      // 插件适配器可自报平台——仅提示不拒绝
      process.stderr.write(
        `⚠ 平台 "${platform}" 非内置（${KNOWN_PLATFORMS.join(" | ")}）；若你注册了自定义框架适配器则继续\n`,
      );
    }
    setupChannels();
    const { host, config, extraFrameworks: pluginFrameworks } = await loadPluginHost(opts.cwd);
    const { config: global, warning: globalWarning } = loadGlobalConfig();
    const isJson = Boolean(opts.json);
    // 全局配置损坏降级警告：--json 下走 stderr 保 stdout 纯净（AI/CI 消费契约）
    if (globalWarning) {
      if (isJson) process.stderr.write(`${pc.yellow(`⚠ ${globalWarning}`)}\n`);
      else p.log.warn(globalWarning);
    }
    // 提审确认非交互门控（fail-fast）：--submit 且未授权（--yes / config.toml assumeYes）时，
    // 无 TTY（CI/管道）或 --json 无法完成交互确认（挂起或被拒），入口即报原因与出路
    if (
      opts.submit &&
      !opts.dryRun &&
      !(opts.yes || global.assumeYes) &&
      (!process.stdout.isTTY || isJson)
    )
      throw new Error(
        "非交互环境（无 TTY 或 --json）下提审需显式授权：加 --yes，或在 ~/.applift/config.toml 设 assumeYes",
      );
    // profile 优先级：--profile 旗标 > projects.json 个人选择（applift use）> 项目配置团队默认
    const creds = opts.dryRun
      ? {}
      : resolveProfile(
          loadCredentialsLayered(opts.cwd),
          opts.profile ?? resolveProfileFor(opts.cwd, config.profile),
          KNOWN_CREDENTIAL_KEYS,
        );

    // 框架探测（RN/Flutter/原生安卓/原生 iOS/原生鸿蒙）
    const framework = requireFramework(opts.cwd, pluginFrameworks);
    if (!isJson) {
      if (framework)
        p.log.info(
          `框架: ${pc.bold(framework.expoAwareLabel?.(opts.cwd) ?? framework.label)}${pc.dim(` (${framework.id})`)}`,
        );
      else p.log.warn("未识别框架，产物路径请用 --artifact 指定");
    }

    // ---------- 热更路由：判定推荐 → promote（测试通道已验证热更重绑正式版本 + 灰度）----------
    const decision = await resolveDeliveryMode(
      opts.cwd,
      host,
      framework,
      {
        yes: Boolean(opts.yes) || Boolean(global.assumeYes),
        delivery: opts.delivery,
        json: isJson,
        dryRun: Boolean(opts.dryRun),
      },
      platform,
    );
    if (decision?.mode === "ota" && decision.provider) {
      if (opts.dryRun) {
        p.log.info(
          `[dry-run] 热更发布正式：优先 promote 测试通道已验证热更，无则直接发布当前 ppk（platform=${platform}）`,
        );
        return;
      }
      // 两条腿：测试通道有已验证热更且 provider 支持 promote → 重绑正式（零构建）；
      // 否则 publishToProd 直接发正式（ppk 产物入口）——热更不依赖 beta
      const publishCtx = {
        cwd: opts.cwd,
        framework,
        platform,
        note: opts.note,
        rollout: opts.rollout !== undefined ? Number(opts.rollout) : undefined,
        credentials: creds,
        artifact: opts.artifact ? path.resolve(opts.artifact) : undefined, // 显式 ppk（与 beta 对称：跳过探测与护栏）
      };
      let r: { versionName: string; rollout?: number };
      let via: "promote" | "publish";
      const promoted = decision.provider.promoteToProd
        ? await decision.provider.promoteToProd(publishCtx)
        : null;
      if (promoted) {
        r = promoted;
        via = "promote";
      } else {
        if (decision.provider.promoteToProd)
          p.log.info("测试通道无可 promote 热更，改为直接发正式热更（ppk 产物入口）");
        r = await decision.provider.publishToProd(publishCtx);
        via = "publish";
      }
      p.log.success(
        `热更已发布正式${pc.dim(`（${via === "promote" ? "promote 测试热更" : "直接发布"}）`)}：${pc.bold(r.versionName)}${r.rollout ? pc.dim(`（灰度 ${r.rollout}%）`) : ""}`,
      );
      appendEntry({
        ts: Date.now(),
        cwd: path.resolve(opts.cwd),
        artifactSha256: "", // promote 不产生新工件（重绑已有热更版本）
        channel: decision.provider.id,
        action: "submit",
        ok: true,
        artifactVersion: r.versionName,
        ref: r.rollout !== undefined ? `rollout:${r.rollout}%` : undefined,
      });
      await host?.broadcast(
        "notify",
        { cwd: opts.cwd },
        {
          stage: [],
          submit: [
            {
              channel: decision.provider.id,
              label: `热更正式（${platform}${r.rollout !== undefined ? `，灰度 ${r.rollout}%` : ""}）`,
              ok: true,
              plan: {
                channel: decision.provider.id,
                platform: platform as ReleasePlanEntry["platform"],
                artifactVersion: r.versionName,
                action: "stage+submit",
                afterApproval: "auto-publish",
              },
            },
          ],
        },
      );
      return;
    }
    // --rollout 只属于热更 promote：原生路径或未注册热更插件时给出提示（与 --delivery ota 的显式报错对齐，
    // 参数给了却无人消费必须可见，CI 传参静默失效最难排查）
    if (opts.rollout !== undefined && decision?.mode !== "ota" && !opts.dryRun)
      p.log.warn("--rollout 仅热更发布（--delivery ota）生效，本次发布不会灰度，参数已忽略");

    /** 上架（release）各平台产物扩展名约束：agc 只收 .app 整包、国内安卓商店 apk、googleplay aab、asc ipa */
    const RELEASE_ARTIFACT_EXTS: Record<string, string[]> = {
      harmony: [".app"],
      android: [".apk", ".aab"],
      ios: [".ipa"],
    };

    // 产物解析：--artifact > 框架 pattern 自动探测（按渠道接受的扩展名过滤后取 mtime 最新）
    // 上架场景的扩展名约束（与 beta 分流同源）：防双产物工程（internaltesting .hap + release .app）
    // 因 mtime 排序误选测试签名包——渠道层仍有终验（agc-harmony 只收 .app），此处让探测先选对
    let artifactPath: string | undefined = opts.artifact ? path.resolve(opts.artifact) : undefined;
    if (!artifactPath) {
      // 优先项目配置 artifacts 覆盖（非标准工程目录），其次框架内置 pattern
      const patterns = config.artifacts?.[platform] ?? framework?.artifactPatterns(platform) ?? [];
      const found = findArtifacts(opts.cwd, patterns);
      const exts = RELEASE_ARTIFACT_EXTS[platform] ?? [];
      const byExt = exts.length
        ? found.filter((f) => exts.includes(path.extname(f).toLowerCase()))
        : found;
      // 版本语义：正式分发/上架必须工程 versionName——测试包（4.0.1000）与旧版本产物都不能出正式门
      const expected = expectedArtifactVersion(
        opts.cwd,
        framework,
        platform,
        "release",
        new Set(),
        config.version?.beta,
      );
      const picked = pickArtifactByVersion(byExt, expected);
      artifactPath = picked.artifact;
      if (artifactPath && !isJson) {
        const via = config.artifacts?.[platform]
          ? "项目配置 artifacts"
          : `${framework?.label} 内置 pattern`;
        p.log.info(
          `自动探测产物（${via}${exts.length ? `，扩展名 ${exts.join("/")}` : ""}${expected ? `，版本 ${expected}` : ""}）: ${pc.bold(path.basename(artifactPath))} ${pc.dim(artifactPath)}`,
        );
      }
      if (!artifactPath && byExt.length > 0) {
        const list = byExt
          .map((f) => path.basename(f))
          .slice(0, 3)
          .join(", ");
        throw new Error(
          expected
            ? `探测到产物但无版本 ${expected} 的 ${exts.join("/")}（现存 ${list}）——测试包/旧版本不能正式分发，请先构建 ${expected} 正式产物或用 --artifact 指定`
            : `探测到产物但无 ${platform} 上架可接受的扩展名（需 ${exts.join("/")}，现存 ${list}）——测试签名包不能上架，请构建正式产物或用 --artifact 指定`,
        );
      }
    }
    if (!artifactPath && !opts.dryRun) {
      throw new Error("未找到构建产物：先构建或用 --artifact 指定");
    }
    if (artifactPath && !fs.existsSync(artifactPath) && !opts.dryRun) {
      throw new Error(
        artifactPath ? `产物不存在: ${artifactPath}` : "未找到构建产物：先构建或用 --artifact 指定",
      );
    }

    // 渠道选择：--stores > 项目配置 > 交互多选
    let storeIds: string[];
    if (opts.stores) {
      storeIds = opts.stores
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      // 未知渠道不再静默过滤（P3-7）：写 stderr 保持 --json 的 stdout 纯净
      const known = new Set(registry.all().map((c) => c.id));
      for (const id of storeIds) {
        if (!known.has(id))
          process.stderr.write(`⚠ 未知渠道 ${id}（可用: ${[...known].join(", ")}）\n`);
      }
    } else {
      const configured = Object.keys(config.android?.stores ?? {});
      if (configured.length > 0) {
        storeIds = configured;
      } else if (opts.dryRun || opts.yes || isJson || global.assumeYes) {
        // 默认全渠道收敛（P2）：按发布平台过滤（plan().platform）且仅限可提审渠道（capabilities.submit）
        // —— pgyer（submit=false 内测渠道）与 ios/harmony 渠道不再混入 `release android` 默认集
        const detectedDefault = detectBundleIds(opts.cwd);
        const candidates: string[] = [];
        for (const c of registry.all()) {
          if (!c.capabilities.submit) continue;
          try {
            const plan = await c.plan(
              makeContext(
                c,
                creds,
                resolveChannelTarget(c.id, config, detectedDefault),
                artifactPath ?? "",
                opts.note,
              ),
            );
            if (plan.platform === platform) candidates.push(c.id);
          } catch {
            // plan 失败（缺 target/应用配置）的渠道不进默认集；显式 --stores 仍可指定
          }
        }
        storeIds = candidates;
      } else {
        const selected = await p.multiselect({
          message: "选择提审渠道",
          options: registry
            .all()
            .filter((c) => c.id !== "pgyer")
            .map((c) => ({ value: c.id, label: c.label })),
          required: true,
        });
        if (p.isCancel(selected)) throw new Error("已取消");
        storeIds = selected as string[];
      }
    }
    let channels: Channel[] = storeIds
      .map((id) => registry.get(id))
      .filter((c): c is Channel => c !== undefined);
    if (channels.length === 0)
      throw new Error(
        `未找到渠道（${storeIds.join(", ")}）。已注册: ${registry
          .all()
          .map((c) => c.id)
          .join(", ")}`,
      );

    // stage-only 流排除不支持草稿区的渠道（如小米上传即提审）：留在列表会走 runStage 的
    // ok:false 兜底 → exit 1 + "修复后重跑"误导；--submit 流不受影响，dry-run 只读也不排除
    if (!opts.submit && !opts.dryRun) {
      const excluded = channels.filter((c) => c.capabilities.stage === false);
      if (excluded.length > 0) {
        const excludedIds = new Set(excluded.map((c) => c.id));
        channels = channels.filter((c) => !excludedIds.has(c.id));
        for (const c of excluded) {
          // --json 下 stdout 纯净（AI/CI 消费契约）：提示改走 stderr
          const msg = `「${c.label}」上传即提审、无草稿区，已从本次传包排除（需提审请用 --submit）`;
          if (isJson) process.stderr.write(`${pc.yellow(`⚠ ${msg}`)}\n`);
          else p.log.warn(msg);
        }
      }
      if (channels.length === 0)
        throw new Error("所选渠道均不支持只传包（上传即提审），需提审请加 --submit");
    }

    // 渠道 target 取值链：stores 渠道配置 > 平台段配置 > 包名自动推导（项目配置 > 自动推导）
    // 小米特例：icon 未配置时从工程 mipmap 自动发现（配置覆盖优先）
    const detected = detectBundleIds(opts.cwd);
    const contexts = new Map<string, ChannelContext>();
    for (const c of channels) {
      let target = resolveChannelTarget(c.id, config, detected);
      if (c.id === "xiaomi" && !target.icon) {
        const icon = discoverXiaomiIcon(opts.cwd);
        if (icon) {
          target = { ...target, icon };
          process.stderr.write(`小米 icon 自动发现: ${path.relative(opts.cwd, icon)}\n`);
        }
      }
      contexts.set(
        c.id,
        makeContext(c, creds, target, artifactPath ?? "", opts.note, {
          releaseTime: opts.releaseTime,
          remark: opts.remark,
        }),
      );
    }

    if (opts.dryRun) {
      const plans: unknown[] = [];
      const errors: Record<string, string> = {};
      for (const c of channels) {
        try {
          const plan = await c.plan(contexts.get(c.id)!);
          plans.push(plan);
          if (!isJson)
            p.log.message(
              `${pc.cyan(plan.platform.padEnd(8))} ${pc.bold(plan.channel.padEnd(12))} → ${plan.action} (${plan.afterApproval})`,
            );
        } catch (e) {
          // plan 抛错可能内嵌凭据/响应体：--json errors 与非 JSON 警告共用同一脱敏值
          errors[c.id] = redactText((e as Error).message);
          if (!isJson) p.log.warn(`${pc.bold(c.label)}: ${errors[c.id]}`);
        }
      }
      if (isJson)
        process.stdout.write(JSON.stringify({ dryRun: true, plans, errors }, null, 2) + "\n");
      return;
    }

    const confirmFn =
      opts.yes || global.assumeYes
        ? async (plans: ReleasePlanEntry[]) => {
            p.log.warn(`[CI 模式] assumeYes，自动确认 ${plans.length} 项提审`);
            return true;
          }
        : confirmWithClack;
    // 发版历史注入：pipeline 每渠道 stage/submit 落一条到 ~/.applift/history.jsonl
    let cachedSha: string | undefined;
    const artifactSha256 = () => {
      if (!artifactPath || !fs.existsSync(artifactPath)) return "";
      cachedSha ??= sha256File(artifactPath);
      return cachedSha;
    };
    const artifactVersionOf = () =>
      artifactPath ? readArtifactVersion(artifactPath)?.versionName : undefined;
    // --json 的 ref 字段来源：core 汇总条目不带 ref，从 history 事件按渠道+动作取值；
    // 取不到显式置 null（字段稳定出现，不被 JSON.stringify 丢弃）。
    // ref 可能内嵌渠道响应体切片（OBS/COS 预签名上传 URL）：在 historySink 入口统一脱敏一次，
    // refOf 与落盘共用（重复脱敏会改写 [REDACTED <len>] 的长度线索，禁止二次过 redactText）
    const jsonRefs = new Map<string, string>();
    const refOf = (channel: string, action: "stage" | "submit") =>
      jsonRefs.get(`${channel}:${action}`) ?? jsonRefs.get(`${channel}:stage`) ?? null;
    const historySink = (e: HistoryEvent) => {
      const ev: HistoryEvent = e.ref ? { ...e, ref: redactText(e.ref) } : e;
      if (ev.ref) jsonRefs.set(`${ev.channel}:${ev.action}`, ev.ref);
      appendEntry({
        ts: Date.now(),
        cwd: path.resolve(opts.cwd),
        artifactSha256: artifactSha256(),
        artifactVersion: e.artifactVersion ?? artifactVersionOf(),
        ...ev,
      });
    };
    // 护栏②：同渠道同 versionName 重复提交警告
    if (artifactPath) for (const c of channels) warnDuplicateVersion(c.id, artifactPath);
    const pipelineInput = {
      channels,
      contexts,
      concurrency: global.concurrency,
      cwd: opts.cwd,
      confirm: confirmFn,
      plugins: host,
      historySink,
    };
    if (!opts.submit) {
      if (!isJson) p.intro(pc.bgCyan(pc.black(" applift release · stage ")));
      // 交互式两段线第一步确认：上传前展示渠道清单
      const interactive = process.stdout.isTTY && !isJson && !opts.yes && !global.assumeYes;
      if (interactive) {
        const list = channels.map((c) => c.label).join("、");
        const ok = await p.confirm({
          message: `将上传到 ${pc.bold(list)} 的草稿区（不提审），继续？`,
        });
        if (p.isCancel(ok) || !ok) throw new Error("已取消（未做任何变更）");
      }
      const summary = await runStage(pipelineInput);
      if (isJson) {
        process.stdout.write(
          JSON.stringify(
            {
              stage: summary.stage.map((e) => ({
                channel: e.channel,
                ok: e.ok,
                ref: refOf(e.channel, "stage"),
                error: e.stageError === undefined ? undefined : redactText(e.stageError),
              })),
            },
            null,
            2,
          ) + "\n",
        );
      } else {
        renderSummary(summary.stage);
      }
      if (summary.stage.some((e) => !e.ok)) {
        process.exitCode = 1;
        if (!isJson) p.outro("部分渠道传包失败，未提审；修复后重跑");
        return;
      }
      // 交互式两段线第二步：草稿就绪后询问是否继续提审（--submit 缺省时的引导；--yes/CI 跳过）
      if (interactive) {
        const goSubmit = await p.confirm({
          message: `草稿已就绪。${pc.red("现在提审？")}（审核通过即自动上架，不可撤回）`,
        });
        if (p.isCancel(goSubmit) || !goSubmit) {
          p.outro(
            `已保留草稿。之后提审: ${pc.cyan(`applift release ${platform} --submit --skip-stage`)}`,
          );
          return;
        }
        const submitSummary = await runSubmit(pipelineInput, { skipStage: true });
        renderSummary(submitSummary.submit);
        if (submitSummary.submit.some((s) => !s.ok)) process.exitCode = 1;
        // tag 后移对交互两段线同样生效：提审全部成功才补 tag（部分成功 = 发布未完成）；
        // 多端版本不一致时不打（单一 tag 无法代表混合版本，警告留给人工决策）
        if (submitSummary.submit.length > 0 && submitSummary.submit.every((s) => s.ok)) {
          const versions = [...new Set(submitSummary.submit.map((s) => s.plan?.artifactVersion))];
          const version = versions.length === 1 ? versions[0] : undefined;
          if (!version) p.log.warn("各端产物版本不一致，跳过 tag（请人工确认 tag 版本）");
          else {
            const r = tagReleaseVersion(opts.cwd, version);
            if (r.tagged) p.log.success(`git tag: v${version}（正式发布）`);
            else if (r.conflict) p.log.warn(`tag: ${r.reason}`);
            else if (r.reason) p.log.info(pc.dim(`tag: ${r.reason}`));
          }
        }
        p.outro("完成");
        return;
      }
      if (!isJson)
        p.outro(
          `已传包到草稿（${pc.bold("未提审")}）。提审执行: ${pc.cyan(`applift release ${platform} --submit`)}`,
        );
      return;
    }
    if (!isJson) p.intro(pc.bgMagenta(pc.black(" applift release · submit ")));
    // 幂等提示：同 sha256+channel 已有成功 stage 记录 → 可 --skip-stage 复用草稿免重传
    if (!opts.skipStage && artifactPath && fs.existsSync(artifactPath)) {
      const sha = artifactSha256();
      const stagedChannels = new Set(
        readEntries({ sha256: sha })
          .filter((h) => h.action === "stage" && h.ok)
          .map((h) => h.channel),
      );
      const reusable = channels.filter((c) => stagedChannels.has(c.id)).map((c) => c.id);
      if (reusable.length > 0) {
        p.log.warn(
          `以下渠道已有同包（sha256 ${sha.slice(0, 8)}…）成功 stage 记录：${pc.bold(reusable.join(", "))}。如草稿未被改动，可加 ${pc.cyan("--skip-stage")} 复用免重传`,
        );
      }
    }
    // 反向守卫：--skip-stage 时校验各渠道「最近一次成功 stage 的包」与当前产物一致，不一致警告（防止提审旧草稿）
    if (opts.skipStage && artifactPath && fs.existsSync(artifactPath)) {
      const sha = artifactSha256();
      for (const ch of channels) {
        const last = readEntries({ channel: ch.id })
          .filter((h) => h.action === "stage" && h.ok)
          .at(-1); // 旧→新序列：filter+at(-1) 取最近一次成功（裸 find 会拿到最旧的）
        if (last && last.artifactSha256 && last.artifactSha256 !== sha) {
          p.log.warn(
            `${pc.bold(ch.label)} 的最近草稿是另一个包（sha ${last.artifactSha256.slice(0, 8)}… ≠ 当前 ${sha.slice(0, 8)}…）——${pc.red("提审的将是商店后台当前草稿，请确认")}（去掉 --skip-stage 重传当前包）`,
          );
        }
      }
    }
    const summary = await runSubmit(pipelineInput, { skipStage: Boolean(opts.skipStage) });
    if (isJson) {
      process.stdout.write(
        JSON.stringify(
          {
            submit: summary.submit.map((e) => {
              const error = e.submitError ?? e.stageError;
              return {
                channel: e.channel,
                ok: e.ok,
                ref: refOf(e.channel, "submit"),
                error: error === undefined ? undefined : redactText(error),
              };
            }),
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      renderSummary(summary.submit);
      p.outro("完成");
    }
    if (summary.submit.some((s) => !s.ok)) process.exitCode = 1;
    // tag 后移：正式发布成功才补 tag（tag = 实际已发布版本；beta 不打 tag，追溯走 history）。
    // 全部渠道提审成功才打（部分成功 = 发布未完成，tag 语义不稀释）；
    // 多端版本不一致时不打（单一 tag 无法代表混合版本，警告留给人工决策）
    if (summary.submit.length > 0 && summary.submit.every((s) => s.ok)) {
      const versions = [...new Set(summary.submit.map((s) => s.plan?.artifactVersion))];
      const version = versions.length === 1 ? versions[0] : undefined;
      if (!version && !opts.dryRun)
        p.log.warn("各端产物版本不一致，跳过 tag（请人工确认 tag 版本）");
      else if (version) {
        const r = tagReleaseVersion(opts.cwd, version, { dryRun: Boolean(opts.dryRun) });
        if (r.tagged) p.log.success(`git tag: v${version}（正式发布）`);
        else if (r.conflict && !opts.dryRun) p.log.warn(`tag: ${r.reason}`);
        else if (r.reason && !opts.dryRun) p.log.info(pc.dim(`tag: ${r.reason}`));
      }
    }
  });

function renderSummary(
  entries: Array<{
    channel?: string;
    label: string;
    ok: boolean;
    stageError?: string;
    submitError?: string;
  }>,
): void {
  for (const e of entries) {
    const raw = e.stageError ?? e.submitError;
    // 错误码翻译：从渠道实例自带的 errorHints 取（平台内聚）；先脱敏后人话化——错误码不受脱敏影响
    const hints = e.channel ? registry.get(e.channel)?.errorHints : undefined;
    const err = raw ? humanizeError(hints, redactText(raw)) : raw;
    p.log.message(
      `  ${e.ok ? pc.green("✓") : pc.red("✗")} ${pc.bold(e.label)}${err ? pc.red(` — ${err}`) : ""}`,
    );
  }
}

program
  .command("doctor")
  .description("体检：框架/凭据/渠道配置")
  .option("--cwd <dir>", "项目目录", process.cwd())
  .action(async (cmdOpts: { cwd: string }) => {
    setupChannels();
    p.intro(pc.bgBlue(pc.black(" applift doctor ")));
    // 框架段：声明（插件注册）为事实，探测仅作建议——两者不一致时提示
    const { host } = await loadPluginHost(cmdOpts.cwd);
    const registered: FrameworkAdapter[] = [];
    await host?.broadcast("framework:register", { cwd: cmdOpts.cwd }, registered);
    let framework: FrameworkAdapter | null = null;
    try {
      framework = resolveFramework(cmdOpts.cwd, registered);
    } catch (e) {
      p.log.error(`框架声明错误: ${(e as Error).message}`);
    }
    if (framework) p.log.success(`框架声明: ${pc.bold(framework.label)}（插件注册）`);
    else {
      const suggested = suggestFramework(cmdOpts.cwd);
      if (suggested)
        p.log.warn(
          `未声明 framework 插件（建议: ${suggested.label}，在 applift.config.ts 的 plugins 里声明对应 framework 工厂）`,
        );
      else p.log.warn("未声明 framework 插件，且未能探测建议（发布命令将无法解析框架）");
    }
    // 自动推导段：展示从工程文件读到的三端标识（配置缺省时作为渠道 target 兜底）
    const ids = detectBundleIds(cmdOpts.cwd);
    const idParts = [
      ids.androidPkgName ? `android ${pc.bold(ids.androidPkgName)}` : "",
      ids.harmonyBundleName ? `harmony ${pc.bold(ids.harmonyBundleName)}` : "",
      ids.iosBundleId
        ? `ios ${pc.bold(ids.iosBundleId)}${ids.iosScheme ? pc.dim(`（scheme ${ids.iosScheme}）`) : ""}`
        : "",
    ].filter(Boolean);
    if (idParts.length > 0)
      p.log.success(`自动推导: ${idParts.join(" · ")} ${pc.dim("（配置缺省时兜底）")}`);
    else
      p.log.warn(
        "自动推导: 未识别到三端标识（app.json / build.gradle / AppScope/app.json5 / pbxproj 均未命中）",
      );
    let healthy = true;
    // 配置优先级公理（唯一解析规则，任何键同链）：flag > env > 个人 > 项目 > 全局
    p.log.info(
      pc.dim(
        "优先级: flag > APPLIFT_* env > applift use（个人）> 项目（.applift/ + applift.config.ts）> 全局（~/.applift）",
      ),
    );
    const envOverrideKeys = [
      ...Object.keys(process.env)
        .filter(
          (k) => k.startsWith("APPLIFT_") && process.env[k] && k !== "APPLIFT_HOME", // 内部运行时变量非凭据覆盖
        )
        .map((k) => k.slice("APPLIFT_".length)),
      ...KNOWN_CREDENTIAL_KEYS.filter((k) => process.env[k]),
    ];
    if (envOverrideKeys.length > 0)
      p.log.info(`env 覆盖生效（值不展示）: ${pc.bold(envOverrideKeys.join(", "))}`);
    const creds = loadCredentialsLayered(cmdOpts.cwd);
    const profileNames = Object.keys(creds.profiles);
    if (profileNames.length > 0)
      p.log.success(`凭据 profiles: ${pc.bold(profileNames.join(", "))}`);
    else p.log.error("无凭据（~/.applift/credentials.json）");
    if (profileNames.length === 0) healthy = false;
    const { config } = await loadProjectConfig(cmdOpts.cwd);
    // 与 release 同链解析：projects.json 个人选择（applift use）> 项目配置团队默认
    const { profile, source: profileSource } = resolveProfileSource(cmdOpts.cwd, config.profile);
    const stores = Object.keys(config.android?.stores ?? {});
    if (stores.length > 0)
      p.log.success(`项目渠道: ${stores.join(", ")}（profile=${profile}，来源: ${profileSource}）`);
    else p.log.info("项目未配置渠道（applift.config.ts → android.stores）");
    // 内测并行配置概览（beta 无平台参数时的渠道开关）
    if (config.beta) {
      const betaParts = [
        config.beta.pgyer ? `pgyer（${config.beta.pgyer.platforms.join("/")}）` : "",
        config.beta.agc ? "agc" : "",
        config.beta.testflight ? "testflight" : "",
      ].filter(Boolean);
      if (betaParts.length > 0) p.log.success(`beta 并行渠道: ${betaParts.join(" · ")}`);
    }
    // 热更 provider 概览（update:register 与 framework:register 对称）
    const updateProviders: UpdateProvider[] = [];
    await host?.broadcast("update:register", { cwd: cmdOpts.cwd }, updateProviders);
    if (updateProviders.length > 0) {
      p.log.success(
        `热更: ${updateProviders
          .map((pr) => `${pr.id}（${pr.platforms?.length ? pr.platforms.join("/") : "全平台"}）`)
          .join(", ")}`,
      );
    }
    // 逐渠道凭据核对（llms.txt 承诺的「凭据缺失清单」）
    // 与 release 同链解析（P2）：env 覆盖生效、缺 profile 报错形态一致（列出可用 profiles）
    const activeProfile =
      stores.length > 0 ? resolveProfile(creds, profile, KNOWN_CREDENTIAL_KEYS) : undefined;
    if (stores.length > 0 && activeProfile) {
      for (const id of stores) {
        const need = REQUIRED_KEYS_BY_CHANNEL[id];
        if (!need) continue;
        // “或”型键（A 或 B）任一备选存在即过，全缺则整串报缺失；普通键直接查缺
        const missing = need.filter((k) =>
          k.includes(" 或 ")
            ? !k.split(" 或 ").some((alt) => activeProfile[alt])
            : !activeProfile[k],
        );
        if (missing.length > 0) {
          p.log.error(`${pc.bold(id)}: 缺凭据 ${missing.join(", ")} — ${CHANNEL_HINTS[id] ?? ""}`);
          healthy = false;
        } else {
          p.log.success(`${id}: 凭据齐全`);
        }
      }
    }
    // 产物版本读取（.hap pack.info / .apk aapt；.ipa 不支持自动读）
    if (framework) {
      for (const plat of ["android", "harmony", "ios"] as const) {
        const cfgPatterns = config.artifacts?.[plat];
        const patterns = cfgPatterns ?? framework.artifactPatterns(plat);
        const found = findArtifacts(cmdOpts.cwd, patterns)[0];
        if (found) {
          const v = readArtifactVersion(found);
          const via = cfgPatterns ? "项目配置 artifacts" : "框架内置 pattern";
          p.log.info(
            `产物 ${plat}: ${pc.bold(path.basename(found))}${pc.dim(`（${via}）`)}${v ? `（${v.versionName ?? "?"} build ${v.versionCode ?? "?"}，读自 ${v.source}）` : pc.dim("（版本自动读取不支持该格式）")}`,
          );
          break;
        }
      }
    }
    p.outro(healthy ? "体检完成：一切就绪" : "体检完成：存在待修复项（见上）");
    if (!healthy) process.exitCode = 1;
  });

import { registerLifecycleCommands } from "./lifecycle.js";
import { registerListingCommand } from "./listing.js";
registerListingCommand(program, { setup: setupChannels, registry });
import { REQUIRED_KEYS_BY_CHANNEL, CHANNEL_HINTS, KNOWN_CREDENTIAL_KEYS } from "./channel-meta.js";
registerLifecycleCommands(program, { setup: setupChannels, registry });

program
  .command("channels")
  .description("列出全部渠道及所需配置（--json 供 AI agent 消费）")
  .option("--json", "JSON 输出")
  .action(async (cmdOpts: { json?: boolean }) => {
    setupChannels();
    const rows = registry.all().map((c) => ({
      id: c.id,
      label: c.label,
      capabilities: c.capabilities,
      credentials: REQUIRED_KEYS_BY_CHANNEL[c.id] ?? [],
      hint: CHANNEL_HINTS[c.id] ?? "",
    }));
    if (cmdOpts.json) {
      process.stdout.write(JSON.stringify({ channels: rows }, null, 2) + "\n");
      return;
    }
    for (const r of rows) {
      process.stdout.write(
        `  ${pc.bold(r.id.padEnd(14))} ${r.label}  ${pc.dim(r.credentials.join("/") || "无需凭据")}\n`,
      );
    }
  });

export { program };
