/**
 * 业务流程测试：版本生命周期全周期（core 层，真 git 仓库 + RN 夹具）。
 * 场景 = 团队真实节奏：功能开发 → beta 内测（多次）→ 修复 → 转正式 → 下一循环；
 * 外加公式版 versionCode 的完整单调链（设计文档的演算表逐行落地）。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import { execSync } from "node:child_process";
import path from "node:path";
import { applyBump, planBump } from "./bump.js";
import type { VersionCodeConfig } from "../config/schema.js";
import { readProjectVersions } from "./project.js";
import { rnAdapter } from "../plugins/frameworks.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-cycle-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function sh(cmd: string) {
  execSync(cmd, { cwd: dir, stdio: "pipe" });
}
function commit(msg: string) {
  sh(`git commit -q --allow-empty -m ${JSON.stringify(msg)}`);
}
function harmonyCode(): number {
  return Number(
    readProjectVersions(dir, rnAdapter).find((v) => v.platform === "harmony")!.versionCode,
  );
}
function tagName(): string {
  return execSync("git describe --tags --abbrev=0", { cwd: dir, encoding: "utf8" }).trim();
}
function cycle(
  level: string | undefined,
  opts?: { pre?: string; versionCode?: VersionCodeConfig },
) {
  const plan = planBump({
    cwd: dir,
    framework: rnAdapter,
    level,
    pre: opts?.pre,
    versionCode: opts?.versionCode,
  });
  const applied = applyBump(dir, plan, rnAdapter, { commit: true, tag: true });
  expect(applied.warnings).toHaveLength(0);
  return plan;
}

function setupRn(formula?: VersionCodeConfig) {
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
  sh("git init -q && git config user.email t@t && git config user.name t");
  commit("chore: init");
  return formula;
}

describe("业务周期：开发 → beta 内测 → 修复 → 转正式 → 下一循环", () => {
  it("完整走完四阶段，tag 与 versionCode 全程单调", () => {
    setupRn();

    // 阶段 1：功能开发（feat）→ 进入 beta（minor + pre）
    commit("feat: 行程模块");
    cycle("minor", { pre: "beta" });
    expect(tagName()).toBe("v4.1.0-beta.0");
    expect(harmonyCode()).toBe(4000001); // 公式未配 → +1

    // 阶段 2：内测反馈再修 → beta.1 → beta.2（prerelease 递进，versionName 不变）
    commit("fix: 内测崩溃");
    cycle("prerelease");
    expect(tagName()).toBe("v4.1.0-beta.1");
    cycle("prerelease");
    expect(tagName()).toBe("v4.1.0-beta.2");
    expect(harmonyCode()).toBe(4000003);

    // 阶段 3：转正式（patch 剥离 prerelease）；CHANGELOG 三段版本各自成段
    cycle("patch");
    expect(tagName()).toBe("v4.1.0");
    expect(harmonyCode()).toBe(4000004);
    const log = fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");
    for (const v of ["4.1.0-beta.0", "4.1.0-beta.1", "4.1.0-beta.2", "4.1.0"]) {
      expect(log).toContain(`## [${v}]`);
    }
    // 三端 versionName 已同步 4.1.0
    for (const v of readProjectVersions(dir, rnAdapter)) {
      if (v.versionName) expect(v.versionName).toBe("4.1.0");
    }

    // 阶段 4：下一循环 feat → minor（锚点 v4.1.0，versionCode +1 链继续）
    commit("feat: 下一个大功能");
    const plan = cycle(undefined); // 无 level：git 推断
    expect(plan.reason).toMatch(/minor/);
    expect(plan.nextVersion).toBe("4.2.0");
    expect(plan.anchorTag).toBe("v4.1.0");
    expect(harmonyCode()).toBe(4000005);

    // 提交历史：5 个 release commit（beta.0/.1/.2 + 4.1.0 + 4.2.0）全部规范
    const logs = execSync("git log --format=%s", { cwd: dir, encoding: "utf8" }).trim().split("\n");
    expect(logs.filter((l) => l.startsWith("chore(release):"))).toHaveLength(5);
  }, 120_000);
});

describe("业务周期：公式版 versionCode（公式按目标版本位编码）", () => {
  it("4.0.0(4000000) → beta×3 → 正式 → 4.2.0(公式接管 4020000)", () => {
    setupRn();
    const formula: VersionCodeConfig = {
      formula: "major*1000000+minor*1000+patch",
      platforms: ["harmony"],
    };

    cycle("minor", { pre: "beta", versionCode: formula });
    // next=4.1.0-beta.0:公式按 4.1.0 算 = 4001000 > 现值+1(4000001) → 公式接管
    expect(harmonyCode()).toBe(4001000);
    cycle("prerelease", { versionCode: formula });
    expect(harmonyCode()).toBe(4001001); // 公式追平 → +1 兜底
    cycle("prerelease", { versionCode: formula });
    expect(harmonyCode()).toBe(4001002);
    cycle("patch", { versionCode: formula });
    expect(harmonyCode()).toBe(4001003); // 正式 4.1.0 = beta 序列继续 +1
    expect(tagName()).toBe("v4.1.0");

    // 下一循环:feat → minor → 4.2.0,公式 4002000 重新接管
    commit("feat: big");
    cycle(undefined, { versionCode: formula });
    expect(harmonyCode()).toBe(4002000);
    expect(tagName()).toBe("v4.2.0");

    // android 不在公式 platforms → 恒 +1 链
    const android = Number(
      readProjectVersions(dir, rnAdapter).find((v) => v.platform === "android")!.versionCode,
    );
    expect(android).toBe(4005);
  }, 30_000);
});
