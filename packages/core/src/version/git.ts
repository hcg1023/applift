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

/** 版本声明锚点：tag（已交付）或 bump commit（已声明未交付），判定与推断共用 */
export interface VersionAnchor {
  /** 可直接传给 git diff / git log 的 ref（tag 名或 commit sha） */
  ref: string;
  /** tag = 已交付；bump = 已声明未交付（chore(release): commit） */
  kind: "tag" | "bump";
  /** 从 tag 名 / commit message 解析的 semver（解析失败缺省） */
  version?: string;
  /** 展示用："v4.0.0（已发布）" / "4.1.0（已声明未发布）" */
  label: string;
}

/** 单个候选提交（tag 或 bump commit）的解析结果 */
interface AnchorCandidate {
  ref: string;
  kind: "tag" | "bump";
  version?: string;
  sha: string;
  /** committer time（秒）——rebase 会重排 author date，committer time 才代表分支上的实际顺序 */
  time: number;
}

/**
 * 最新 `chore(release):` 声明提交（applyBump 的产物；squash-merge 会丢标记，见 AGENTS.md 已知边界）。
 * 只认 **subject**：git --grep 的 `^` 是行锚定、作用于整条 message 含 body——release-note 风格的
 * body 行（"chore(release): 4.1.0 included below"）会劫持锚点，把更早的原生改动挤出判定窗口
 * （对抗审查 P1 实证）。故取最近若干条提交的 subject 在本侧匹配。
 */
function latestBumpCommitCandidate(cwd: string): AnchorCandidate | undefined {
  const r = git(cwd, ["log", "-n", "200", "--format=%H%x00%ct%x00%s"]);
  if (!r.ok || !r.stdout) return undefined;
  for (const line of r.stdout.split("\n")) {
    const [sha, time, subject] = line.split("\u0000");
    if (!sha || !time || !subject || !/^\d+$/.test(time)) continue;
    if (!subject.startsWith("chore(release): ")) continue;
    return {
      ref: sha,
      kind: "bump",
      version: looseSemver(subject),
      sha,
      time: Number(time),
    };
  }
  return undefined;
}

/**
 * 版本声明锚点：最新 semver tag 的提交 vs 最新 `chore(release):` 提交，按 committer time 取新者。
 * - tag 新（已交付）→ kind=tag（判定 diff 从交付点起算）
 * - bump commit 新（声明后未交付）→ kind=bump（bump 写入的版本文件不计入判定 diff，
 *   否则去 tag 化后每次 beta 都会把自己写的版本文件误判为原生改动、连环烧版本号）
 * - 同一提交（旧形态 bump+tag 一步完成）→ 优先 tag（交付态是更强事实）
 * - committer time 同秒平局 → 拓扑序决胜（bump 是 tag 的后代则声明在交付后 → bump 胜）——
 *   秒级精度不足时不依赖时序运气
 * 无 tag 且无 bump commit / 非 git 仓库 → null。
 */
export function latestVersionAnchor(cwd: string): VersionAnchor | null {
  if (!isGitRepo(cwd)) return null;
  let tagC: AnchorCandidate | undefined;
  const tag = latestSemverTag(cwd);
  if (tag) {
    const r = git(cwd, ["log", "-1", "--format=%H%x00%ct", tag]);
    const [sha, time] = r.ok ? r.stdout.split("\u0000") : [];
    if (sha && time && /^\d+$/.test(time))
      tagC = { ref: tag, kind: "tag", version: looseSemver(tag), sha, time: Number(time) };
  }
  const bumpC = latestBumpCommitCandidate(cwd);
  let winner: AnchorCandidate | undefined;
  if (!tagC) winner = bumpC;
  else if (!bumpC) winner = tagC;
  else if (bumpC.sha === tagC.sha) winner = tagC; // 同一提交：交付态（tag）是更强事实
  else if (bumpC.time !== tagC.time) winner = bumpC.time > tagC.time ? bumpC : tagC;
  else winner = git(cwd, ["merge-base", "--is-ancestor", tagC.sha, bumpC.sha]).ok ? bumpC : tagC;
  if (!winner) return null;
  return winner.kind === "tag"
    ? {
        ref: winner.ref,
        kind: "tag",
        version: winner.version,
        label: `v${winner.version}（已发布）`, // latestSemverTag 只返回可解析 tag，version 恒存在
      }
    : {
        ref: winner.ref,
        kind: "bump",
        version: winner.version,
        label: winner.version
          ? `${winner.version}（已声明未发布）`
          : `bump ${winner.sha.slice(0, 8)}（已声明未发布）`,
      };
}

/** 锚点 tag..HEAD 的完整 commit messages（%B 含 footer，NUL 分隔——body 内建换行安全） */
export function commitsSince(cwd: string, ref: string): string[] {
  const range = `${ref}..HEAD`;
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

export interface TagResult {
  tagged: boolean;
  reason?: string;
  /** tag 已存在但指向不同 commit（疑似历史提前 tag / 驳回重提后未移动）——调用方应告警而非静默跳过 */
  conflict?: boolean;
}

/**
 * release 分发成功后补 tag（tag = 交付封板标记；bump 只声明不打 tag，见 AGENTS.md 版本语义）。
 * - tag 已存在且指向 HEAD（多端发布，前一端已打）→ 跳过
 * - tag 已存在但指向不同 commit → conflict 告警（历史提前 tag / 驳回重提未移动 / 多端错峰发布）
 * - dryRun / 无版本 / 非 git 仓库 → 不动、不炸（tag 失败不阻断发布主流程）
 */
export function tagReleaseVersion(
  cwd: string,
  version: string | undefined,
  opts: { dryRun?: boolean } = {},
): TagResult {
  if (!version) return { tagged: false, reason: "无版本" };
  if (opts.dryRun) return { tagged: false, reason: "dry-run" };
  const tag = `v${version}`;
  const exists = spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], {
    cwd,
    encoding: "utf8",
  });
  if (exists.status === 0) {
    const tagCommit = git(cwd, ["rev-parse", `refs/tags/${tag}^{commit}`]).stdout;
    const head = git(cwd, ["rev-parse", "HEAD"]).stdout;
    if (tagCommit && tagCommit === head)
      return { tagged: false, reason: `tag ${tag} 已存在（前一端已发布）` };
    return {
      tagged: false,
      conflict: true,
      reason: `tag ${tag} 已存在但指向 ${tagCommit.slice(0, 8) || "?"} ≠ 当前 HEAD ${
        head.slice(0, 8) || "?"
      }——可能原因：①历史提前 tag ②驳回重提后未移动（这两种且 tag 未 push 时可 git tag -d 后重打）③多端错峰发布（前一端已在较早提交交付，HEAD 已前进，属正常形态，勿动 tag）。请人工确认`,
    };
  }
  const r = spawnSync("git", ["tag", tag], { cwd, encoding: "utf8" });
  if (r.status !== 0) return { tagged: false, reason: `tag ${tag} 创建失败：${r.stderr.trim()}` };
  return { tagged: true };
}
