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
  // RN 工程痕迹：声明式 framework 守卫的 detect 校验需要（发布命令统一要求插件声明）
  fs.writeFileSync(
    path.join(proj, "package.json"),
    JSON.stringify({ name: "smoke", dependencies: { "react-native": "0.84.0" } }),
  );
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
    // resolveProfile 对齐 release：缺 profile 直接报错——先给最小 default profile 再验未知渠道路径
    fs.mkdirSync(path.join(proj, ".applift"), { recursive: true });
    fs.writeFileSync(
      path.join(proj, ".applift", "credentials.json"),
      `{"profiles":{"default":{}}}`,
    );
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
    fs.writeFileSync(
      path.join(proj, "applift.config.ts"),
      `import { defineConfig, rnFramework } from "@applift/core";\nexport default defineConfig({ plugins: [rnFramework()] });\n`,
    );
    const r = cli(["release", "android", "--stores", "huawei", "--dry-run", "--json"]);
    expect(r.code).toBe(0);
    const plan = JSON.parse(r.out) as { dryRun?: boolean };
    expect(plan).toBeTruthy();
  });

  it("beta android：缺凭据/产物 → 人话引导", () => {
    fs.writeFileSync(
      path.join(proj, "applift.config.ts"),
      `import { defineConfig, rnFramework } from "@applift/core";\nexport default defineConfig({ plugins: [rnFramework()] });\n`,
    );
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

  it("release harmony --dry-run：双产物工程探测必选 .app（扩展名过滤，不选 mtime 更新的 internaltesting .hap）", () => {
    fs.writeFileSync(
      path.join(proj, "applift.config.ts"),
      `import { defineConfig, rnFramework } from "@applift/core";\nexport default defineConfig({\n  plugins: [rnFramework()],\n  artifacts: {\n    harmony: [\n      'harmony/entry/build/default/outputs/**/entry-default-signed.internaltesting.hap',\n      'harmony/build/outputs/**/*-signed.app',\n    ],\n  },\n});\n`,
    );
    const hapDir = path.join(proj, "harmony", "entry", "build", "default", "outputs", "default");
    const appDir = path.join(proj, "harmony", "build", "outputs", "default");
    fs.mkdirSync(hapDir, { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    const hap = path.join(hapDir, "entry-default-signed.internaltesting.hap");
    const app = path.join(appDir, "harmony-default-signed.app");
    // .hap mtime 更新（模拟刚跑过蒲公英测试轮）：旧过滤逻辑会误选它上架
    fs.writeFileSync(app, "app-bytes");
    fs.writeFileSync(hap, "hap-bytes");
    const past = new Date(Date.now() - 3_600_000);
    fs.utimesSync(app, past, past);
    const r = cli(["release", "harmony", "--dry-run", "--delivery", "native"]);
    expect(r.out).toContain("harmony-default-signed.app");
    expect(r.out).not.toContain("internaltesting.hap");
  });

  it("release harmony --dry-run：产物可读版本但非工程版本（偏移包遗留）→ 拦截并引导构建正式产物", () => {
    fs.writeFileSync(
      path.join(proj, "applift.config.ts"),
      `import { defineConfig, rnFramework } from "@applift/core";\nexport default defineConfig({\n  plugins: [rnFramework()],\n  artifacts: { harmony: ['harmony/build/outputs/**/*-signed.app'] },\n});\n`,
    );
    const appDir = path.join(proj, "harmony", "build", "outputs", "default");
    fs.mkdirSync(appDir, { recursive: true });
    // 工程版本文件（release 期望版本 = 工程版 4.0.0）
    fs.mkdirSync(path.join(proj, "harmony", "AppScope"), { recursive: true });
    fs.writeFileSync(
      path.join(proj, "harmony", "AppScope", "app.json5"),
      JSON.stringify({ versionName: "4.0.0", versionCode: 4000000 }), // 顶层字段（app.json5 真实 schema）
    );
    fs.writeFileSync(path.join(appDir, "harmony-default-signed.app"), "fake");
    // 伴生 pack.info：产物可读版本 1004.0.0（偏移包），工程 app.json5 是 4.0.0
    fs.writeFileSync(
      path.join(appDir, "pack.info"),
      JSON.stringify({ summary: { app: { version: { name: "1004.0.0", code: 1004000000 } } } }),
    );
    const r = cli(["release", "harmony", "--dry-run", "--delivery", "native"]);
    expect(r.out).toMatch(/无版本 4\.0\.0 的 \.app[\s\S]*不能正式分发/);
  });

  it("beta harmony：热更平台只探测到非测试包 → 引导构建测试包", () => {
    fs.writeFileSync(
      path.join(proj, "applift.config.ts"),
      `import { defineConfig } from "@applift/cli";\nimport { rnFramework, rnUpdate } from "@applift/cli/plugins";\nexport default defineConfig({\n  plugins: [rnFramework(), rnUpdate({ harmony: 1 })],\n  artifacts: { harmony: ['harmony/build/outputs/**/*-signed.app'] },\n});\n`,
    );
    // 工程版本文件（beta 期望 = betaVersionName(4.0.0) = 4.0.1000，默认 patch+1000）
    fs.mkdirSync(path.join(proj, "harmony", "AppScope"), { recursive: true });
    fs.writeFileSync(
      path.join(proj, "harmony", "AppScope", "app.json5"),
      JSON.stringify({ versionName: "4.0.0", versionCode: 4000000 }),
    );
    const appDir = path.join(proj, "harmony", "build", "outputs", "default");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, "harmony-default-signed.app"), "fake");
    fs.writeFileSync(
      path.join(appDir, "pack.info"),
      JSON.stringify({ summary: { app: { version: { name: "4.0.0", code: 4000000 } } } }),
    );
    const r = cli(["beta", "harmony", "--delivery", "native", "--yes"]);
    expect(r.out).toMatch(/未探测到测试包 4\.0\.1000[\s\S]*版本名必须是 4\.0\.1000/);
  });

  it("beta harmony：suffix 策略期望派生测试包 4.0.0-beta（默认 patch+1000 之外的策略生效）", () => {
    fs.writeFileSync(
      path.join(proj, "applift.config.ts"),
      `import { defineConfig } from "@applift/cli";\nimport { rnFramework, rnUpdate } from "@applift/cli/plugins";\nexport default defineConfig({\n  plugins: [rnFramework(), rnUpdate({ harmony: 1 })],\n  artifacts: { harmony: ['harmony/build/outputs/**/*-signed.app'] },\n  version: { beta: { mode: "suffix" } },\n});\n`,
    );
    fs.mkdirSync(path.join(proj, "harmony", "AppScope"), { recursive: true });
    fs.writeFileSync(
      path.join(proj, "harmony", "AppScope", "app.json5"),
      JSON.stringify({ versionName: "4.0.0", versionCode: 4000000 }),
    );
    const appDir = path.join(proj, "harmony", "build", "outputs", "default");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, "harmony-default-signed.app"), "fake");
    fs.writeFileSync(
      path.join(appDir, "pack.info"),
      JSON.stringify({ summary: { app: { version: { name: "4.0.0", code: 4000000 } } } }),
    );
    const r = cli(["beta", "harmony", "--delivery", "native", "--yes"]);
    // 期望版本按 suffix 策略派生为 4.0.0-beta，现存 4.0.0 正式包被判不匹配
    expect(r.out).toMatch(/未探测到测试包 4\.0\.0-beta[\s\S]*版本名必须是 4\.0\.0-beta/);
  });

  it("beta ios：suffix 策略与 iOS 不兼容 → 报错文案引导改 offset/app-id（TestFlight 硬拒）", () => {
    fs.writeFileSync(
      path.join(proj, "applift.config.ts"),
      `import { defineConfig } from "@applift/cli";\nimport { rnFramework, rnUpdate } from "@applift/cli/plugins";\nexport default defineConfig({\n  plugins: [rnFramework(), rnUpdate({ ios: 1 })],\n  artifacts: { ios: ['ios/build/*.ipa'] },\n  version: { beta: { mode: "suffix" } },\n});\n`,
    );
    // iOS 版本事实源：pbxproj 的 MARKETING_VERSION（RN 布局标准位置）
    fs.mkdirSync(path.join(proj, "ios", "DemoApp.xcodeproj"), { recursive: true });
    fs.writeFileSync(
      path.join(proj, "ios", "DemoApp.xcodeproj", "project.pbxproj"),
      "423ABCD = { /* Debug */\n  CURRENT_PROJECT_VERSION = 4000;\n  MARKETING_VERSION = 4.0.0;\n};\n",
    );
    fs.mkdirSync(path.join(proj, "ios", "build"), { recursive: true });
    fs.writeFileSync(path.join(proj, "ios", "build", "DemoApp.ipa"), "fake-ipa");
    const r = cli(["beta", "ios", "--delivery", "native", "--yes"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(
      /ios 的 versionName 不支持 prerelease 后缀[\s\S]*改用 version\.beta\.mode=offset/,
    );
  });

  it("version：空目录 → 未识别框架兜底提示", () => {
    // beforeEach 给 proj 放了 RN 痕迹（守卫校验用）；空目录语义用独立子目录验证
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "applift-empty-"));
    try {
      const r = cli(["version"], empty);
      expect(r.code).toBe(1); // 空目录无版本文件 = 明确失败（引导），不是静默成功
      expect(r.out).toMatch(/版本文件/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
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
      path.join(proj, "applift.config.ts"),
      `import { defineConfig, rnFramework } from "@applift/core";\nexport default defineConfig({ plugins: [rnFramework()] });\n`,
    );
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
describe("业务流程：外部构建产物 → beta 发版（applift 不接管构建）", () => {
  it("外部构建产物就位 → beta 直接发版：产物探测 + 渠道止步于凭据（applift 不接管构建）", () => {
    // 项目已自行构建（产物落盘）；applift beta 只做：探测产物 → 渠道发布尝试（无凭据止步）
    const apkDir = path.join(proj, "android", "app", "build", "outputs", "apk", "release");
    fs.mkdirSync(apkDir, { recursive: true });
    fs.writeFileSync(path.join(apkDir, "app-release.apk"), "fake-apk");
    fs.writeFileSync(
      path.join(proj, "package.json"),
      JSON.stringify({
        name: "ext-build",
        version: "4.0.0",
        dependencies: { "react-native": "0.76.0" },
      }),
    );
    fs.writeFileSync(
      path.join(proj, "applift.config.ts"),
      `import { defineConfig, rnFramework } from "@applift/core";\nexport default defineConfig({ plugins: [rnFramework()], beta: { pgyer: { platforms: ["android"] } } });\n`,
    );
    const r = cli(["beta", "--yes"]);
    expect(r.out).toMatch(/pgyer\(android\)|凭据/); // 探测到产物并进入渠道流程
  }, 120_000);

  it("无产物 → beta 引导先构建（外部构建模型的缺产物路径）", () => {
    fs.writeFileSync(
      path.join(proj, "package.json"),
      JSON.stringify({
        name: "no-art",
        version: "4.0.0",
        dependencies: { "react-native": "0.76.0" },
      }),
    );
    fs.writeFileSync(
      path.join(proj, "applift.config.ts"),
      `import { defineConfig, rnFramework } from "@applift/core";\nexport default defineConfig({ plugins: [rnFramework()], beta: { pgyer: { platforms: ["android"] } } });\n`,
    );
    const r = cli(["beta", "--yes"]);
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/凭据|产物|构建/); // 外部模型否定路径：凭据/产物缺失均给出明确引导
  }, 120_000);
});
