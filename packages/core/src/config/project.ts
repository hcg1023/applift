/**
 * 项目配置装载：c12（社区主流）加载 applift.config.ts。
 * c12 负责：TS 配置文件执行、缺省值、多源合并 —— 非自研。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig as c12Load } from "c12";
import { findUp } from "./loader.js";
import { createJiti } from "jiti";
import { ProjectConfigSchema, type ProjectConfig } from "./schema.js";
import type { AppliftUserConfig } from "../plugin.js";

/**
 * 裸工程兼容：applift.config.ts 里的 `@applift/core` / `@applift/cli` 导入按目标工程解析会
 * 找不到包（工程未安装依赖）——jiti 别名统一指到 CLI 进程自带的那份 core 入口，
 * 使 `import { defineConfig } from "@applift/cli"`（或 @applift/core）在任何工程可用。
 */
function appliftAlias(): Record<string, string> {
  try {
    // import.meta.resolve 走 ESM import 条件（core 的 exports 仅含 import），按 exports 拿 dist 入口
    const distEntry = fileURLToPath(import.meta.resolve("@applift/core"));
    // 仓库内跑测试时 dist 可能尚未构建（CI 先 test 后 build）——回退 src 入口，jiti 原生加载 TS
    const coreEntry = fs.existsSync(distEntry)
      ? distEntry
      : path.join(path.dirname(path.dirname(distEntry)), "src", "index.ts");
    if (!fs.existsSync(coreEntry)) return {};
    const alias: Record<string, string> = {
      "@applift/core": coreEntry,
      "@applift/cli": coreEntry,
    };
    // 子路径导出（@applift/core/plugins）需显式映射：jiti 的包名别名不展开子路径
    // （会拼到入口文件后成 dist/index.mjs/plugins，模块找不到）
    try {
      const distPlugins = fileURLToPath(import.meta.resolve("@applift/core/plugins"));
      const pluginsEntry = fs.existsSync(distPlugins)
        ? distPlugins
        : path.join(path.dirname(coreEntry), "plugins", "index.ts");
      if (fs.existsSync(pluginsEntry)) {
        alias["@applift/core/plugins"] = pluginsEntry;
        alias["@applift/cli/plugins"] = pluginsEntry;
      }
    } catch {
      // 无 plugins 子路径导出（老版本布局）——仅主路径别名
    }
    return alias;
  } catch {
    return {}; // 解析失败（非预期布局）时退回目标工程自然解析
  }
}

export interface LoadedProjectConfig {
  config: ProjectConfig;
  /**
   * c12 原始配置（保留 plugins 等 schema 外键）——插件发现（resolvePlugins）用；
   * 业务字段一律以 config（zod 解析后）为准。
   */
  raw: AppliftUserConfig;
  /** 配置文件所在目录（解析相对路径用），无配置文件时为 cwd */
  cwd: string;
}

export async function loadProjectConfig(cwd: string): Promise<LoadedProjectConfig> {
  // 配置文件逐层向上（monorepo 子包可借用根配置）；未找到时用原 cwd（走 defaults）
  const cfgPath = findUp(cwd, "applift.config.ts");
  const cfgDir = cfgPath ? path.dirname(cfgPath) : cwd;
  // 方案 B″（实验定稿）：bun 下 jiti 的 tryNative 默认启用——bun 原生加载 .ts 零转换；
  // 注入 Bun.Transpiler 仅作原生路径失败时的 transform 兜底（tryNative 成功时不会被调用），消除 babel 外部文件隐患。
  // Node 运行时：不注入——c12 默认 jiti 路径，babel.cjs 在真实 node_modules 内无坑。
  type BunGlobal = {
    Transpiler: new (o: { loader: string }) => { transformSync: (code: string) => string };
  };
  const bunRuntime = (globalThis as { Bun?: BunGlobal }).Bun;
  const alias = appliftAlias();
  const jitiInstance = bunRuntime
    ? createJiti(import.meta.url, {
        alias,
        transform: (opts: { source: string; ts?: boolean }) => ({
          code: new bunRuntime.Transpiler({ loader: "ts" }).transformSync(opts.source),
        }),
      })
    : Object.keys(alias).length
      ? createJiti(import.meta.url, { alias })
      : undefined;
  const result = await c12Load<ProjectConfig>({
    name: "applift",
    cwd: cfgDir,
    ...(jitiInstance ? { jiti: jitiInstance } : {}),
    configFile: "applift.config",
    rcFile: false,
    packageJson: false,
    defaults: ProjectConfigSchema.parse({}),
  });
  const raw = result.config ?? {};
  const parsed = ProjectConfigSchema.safeParse(raw);
  if (!parsed.success) {
    // 人话化 zod issues：原始 JSON 数组对 CLI 用户不可读
    const details = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(根)"}: ${i.message}`)
      .join("；");
    throw new Error(`applift.config.ts 字段校验失败 → ${details}`);
  }
  const config = parsed.data;
  // 已删除配置键的迁移警告：zod 默认剥离未知键，不警告会静默失效（bump 不再执行/构建命令被忽略）
  const rawRec = raw as Record<string, unknown>;
  const deprecated: Array<{ key: string; hint: string }> = [];
  if ("build" in rawRec)
    deprecated.push({ key: "build", hint: "构建已回归项目自身（applift 不接管构建），请删除该键" });
  if ("bump" in ((rawRec.beta as Record<string, unknown>) ?? {}))
    deprecated.push({
      key: "beta.bump",
      hint: "改用 applift version bump 显式升版本（applift 不再代构建）",
    });
  if ("release" in rawRec && "bump" in ((rawRec.release as Record<string, unknown>) ?? {}))
    deprecated.push({
      key: "release.bump",
      hint: "改用 applift version bump 显式升版本（applift 不再代构建）",
    });
  if (deprecated.length > 0) {
    const lines = deprecated.map((d) => `  - ${d.key}: ${d.hint}`).join("\n");
    process.stderr.write(`⚠ applift.config.ts 含已废弃配置键（将被忽略）：\n${lines}\n`);
  }
  return { config, raw, cwd: result.cwd ?? cwd };
}
