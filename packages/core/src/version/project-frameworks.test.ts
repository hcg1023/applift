/**
 * 其余框架形态读写覆盖：flutter pubspec / tauri / electron / Expo / 原生安卓 kts /
 * 原生 iOS（含 Info.plist 字面量兜底）/ 未识别框架 tryAll / 缺文件 skipped。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  flutterAdapter,
  nativeAndroidAdapter,
  nativeIosAdapter,
  rnAdapter,
  tauriAdapter,
} from "../framework.js";
import { readProjectVersions, writeProjectVersions } from "./project.js";
let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-frames-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function w(p: string, content: string) {
  fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
  fs.writeFileSync(path.join(dir, p), content);
}
function read(p: string): string {
  return fs.readFileSync(path.join(dir, p), "utf8");
}

describe("flutter pubspec", () => {
  it("读 version: x.y.z+n；写回同升 versionName 与 versionCode", () => {
    w(
      "pubspec.yaml",
      `name: demo\ndescription: t\npublish_to: none\nversion: 1.0.0+42\n\nenvironment:\n  sdk: ^3.0.0\n`,
    );
    const vs = readProjectVersions(dir, flutterAdapter);
    expect(vs.find((v) => v.platform === "flutter")).toMatchObject({
      versionName: "1.0.0",
      versionCode: "42",
    });

    const r = writeProjectVersions(dir, flutterAdapter, [
      { platform: "flutter", versionName: "1.1.0", versionCode: 43 },
    ]);
    expect(r.changed).toHaveLength(1);
    expect(read("pubspec.yaml")).toContain("version: 1.1.0+43");
    expect(read("pubspec.yaml")).toContain("publish_to: none"); // 其余行不动
  });

  it("无 version 行报错（skipped 不抛）", () => {
    w("pubspec.yaml", `name: demo\n`);
    const r = writeProjectVersions(dir, flutterAdapter, [
      { platform: "flutter", versionName: "1.1.0", versionCode: 43 },
    ]);
    expect(r.changed).toHaveLength(0);
    expect(r.skipped[0]?.reason).toMatch(/version/);
  });
});

describe("tauri / electron", () => {
  it("tauri：src-tauri/tauri.conf.json 的 version 键 + package.json 同步", () => {
    w("src-tauri/tauri.conf.json", `{\n  "productName": "t",\n  "version": "0.3.0"\n}\n`);
    w("package.json", `{"name":"t","version":"0.3.0"}\n`);
    const vs = readProjectVersions(dir, tauriAdapter);
    expect(vs.find((v) => v.platform === "tauri")).toMatchObject({ versionName: "0.3.0" });
    const r = writeProjectVersions(dir, tauriAdapter, [
      { platform: "tauri", versionName: "0.4.0", versionCode: 1 },
    ]);
    expect(read("src-tauri/tauri.conf.json")).toContain('"version": "0.4.0"');
    expect(r.changed).toHaveLength(1);
  });

  it("json 无 version 键：读 undefined、写 no-op 不列入 changed", () => {
    w("src-tauri/tauri.conf.json", `{"productName": "t"}\n`);
    const vs = readProjectVersions(dir, tauriAdapter);
    expect(vs.find((v) => v.platform === "tauri")?.versionName).toBeUndefined();
    const r = writeProjectVersions(dir, tauriAdapter, [
      { platform: "tauri", versionName: "0.4.0", versionCode: 1 },
    ]);
    expect(r.changed).toHaveLength(0);
  });
});

describe("Expo app.json", () => {
  it("expo 段：version / ios.buildNumber / android.versionCode 读写", () => {
    w(
      "package.json",
      `{"name":"e","version":"2.0.0","dependencies":{"expo":"52","react-native":"0.76"}}\n`,
    );
    w(
      "app.json",
      `{\n  "expo": {\n    "version": "2.0.0",\n    "ios": { "buildNumber": "20" },\n    "android": { "versionCode": 20 }\n  }\n}\n`,
    );
    // rnAdapter 探测（package.json 有 react-native + expo）
    const vs = readProjectVersions(dir, rnAdapter);
    expect(vs.find((v) => v.platform === "expo")).toMatchObject({
      versionName: "2.0.0",
      versionCode: "20",
    });
    const r = writeProjectVersions(dir, rnAdapter, [
      { platform: "expo", versionName: "2.1.0", versionCode: 21 },
    ]);
    expect(read("app.json")).toContain('"version": "2.1.0"');
    expect(read("app.json")).toContain('"buildNumber": "21"');
    expect(read("app.json")).toContain('"versionCode": 21');
    expect(r.changed).toHaveLength(1);
  });
});

describe("原生安卓 kts", () => {
  it("kts 赋值语法（= 与无引号 versionName）读写", () => {
    w("settings.gradle.kts", `pluginManagement {}\n`);
    w(
      "app/build.gradle.kts",
      `android {\n  defaultConfig {\n    versionCode = 3052\n    versionName = 3.0.52\n  }\n}\n`,
    );
    const vs = readProjectVersions(dir, nativeAndroidAdapter);
    expect(vs.find((v) => v.platform === "android")).toMatchObject({
      versionName: "3.0.52",
      versionCode: "3052",
    });
    writeProjectVersions(dir, nativeAndroidAdapter, [
      { platform: "android", versionName: "3.0.53", versionCode: 3053 },
    ]);
    const after = read("app/build.gradle.kts");
    expect(after).toContain("versionCode = 3053");
    expect(after).toContain('versionName = "3.0.53"'); // 无引号形态统一规范为带引号
  });
});

describe("原生 iOS", () => {
  it("pbxproj 双 configuration 读写", () => {
    w(
      "Qy.xcodeproj/project.pbxproj",
      `a { CURRENT_PROJECT_VERSION = 3.0.08; MARKETING_VERSION = 3.0.08; }\nb { CURRENT_PROJECT_VERSION = 3.0.08; MARKETING_VERSION = 3.0.08; }\n`,
    );
    const vs = readProjectVersions(dir, nativeIosAdapter);
    expect(vs.find((v) => v.platform === "ios")).toMatchObject({
      versionName: "3.0.08",
      versionCode: "3.0.08",
    });
    writeProjectVersions(dir, nativeIosAdapter, [
      { platform: "ios", versionName: "4.0.0", versionCode: 4001 },
    ]);
    expect(
      read("Qy.xcodeproj/project.pbxproj").match(/MARKETING_VERSION = 4\.0\.0;/g),
    ).toHaveLength(2);
  });

  it("pbxproj 缺失：Info.plist 字面量兜底读出", () => {
    w("Qy.xcodeproj/.keep", ""); // 原生工程必有 xcodeproj；pbxproj 缺失 → plist 字面量兜底
    w(
      "Qy/Info.plist",
      `<?xml version="1.0"?><plist><dict>\n<key>CFBundleShortVersionString</key>\n<string>4.0.0</string>\n<key>CFBundleVersion</key>\n<string>4000</string>\n</dict></plist>\n`,
    );
    const vs = readProjectVersions(dir, nativeIosAdapter);
    const ios = vs.find((v) => v.platform === "ios");
    expect(ios).toMatchObject({ versionName: "4.0.0", versionCode: "4000" });
    expect(ios?.problem).toMatch(/Info.plist/);
  });

  it("Info.plist 为 $(VAR) 变量引用：不产出版本条目（pbxproj 才是事实源）", () => {
    w(
      "Qy/Info.plist",
      `<?xml version="1.0"?><plist><dict>\n<key>CFBundleShortVersionString</key>\n<string>$(MARKETING_VERSION)</string>\n</dict></plist>\n`,
    );
    const vs = readProjectVersions(dir, nativeIosAdapter);
    expect(vs.find((v) => v.platform === "ios")).toBeUndefined();
  });
});

describe("未识别框架（tryAll）与 skipped", () => {
  it("framework=null：全部标准位置探测（pubspec + app.json5 并存都读出）", () => {
    w("pubspec.yaml", `name: d\nversion: 1.0.0+1\n`);
    w("harmony/AppScope/app.json5", `{"app":{"versionCode":100,"versionName":"1.0.0"}}\n`);
    const vs = readProjectVersions(dir, null);
    expect(vs.find((v) => v.platform === "flutter")).toMatchObject({ versionName: "1.0.0" });
    expect(vs.find((v) => v.platform === "harmony")).toMatchObject({ versionCode: "100" });
  });

  it("指定端但文件缺失：skipped 说明未找到", () => {
    const r = writeProjectVersions(dir, null, [
      { platform: "android", versionName: "1.0.0", versionCode: 2 },
    ]);
    expect(r.changed).toHaveLength(0);
    expect(r.skipped[0]?.reason).toMatch(/未找到版本文件/);
  });
});
