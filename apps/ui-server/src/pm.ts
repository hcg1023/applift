/**
 * 全局安装的包管理器识别（引导安装 install/update-global 用）：
 * 探测优先级 = env 覆盖（APPLIFT_PM，测试/高级用户逃生口）→ 现有全局 applift 的归属
 * （路径特征——装了哪家用哪家更新，避免双轨）→ 启动环境的 user_agent → 锁文件
 * （package-manager-detector）→ npm 兜底（node 自带，永远存在）。
 * 命令映射：npm/pnpm/bun 直接 add -g；yarn 仅 v1 支持 global（berry 无 global → 降级 npm）。
 */
import { detect } from "package-manager-detector";

export type PmName = "npm" | "pnpm" | "yarn" | "bun";

export interface PmResolution {
  name: PmName;
  /** 探测依据（日志/事件透出，用户可理解为什么用了这个） */
  source: "env" | "global-path" | "user-agent" | "lockfile" | "fallback";
  /** yarn berry 等：识别到了但不支持全局安装 → 实际执行用 fallbackTo 的命令 */
  fallbackTo?: PmName;
  note?: string;
}

/** 现有全局 applift 路径 → 包管理器归属（各家全局目录特征，跨平台子串匹配） */
export function pmFromGlobalPath(path: string): PmName | null {
  const p = path.toLowerCase();
  if (p.includes(".pnpm-global") || p.includes("pnpm/global") || p.includes("pnpm\\global")) {
    return "pnpm";
  }
  if (p.includes(".bun")) return "bun";
  if (p.includes(".yarn") || p.includes("yarn/global")) return "yarn";
  // npm 系全局目录特征：nvm/fnm/volta/npm-global/lib/node_modules（默认前缀 lib/node_modules 归 npm）
  if (
    p.includes("npm-global") ||
    p.includes("node_modules") ||
    p.includes("nvm") ||
    p.includes("fnm") ||
    p.includes("volta")
  ) {
    return "npm";
  }
  return null;
}

/** npm_config_user_agent（启动 ui-server 的 PM 环境）→ 名称（`pnpm/10.1.0 node/v22.1.0 ...`） */
export function pmFromUserAgent(ua: string | undefined): PmName | null {
  if (ua === undefined || ua === "") return null;
  const head = ua.split(/\s+/)[0] ?? "";
  const name = head.split("/")[0]?.toLowerCase();
  if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") return name;
  return null;
}

/** 解析结果 → 实际执行的安装命令（bin + args；yarn berry 不支持 global → 降级 npm 命令） */
export function installCommand(
  res: PmResolution,
  opts: { update?: boolean } = {},
): { bin: string; args: string[] } {
  const spec = opts.update === true ? "@applift/cli@latest" : "@applift/cli";
  const name = res.fallbackTo ?? res.name;
  switch (name) {
    case "pnpm":
      return { bin: "pnpm", args: ["add", "-g", spec] };
    case "bun":
      return { bin: "bun", args: ["add", "-g", spec] };
    case "yarn":
      // yarn v1 才有 global；berry 到这里必经 fallbackTo 降级，此分支只服务 v1
      return { bin: "yarn", args: ["global", "add", spec] };
    default:
      return { bin: "npm", args: ["install", "-g", spec] };
  }
}

/**
 * 全量探测（装配期一次，环境跑服务期间不变）。
 * @param opts.globalAppliftPath 现有全局 applift 的绝对路径（findGlobalApplift 结果）
 * @param opts.cwd 锁文件探测目录（默认 ui-server cwd）
 * @param opts.pathEnv findGlobalApplift 用的 PATH（透传，不在此重复探测）
 */
export async function detectGlobalPackageManager(
  opts: {
    env?: NodeJS.ProcessEnv;
    globalAppliftPath?: string | null;
    cwd?: string;
  } = {},
): Promise<PmResolution> {
  const env = opts.env ?? process.env;
  const override = env.APPLIFT_PM?.trim().toLowerCase();
  if (override === "npm" || override === "pnpm" || override === "yarn" || override === "bun") {
    return { name: override, source: "env" };
  }
  if (opts.globalAppliftPath !== undefined && opts.globalAppliftPath !== null) {
    const byPath = pmFromGlobalPath(opts.globalAppliftPath);
    if (byPath !== null) return { name: byPath, source: "global-path" };
  }
  const byAgent = pmFromUserAgent(env.npm_config_user_agent);
  if (byAgent !== null) {
    // yarn berry 无 global add：识别出 yarn 但无法确认 v1 → 统一降级 npm（提示见 note）
    if (byAgent === "yarn") {
      return {
        name: "yarn",
        source: "user-agent",
        fallbackTo: "npm",
        note: "yarn（berry）不支持全局安装，已降级 npm",
      };
    }
    return { name: byAgent, source: "user-agent" };
  }
  const byLock = await detect({ cwd: opts.cwd ?? process.cwd() });
  if (byLock !== null) {
    if (byLock.name === "yarn") {
      return {
        name: "yarn",
        source: "lockfile",
        fallbackTo: "npm",
        note: "yarn（berry）不支持全局安装，已降级 npm",
      };
    }
    if (byLock.name === "npm" || byLock.name === "pnpm" || byLock.name === "bun") {
      return { name: byLock.name, source: "lockfile" };
    }
  }
  return { name: "npm", source: "fallback" };
}
