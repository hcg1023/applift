/**
 * CLI：commander 参数解析 + @clack/prompts 交互 + picocolors 美化。
 * 薄壳——渲染 core 事件流与插件钩子结果，业务全在 core。
 */
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
  loadCredentials,
  loadCredentialsLayered,
  resolveProfile,
  resolveProfileFor,
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
  detectFramework,
  detectBundleIds,
  findArtifacts,
  type Channel,
  type ChannelContext,
  type ChannelEvent,
  type ReleasePlanEntry,
  type ProjectConfig,
  humanizeError,
  readArtifactVersion,
  type FrameworkAdapter,
} from "@applift/core";
import { resolveChannelTarget } from "./target.js";

/** 框架探测（含插件注册的自定义适配器） */
function detectFrameworkWith(cwd: string, extra: FrameworkAdapter[]) {
  return detectFramework(cwd, extra);
}

const program = new Command("applift");

program
  .name("applift")
  .description("三端 App 发版工具（内测 / 多商店提审 / 插件扩展）")
  .version("0.2.0");

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
    // 渠道进度写 stderr——保证 --json 的 stdout 纯净（AI/CI 消费契约）
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
        `  ${label} ${phaseText}${event.message ? pc.dim(` — ${event.message}`) : ""}\n`,
      );
    } else if (event.type === "warn") {
      process.stderr.write(`  ${label} ⚠ ${event.message}\n`);
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

/** clack 确认：计划表 → confirm（非 TTY/CI 环境自动拒绝，需 --yes） */
async function confirmWithClack(plans: ReleasePlanEntry[]): Promise<boolean> {
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
  if (p.isCancel(yes)) return false;
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

program
  .command("beta")
  .description(
    "内测分发（android/ios → 蒲公英扫码即装；harmony 默认 AGC 测试发布，--via pgyer 改走蒲公英）",
  )
  .argument("<platform>", "android | harmony | ios")
  .option("--artifact <path>", "产物路径（缺省自动探测最新构建产物）")
  .option("--note <text>", "更新说明")
  .option("--via <target>", "harmony 分发通道：agc（默认，AGC 指定设备测试发布）| pgyer", "agc")
  .option("--install-password <pwd>", "安装密码（蒲公英密码安装）")
  .option("--cwd <dir>", "项目目录", process.cwd())
  .action(
    async (
      platform: string,
      cmdOpts: {
        artifact?: string;
        note?: string;
        via?: string;
        installPassword?: string;
        cwd: string;
      },
    ) => {
      setupChannels();
      const { extraFrameworks: pluginFrameworks } = await loadPluginHost(cmdOpts.cwd);
      const { config: projCfg } = await loadProjectConfig(cmdOpts.cwd);
      // profile 解析链：projects.json 个人选择（applift use）> 项目配置团队默认
      const creds = resolveProfile(
        loadCredentialsLayered(cmdOpts.cwd),
        resolveProfileFor(cmdOpts.cwd, projCfg.profile),
        KNOWN_CREDENTIAL_KEYS,
      );
      const detected = detectBundleIds(cmdOpts.cwd);
      let artifactPath = cmdOpts.artifact ? path.resolve(cmdOpts.artifact) : undefined;
      if (!artifactPath) {
        const framework = detectFrameworkWith(cmdOpts.cwd, pluginFrameworks);
        const patterns =
          projCfg.artifacts?.[platform] ?? framework?.artifactPatterns(platform) ?? [];
        artifactPath = findArtifacts(cmdOpts.cwd, patterns)[0];
      }
      if (!artifactPath) throw new Error("未找到构建产物：先构建或用 --artifact 指定");
      if (!fs.existsSync(artifactPath)) throw new Error(`产物不存在: ${artifactPath}`);
      const s = p.spinner();

      // harmony 分流：默认 AGC 测试发布（releaseType=6，指定设备内测），--via pgyer 走蒲公英
      if (platform === "harmony" && cmdOpts.via !== "pgyer") {
        const agc = registry.get("agc-harmony");
        if (!agc) throw new Error("agc-harmony 渠道未注册");
        const target = resolveChannelTarget("agc-harmony", projCfg, detected);
        s.start(`AGC 测试发布 ${path.basename(artifactPath)}`);
        const ctx = makeContext(
          agc,
          creds,
          { ...target, releaseType: "6" },
          artifactPath,
          cmdOpts.note,
        );
        const r = await agc.stage({ ...ctx, emit: () => {} });
        if (r.ok) {
          s.stop(`AGC 测试包已上传 ${pc.green("✓")} 到控制台「我的应用 → 测试」指定测试设备`);
        } else {
          s.stop(`AGC 测试发布失败: ${r.error}`);
          process.exitCode = 1;
        }
        return;
      }

      const pgyer = registry.get("pgyer");
      if (!pgyer) throw new Error("pgyer 渠道未注册");
      s.start(`蒲公英上传 ${path.basename(artifactPath)}`);
      const ctx = makeContext(
        pgyer,
        creds,
        resolveChannelTarget("pgyer", projCfg, detected),
        artifactPath,
        cmdOpts.note,
        { installPassword: cmdOpts.installPassword },
      );
      const r = await pgyer.stage({ ...ctx, emit: () => {} });
      if (r.ok) {
        s.stop(`蒲公英发布成功 ${pc.green("✓")} 扫码即装`);
      } else {
        s.stop(`蒲公英上传失败: ${r.error}`);
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
  .option("--cwd <dir>", "项目目录", process.cwd())
  .option("--yes", "CI 无人值守豁免确认")
  .option("--dry-run", "只打印计划")
  .option("--json", "结构化输出（stdout 给机器，渲染抑制）")
  .action(async (platform: string, raw: Record<string, unknown>) => {
    const opts = raw as unknown as ReleaseOpts;
    const KNOWN_PLATFORMS = ["android", "harmony", "ios", "windows", "macos", "linux"];
    if (!KNOWN_PLATFORMS.includes(platform)) {
      // 插件适配器可自报平台——仅提示不拒绝
      process.stderr.write(
        `⚠ 平台 "${platform}" 非内置（${KNOWN_PLATFORMS.join(" | ")}）；若你注册了自定义框架适配器则继续\n`,
      );
    }
    setupChannels();
    const {
      host: plugins,
      config,
      extraFrameworks: pluginFrameworks,
    } = await loadPluginHost(opts.cwd);
    const global = loadGlobalConfig();
    // profile 优先级：--profile 旗标 > projects.json 个人选择（applift use）> 项目配置团队默认
    const creds = opts.dryRun
      ? {}
      : resolveProfile(
          loadCredentials(),
          opts.profile ?? resolveProfileFor(opts.cwd, config.profile),
          KNOWN_CREDENTIAL_KEYS,
        );

    const isJson = Boolean((opts as { json?: boolean }).json);
    // 框架探测（RN/Flutter/原生安卓/原生 iOS/原生鸿蒙）
    const framework = detectFrameworkWith(opts.cwd, pluginFrameworks);
    if (!isJson) {
      if (framework)
        p.log.info(
          `框架: ${pc.bold(framework.expoAwareLabel?.(opts.cwd) ?? framework.label)}${pc.dim(` (${framework.id})`)}`,
        );
      else p.log.warn("未识别框架，产物路径请用 --artifact 指定");
    }

    // 产物解析：--artifact > 框架 pattern 自动探测（最新 mtime）
    let artifactPath: string | undefined = opts.artifact ? path.resolve(opts.artifact) : undefined;
    if (!artifactPath) {
      // 优先项目配置 artifacts 覆盖（非标准工程目录），其次框架内置 pattern
      const patterns = config.artifacts?.[platform] ?? framework?.artifactPatterns(platform) ?? [];
      const found = findArtifacts(opts.cwd, patterns);
      artifactPath = found[0];
      if (artifactPath && !isJson) {
        const via = config.artifacts?.[platform]
          ? "项目配置 artifacts"
          : `${framework?.label} 内置 pattern`;
        p.log.info(
          `自动探测产物（${via}）: ${pc.bold(path.basename(artifactPath))} ${pc.dim(artifactPath)}`,
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
        storeIds = registry.all().map((c) => c.id);
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
    const channels: Channel[] = storeIds
      .map((id) => registry.get(id))
      .filter((c): c is Channel => c !== undefined);
    if (channels.length === 0)
      throw new Error(
        `未找到渠道（${storeIds.join(", ")}）。已注册: ${registry
          .all()
          .map((c) => c.id)
          .join(", ")}`,
      );

    // 渠道 target 取值链：stores 渠道配置 > 平台段配置 > 包名自动推导（项目配置 > 自动推导）
    const detected = detectBundleIds(opts.cwd);
    const contexts = new Map<string, ChannelContext>();
    for (const c of channels) {
      contexts.set(
        c.id,
        makeContext(
          c,
          creds,
          resolveChannelTarget(c.id, config, detected),
          artifactPath ?? "",
          opts.note,
          { releaseTime: opts.releaseTime, remark: opts.remark },
        ),
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
          errors[c.id] = (e as Error).message;
          if (!isJson) p.log.warn(`${pc.bold(c.label)}: ${(e as Error).message}`);
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
    const historySink = (e: HistoryEvent) => {
      appendEntry({ ts: Date.now(), cwd: opts.cwd, artifactSha256: artifactSha256(), ...e });
    };
    const pipelineInput = {
      channels,
      contexts,
      concurrency: global.concurrency,
      cwd: opts.cwd,
      confirm: confirmFn,
      plugins,
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
                ref: undefined,
                error: e.stageError,
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
        const last = readEntries({ channel: ch.id }).find((h) => h.action === "stage" && h.ok);
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
            submit: summary.submit.map((e) => ({
              channel: e.channel,
              ok: e.ok,
              error: e.submitError ?? e.stageError,
            })),
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
    // 错误码翻译：从渠道实例自带的 errorHints 取（平台内聚）
    const hints = e.channel ? registry.get(e.channel)?.errorHints : undefined;
    const err = raw ? humanizeError(hints, raw) : raw;
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
    const framework = detectFramework(cmdOpts.cwd);
    p.intro(pc.bgBlue(pc.black(" applift doctor ")));
    if (framework) p.log.success(`框架识别: ${pc.bold(framework.label)}`);
    else p.log.error("框架识别失败（目录结构不符合任何已知框架）");
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
    const creds = loadCredentials();
    const profileNames = Object.keys(creds.profiles);
    if (profileNames.length > 0)
      p.log.success(`凭据 profiles: ${pc.bold(profileNames.join(", "))}`);
    else p.log.error("无凭据（~/.applift/credentials.toml）");
    if (profileNames.length === 0) healthy = false;
    const { config } = await loadProjectConfig(cmdOpts.cwd);
    // 与 release 同链解析：projects.json 个人选择（applift use）> 项目配置团队默认
    const profile = resolveProfileFor(cmdOpts.cwd, config.profile);
    const stores = Object.keys(config.android?.stores ?? {});
    if (stores.length > 0) p.log.success(`项目渠道: ${stores.join(", ")}（profile=${profile}）`);
    else p.log.info("项目未配置渠道（applift.config.ts → android.stores）");
    // 逐渠道凭据核对（llms.txt 承诺的「凭据缺失清单」）
    const activeProfile = creds.profiles[profile];
    if (stores.length > 0) {
      if (!activeProfile) {
        p.log.error(
          `凭据 profile "${profile}" 不存在（可用: ${profileNames.join(", ") || "无"}；个人可 applift use 切换）`,
        );
        healthy = false;
      } else {
        for (const id of stores) {
          const need = REQUIRED_KEYS_BY_CHANNEL[id];
          if (!need) continue;
          const missing = need.filter((k) => !k.includes(" 或 ") && !activeProfile[k]);
          if (missing.length > 0) {
            p.log.error(
              `${pc.bold(id)}: 缺凭据 ${missing.join(", ")} — ${CHANNEL_HINTS[id] ?? ""}`,
            );
            healthy = false;
          } else {
            p.log.success(`${id}: 凭据齐全`);
          }
        }
      }
    }
    // 产物版本读取（.hap pack.info / .apk aapt；.ipa 不支持自动读）
    if (framework) {
      for (const plat of ["android", "harmony", "ios"] as const) {
        const patterns = config.artifacts?.[plat] ?? framework.artifactPatterns(plat);
        const found = findArtifacts(cmdOpts.cwd, patterns)[0];
        if (found) {
          const v = readArtifactVersion(found);
          p.log.info(
            `产物 ${plat}: ${pc.bold(path.basename(found))}${v ? `（${v.versionName ?? "?"} build ${v.versionCode ?? "?"}，读自 ${v.source}）` : pc.dim("（版本自动读取不支持该格式）")}`,
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
import { REQUIRED_KEYS_BY_CHANNEL, CHANNEL_HINTS } from "./channel-meta.js";

/** 环境变量兼容的裸键名全集（渠道凭据键展开） */
const KNOWN_CREDENTIAL_KEYS = [
  ...new Set(
    Object.values(REQUIRED_KEYS_BY_CHANNEL)
      .flat()
      .flatMap((k) => k.split(" 或 ")),
  ),
];
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
