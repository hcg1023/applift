/**
 * 项目 → profile 本地映射（~/.applift/projects.json，形状 { [绝对项目路径]: profile }）。
 * 个人选择不进项目文件/git —— `applift use` 写这里。
 * 生效优先级（高 → 低）：--profile 旗标（调用方覆盖）> projects.json 个人选择 > 项目配置 profile 字段（团队默认）> 'default' 全局默认。
 */
import fs from "node:fs";
import path from "node:path";
import { APPLIFT_HOME } from "./loader.js";

export const PROJECTS_MAP_PATH = path.join(APPLIFT_HOME, "projects.json");

/** 读取映射；不存在/损坏 JSON/顶层非对象/值非字符串 → {}（个人偏好缺失或损坏不阻断发版） */
export function loadProjectProfileMap(filePath = PROJECTS_MAP_PATH): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && v.length > 0) map[k] = v;
    }
    return map;
  } catch {
    return {};
  }
}

/** 覆盖写整个映射（目录自动创建；非凭据，无敏感值，默认权限即可） */
export function saveProjectProfileMap(
  map: Record<string, string>,
  filePath = PROJECTS_MAP_PATH,
): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(map, null, 2)}\n`);
}

/** 记录某项目使用的 profile（键统一绝对路径；合并保留其他项目的条目） */
export function setProjectProfile(
  cwd: string,
  profile: string,
  filePath = PROJECTS_MAP_PATH,
): void {
  const map = loadProjectProfileMap(filePath);
  map[path.resolve(cwd)] = profile;
  saveProjectProfileMap(map, filePath);
}

/**
 * 解析项目生效 profile：projects.json 个人选择 > 项目配置 profile（团队默认）> 'default' 全局默认。
 * CLI 的 --profile 旗标在调用方以 `opts.profile ?? resolveProfileFor(...)` 再盖一层（最高优先级）。
 */
export function resolveProfileFor(
  cwd: string,
  projectCfgProfile?: string,
  filePath = PROJECTS_MAP_PATH,
): string {
  const mapped = loadProjectProfileMap(filePath)[path.resolve(cwd)];
  if (mapped) return mapped;
  return projectCfgProfile || "default";
}
