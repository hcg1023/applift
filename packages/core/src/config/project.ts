/**
 * 项目配置装载：c12（社区主流）加载 applift.config.ts。
 * c12 负责：TS 配置文件执行、缺省值、多源合并 —— 非自研。
 */
import path from "node:path";
import { loadConfig as c12Load } from "c12";
import { findUp } from "./loader.js";
import { createJiti } from "jiti";
import { ProjectConfigSchema, type ProjectConfig } from "./schema.js";
import type { QypubUserConfig } from "../plugin.js";

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
  const jitiInstance = bunRuntime
    ? createJiti(import.meta.url, {
        transform: (opts: { source: string; ts?: boolean }) => ({
          code: new bunRuntime.Transpiler({ loader: "ts" }).transformSync(opts.source),
        }),
      } as never)
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
