/**
 * CLI 编排业务流程测试（spawn dist/bin.mjs，同 CI smoke 模式）：
 * version show（真实读取）→ bump --yes（全闭环）→ prerelease --pre → beta 的 bump 开关否定路径。
 * 覆盖 CLI 层编排（runBumpOrchestration 注入的确认跳过、构建提示与退出码），交互式 confirm
 * 走 --yes 旁路（项目约定：TTY 交互归真实冒烟）。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../dist/bin.mjs", import.meta.url));

// dist/bin.mjs 由 vitest globalSetup（vitest.global-setup.ts）单次构建（多 worker 并发 build 的 dist 竞态防护）

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-cli-ver-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function cli(args: string[]) {
  // HOME/APPLIFT_HOME 隔离:不隔离时读开发者真实 ~/.applift(本地凭据碰巧让它过,CI 无凭据即崩)
  const r = spawnSync("node", [BIN, ...args, "--cwd", dir], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, HOME: dir, APPLIFT_HOME: path.join(dir, ".applift") },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function setupRn(withConfig = false) {
  fs.mkdirSync(path.join(dir, "android", "app"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "android", "app", "build.gradle"),
    `android { defaultConfig { versionCode 4000; versionName "4.0.0" } }\n`,
  );
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `{"name":"a","version":"4.0.0","dependencies":{"react-native":"0.84.0"}}\n`,
  );
  if (withConfig) {
    fs.writeFileSync(
      path.join(dir, "applift.config.ts"),
      `import { defineConfig, rnFramework } from "@applift/core";\nexport default defineConfig({ plugins: [rnFramework()] });\n`,
    );
  }
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-qm", "feat: init"], { cwd: dir });
}

describe("CLI version show/bump 编排（spawn 级）", () => {
  it("show：读出各端实况与锚点 tag 提示", () => {
    setupRn();
    const r = cli(["version"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("4.0.0");
    expect(r.out).toContain("android/app/build.gradle");
    expect(r.out).toContain("无（bump 后打第一个 tag 激活 git 推断）");
  });

  it("bump --yes：全闭环（写文件 + CHANGELOG + commit + tag）且输出提示 push", () => {
    setupRn();
    const r = cli(["version", "bump", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("chore(release): 4.0.1");
    expect(r.out).toContain("git tag: v4.0.1");
    expect(r.out).toContain("git push --follow-tags");
    expect(fs.readFileSync(path.join(dir, "package.json"), "utf8")).toContain('"version": "4.0.1"');
  });

  it("bump --pre beta --yes：tag v4.1.0-beta.0，工程 versionName 仍 4.1.0", () => {
    setupRn();
    const r = cli(["version", "bump", "minor", "--pre", "beta", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("v4.1.0-beta.0");
    expect(fs.readFileSync(path.join(dir, "package.json"), "utf8")).toContain('"version": "4.1.0"');
  });

  it("bump --no-commit：只写文件不代 commit（无 release commit 产生）", () => {
    setupRn();
    const r = cli(["version", "bump", "--no-commit", "--yes"]);
    expect(r.code).toBe(0);
    expect(fs.readFileSync(path.join(dir, "package.json"), "utf8")).toContain('"version": "4.0.1"');
    const last = spawnSync("git", ["log", "--format=%s", "-1"], {
      cwd: dir,
      encoding: "utf8",
    }).stdout.trim();
    expect(last).toBe("feat: init"); // 未产生 chore(release) commit
  });
});

describe("bump 非交互门控（spawn 级，非 TTY）", () => {
  it("version bump 无 --yes → fail-fast exit 1 并引导 --yes（不挂起）", () => {
    setupRn();
    const r = cli(["version", "bump"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("bump 需 --yes");
  });

  it("version bump 无 --yes 但 config.toml assumeYes=true → 门控放行走完闭环", () => {
    setupRn();
    fs.mkdirSync(path.join(dir, ".applift"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".applift", "config.toml"), "assumeYes = true\n");
    // 新写文件先入 git：bump 代 commit 有「计划外未提交变更」护栏
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["commit", "-qm", "chore: test config"], { cwd: dir });
    const r = cli(["version", "bump"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("git tag: v4.0.1");
  });
});
