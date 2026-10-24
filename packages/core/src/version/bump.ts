/**
 * bump 编排闭环：决定版本（显式 > git 推断 > patch 兜底）→ 写工程文件 →
 * CHANGELOG → git commit（只 add 版本文件+CHANGELOG，不卷入无关变更）→ git tag。
 * plan/apply 两段分离，中间由 CLI 插入用户确认（core 不碰交互）。
 */
import type { VersionCodeConfig } from "../config/schema.js";

import path from "node:path";
import fs from "node:fs";
import semver from "semver";
import type { FrameworkAdapter } from "../framework.js";
import {
  commitsSince,
  git,
  isGitRepo,
  latestVersionAnchor,
  statusShort,
  type VersionAnchor,
} from "./git.js";
import { decideNextVersion, inferBumpLevel, storeVersionName, type InferResult } from "./infer.js";
import { renderChangelogSection, toChangelogEntries, upsertChangelog } from "./changelog.js";
import { evalVersionCodeFormula, nextVersionCode } from "./version-code.js";
import {
  readProjectVersions,
  writeProjectVersions,
  type PlatformVersionInfo,
  type VersionWrite,
} from "./project.js";

export interface BumpOptions {
  cwd: string;
  framework: FrameworkAdapter | null;
  /** major | minor | patch | prerelease | <semver>；缺省走推断 */
  level?: string;
  /** prerelease 标识（beta | rc…） */
  pre?: string;
  versionCode?: VersionCodeConfig;
  /** 仅限端（缺省全端）；平台名 = android/ios/harmony/flutter/js/tauri/expo */
  platforms?: string[];
}

export interface BumpPlan {
  /** 版本声明锚点（tag=已交付 / bump commit=已声明未交付，取新者）；首次无锚点 */
  anchor?: VersionAnchor;
  /** 疑似失败重跑（HEAD 是 release commit 且锚点后无新业务提交）——CLI 在 --yes 且无显式 level 时拒绝 */
  suspectRerun?: boolean;
  /** 基线版本（多端中最大 semver） */
  base: string;
  currentVersions: PlatformVersionInfo[];
  /** 完整 semver（tag/changelog 用，可含 prerelease） */
  nextVersion: string;
  /** 商店 versionName（三段数字，工程文件用） */
  storeName: string;
  reason: string;
  infer?: InferResult;
  commits: string[];
  writes: VersionWrite[];
  versionCodeNote: string;
}

/** 多端 versionName 的基线：取 semver 合法值中最大；全部非法 → null（需显式指定） */
function baselineVersion(currents: PlatformVersionInfo[]): string | null {
  let best: string | null = null;
  for (const c of currents) {
    const v = semver.valid(c.versionName ?? "");
    if (v && (!best || semver.gt(v, best))) best = v;
  }
  return best;
}

