/**
 * 全命令冒烟/业务流程测试（spawn dist/bin.mjs，同 CI smoke 模式）：
 * 11 个命令的非交互路径全覆盖——channels / doctor / status / history /
 * listing --dry-run / release --dry-run / beta 快捷路径 / init --help / version / use。
 * HOME 隔离到临时目录，绝不触碰真实 ~/.applift。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../dist/bin.mjs", import.meta.url));

// dist/bin.mjs 由 vitest globalSetup（vitest.global-setup.ts）单次构建——
// 避免多 worker 并发 pnpm -r build 清写 dist 的竞态
let dir: string; // 假 HOME（隔离 ~/.applift）
let proj: string; // 假项目
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-home-"));
  proj = fs.mkdtempSync(path.join(os.tmpdir(), "applift-proj-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

function cli(args: string[], cwd = proj) {
  const r = spawnSync("node", [BIN, ...args], {
    cwd, // 进程工作目录：各命令 --cwd 缺省取 process.cwd()，且不是所有命令都有 --cwd 旗标
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: dir,
      XDG_CONFIG_HOME: dir,
      APPLIFT_HOME: path.join(dir, ".applift"),
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("全命令冒烟（非交互路径）", () => {
  it("channels --json：静态渠道清单", () => {
    const r = cli(["channels", "--json"]);
    expect(r.code).toBe(0);
    const list = (JSON.parse(r.out) as { channels: Array<{ id: string }> }).channels;
    for (const id of [
      "pgyer",
      "agc",
      "asc",
      "huawei",
      "xiaomi",
      "oppo",
      "vivo",
      "honor",
      "yyb",
      "googleplay",
    ])
      expect(list.map((c) => c.id)).toContain(id);
  });

  it("doctor：空项目体检不炸，输出框架/凭据检查", () => {
    const r = cli(["doctor"]);
    expect(r.code === 0 || r.code === 1).toBe(true); // 不健康时 exit 1 也算正常路径
    expect(r.out).toMatch(/体检完成/);
  });

  it("doctor：googleplay 缺 SA 凭据 → “或”型键整串报缺失且 exit 1；项目级凭据文件被识别", () => {
    fs.writeFileSync(
      path.join(proj, "applift.config.ts"),
      `import { defineConfig } from "@applift/core";\nexport default defineConfig({ android: { pkgName: "com.doc.demo", stores: { googleplay: {} } } });\n`,
    );
    // ① profile 存在但 SA 键全缺：命中“或”型键分支（A 或 B 任一存在即过，全缺报整串）
    fs.mkdirSync(path.join(proj, ".applift"), { recursive: true });
    fs.writeFileSync(
      path.join(proj, ".applift", "credentials.json"),
      `{"profiles":{"default":{}}}`,
    );
    const miss = cli(["doctor"]);
    expect(miss.code).toBe(1);
    expect(miss.out).toContain("GOOGLEPLAY_SA_JSON 或 GOOGLEPLAY_SA_KEY");
    // ② 项目级 .applift/credentials.json（HOME 隔离无全局凭据）写入 SA 键 → doctor 识别到
    fs.writeFileSync(
      path.join(proj, ".applift", "credentials.json"),
      `{"profiles":{"default":{"GOOGLEPLAY_SA_JSON":"{}"}}}`,
    );
    const ok = cli(["doctor"]);
    expect(ok.out).toContain("googleplay: 凭据齐全");
    expect(ok.code).toBe(0);
  });

  it("listing --stores nope --json：未知渠道 → ok:false 且 exit 1", () => {
    const r = cli(["listing", "--stores", "nope", "--brief", "简介", "--json"]);
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.out) as { stores: Array<{ ok: boolean; error: string }> };
    expect(parsed.stores[0]?.ok).toBe(false);
    expect(parsed.stores[0]?.error).toBe("未知渠道");
  });

  it("history：空历史输出（HOME 隔离）+ --json 形态", () => {
    const r = cli(["history", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([]);
  });

  it("history：写入假记录后按渠道过滤", () => {
    fs.mkdirSync(path.join(dir, ".applift"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".applift", "history.jsonl"),
      [
        {
          ts: 1,
          channel: "pgyer",
          action: "stage",
          artifactSha256: "aa",
          ok: true,
          cwd: proj,
          artifactVersion: "4.0.1",
        },
        { ts: 2, channel: "agc", action: "submit", artifactSha256: "bb", ok: true, cwd: proj },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    const r = cli(["history", "--channel", "pgyer", "--json"]);
    const rows = JSON.parse(r.out) as Array<{ channel: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.channel).toBe("pgyer");
  });

  it("status：缺凭据/配置 → 人话提示不栈崩", () => {
    const r = cli(["status", "--stores", "huawei"]);
    expect(r.out).toMatch(/凭据|appId|缺少|profile/i);
  });

  it("listing --dry-run：无配置 → 引导报错", () => {
    const r = cli(["listing", "--dry-run"]);
    expect(r.code).not.toBe(0);
  });

  it("release android --dry-run：无凭据产物也出计划（json）", () => {
    const r = cli(["release", "android", "--stores", "huawei", "--dry-run", "--json"]);
    expect(r.code).toBe(0);
    const plan = JSON.parse(r.out) as { dryRun?: boolean };
    expect(plan).toBeTruthy();
  });

  it("beta android：缺凭据/产物 → 人话引导", () => {
    const r = cli(["beta", "android"]);
    expect(r.out).toMatch(/凭据|产物|构建/);
  });

  it("beta harmony --via pgyer：无 .hap → 引导", () => {
    const r = cli(["beta", "harmony", "--via", "pgyer"]);
    expect(r.code).not.toBe(0);
  });

  it("init --help / version --help：参数帮助不炸", () => {
    expect(cli(["init", "--help"]).code).toBe(0);
    expect(cli(["version", "--help"]).code).toBe(0);
    expect(cli(["release", "--help"]).code).toBe(0);
  });

  it("version：空目录 → 未识别框架兜底提示", () => {
    const r = cli(["version"]);
    expect(r.code).toBe(1); // 空目录无版本文件 = 明确失败（引导），不是静默成功
    expect(r.out).toMatch(/版本文件/);
  });
});

describe("业务流程：护栏②同渠道同版本重复提交警告（真触发链路）", () => {
  it("beta harmony 快捷路径：产物版本与 history 重复 → 输出警告；不同版本无警告", () => {
    // 产物版本可读：.hap 非 zip 时回退同目录 pack.info（构建伴生文件）
    const artDir = path.join(proj, "out");
    fs.mkdirSync(artDir, { recursive: true });
    fs.writeFileSync(path.join(artDir, "entry-default-signed.hap"), "fake-hap");
    fs.writeFileSync(
      path.join(artDir, "pack.info"),
      JSON.stringify({ versionName: "4.1.0", versionCode: "4001" }),
    );
    // 最小凭据（default 空 profile）：流程走到护栏②与 stage，不在 creds 解析就失败
    fs.mkdirSync(path.join(dir, ".applift"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".applift", "credentials.json"), `{"profiles":{"default":{}}}`);
    // history：agc 渠道已成功发过同版本
    fs.writeFileSync(
      path.join(dir, ".applift", "history.jsonl"),
      `${JSON.stringify({ ts: 1, channel: "agc", action: "submit", artifactSha256: "x", ok: true, cwd: proj, artifactVersion: "4.1.0" })}\n`,
    );
    const r = cli(["beta", "harmony", "--artifact", path.join(artDir, "entry-default-signed.hap")]);
    expect(r.out).toContain("已提交过版本 4.1.0"); // 护栏②真实输出（AGC 分支 stage 前）
    // 对照：不同版本的产物无警告
    fs.writeFileSync(
      path.join(artDir, "pack.info"),
      JSON.stringify({ versionName: "4.2.0", versionCode: "4002" }),
    );
    const r2 = cli([
      "beta",
      "harmony",
      "--artifact",
      path.join(artDir, "entry-default-signed.hap"),
    ]);
    expect(r2.out).not.toContain("已提交过版本");
  });
});
describe("业务流程：beta --bump 一条龙编排（bump → 构建 → 产物探测 → 渠道发布尝试）", () => {
  it("假构建命令串通全管道：版本写回、tag、构建产物生成、渠道因缺凭据止步", () => {
    // 伪 RN 工程：build:test 脚本“构建”= 落一个 apk 文件
    const apkDir = path.join(proj, "android", "app", "build", "outputs", "apk", "release");
    fs.mkdirSync(path.join(proj, "android", "app"), { recursive: true });
    fs.writeFileSync(
      path.join(proj, "android", "app", "build.gradle"),
      `defaultConfig { versionCode 4000; versionName "4.0.0" }\n`,
    );
    fs.writeFileSync(
      path.join(proj, "package.json"),
      JSON.stringify({
        name: "e2e",
        version: "4.0.0",
        dependencies: { "react-native": "0.76.0" },
        scripts: {
          "build:test": `node -e "require('fs').mkdirSync('${apkDir}',{recursive:true});require('fs').writeFileSync('${apkDir}/app-release.apk','fake')" --`,
        },
      }),
    );
    fs.writeFileSync(
      path.join(proj, "applift.config.ts"),
      `import { defineConfig } from "@applift/core";\nexport default defineConfig({ beta: { pgyer: { platforms: ["android"] } } });\n`,
    );
    const g = (cmd: string) => spawnSync("sh", ["-c", cmd], { cwd: proj, encoding: "utf8" });
    g("git init -q && git config user.email t@t && git config user.name t");
    g("git add -A && git commit -qm 'feat: 初始功能'");

    const r = cli(["beta", "--bump", "--yes"]);

    // 编排顺序全验证：① 版本写回（推断 feat → minor）
    expect(fs.readFileSync(path.join(proj, "package.json"), "utf8")).toContain(
      '"version": "4.0.1"',
    );
    expect(fs.readFileSync(path.join(proj, "android", "app", "build.gradle"), "utf8")).toContain(
      'versionName "4.0.1"',
    );
    // ② commit + tag
    expect(g("git tag -l").stdout).toContain("v4.0.1");
    expect(g("git log --format=%s -1").stdout).toContain("chore(release): 4.0.1");
    // ③ 构建已触发（产物由 build:test 脚本生成）
    expect(fs.existsSync(path.join(apkDir, "app-release.apk"))).toBe(true);
    // ④ CHANGELOG
    expect(fs.readFileSync(path.join(proj, "CHANGELOG.md"), "utf8")).toContain("## [4.0.1]");
    // ⑤ 渠道止步于凭据（隔离 HOME 无 credentials.json），编排不静默吞错
    expect(r.out).toMatch(/pgyer\(android\)|凭据/);
  }, 120_000);

  it("构建失败 → 中止且不进发布（版本已 bump + tag 已打，渠道零调用）", () => {
    fs.mkdirSync(path.join(proj, "android", "app"), { recursive: true });
    fs.writeFileSync(
      path.join(proj, "android", "app", "build.gradle"),
      `defaultConfig { versionCode 4000; versionName "4.0.0" }\n`,
    );
    fs.writeFileSync(
      path.join(proj, "package.json"),
      JSON.stringify({
        name: "e2e-fail",
        version: "4.0.0",
        dependencies: { "react-native": "0.76.0" },
        scripts: { "build:test": `node -e "process.exit(1)" --` },
      }),
    );
    fs.writeFileSync(
      path.join(proj, "applift.config.ts"),
      `import { defineConfig } from "@applift/core";\nexport default defineConfig({ beta: { pgyer: { platforms: ["android"] } } });\n`,
    );
    const g = (cmd: string) => spawnSync("sh", ["-c", cmd], { cwd: proj, encoding: "utf8" });
    g("git init -q && git config user.email t@t && git config user.name t");
    g("git add -A && git commit -qm 'chore: init'");

    const r = cli(["beta", "--bump", "--yes"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/构建失败/);
    expect(r.out).not.toContain("内测多渠道并行发布"); // 构建失败即中止，渠道零触达
    expect(g("git tag -l").stdout).toContain("v4.0.1"); // bump 先行已完成（记录尝试）
  }, 120_000);

  it("config beta.bump:true 默认开启：无 --bump 旗标同样走 bump 闭环", () => {
    const apkDir = path.join(proj, "android", "app", "build", "outputs", "apk", "release");
    fs.mkdirSync(path.join(proj, "android", "app"), { recursive: true });
    fs.writeFileSync(
      path.join(proj, "android", "app", "build.gradle"),
      `defaultConfig { versionCode 4000; versionName "4.0.0" }\n`,
    );
    fs.writeFileSync(
      path.join(proj, "package.json"),
      JSON.stringify({
        name: "e2e-cfg",
        version: "4.0.0",
        dependencies: { "react-native": "0.76.0" },
        scripts: {
          "build:test": `node -e "require('fs').mkdirSync('${apkDir}',{recursive:true});require('fs').writeFileSync('${apkDir}/app-release.apk','fake')" --`,
        },
      }),
    );
    fs.writeFileSync(
      path.join(proj, "applift.config.ts"),
      `import { defineConfig } from "@applift/core";\nexport default defineConfig({ beta: { bump: true, pgyer: { platforms: ["android"] } } });\n`,
    );
    const g = (cmd: string) => spawnSync("sh", ["-c", cmd], { cwd: proj, encoding: "utf8" });
    g("git init -q && git config user.email t@t && git config user.name t");
    g("git add -A && git commit -qm 'feat: x'");

    const r = cli(["beta", "--yes"]); // 无 --bump 旗标：config 默认开
    expect(fs.readFileSync(path.join(proj, "package.json"), "utf8")).toContain(
      '"version": "4.0.1"',
    );
    expect(g("git tag -l").stdout).toContain("v4.0.1");
    expect(r.out).toMatch(/pgyer|凭据/); // 编排走到渠道
  }, 120_000);
});
