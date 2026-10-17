/**
 * git 只读/写小助手（bump 编排与推断共用）。
 * spawnSync + 超时；失败返回 ok:false 由调用方决定语义，不在此抛。
 */
import { spawnSync } from "node:child_process";
import semver from "semver";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export function git(cwd: string, args: string[]): GitResult {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 60_000 });
  return {
    ok: !r.error && r.status === 0,
    stdout: (r.stdout ?? "").trim(),
    stderr: ((r.stderr ?? "") as string).trim(),
  };
}

export function isGitRepo(cwd: string): boolean {
  return git(cwd, ["rev-parse", "--is-inside-work-tree"]).stdout === "true";
}

/** 宽松 semver 解析（可选 v/前缀，如 v4.1.0 / 4.1.0-beta.3 / release-4.1.0 里取 semver 部分） */
export function looseSemver(tag: string): string | undefined {
  const direct = semver.valid(tag);
  if (direct) return direct;
  // 尾缀/前缀形态：app-v4.1.0、release-4.1.0、v4.1.0-rc1 → 抓第一个 semver 形态子串
  const m = /(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/.exec(tag);
  return m ? (semver.valid(m[1]) ?? undefined) : undefined;
}

/**
 * 最新 semver tag（按版本序取最大，非创建时间——修复补打旧版本 tag 的场景更稳）。
 * 无 tag / 非 git 仓库返回 undefined。
 */
export function latestSemverTag(cwd: string): string | undefined {
  const r = git(cwd, ["tag", "-l"]);
  if (!r.ok) return undefined;
  let best: { raw: string; v: string } | undefined;
  for (const raw of r.stdout.split("\n")) {
    const t = raw.trim();
    if (!t) continue;
    const v = looseSemver(t);
    if (!v) continue;
    if (!best || semver.gt(v, best.v)) best = { raw: t, v };
  }
  return best?.raw;
}

/** 锚点 tag..HEAD 的完整 commit messages（%B 含 footer，NUL 分隔——body 内建换行安全） */
export function commitsSince(cwd: string, ref?: string): string[] {
  const range = ref ? `${ref}..HEAD` : "HEAD";
  const r = git(cwd, ["log", range, "--format=%B%x00", "--no-merges"]);
  if (!r.ok) return [];
  return r.stdout
    .split("\u0000")
    .map((m) => m.trim())
    .filter(Boolean);
}
/** 工作区状态（--porcelain）。注意：不走通用 git()——其 stdout.trim() 会剥掉首行前导空格，
 *  破坏 porcelain 的两列状态位（" M file" → "M file"），此处保留原始行仅去行尾。 */
export function statusShort(cwd: string): string[] {
  const r = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", timeout: 30_000 });
  if (r.error || r.status !== 0) return [];
  return (r.stdout ?? "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean);
}
