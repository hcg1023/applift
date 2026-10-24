/**
 * bump 编排全链路（临时 git 仓库 + RN 夹具）：plan 推断 → apply 写文件/CHANGELOG/commit/tag →
 * 再 plan 锚点前移。顺带覆盖 git.ts 的 tag 发现与 log 切片。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { applyBump, planBump } from "./bump.js";
import { latestSemverTag, looseSemver } from "./git.js";
import { readProjectVersions } from "./project.js";
import { rnAdapter } from "../plugins/frameworks.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-bump-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function sh(cmd: string) {
  execSync(cmd, { cwd: dir, stdio: "pipe" });
}

function setup() {
  fs.mkdirSync(path.join(dir, "android", "app"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "android", "app", "build.gradle"),
    `android { defaultConfig { versionCode 4000; versionName "4.0.0" } }\n`,
  );
  fs.mkdirSync(path.join(dir, "harmony", "AppScope"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "harmony", "AppScope", "app.json5"),
    `{\n  "app": { "versionCode": 4000000, "versionName": "4.0.0" }\n}\n`,
  );
  fs.writeFileSync(path.join(dir, "package.json"), `{"name":"a","version":"4.0.0"}\n`);
  sh("git init -q");
  sh("git config user.email t@t && git config user.name t");
  sh("git add -A && git commit -qm 'feat: 初始功能'");
  sh("git commit -q --allow-empty -m 'fix: 修一个问题'");
}

describe("looseSemver / latestSemverTag", () => {
  it("宽松识别 v 前缀与前后缀形态；非 semver 忽略", () => {
    expect(looseSemver("v4.1.0")).toBe("4.1.0");
    // 数字段超长（semver 拒收）→ 正则命中但校验失败 → undefined
    expect(looseSemver("v99999999999999999999.0.0")).toBeUndefined();
    expect(looseSemver("release-4.1.0")).toBe("4.1.0");
    expect(looseSemver("not-a-version")).toBeUndefined();
  });
});

describe("planBump → applyBump 全链路", () => {
  it("feat+fix 推断 minor → 写三端 + CHANGELOG + commit + tag → 再 plan 锚点前移", () => {
    setup();
    // 首次无 tag：不推断（设计定稿）——patch 兜底且 reason 明示
    const first = planBump({ cwd: dir, framework: rnAdapter });
    expect(first.infer).toBeUndefined();
    expect(first.nextVersion).toBe("4.0.1");
    expect(first.reason).toMatch(/无发版锚点.*patch 兜底/);
    // 打锚点后：feat+fix 区间 → minor（tag 打在首个提交上，区间内补 feat）
    sh("git tag v4.0.0 HEAD~1");
    sh("git commit -q --allow-empty -m 'feat: 区间内功能'");
    const plan = planBump({ cwd: dir, framework: rnAdapter });
    expect(plan.infer).toMatchObject({ level: "minor", feat: 1, fix: 1 });
    expect(plan.nextVersion).toBe("4.1.0");
    expect(plan.writes).toContainEqual({
      platform: "android",
      versionName: "4.1.0",
      versionCode: 4001,
    });
    expect(plan.writes).toContainEqual({
      platform: "harmony",
      versionName: "4.1.0",
      versionCode: 4000001,
    });
    expect(plan.writes).toContainEqual({ platform: "js", versionName: "4.1.0", versionCode: 1 }); // package.json 无 versionCode 字段 → 占位 1（写回只用 versionName）

    const applied = applyBump(dir, plan, rnAdapter, { commit: true, tag: true });
    expect(applied.committed).toBe(true);
    expect(applied.tagged).toBe(true);
    expect(applied.warnings).toHaveLength(0);

    // 三端文件已更新
    const after = readProjectVersions(dir, rnAdapter);
    expect(after.find((v) => v.platform === "harmony")).toMatchObject({
      versionName: "4.1.0",
      versionCode: "4000001",
    });
    // CHANGELOG 生成且含 feat 条目
    const log = fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");
    expect(log).toContain("## [4.1.0]");
    expect(log).toContain("- feat: 区间内功能");
    // commit 范围精确锁定：只有版本文件 + CHANGELOG——预埋 WIP 文件验证未被卷入
    fs.writeFileSync(path.join(dir, "wip.txt"), "uncommitted work");
    const commitFiles = execSync("git show --name-only --format=", { cwd: dir, encoding: "utf8" })
      .trim()
      .split("\n")
      .sort();
    expect(commitFiles).toEqual([
      "CHANGELOG.md",
      "android/app/build.gradle",
      "harmony/AppScope/app.json5",
      "package.json",
    ]);
    expect(execSync("git status --porcelain", { cwd: dir, encoding: "utf8" })).toContain(
      "?? wip.txt",
    );
    // tag 存在
    expect(latestSemverTag(dir)).toBe("v4.1.0");

    // 锚点前移：新提交为空 → patch 兜底；版本基线是 4.1.0
    sh("git commit -q --allow-empty -m 'chore: something'");
    const plan2 = planBump({ cwd: dir, framework: rnAdapter });
    expect(plan2.anchor).toMatchObject({ ref: "v4.1.0", kind: "tag" });
    expect(plan2.infer).toMatchObject({ level: "patch", total: 1, feat: 0, fix: 0 }); // 推断确实执行且数对提交
  }, 90_000);

  it("level=prerelease：基线已是 prerelease → 递进 beta.1；否则报错引导 --pre", () => {
    setup();
    // 非 prerelease 基线：明确拒绝（不静默给 -0），引导 --pre 或显式版本
    expect(() => planBump({ cwd: dir, framework: rnAdapter, level: "prerelease" })).toThrow(
      /不是 prerelease/,
    );
    // 基线 4.1.0-beta.0 → prerelease 递进 4.1.0-beta.1
    fs.writeFileSync(path.join(dir, "package.json"), `{"name":"a","version":"4.1.0-beta.0"}\n`);
    const plan = planBump({ cwd: dir, framework: rnAdapter, level: "prerelease" });
    expect(plan.nextVersion).toBe("4.1.0-beta.1");
  }, 30_000);

  it("基线含非 semver 端 → 跳过该端取其余有效最大值", () => {
    setup();
    fs.writeFileSync(path.join(dir, "package.json"), `{"name":"a","version":"not-semver"}\n`);
    const plan = planBump({ cwd: dir, framework: rnAdapter, level: "patch" });
    expect(plan.base).toBe("4.0.0"); // js 端无效不参与基线，gradle 4.0.0 兜底
    expect(plan.writes.find((w) => w.platform === "js")?.versionName).toBe("4.0.1");
  }, 30_000);

  it("全部端无 semver 且无显式 level → 明确报错（不猜）", () => {
    setup();
    fs.writeFileSync(path.join(dir, "package.json"), `{"name":"a","version":"???"}\n`);
    fs.writeFileSync(
      path.join(dir, "android", "app", "build.gradle"),
      `android { defaultConfig { versionName "garbage" } }\n`,
    );
    fs.writeFileSync(
      path.join(dir, "harmony", "AppScope", "app.json5"),
      `{\n  "app": { "versionName": "garbage" }\n}\n`,
    );
    expect(() => planBump({ cwd: dir, framework: rnAdapter })).toThrow(/各端均无可解析的 semver/);
  }, 30_000);

  it("--platform 混入未知名 → 拒绝（防静默空 bump 打出无承载 tag）", () => {
    setup();
    expect(() =>
      planBump({
        cwd: dir,
        framework: rnAdapter,
        level: "patch",
        platforms: ["android", "winphone"],
      }),
    ).toThrow(/未知平台: winphone/);
  }, 30_000);

  it("versionCode 公式超商店上限 → bump 时即报（不留到构建/提审）", () => {
    setup();
    expect(() =>
      planBump({
        cwd: dir,
        framework: rnAdapter,
        level: "patch",
        versionCode: { formula: "major*9999999999" },
      }),
    ).toThrow(/2100000000/);
  }, 30_000);

  it("--pre beta：4.0.0 → 4.1.0-beta.0（tag 带 prerelease，工程 versionName 仍三段）", () => {
    setup();
    const plan = planBump({ cwd: dir, framework: rnAdapter, level: "minor", pre: "beta" });
    expect(plan.nextVersion).toBe("4.1.0-beta.0");
    expect(plan.storeName).toBe("4.1.0"); // 商店域不写 prerelease
    const applied = applyBump(dir, plan, rnAdapter, { commit: true, tag: true });
    expect(applied.tagged).toBe(true);
    expect(latestSemverTag(dir)).toBe("v4.1.0-beta.0");
    const after = readProjectVersions(dir, rnAdapter);
    expect(after.find((v) => v.platform === "js")?.versionName).toBe("4.1.0");
  }, 90_000);

  it("非 git 目录：写文件与 CHANGELOG 正常，commit/tag 降级警告", () => {
    setup();
    fs.rmSync(path.join(dir, ".git"), { recursive: true });
    const plan = planBump({ cwd: dir, framework: rnAdapter });
    const applied = applyBump(dir, plan, rnAdapter, { commit: true, tag: true });
    expect(applied.committed).toBe(false);
    expect(applied.warnings[0]).toMatch(/git/);
    expect(applied.changedFiles.length).toBeGreaterThan(0);
  });
});