/** 并发 bump 互斥锁（O_EXCL 原子创建；>10 分钟视为陈旧自动接管） */
function acquireBumpLock(cwd: string): (() => void) | Error {
  const lockPath = path.join(cwd, ".git", "applift-bump.lock");
  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.closeSync(fd);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "EEXIST") throw e;
    // 陈旧锁（进程被杀未释放）：>10 分钟自动接管
    try {
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (age > 10 * 60 * 1000) {
        fs.writeFileSync(lockPath, String(process.pid));
      } else {
        return new Error(
          `另一 bump 进程正在运行（${lockPath}）——并发 bump 会产出内容错位的提交，稍后重试或确认无并发后删除锁文件`,
        );
      }
    } catch {
      return new Error(`无法获取 bump 锁（${lockPath}）`);
    }
  }
  return () => {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // 已被清理则忽略
    }
  };
}
/** HEAD 提交是否是我们打的 release commit（失败重跑识别用） */
function lastCommitIsRelease(cwd: string): boolean {
  return git(cwd, ["log", "-1", "--format=%s"]).stdout.startsWith("chore(release): ");
}
export function planBump(opts: BumpOptions): BumpPlan {
  let anchor: VersionAnchor | undefined;
  let commits: string[] = [];
  let infer: InferResult | undefined;
  if (isGitRepo(opts.cwd)) {
    anchor = latestVersionAnchor(opts.cwd) ?? undefined;
    if (anchor) {
      // 无锚点不做全量历史推断（设计定稿：无锚点 → patch 兜底并明示）
      commits = commitsSince(opts.cwd, anchor.ref);
      if (commits.length > 0) infer = inferBumpLevel(commits);
    }
  }

  const currents = readProjectVersions(opts.cwd, opts.framework).filter(
    (c) =>
      ((c.versionName || c.versionCode) && !opts.platforms) || opts.platforms?.includes(c.platform),
  );
  // 基线:工程 versionName 恒三段数字,prerelease 状态只在 tag(v4.1.0-beta.0)——
  // 锚点是 prerelease 时基线取 tag(递进/转正式的语义基线),否则取 max(各端文件, tag)
  const anchorVersion = anchor?.version;
  const anchorIsPre = anchorVersion ? semver.prerelease(anchorVersion) !== null : false;
  const base = anchorIsPre
    ? anchorVersion!
    : baselineVersion([
        ...currents,
        ...(anchorVersion
          ? [{ platform: "__tag__", versionName: anchorVersion } as PlatformVersionInfo]
          : []),
      ]);

  if (!base) {
    if (!opts.level || !semver.valid(opts.level)) {
      throw new Error(
        `各端均无可解析的 semver versionName（${currents.map((c) => `${c.platform}=${c.versionName ?? "?"}`).join(" ")}）：显式指定目标版本，如 applift version bump 4.0.0`,
      );
    }
  }

  const decided = decideNextVersion(base ?? "0.0.0", { level: opts.level, pre: opts.pre }, infer);
  // 无锚点（首次）：patch 兜底需明示，不能默认吞掉（决定链红线「不静默」）
  if (!anchor && !opts.level)
    decided.reason = "无发版锚点（首次 bump）→ patch 兜底；首个 bump commit 或 tag 后激活 git 推断";
  // 疑似失败重跑：HEAD 是 release commit 且锚点后没有非 release 提交（覆盖构建失败/tag 打完/
  // commit 失败后残留 tag 等形态）——再 bump 会静默烧掉一个版本号
  const suspectRerun =
    !!anchor &&
    lastCommitIsRelease(opts.cwd) &&
    commits.every((c) => c.startsWith("chore(release): "));
  if (suspectRerun)
    decided.reason +=
      "；⚠ 锚点后无新业务提交且 HEAD 已是 release commit——疑似失败重跑，建议不带 --bump 重跑复用已 bump 版本";

  // versionCode per platform：max(公式值, 现值+1)
  const formulaCfg =
    opts.versionCode && opts.versionCode !== "increment" ? opts.versionCode : undefined;
  // --platform 与实际端无交集（拼写错误）→ 拒绝：静默空 bump 会打出无文件承载的 tag，版本链错位
  if (opts.platforms && opts.platforms.length > 0) {
    const known = new Set(currents.map((c) => c.platform));
    const unknown = opts.platforms.filter((p) => !known.has(p));
    if (unknown.length > 0)
      throw new Error(`未知平台: ${unknown.join(", ")}（可用: ${[...known].join("/") || "无"}）`);
  }
  const writes: VersionWrite[] = [];
  let formulaNote = "递增 +1";
  let formulaApplied = false;
  const resetCodes: string[] = [];
  for (const c of currents) {
    if (opts.platforms && !opts.platforms.includes(c.platform)) continue;
    const cur =
      c.versionCode !== undefined && /^\d+$/.test(c.versionCode)
        ? Number(c.versionCode)
        : undefined;
    if (c.versionCode !== undefined && cur === undefined)
      resetCodes.push(`${c.platform}=${c.versionCode}`);
    let formulaValue: number | undefined;
    if (formulaCfg && (!formulaCfg.platforms || formulaCfg.platforms.includes(c.platform))) {
      const v = new semver.SemVer(decided.next);
      formulaValue = evalVersionCodeFormula(formulaCfg.formula, {
        major: v.major,
        minor: v.minor,
        patch: v.patch,
      });
      if (formulaValue === undefined)
        throw new Error(
          `versionCode 公式无法求值：${formulaCfg.formula}（仅支持 + - * ( ) 与 major/minor/patch）`,
        );
      formulaNote = `max(公式 ${formulaCfg.formula}, 现值+1)`;
      formulaApplied = true;
    }
    const code = nextVersionCode(cur, formulaValue);
    // Google Play 上限 2100000000（全渠道最严）：溢出在 bump 时报，不留到构建/提审才炸
    if (code > 2_100_000_000)
      throw new Error(
        `versionCode ${code} 超过商店上限 2100000000（${c.platform}）：检查公式或手动规范化`,
      );
    writes.push({
      platform: c.platform,
      versionName: storeVersionName(decided.next),
      versionCode: code,
    });
  }
  // 公式配置存在但一次都没命中（platforms 名字对不上/端不存在）→ 显式警告，防静默全端 +1
  if (formulaCfg && !formulaApplied && writes.length > 0)
    formulaNote += `；⚠ 公式 ${formulaCfg.formula} 未命中任何端${
      formulaCfg.platforms
        ? `（platforms: ${formulaCfg.platforms.join("/")}，可用端: ${writes.map((w) => w.platform).join("/")})`
        : ""
    }——全部端走 +1 兜底`;
  if (resetCodes.length > 0)
    formulaNote += `；⚠ 非数字 versionCode 已从 1 重新起号（${resetCodes.join(", ")}）——商店单调性可能拒绝，建议配置 version.versionCode 公式或手动规范化`;
  return {
    anchor,
    currentVersions: currents,
    writes,
    base: base ?? decided.next,
    nextVersion: decided.next,
    storeName: storeVersionName(decided.next),
    reason: decided.reason,
    infer,
    commits,
    suspectRerun,
    versionCodeNote: formulaNote,
  };
}

