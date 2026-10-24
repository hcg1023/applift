import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { tagReleaseVersion } from "./git.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-tag-"));
  const g = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  g(["init", "-q"]);
  g(["config", "user.email", "t@t"]);
  g(["config", "user.name", "t"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "x");
  g(["add", "-A"]);
  g(["commit", "-qm", "init"]);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("tagReleaseVersion（release 成功后补 tag：tag = 实际已发布版本）", () => {
  it("无 tag 时创建 v{version}", () => {
    const r = tagReleaseVersion(dir, "4.0.1");
    expect(r.tagged).toBe(true);
    expect(spawnSync("git", ["tag", "-l"], { cwd: dir, encoding: "utf8" }).stdout).toContain(
      "v4.0.1",
    );
  });

  it("tag 已存在（前一端已发布）→ 跳过不报错", () => {
    spawnSync("git", ["tag", "v4.0.1"], { cwd: dir });
    const r = tagReleaseVersion(dir, "4.0.1");
    expect(r.tagged).toBe(false);
    expect(r.reason).toContain("已存在");
  });

  it("tag 已存在但指向不同 commit → conflict（历史提前 tag / 驳回重提未移动）", () => {
    spawnSync("git", ["tag", "v4.0.1"], { cwd: dir });
    fs.writeFileSync(path.join(dir, "b.txt"), "y");
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["commit", "-qm", "fix: after"], { cwd: dir });
    const r = tagReleaseVersion(dir, "4.0.1");
    expect(r.tagged).toBe(false);
    expect(r.conflict).toBe(true);
    expect(r.reason).toContain("≠");
    expect(r.reason).toContain("请人工确认");
    expect(r.reason).toContain("错峰"); // 多端错峰发布是 conflict 的第三种合法原因（勿动 tag）
  });

  it("dryRun / 无版本 → 不动 git", () => {
    expect(tagReleaseVersion(dir, "4.0.1", { dryRun: true }).tagged).toBe(false);
    expect(tagReleaseVersion(dir, undefined).tagged).toBe(false);
    expect(spawnSync("git", ["tag", "-l"], { cwd: dir, encoding: "utf8" }).stdout).not.toContain(
      "v4",
    );
  });

  it("非 git 目录 → 不炸，标注失败原因（tag 失败不阻断发布）", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "applift-nogit-"));
    try {
      const r = tagReleaseVersion(plain, "4.0.1");
      expect(r.tagged).toBe(false);
      expect(r.reason).toBeTruthy();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});
