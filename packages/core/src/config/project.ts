/**
 * 项目配置装载：c12（社区主流）加载 applift.config.ts。
 * c12 负责：TS 配置文件执行、缺省值、多源合并 —— 非自研。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig as c12Load } from "c12";
import { findUp } from "./loader.js";
import { createJiti } from "jiti";
import { ProjectConfigSchema, type ProjectConfig } from "./schema.js";
import type { QypubUserConfig } from "../plugin.js";

/**
 * 裸工程兼容：applift.config.ts 里的 `@applift/core` / `@applift/cli` 导入按目标工程解析会
 * 找不到包（工程未安装依赖）——jiti 别名统一指到 CLI 进程自带的那份 core 入口，
 * 使 `import { defineConfig } from "@applift/cli"`（或 @applift/core）在任何工程可用。
 */
function appliftAlias(): Record<string, string> {
  try {
    // import.meta.resolve 走 ESM import 条件（core 的 exports 仅含 import），拿真实入口文件路径
    const coreEntry = fileURLToPath(import.meta.resolve("@applift/core"));
    return { "@applift/core": coreEntry, "@applift/cli": coreEntry };
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
  raw: QypubUserConfig;
  /** 配置文件所在目录（解析相对路径用），无配置文件时为 cwd */
  cwd: string;
}

export async function loadProjectConfig(cwd: string): Promise<LoadedProjectConfig> {
  // 配置文件逐层向上（monorepo 子包可借用根配置）；未找到时用原 cwd（走 defaults）
  const cfgPath = findUp(cwd, "applift.config.ts");
  const cfgDir = cfgPath ? path.dirname(cfgPath) : cwd;
  // 方案 B″（实验定稿）：bun 下 jiti 的 tryNative 默认启用——bun 原生加载 .ts 零转换（实测 compile 二进制内生效）；
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
  const config = ProjectConfigSchema.parse(result.config ?? {});
  return { config, raw: result.config ?? {}, cwd: result.cwd ?? cwd };
}
