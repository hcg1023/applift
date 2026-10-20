/**
 * 第四轮对抗审查修复的行为锁定：嵌套 version 键不篡改、commit 失败不打 tag、
 * writes 空拒绝（catalog/无键端读取期丢弃）、expo 幂等、全就位重入。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { applyBump, planBump } from "./bump.js";
import { readProjectVersions, writeProjectVersions } from "./project.js";
import { rnAdapter } from "../plugins/frameworks.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-r4-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function sh(cmd: string) {
  execSync(cmd, { cwd: dir, stdio: "pipe" });
}

describe("嵌套 version 键（依赖声明）不得篡改", () => {
  it("嵌套先于顶层出现：只改顶层，依赖锁不动", () => {
    // 依赖对象在前、顶层 version 在后（第三轮单遍回调在此会双改）
    fs.writeFileSync(
      path.join(dir, "package.json"),
      `{\n  "name": "app",\n  "dependencies": {\n    "foo": {\n      "version": "1.2.3"\n    }\n  },\n  "version": "0.1.0"\n}\n`,
    );
    const vs = readProjectVersions(dir, rnAdapter);
    expect(vs.find((v) => v.platform === "js")?.versionName).toBe("0.1.0"); // 读顶层非嵌套
    const r = writeProjectVersions(dir, rnAdapter, [
      { platform: "js", versionName: "0.2.0", versionCode: 1 },
    ]);
    const after = fs.readFileSync(path.join(dir, "package.json"), "utf8");
    expect(after).toContain('"version": "0.2.0"');
    expect(after).toContain('"version": "1.2.3"'); // 依赖声明原样
    expect(r.changed).toHaveLength(1);
  });

  it("幂等：同参数重跑 changed 空且无 skipped 诬告", () => {
    fs.writeFileSync(path.join(dir, "package.json"), `{"name":"a","version":"1.0.0"}\n`);
    const w = [{ platform: "js", versionName: "1.1.0", versionCode: 1 }] as const;
    writeProjectVersions(dir, rnAdapter, [...w]);
    const again = writeProjectVersions(dir, rnAdapter, [...w]);
    expect(again.changed).toHaveLength(0);
    expect(again.skipped).toHaveLength(0);
  });
});

describe("applyBump 状态护栏", () => {
  it("commit 失败（pre-commit hook 拒绝）→ 不打 tag：tag 不指向旧树", () => {
    fs.mkdirSync(path.join(dir, "android", "app"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "android", "app", "build.gradle"),
      `defaultConfig { versionCode 1; versionName "1.0.0" }\n`,
    );
    sh("git init -q && git config user.email t@t && git config user.name t");
    sh("git add -A && git commit -qm init");
    sh("git tag v1.0.0 HEAD");
    sh(
      "mkdir -p .git/hooks && printf '#!/bin/sh\\nexit 1\\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit",
    );
    const plan = planBump({ cwd: dir, framework: rnAdapter, level: "patch" });
    const applied = applyBump(dir, plan, rnAdapter, { commit: true, tag: true });
    expect(applied.committed).toBe(false);
    expect(applied.tagged).toBe(false); // tag 门控：commit 失败不打
    expect(applied.warnings.join()).toMatch(/git commit 失败/);
    expect(execSync("git tag -l", { cwd: dir, encoding: "utf8" }).trim()).toBe("v1.0.0");
    expect(
      execSync("git show v1.0.0:android/app/build.gradle 2>/dev/null || echo none", {
        cwd: dir,
        encoding: "utf8",
      }),
    ).toContain('versionName "1.0.0"');
  });

  it("全就位重入（同 plan 二次 apply）→ 不误报全跳过，补全 commit+tag", () => {
    fs.writeFileSync(path.join(dir, "package.json"), `{"name":"a","version":"1.0.0"}\n`);
    sh("git init -q && git config user.email t@t && git config user.name t");
    sh("git add -A && git commit -qm init && git tag v1.0.0");
    const plan = planBump({ cwd: dir, framework: rnAdapter, level: "patch" });
    const first = applyBump(dir, plan, rnAdapter, { commit: true, tag: true });
    expect(first.committed).toBe(true);
    // 模拟 commit 成功后中断，同 plan 重入：文件已就位，不得抛"全部写入被跳过"
    const again = applyBump(dir, plan, rnAdapter, { commit: true, tag: true });
    expect(again.warnings.join()).not.toMatch(/所有端的版本写入均被跳过/);
  });

  it("writes 为空（--platform 过滤后无端）→ 拒绝且不打 tag", () => {
    fs.writeFileSync(path.join(dir, "package.json"), `{"name":"a","version":"1.0.0"}\n`);
    sh("git init -q && git config user.email t@t && git config user.name t");
    sh("git add -A && git commit -qm init");
    const plan = planBump({ cwd: dir, framework: rnAdapter, level: "1.0.1", platforms: [] });
    expect(() => applyBump(dir, plan, rnAdapter, { commit: true, tag: true })).toThrow(
      /没有可写入的端/,
    );
    expect(execSync("git tag -l", { cwd: dir, encoding: "utf8" }).trim()).toBe("");
  });

  it("EACCES 只读端 → 直接抛出阻断（不降级 skipped、不打 tag）", () => {
    fs.mkdirSync(path.join(dir, "harmony", "AppScope"), { recursive: true });
    const j5 = path.join(dir, "harmony", "AppScope", "app.json5");
    fs.writeFileSync(j5, `{"app":{"versionCode":1,"versionName":"1.0.0"}}\n`);
    fs.chmodSync(j5, 0o444);
    try {
      const plan = planBump({ cwd: dir, framework: rnAdapter, level: "patch" });
      expect(() => applyBump(dir, plan, rnAdapter, { commit: true, tag: true })).toThrow(
        /EACCES|permission/i,
      );
    } finally {
      fs.chmodSync(j5, 0o644);
    }
  });
});
