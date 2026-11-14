/**
 * validate 命令：校验目录是否为合法 applift 工程（applift-ui 添加项目的即时校验消费 --json）。
 * 只读探测——不写文件、不注册渠道（deps 形参与 lifecycle/listing 同构，留作未来扩展）。
 */
import * as p from "@clack/prompts";
import pc from "picocolors";
import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import {
  findUp,
  loadProjectConfig,
  resolveFramework,
  resolvePlugins,
  suggestFramework,
  detectBundleIds,
  PluginHost,
  type ChannelRegistry,
  type FrameworkAdapter,
} from "@applift/core";

/** applift-ui 添加项目时消费的机读校验报告（--json 时 stdout 整体即此形态） */
export interface ProjectValidation {
  ok: boolean;
  path: string;
  configFound: boolean; // findUp 命中 applift.config.ts
  name?: string; // config.name
  framework: { id: string; label: string } | null; // 插件注册声明
  suggestedFramework: { id: string; label: string } | null;
  bundleIds: { android?: string; harmony?: string; ios?: string; iosScheme?: string };
  platforms: string[]; // 由 bundleIds 命中端推导
  appliftAvailable: boolean; // 工程依赖里声明了提供 applift 可执行命令的包
  error?: string; // configFound=false 或配置解析失败时的原因
}

/** 工程依赖里可执行 applift 的包（README 安装名 @applift/cli；旧名 applift 兼容）；无 package.json = false */
function detectAppliftAvailable(cwd: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return [
      pkg.dependencies?.["@applift/cli"],
      pkg.devDependencies?.["@applift/cli"],
      pkg.dependencies?.applift,
      pkg.devDependencies?.applift,
    ].some((v) => v !== undefined);
  } catch {
    return false;
  }
}

/** 探测目录：config 缺失/解析失败产出 ok=false 报告（不抛——UI 需要完整形态而非中断） */
export async function validateProject(cwd: string): Promise<ProjectValidation> {
  const dir = path.resolve(cwd);
  const configPath = findUp(dir, "applift.config.ts");
  // monorepo 探测锚定：bundleIds/appliftAvailable 跟 loadProjectConfig 的 cfgDir（config 命中目录），
  // 子包校验按根工程算而非输入子目录（子包无 app.json/package.json 依赖时不再误判）
  const cfgDir = configPath !== null ? path.dirname(configPath) : dir;
  // 探测类字段与 config 无关，缺 config 也照常给（UI 引导 applift init 需要）
  const suggested = suggestFramework(dir);
  const ids = detectBundleIds(cfgDir);
  const platforms = [
    ...(ids.androidPkgName ? ["android"] : []),
    ...(ids.harmonyBundleName ? ["harmony"] : []),
    ...(ids.iosBundleId ? ["ios"] : []),
  ];
  const base = {
    path: dir,
    suggestedFramework: suggested ? { id: suggested.id, label: suggested.label } : null,
    bundleIds: {
      android: ids.androidPkgName,
      harmony: ids.harmonyBundleName,
      ios: ids.iosBundleId,
      iosScheme: ids.iosScheme,
    },
    platforms,
    appliftAvailable: detectAppliftAvailable(cfgDir),
  };
  if (!configPath) {
    return {
      ...base,
      ok: false,
      configFound: false,
      framework: null,
      error: `未找到 applift.config.ts（自 ${dir} 逐级向上均无，非 applift 工程或尚未 applift init）`,
    };
  }
  try {
    const { config, raw } = await loadProjectConfig(dir);
    // 框架声明与 doctor 同链：插件广播注册 → resolveFramework（声明错误降级 null，不阻断报告）
    let framework: FrameworkAdapter | null = null;
    try {
      const registered: FrameworkAdapter[] = [];
      const plugins = resolvePlugins(raw);
      if (plugins.length > 0) {
        await new PluginHost(plugins).broadcast("framework:register", { cwd: dir }, registered);
        framework = resolveFramework(dir, registered);
      }
    } catch {
      framework = null;
    }
    return {
      ...base,
      ok: true,
      configFound: true,
      ...(config.name ? { name: config.name } : {}),
      framework: framework ? { id: framework.id, label: framework.label } : null,
      // 已声明 → 建议字段置空（与 doctor --json 同形）
      suggestedFramework: framework ? null : base.suggestedFramework,
    };
  } catch (e) {
    return { ...base, ok: false, configFound: true, framework: null, error: (e as Error).message };
  }
}

export function registerValidateCommand(
  program: Command,
  _deps: { setup: () => void; registry: ChannelRegistry },
): void {
  program
    .command("validate <path>")
    .description("校验目录是否为 applift 工程（--json 供 UI 消费）")
    .option("--json", "JSON 输出")
    .action(async (target: string, cmdOpts: { json?: boolean }) => {
      const report = await validateProject(target);
      if (cmdOpts.json) {
        // stdout 纯 JSON 契约（与 doctor --json 同写法）：人读渲染全走 stderr 或跳过
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      } else {
        p.intro(pc.bgCyan(pc.black(" applift validate ")));
        if (report.ok) {
          p.log.success(`${pc.bold(report.path)} 是合法 applift 工程`);
          if (report.framework) p.log.info(`框架声明: ${report.framework.label}`);
          if (report.platforms.length > 0) p.log.info(`平台标识: ${report.platforms.join(" / ")}`);
          p.outro("校验通过");
        } else {
          p.log.error(`${report.path} 不是合法 applift 工程`);
          if (report.error) p.log.error(report.error);
          if (report.suggestedFramework)
            p.log.warn(`疑似 ${report.suggestedFramework.label} 工程，可先 applift init 生成配置`);
          p.outro("校验未通过");
        }
      }
      if (!report.ok) process.exitCode = 1;
    });
}
