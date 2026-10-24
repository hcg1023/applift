/**
 * latestVersionAnchor（版本声明锚点）契约测试：tag / bump commit 双候选取新者。
 * 语义背景（bump-semantics，2026-10-24）：bump 去掉 tag 后，「多次 beta 不重复 bump」
 * 不能再依赖 tag 推进锚点——锚点改为 tag（已交付）与 chore(release): commit（已声明未交付）
 * 按 committer time 取新者，否则 bump 写入的版本文件会被判为原生改动、连环烧版本号。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { latestVersionAnchor } from "./git.js";
import { compareDeclared } from "./infer.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-anchor-"));
  const g = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "x");
  g(["add", "-A"]);
  g(["commit", "-qm", "init"]);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function commit(msg: string): void {
  fs.writeFileSync(path.join(dir, `${msg.replace(/\W+/g, "_")}.txt`), msg);
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-qm", msg], { cwd: dir });
}

describe("latestVersionAnchor（tag vs bump commit 取新者）", () => {
  it("只有 tag → kind=tag（已交付）", () => {
    spawnSync("git", ["tag", "v4.0.0"], { cwd: dir });
    const a = latestVersionAnchor(dir);
    expect(a).toMatchObject({ ref: "v4.0.0", kind: "tag", version: "4.0.0" });
    expect(a?.label).toContain("已发布");
  });

  it("只有 bump commit → kind=bump（已声明未交付），version 从 message 解析", () => {
    commit("feat: something");
    commit("chore(release): 4.1.0");
    const a = latestVersionAnchor(dir);
    expect(a?.kind).toBe("bump");
    expect(a?.version).toBe("4.1.0");
    expect(a?.label).toContain("已声明未发布");
    // ref 是 sha（可直接给 git diff）
    expect(a?.ref).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it("tag 与 bump commit 并存：bump 更新 → 锚点推进到声明点（去 tag 化的核心保障）", () => {
    spawnSync("git", ["tag", "v4.0.0"], { cwd: dir });
    commit("feat: next iteration");
    commit("chore(release): 4.1.0");
    expect(latestVersionAnchor(dir)).toMatchObject({ kind: "bump", version: "4.1.0" });
  });

  it("tag 比 bump commit 更新（release 交付后）→ 锚点回到 tag", () => {
    commit("chore(release): 4.1.0");
    commit("fix: review fix");
    spawnSync("git", ["tag", "v4.1.0"], { cwd: dir });
    expect(latestVersionAnchor(dir)).toMatchObject({ kind: "tag", version: "4.1.0" });
  });

  it("同一提交（旧形态 bump+tag 一步完成）→ 优先 tag（交付态是更强事实）", () => {
    commit("chore(release): 4.1.0");
    spawnSync("git", ["tag", "v4.1.0"], { cwd: dir });
    expect(latestVersionAnchor(dir)).toMatchObject({ kind: "tag", version: "4.1.0" });
  });

  it("body 行携带 chore(release): 不构成锚点（只认 subject，防 release-note body 劫持判定窗口）", () => {
    // 劫持形态：subject 是 docs，body 有一行以 chore(release): 开头（git --grep 的 ^ 是行锚定会误命中）
    const g = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    fs.writeFileSync(path.join(dir, "notes.md"), "x");
    g(["add", "-A"]);
    g(["commit", "-qm", "docs: release notes\n\nchore(release): 4.1.0 included below\n"]);
    expect(latestVersionAnchor(dir)).toBeNull(); // 无 tag、无真实声明 → null
    // 真实声明在其后 → 锚点是真实 bump commit（版本可解析），不是 docs 提交
    commit("chore(release): 4.1.0");
    expect(latestVersionAnchor(dir)).toMatchObject({ kind: "bump", version: "4.1.0" });
  });

  it("committer time 同秒平局：bump 是 tag 的后代 → bump 胜（拓扑序决胜，不依赖时序运气）", () => {
    const at = (args: string[]) =>
      spawnSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_COMMITTER_DATE: "1700000000 +0800",
          GIT_AUTHOR_DATE: "1700000000 +0800",
        },
      });
    // 全部提交固定同一 committer 秒：tag 提交与 bump 提交 time 相同，只能靠拓扑序分胜负
    fs.writeFileSync(path.join(dir, "a.txt"), "1");
    at(["add", "-A"]);
    at(["commit", "-qm", "feat: init"]);
    at(["tag", "v4.0.0"]);
    fs.writeFileSync(path.join(dir, "b.txt"), "2");
    at(["add", "-A"]);
    at(["commit", "-qm", "feat: native"]);
    fs.writeFileSync(path.join(dir, "c.txt"), "3");
    at(["add", "-A"]);
    at(["commit", "-qm", "chore(release): 4.1.0"]);
    expect(latestVersionAnchor(dir)).toMatchObject({ kind: "bump", version: "4.1.0" });
  });

  it("committer time 同秒平局：tag 在 bump 之后（非其祖先）→ tag 胜（拓扑序双向）", () => {
    const at = (args: string[]) =>
      spawnSync("git", args, {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_COMMITTER_DATE: "1700000000 +0800",
          GIT_AUTHOR_DATE: "1700000000 +0800",
        },
      });
    // 全部同一 committer 秒：先声明（无 tag），再交付打 tag 在更新的提交上
    fs.writeFileSync(path.join(dir, "a.txt"), "1");
    at(["add", "-A"]);
    at(["commit", "-qm", "feat: init"]);
    fs.writeFileSync(path.join(dir, "b.txt"), "2");
    at(["add", "-A"]);
    at(["commit", "-qm", "chore(release): 4.1.0"]);
    fs.writeFileSync(path.join(dir, "c.txt"), "3");
    at(["add", "-A"]);
    at(["commit", "-qm", "fix: review fix"]);
    at(["tag", "v4.1.0"]); // tag 在 bump 的后代上：交付比声明新 → tag 胜
    expect(latestVersionAnchor(dir)).toMatchObject({ kind: "tag", version: "4.1.0" });
  });

  it("声明提交 subject 无可解析版本（手工 chore(release)）→ 仍是 bump 锚点，label 退化为 sha", () => {
    commit("chore(release): 手动归档");
    const a = latestVersionAnchor(dir);
    expect(a?.kind).toBe("bump");
    expect(a?.version).toBeUndefined();
    expect(a?.label).toMatch(/^bump [0-9a-f]{8}（已声明未发布）$/);
  });

  it("空 subject 提交（--allow-empty-message）不构成锚点（守卫跳过，不炸）", () => {
    const g = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    g(["commit", "-q", "--allow-empty", "--allow-empty-message", "-m", ""]);
    commit("chore(release): 4.1.0"); // 其后的真实声明才是锚点
    expect(latestVersionAnchor(dir)).toMatchObject({ kind: "bump", version: "4.1.0" });
  });

  it("刚 init 无任何提交的仓库 → 锚点 null（git log 失败守卫，不炸）", () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "applift-unborn-"));
    try {
      spawnSync("git", ["init", "-q"], { cwd: fresh });
      expect(latestVersionAnchor(fresh)).toBeNull();
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("releasedTag 非 semver（无法解析）→ 视同未发布：合法工程版本即已声明", () => {
    expect(compareDeclared("4.1.0", "not-a-semver-tag")).toBe("ahead");
  });

  it("非 chore(release) 的提交不构成锚点；无 tag 无 bump → null", () => {
    commit("feat: just a feature");
    expect(latestVersionAnchor(dir)).toBeNull();
  });

  it("非 git 目录 → null（不炸）", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "applift-nogit-"));
    try {
      expect(latestVersionAnchor(plain)).toBeNull();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("compareDeclared（三态判定核心比较）", () => {
  it("工程版本领先发布 tag → ahead（已声明未发布）", () => {
    expect(compareDeclared("4.1.0", "v4.0.0")).toBe("ahead");
  });

  it("持平 / 落后 → not-ahead（需 bump）", () => {
    expect(compareDeclared("4.0.0", "v4.0.0")).toBe("not-ahead");
    expect(compareDeclared("3.9.0", "v4.0.0")).toBe("not-ahead");
  });

  it("prerelease 工程版本：同版本 prerelease 视为未领先（not-ahead），更高版本 prerelease 视为领先", () => {
    // semver 语义：4.1.0-beta.1 < 4.1.0（prerelease 低于对应正式版）
    expect(compareDeclared("4.1.0-beta.1", "v4.1.0")).toBe("not-ahead");
    expect(compareDeclared("4.2.0-rc.0", "v4.1.0")).toBe("ahead");
  });

  it("从未发布（无 tag）→ 任何合法工程版本都算已声明", () => {
    expect(compareDeclared("1.0.0", undefined)).toBe("ahead");
  });

  it("工程版本非 semver / 缺失 → unknown（调用方告警并按需 bump 处理）", () => {
    expect(compareDeclared("4.0.0.100", "v4.0.0")).toBe("unknown");
    expect(compareDeclared(undefined, "v4.0.0")).toBe("unknown");
    expect(compareDeclared(undefined, undefined)).toBe("unknown");
  });
});
