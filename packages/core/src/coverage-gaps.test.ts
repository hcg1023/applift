/**
 * 全仓覆盖率补口（既有债 + 新代码的 branch/stmt 缺口）：
 * humanizeError（此前 0%）、git 分支、changelog 渲染分支、framework detect 否定路径、
 * config alias 异常、apk-abi、artifact 探测回退。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { planBump } from "./version/bump.js";
import { listApkLibAbis } from "./channels/shared/apk-abi.js";
import { humanizeError } from "./channels/shared/error-codes.js";
import { commitsSince, latestSemverTag, looseSemver } from "./version/git.js";
import { renderChangelogSection, toChangelogEntries } from "./version/changelog.js";
import { readArtifactVersion } from "./version/artifact.js";
import { evalVersionCodeFormula } from "./version/version-code.js";
import { detectBundleIds } from "./framework.js";
import { suggestFramework } from "./plugins/frameworks.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-cov-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("humanizeError（错误码人话化）", () => {
  const hints = { "203886599": "clientId 类型不匹配，用 API 客户端而非 Service Account" };
  it("命中错误码 → 追加提示", () => {
    expect(humanizeError(hints, "failed: 203886599 bad")).toMatch(/提示:.*API 客户端/);
  });
  it("未命中/无 hints → 原样返回", () => {
    expect(humanizeError(hints, "other error")).toBe("other error");
    expect(humanizeError(undefined, "raw")).toBe("raw");
    expect(humanizeError({}, "raw")).toBe("raw");
  });
});

describe("git 分支", () => {
  it("looseSemver：前缀+非法尾缀/纯非法", () => {
    expect(looseSemver("release-1.2.3")).toBe("1.2.3");
    expect(looseSemver("x-1.2.3-")).toBe("1.2.3"); // 尾缀 - 回溯掉，核心 semver 仍可解析
    expect(looseSemver("no digits here")).toBeUndefined();
    expect(looseSemver("1.2")).toBeUndefined(); // 两段非完整 semver
  });
  it("latestSemverTag：非 semver tag 混入被忽略；commitsSince 坏 ref → 空数组", () => {
    const sh = (cmd: string) => spawnSync("sh", ["-c", cmd], { cwd: dir, encoding: "utf8" });
    sh("git init -q && git config user.email t@t && git config user.name t");
    sh("git commit -q --allow-empty -m init");
    sh("git tag not-semver && git tag v1.2.3");
    expect(latestSemverTag(dir)).toBe("v1.2.3");
    expect(commitsSince(dir, "no-such-ref")).toEqual([]);
    // 无 tag 前缀形态也算
    sh("git tag 2.0.0");
    expect(latestSemverTag(dir)).toBe("2.0.0");
  }, 30_000);
});

describe("changelog 渲染分支", () => {
  it("空 entries → 仅 heading；BREAKING header 文本兜底", () => {
    expect(renderChangelogSection("1.0.0", "2026-01-01", [])).toBe("## [1.0.0] - 2026-01-01");
    // subject 缺失回退 header
    const entries = toChangelogEntries(["fix: "]);
    expect(entries).toHaveLength(1);
  });
});

describe("version-code 一元负号深分支", () => {
  it("-( 未闭合与纯负因子", () => {
    expect(evalVersionCodeFormula("1-(", { major: 1, minor: 0, patch: 0 })).toBeUndefined();
    expect(evalVersionCodeFormula("(-(1", { major: 1, minor: 0, patch: 0 })).toBeUndefined();
  });
});

describe("framework detect 否定路径与 bundle 推导", () => {
  it("空目录：全部框架不命中，bundleIds 全空", () => {
    expect(suggestFramework(dir)).toBeNull();
    expect(detectBundleIds(dir)).toEqual({
      android: undefined,
      harmony: undefined,
      ios: undefined,
    });
  });
});

describe("artifact 版本读取回退分支", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  it("非包扩展名 → undefined；unzip 失败且无同目录 pack.info → undefined", () => {
    expect(readArtifactVersion(`${dir}/x.txt`)).toBeUndefined();
    const fake = path.join(dir, "fake.app");
    fs.writeFileSync(fake, "not a zip");
    expect(readArtifactVersion(fake)).toBeUndefined();
  });
});

describe("apk-abi 坏包防御分支", () => {
  it("非 zip / 截断 zip → 空数组（32/64 兼容处理）", () => {
    const junk = path.join(dir, "junk.apk");
    fs.writeFileSync(junk, "not a zip at all");
    expect(listApkLibAbis(junk)).toEqual([]);
    const buf = Buffer.alloc(46);
    buf.writeUInt32LE(0x06054b50, 24); // EOCD 魔数放扫描窗内，CEN 读不满 → break
    fs.writeFileSync(path.join(dir, "t.apk"), buf);
    expect(listApkLibAbis(path.join(dir, "t.apk"))).toEqual([]);
  });
});

describe("planBump 组合分支（platforms/字段缺失/公式限定）", () => {
  function rnDir() {
    fs.mkdirSync(path.join(dir, "android", "app"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "android", "app", "build.gradle"),
      `defaultConfig { versionCode 7; versionName "1.0.0" }\n`,
    );
    fs.writeFileSync(path.join(dir, "package.json"), `{"name":"a"}`); // 无 version 字段（js 端字段缺失分支）
  }

  it("--platform android：只动指定端，js 缺 versionName 不参与基线", () => {
    rnDir();
    const plan = planBump({
      cwd: dir,
      framework: null,
      level: "minor",
      platforms: ["android"],
    });
    expect(plan.writes.map((w) => w.platform)).toEqual(["android"]);
    expect(plan.nextVersion).toBe("1.1.0");
  });

  it("非数字 versionCode（旧 iOS 3.0.08 形态）→ 当作无值从 1 起", () => {
    fs.mkdirSync(path.join(dir, "ios", "Qy.xcodeproj"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "ios", "Qy.xcodeproj", "project.pbxproj"),
      `MARKETING_VERSION = 4.0.0; CURRENT_PROJECT_VERSION = 3.0.08;`,
    );
    const plan = planBump({
      cwd: dir,
      framework: null,
      level: "patch",
    });
    const ios = plan.writes.find((w) => w.platform === "ios");
    expect(ios?.versionCode).toBe(1);
  });

  it("公式 platforms 不含该端 → 该端走 +1；非 git 目录无锚点无推断", () => {
    rnDir();
    const framework = null;
    const plan = planBump({
      cwd: dir,
      framework,
      level: "patch",
      versionCode: { formula: "major*100+minor", platforms: ["harmony"] },
    });
    expect(plan.writes.find((w) => w.platform === "android")?.versionCode).toBe(8);
    expect(plan.anchor).toBeUndefined();
    expect(plan.infer).toBeUndefined();
  });
});

describe("杂项自然分支", () => {
  it("projectCredentialsPath：项目级凭据路径拼接", async () => {
    const { projectCredentialsPath } = await import("./config/loader.js");
    expect(projectCredentialsPath("/proj")).toBe(
      path.join("/proj", ".applift", "credentials.json"),
    );
  });

  it("readArtifactVersion：unzip 失败回退同目录 pack.info（可能过期标注）", () => {
    const fake = path.join(dir, "side.app");
    fs.writeFileSync(fake, "not a zip");
    fs.writeFileSync(
      path.join(dir, "pack.info"),
      JSON.stringify({ versionName: "1.2.3", versionCode: 99 }),
    );
    const v = readArtifactVersion(fake);
    expect(v).toMatchObject({ versionName: "1.2.3", versionCode: "99" });
    expect(v?.source).toMatch(/同目录/);
  });

  it("PATH 无 git：isGitRepo false 走 spawn error 分支", async () => {
    const path0 = process.env.PATH;
    process.env.PATH = "/nonexistent-dir-for-git";
    try {
      const { isGitRepo } = await import("./version/git.js");
      expect(isGitRepo(dir)).toBe(false);
    } finally {
      process.env.PATH = path0;
    }
  });
});
