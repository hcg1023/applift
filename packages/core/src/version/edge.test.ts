/**
 * 剩余分支覆盖：错误路径与防御分支（非 semver 基线、非法公式、writer 未命中、
 * plist $(VAR) 跳过、catalog versionCode、一元负号、statusShort 非仓库）。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyBump, planBump } from "./bump.js";
import { statusShort } from "./git.js";
import { readProjectVersions, writeProjectVersions } from "./project.js";
import { evalVersionCodeFormula } from "./version-code.js";
import { rnAdapter, nativeAndroidAdapter } from "../framework.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-branch-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("planBump 错误路径", () => {
  it("各端均非 semver 且无显式版本 → 报错引导显式指定", () => {
    fs.mkdirSync(path.join(dir, "android", "app"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "android", "app", "build.gradle"),
      `defaultConfig { versionName "3.0.08" }\n`,
    );
    fs.writeFileSync(path.join(dir, "package.json"), `{"name":"a","version":"3.0.08"}\n`);
    expect(() => planBump({ cwd: dir, framework: rnAdapter })).toThrow(/显式指定目标版本/);
  });

  it("公式无法求值 → 报错（不静默回退）", () => {
    fs.writeFileSync(path.join(dir, "package.json"), `{"name":"a","version":"4.0.0"}\n`);
    expect(() =>
      planBump({
        cwd: dir,
        framework: rnAdapter,
        versionCode: { formula: "major/patch" },
      }),
    ).toThrow(/公式无法求值/);
  });

  it("显式非 semver level → decide 报错", () => {
    fs.writeFileSync(path.join(dir, "package.json"), `{"name":"a","version":"4.0.0"}\n`);
    expect(() => planBump({ cwd: dir, framework: rnAdapter, level: "abc" })).toThrow(/无法识别/);
  });
});

describe("writer 未命中字段", () => {
  it("gradle 无版本字段面量 → skipped 报错", () => {
    fs.mkdirSync(path.join(dir, "app"), { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.gradle"), "");
    fs.writeFileSync(path.join(dir, "app", "build.gradle"), `android { }\n`);
    const r = writeProjectVersions(dir, nativeAndroidAdapter, [
      { platform: "android", versionName: "4.0.0", versionCode: 2 },
    ]);
    expect(r.skipped[0]?.reason).toMatch(/未找到 versionCode/);
  });

  it("pbxproj 无 MARKETING/CURRENT → skipped", () => {
    fs.mkdirSync(path.join(dir, "Qy.xcodeproj"), { recursive: true });
    fs.writeFileSync(path.join(dir, "Qy.xcodeproj", "project.pbxproj"), `nothing here\n`);
    const r = writeProjectVersions(dir, nativeAndroidAdapter, [
      { platform: "ios", versionName: "4.0.0", versionCode: 2 },
    ]).changed; // nativeAndroid 不含 ios → 0；换 null 框架再验
    expect(r).toHaveLength(0);
    const r2 = writeProjectVersions(dir, null, [
      { platform: "ios", versionName: "4.0.0", versionCode: 2 },
    ]);
    expect(r2.skipped[0]?.reason).toMatch(/MARKETING_VERSION/);
  });

  it("app.json5 无版本键 → skipped", () => {
    fs.mkdirSync(path.join(dir, "harmony", "AppScope"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "harmony", "AppScope", "app.json5"),
      `{"app":{"bundleName":"x"}}\n`,
    );
    const r = writeProjectVersions(dir, null, [
      { platform: "harmony", versionName: "4.0.0", versionCode: 2 },
    ]);
    expect(r.skipped[0]?.reason).toMatch(/versionName\/versionCode/);
  });
});

describe("读侧防御分支", () => {
  it("catalog versionCode 引用（name 正常）→ problem 标注", () => {
    fs.mkdirSync(path.join(dir, "app"), { recursive: true });
    fs.writeFileSync(path.join(dir, "settings.gradle"), "");
    fs.writeFileSync(
      path.join(dir, "app", "build.gradle"),
      `defaultConfig {\n  versionCode = libs.versions.versionCode.get().toInt()\n  versionName "4.0.0"\n}\n`,
    );
    const vs = readProjectVersions(dir, nativeAndroidAdapter);
    expect(vs[0]?.problem).toMatch(/catalog/);
    expect(vs[0]?.versionName).toBe("4.0.0"); // name 字面量仍读出
  });

  it("plist 只有 $(VAR) versionName + 正常 CFBundleVersion → 整体不产出", () => {
    fs.mkdirSync(path.join(dir, "Qy"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "Qy", "Info.plist"),
      `<plist><dict><key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string><key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string></dict></plist>`,
    );
    const vs = readProjectVersions(dir, null);

    expect(vs.find((v) => v.platform === "ios")).toBeUndefined();
  });
});

describe("其余小分支", () => {
  it("一元负号：公式 -major 拒绝（非正结果）", () => {
    expect(evalVersionCodeFormula("-major", { major: 4, minor: 0, patch: 0 })).toBeUndefined();
    expect(evalVersionCodeFormula("(1-2)*major", { major: 5, minor: 0, patch: 0 })).toBeUndefined();
  });

  it("statusShort 非仓库 → 空数组", () => {
    expect(statusShort(dir)).toEqual([]);
  });

  it("applyBump commit:false tag:false → 不碰 git（非仓库也不警告）", () => {
    fs.writeFileSync(path.join(dir, "package.json"), `{"name":"a","version":"4.0.0"}\n`);
    const plan = planBump({ cwd: dir, framework: rnAdapter, level: "patch" });
    const applied = applyBump(dir, plan, rnAdapter, { commit: false, tag: false });
    expect(applied.committed).toBe(false);
    expect(applied.tagged).toBe(false);
    expect(applied.warnings).toHaveLength(0);
  });
});
