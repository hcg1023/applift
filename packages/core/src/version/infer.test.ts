/**
 * 版本推断契约测试：conventional commits → level、semver 演进（inc/prerelease 剥离）、
 * 商店 versionName 三段化。全纯函数，覆盖发版闭环的版本决定行为。
 */
import { describe, expect, it } from "vitest";
import { decideNextVersion, inferBumpLevel, storeVersionName } from "./infer.js";

describe("inferBumpLevel", () => {
  it("feat → minor；fix → patch；混合取最大", () => {
    expect(inferBumpLevel(["feat: 新功能"]).level).toBe("minor");
    expect(inferBumpLevel(["fix: 修问题"]).level).toBe("patch");
    expect(inferBumpLevel(["fix: a", "feat: b", "chore: c"]).level).toBe("minor");
  });

  it("BREAKING CHANGE（footer 与 ! 语法）→ major", () => {
    expect(inferBumpLevel(["feat!: 改接口\n\nBREAKING CHANGE: api 变了"]).level).toBe("major");
    expect(inferBumpLevel(["chore: x\n\nBREAKING CHANGE: 删了旧接口"]).level).toBe("major");
  });

  it("仅 chore/docs 或无提交 → patch 兜底", () => {
    expect(inferBumpLevel(["chore: 依赖升级", "docs: readme"]).level).toBe("patch");
    expect(inferBumpLevel([]).level).toBe("patch");
    expect(inferBumpLevel(["随便一句话"]).level).toBe("patch");
  });
});

describe("decideNextVersion", () => {
  it("显式 semver 直接用；不大于当前报错", () => {
    expect(decideNextVersion("4.0.0", { level: "4.2.0" }).next).toBe("4.2.0");
    expect(() => decideNextVersion("4.0.0", { level: "4.0.0" })).toThrow(/必须大于/);
    expect(() => decideNextVersion("4.0.0", { level: "abc" })).toThrow(/无法识别/);
  });

  it("level 递进：minor 4.0.0 → 4.1.0；prerelease 基线上的 level = 完成当前版本（semver 标准）", () => {
    expect(decideNextVersion("4.0.0", { level: "minor" }).next).toBe("4.1.0");
    // beta.3 转正式：patch 剥离 prerelease → 4.0.0（不是 4.0.1）
    expect(decideNextVersion("4.0.0-beta.3", { level: "patch" }).next).toBe("4.0.0");
    // inc('minor') 在 prerelease 基线上也是完成当前 minor（semver.inc 语义）
    expect(decideNextVersion("4.0.0-beta.3", { level: "minor" }).next).toBe("4.0.0");
  });

  it("--pre 进入 prerelease：preminor 4.0.0 + beta → 4.1.0-beta.0（semver 从 .0 起号）", () => {
    expect(decideNextVersion("4.0.0", { level: "minor", pre: "beta" }).next).toBe("4.1.0-beta.0");
    // 显式推断 level + pre
    expect(
      decideNextVersion(
        "4.0.0",
        { pre: "rc" },
        { level: "major", reason: "", total: 1, breaking: 1, feat: 0, fix: 0 },
      ).next,
    ).toBe("5.0.0-rc.0");
  });
  it("prerelease 递进：beta.3 → beta.4；非 prerelease 基线报错引导 --pre", () => {
    expect(decideNextVersion("4.1.0-beta.3", { level: "prerelease" }).next).toBe("4.1.0-beta.4");
    expect(() => decideNextVersion("4.0.0", { level: "prerelease" })).toThrow(/--pre/);
  });

  it("无 level 用推断结果；无推断 patch 兜底", () => {
    expect(
      decideNextVersion(
        "4.0.0",
        {},
        { level: "minor", reason: "x", total: 2, breaking: 0, feat: 1, fix: 1 },
      ).next,
    ).toBe("4.1.0");
    expect(decideNextVersion("4.0.0", {}).next).toBe("4.0.1");
  });

  it("当前版本非 semver（前导零）报错并要求显式指定", () => {
    expect(() => decideNextVersion("3.0.08", {})).toThrow(/不是合法 semver/);
  });
});

describe("storeVersionName", () => {
  it("prerelease 剥离为三段数字（商店 versionName 恒数字三段）", () => {
    expect(storeVersionName("4.1.0-beta.3")).toBe("4.1.0");
    expect(storeVersionName("4.1.0")).toBe("4.1.0");
  });
});
