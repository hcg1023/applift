/**
 * 凭据与配置装载：文件定位、profile 解析、0600 权限。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parse as parseToml } from "smol-toml";
import {
  CredentialsFileSchema,
  GlobalConfigSchema,
  type CredentialsFile,
  type GlobalConfig,
} from "./schema.js";

export const APPLIFT_HOME = process.env.APPLIFT_HOME || path.join(os.homedir(), ".applift");
export const CREDENTIALS_PATH = path.join(APPLIFT_HOME, "credentials.json");
export const GLOBAL_CONFIG_PATH = path.join(APPLIFT_HOME, "config.toml");

/** 项目级凭据目录（<project>/.applift/credentials.json；gitignore 由用户决定：私有仓可提交，公开仓 ignore） */
export function projectCredentialsPath(projectRoot: string): string {
  return path.join(projectRoot, ".applift", "credentials.json");
}

/** 从 startDir 逐层向上找第一个存在的路径（monorepo 子包向上借用根配置/凭据）；找不到返回 null */
export function findUp(startDir: string, relative: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, relative);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * 逐级凭据加载：项目 <root>/.applift/credentials.json（就近，逐键优先）→ 全局 ~/.applift/（逐键回退）。
 * 场景：私有仓提交凭据进仓库；或公开仓 .applift/ 进 gitignore 由成员各自维护。
 * profile 合并：项目同名 profile 逐键覆盖全局；仅全局有则用全局。
 */
export function loadCredentialsLayered(
  projectRoot?: string,
  globalPath = CREDENTIALS_PATH,
): CredentialsFile {
  const global = loadCredentials(globalPath);
  if (!projectRoot) return global;
  const localPath = findUp(projectRoot, path.join(".applift", "credentials.json"));
  if (!localPath) return global;
  const local = loadCredentials(localPath);
  const merged: Record<string, Record<string, string>> = {};
  for (const [name, kv] of Object.entries(global.profiles)) merged[name] = { ...kv };
  for (const [name, kv] of Object.entries(local.profiles))
    merged[name] = { ...merged[name], ...kv };
  return CredentialsFileSchema.parse({ profiles: merged });
}

const EMPTY_CREDENTIALS: CredentialsFile = { profiles: {} };

/** 读取并校验 credentials.json；不存在返回空 profiles；强制 0600 */
export function loadCredentials(filePath = CREDENTIALS_PATH): CredentialsFile {
  if (!fs.existsSync(filePath)) {
    return EMPTY_CREDENTIALS;
  }
  const stat = fs.statSync(filePath);
  if (stat.mode & 0o077) {
    // 修复过宽权限（首次从旧 .publish_env 迁移等场景）
    fs.chmodSync(filePath, 0o600);
  }
  const raw: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return CredentialsFileSchema.parse(raw);
}

/** 按项目 profile 取凭据；profile 不存在时报错并列出可用 profiles。
 * 环境变量覆盖（CI 场景）：APPLIFT_<KEY> 前缀优先（如 APPLIFT_PGYER_API_KEY）；
 * knownKeys 提供时其裸键名（如 PGYER_API_KEY）也认（向后兼容），未提供的裸大写键不捡（避免误吸无关变量）。
 */
export function resolveProfile(
  creds: CredentialsFile,
  profile: string,
  knownKeys?: string[],
): Record<string, string> {
  const p = creds.profiles[profile];
  if (!p) {
    const available = Object.keys(creds.profiles).join(", ") || "(无)";
    throw new Error(`凭据 profile "${profile}" 不存在（${CREDENTIALS_PATH}）。可用: ${available}`);
  }
  const merged: Record<string, string> = { ...p };
  if (knownKeys) {
    for (const key of knownKeys) {
      if (process.env[key]) merged[key] = process.env[key]!;
    }
  }
  for (const [envName, value] of Object.entries(process.env)) {
    if (envName.startsWith("APPLIFT_") && value) {
      merged[envName.slice("APPLIFT_".length)] = value;
    }
  }
  return merged;
}

/** 全局配置装载（缺失/损坏降级默认值并警告，不阻断） */
export function loadGlobalConfig(filePath = GLOBAL_CONFIG_PATH): GlobalConfig {
  if (!fs.existsSync(filePath)) return GlobalConfigSchema.parse({});
  try {
    return GlobalConfigSchema.parse(parseToml(fs.readFileSync(filePath, "utf8")));
  } catch (e) {
    process.stderr.write?.(`[applift] 全局配置解析失败，使用默认值: ${(e as Error).message}\n`);
    return GlobalConfigSchema.parse({});
  }
}

/** 写凭据（目录自动创建，文件强制 0600） */
export function saveCredentials(data: CredentialsFile, filePath = CREDENTIALS_PATH): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}