export interface ApplyOptions {
  /** 代 commit（CLI 默认开；--no-commit 跳过） */
  commit: boolean;
  /** 代打 tag（CLI 默认不打——tag 是交付标记，归 release 提审成功后补；--tag 显式开） */
  tag: boolean;
}

export interface ApplyResult {
  changedFiles: string[];
  skipped: Array<{ platform: string; reason: string }>;
  changelogFile?: string;
  committed: boolean;
  tagged: boolean;
  /** commit/tag 失败原因（降级不阻断：文件已写好，提示用户手动收尾） */
  warnings: string[];
}

export function applyBump(
  cwd: string,
  plan: BumpPlan,
  framework: FrameworkAdapter | null,
  opts: ApplyOptions,
): ApplyResult {
  // 并发互斥：同工程双 bump 会互相污染基线/提交（对抗审查第四轮实测）
  const lock = isGitRepo(cwd) ? acquireBumpLock(cwd) : undefined;
  if (lock instanceof Error) throw lock;
  try {
    const { changed, skipped } = writeProjectVersions(cwd, framework, plan.writes);
    // 写入零产出（含读取期整端被丢弃的 catalog/无键形态）→ 阻断：打出无工程文件承载的 tag 会让版本链错位
    if (plan.writes.length === 0)
      throw new Error(
        `没有可写入的端（读取期被丢弃或 --platform 过滤为空）——不生成 release commit/tag；catalog 引用形态需先改造为字面量`,
      );
    if (plan.writes.length > 0 && changed.length === 0 && skipped.length > 0)
      throw new Error(
        `所有端的版本写入均被跳过：${skipped.map((s) => `${s.platform}(${s.reason})`).join("；")}——不生成 release commit/tag`,
      );
    if (plan.writes.length > 0 && changed.length === 0 && skipped.length === 0) {
      // 全部已是目标版本（如 commit 失败后同 plan 重入）：不算失败，继续走 changelog/commit/tag 补全
    }
    const warnings: string[] = [];

    // 脏工作区护栏：commit 前检查计划外脏项（版本文件自身改动除外）——
    // 防止手工 WIP 混入 chore(release) 提交随 --follow-tags 推走
    if (opts.commit && isGitRepo(cwd)) {
      const staging = new Set(
        [...changed, `${cwd}/CHANGELOG.md`].map((f) => path.relative(cwd, f) || f),
      );
      const dirty = statusShort(cwd).filter((line) => {
        const f = line.slice(3).split(" -> ").pop()!.trim().replace(/\/$/, ""); // XY <path>（重命名取目标）
        // porcelain 对未跟踪目录只给目录名（?? android/）——staging 文件位于其下即视为我们的产物
        return ![...staging].some((s) => s === f || s.startsWith(`${f}/`));
      });
      if (dirty.length > 0)
        throw new Error(
          `工作区有计划外未提交变更，拒绝代 commit（防混入 release 提交）：\n${dirty.join("\n")}\n先提交它们或移出工作区（.gitignore），或用 --no-commit`,
        );
    }

    const entries = toChangelogEntries(plan.commits);
    const changelogFile = upsertChangelog(
      cwd,
      plan.nextVersion,
      renderChangelogSection(plan.nextVersion, new Date().toISOString().slice(0, 10), entries),
    );
    const changedFiles = [...new Set([...changed, changelogFile])];

    let committed = false;
    let tagged = false;
    if (opts.commit || opts.tag) {
      if (!isGitRepo(cwd)) {
        warnings.push("非 git 仓库：跳过 commit/tag");
      } else {
        const files = changedFiles.map((f) => path.relative(cwd, f) || f);
        if (opts.commit) {
          const add = git(cwd, ["add", "--", ...files]);
          const commit = add.ok
            ? git(cwd, ["commit", "-m", `chore(release): ${plan.nextVersion}`, "--", ...files])
            : add;
          if (commit.ok) committed = true;
          else warnings.push(`git commit 失败：${commit.stderr || commit.stdout || "未知错误"}`);
        }
        // tag 只在 commit 成功（或本就 --no-commit）后打：commit 失败时 tag 会指向不含版本变更的旧树
        if (opts.tag && (!opts.commit || committed)) {
          const tag = git(cwd, ["tag", `v${plan.nextVersion}`]);
          if (tag.ok) tagged = true;
          else warnings.push(`git tag 失败：${tag.stderr || tag.stdout || "未知错误"}`);
        }
      }
    }
    return { changedFiles, skipped, changelogFile, committed, tagged, warnings };
  } finally {
    lock?.();
  }
}
