/**
 * 版本推断与决定：锚点 tag..HEAD 的 conventional commits → bump level（纯函数），
 * 版本演进全用 semver（inc / prerelease 剥离），不自写版本数学。
 * 纯函数输入 git log 文本，便于契约测试；git 交互在 git.ts。
 */
import { CommitParser, type Commit } from "conventional-commits-parser";
import semver from "semver";

export type BumpLevel = "major" | "minor" | "patch";

export interface InferResult {
  level: BumpLevel;
  /** 展示用判定说明（中文，CLI 直接输出） */
  reason: string;
  total: number;
  breaking: number;
  feat: number;
  fix: number;
}

/** conventional commits → bump level：BREAKING > feat(minor) > fix(patch)；无可识别提交 → patch */
export function inferBumpLevel(messages: string[]): InferResult {
  let breaking = 0;
  let feat = 0;
  let fix = 0;
  const parser = new CommitParser();
  for (const raw of messages) {
    let c: Commit | null = null;
    try {
      c = parser.parse(raw);
    } catch {
      continue; // 解析失败按无关提交计
    }
    if (!c) continue;
    const type = (c.type ?? "").toLowerCase();
    // BREAKING 只认 footer（parser notes，含 `type!:` 语法的自动转换）——
    // header 子串匹配会把 "fix: avoid breaking the bank" 误判成 major
    if ((c.notes ?? []).some((n) => /breaking/i.test(n.title ?? ""))) breaking++;
    else if (type === "feat") feat++;
    else if (type === "fix") fix++;
  }
  const total = messages.length;
  let level: BumpLevel;
  let reason: string;
  if (breaking > 0) {
    level = "major";
    reason = `git 推断：${breaking} 个 BREAKING CHANGE → major`;
  } else if (feat > 0) {
    level = "minor";
    reason = `git 推断：feat ${feat} 个（fix ${fix} 个）→ minor`;
  } else if (fix > 0) {
    level = "patch";
    reason = `git 推断：fix ${fix} 个，无 feat/BREAKING → patch`;
  } else {
    level = "patch";
    reason =
      total === 0
        ? "锚点 tag..HEAD 无提交 → patch 兜底"
        : `git 推断：${total} 个提交无 feat/fix/BREAKING（chore/docs 等）→ patch 兜底`;
  }
  return { level, reason, total, breaking, feat, fix };
}

export interface DecideOptions {
  /** 显式 level：major | minor | patch | prerelease */
  level?: string;
  /** prerelease 标识（beta | rc…），与 level 组合或延续当前 */
  pre?: string;
}

export interface DecideResult {
  /** 完整 semver（可含 prerelease，tag 与 changelog 用） */
  next: string;
  /** 判定说明 */
  reason: string;
}

/**
 * 从当前版本决定下一版本（纯函数）。
 * - 显式 level：semver.inc；当前是 prerelease 且不带 --pre → 剥离转正式（4.0.0-beta.3 + patch → 4.0.0）
 * - 无 level：用 infer 结果
 * - prerelease level：当前有 pre → 同基线递进（beta.3 → beta.4）；无 pre → 报错（应使用 --pre 进入）
 * - --pre：从 level 出发挂 prerelease（4.0.0 + minor + beta → 4.1.0-beta.1）
 * current 非 semver 时抛错（调用方要求显式指定或先手动规范化）。
 */
export function decideNextVersion(
  current: string,
  opts: DecideOptions,
  infer?: InferResult,
): DecideResult {
  const base = semver.valid(current);
  if (!base) {
    throw new Error(
      `当前版本 "${current}" 不是合法 semver（如前导零 3.0.08）：显式指定目标版本（bump 4.0.0）或先手动规范化`,
    );
  }
  const level = opts.level;
  if (level && !["major", "minor", "patch", "prerelease"].includes(level)) {
    // 非保留字 → 当作显式 semver
    const explicit = semver.valid(level);
    if (!explicit) throw new Error(`无法识别的版本/级别 "${level}"`);
    if (!semver.gt(explicit, base)) throw new Error(`目标版本 ${explicit} 必须大于当前 ${base}`);
    return { next: explicit, reason: "显式指定" };
  }

  const hasPre = semver.prerelease(base) !== null;
  const preId = opts.pre ?? (semver.prerelease(base)?.[0] as string | undefined);

  if (level === "prerelease") {
    if (hasPre) {
      const next = preId ? semver.inc(base, "prerelease", preId) : semver.inc(base, "prerelease");
      if (!next) throw new Error(`prerelease 递进失败：${base}`);
      return { next, reason: `prerelease 递进（${base} → ${next}）` };
    }
    throw new Error(
      `当前 ${base} 不是 prerelease：用 --pre beta（进入 beta.1）或显式版本（bump 4.1.0-beta.1）`,
    );
  }

  const effectiveLevel = (level ?? infer?.level ?? "patch") as BumpLevel;
  const reasonPrefix = level ? `显式 ${level}` : infer ? infer.reason : "无依据 → patch 兜底";
  if (opts.pre) {
    const next = semver.inc(
      base,
      `pre${effectiveLevel}` as "premajor" | "preminor" | "prepatch",
      opts.pre,
    );
    if (!next) throw new Error(`pre${effectiveLevel} 计算失败：${base}`);
    return { next, reason: `${reasonPrefix} + prerelease(${opts.pre})` };
  }
  const next = semver.inc(base, effectiveLevel);
  if (!next) throw new Error(`${effectiveLevel} 递进失败：${base}`);
  return { next, reason: reasonPrefix };
}

/** 工程文件写入用的三段数字 versionName（prerelease 只留在 tag，不进商店） */
export function storeVersionName(full: string): string {
  const v = new semver.SemVer(full);
  return `${v.major}.${v.minor}.${v.patch}`;
}
