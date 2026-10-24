/**
 * 工程文件版本读写契约测试：RN 三端标准夹具（gradle / pbxproj / app.json5 / package.json）
 * + 读写不变量（幂等、保格式、catalog 拒写、$(VAR) 变量引用识别）。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readProjectVersions, writeProjectVersions } from "./project.js";
import { flutterAdapter, rnAdapter } from "../plugins/frameworks.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-version-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const GRADLE = `android {
    defaultConfig {
        applicationId "com.example.app"
        versionCode 4000
        versionName "4.0.0"
    }
}
`;
const PBXPROJ = `		423ABCD = { /* Debug */
				CURRENT_PROJECT_VERSION = 4000;
				MARKETING_VERSION = 4.0.0;
		};
		423ABCE = { /* Release */
				CURRENT_PROJECT_VERSION = 4000;
				MARKETING_VERSION = 4.0.0;
		};
`;
const APP_JSON5 = `{
  "app": {
    "bundleName": "com.example.app",
    // 版本注释要保住
    "versionCode": 4000000,
    "versionName": "4.0.0",
  }
}
`;
const PLIST = `<?xml version="1.0">
<plist><dict>
	<key>CFBundleShortVersionString</key>
	<string>$(MARKETING_VERSION)</string>
</dict></plist>
`;

function makeRnFixture() {
  fs.mkdirSync(path.join(dir, "android", "app"), { recursive: true });
  fs.writeFileSync(path.join(dir, "android", "app", "build.gradle"), GRADLE);
  fs.mkdirSync(path.join(dir, "ios", "QyDriver.xcodeproj"), { recursive: true });
  fs.writeFileSync(path.join(dir, "ios", "QyDriver.xcodeproj", "project.pbxproj"), PBXPROJ);
  fs.mkdirSync(path.join(dir, "ios", "QyDriver"), { recursive: true });
  fs.writeFileSync(path.join(dir, "ios", "QyDriver", "Info.plist"), PLIST);
  fs.mkdirSync(path.join(dir, "harmony", "AppScope"), { recursive: true });
  fs.writeFileSync(path.join(dir, "harmony", "AppScope", "app.json5"), APP_JSON5);
  fs.writeFileSync(
    path.join(dir, "package.json"),
    `{\n  "name": "app",\n  "version": "4.0.0",\n}\n`,
  );
}

describe("readProjectVersions（RN 布局）", () => {
  it("三端 + js 源头全读出", () => {
    makeRnFixture();
    const vs = readProjectVersions(dir, rnAdapter);
    const by = Object.fromEntries(vs.map((v) => [v.platform, v]));
    expect(by.android).toMatchObject({ versionName: "4.0.0", versionCode: "4000" });
    expect(by.ios).toMatchObject({ versionName: "4.0.0", versionCode: "4000" });
    expect(by.harmony).toMatchObject({ versionName: "4.0.0", versionCode: "4000000" });
    expect(by.js).toMatchObject({ versionName: "4.0.0" });
    // $(VAR) 变量引用不作为 iOS 事实源（pbxproj 已读到 → plist 不产出条目）
    expect(vs.filter((v) => v.platform === "ios")).toHaveLength(1);
  });

  it("版本文件为空（损坏/占位形态）→ 读取不炸、无版本信息（不猜）", () => {
    makeRnFixture();
    // 三端版本文件清空为 0 字节；package.json 保持合法 JSON（js 读取走 JSON.parse）
    fs.writeFileSync(path.join(dir, "android", "app", "build.gradle"), "");
    fs.writeFileSync(path.join(dir, "ios", "QyDriver.xcodeproj", "project.pbxproj"), "");
    fs.writeFileSync(path.join(dir, "ios", "QyDriver", "Info.plist"), "");
    fs.writeFileSync(path.join(dir, "harmony", "AppScope", "app.json5"), "");
    fs.writeFileSync(path.join(dir, "package.json"), `{"name":"app"}\n`);
    const vs = readProjectVersions(dir, rnAdapter);
    expect(vs.every((v) => v.versionName === undefined && v.versionCode === undefined)).toBe(true);
  });

  it("MARKETING_VERSION 多 target 不一致 → problem 标注（读第一个，写时全量同步）", () => {
    makeRnFixture();
    // Debug 4.0.0 / Release 4.1.0：读第一个并标注不一致
    fs.writeFileSync(
      path.join(dir, "ios", "QyDriver.xcodeproj", "project.pbxproj"),
      `		423ABCD = { /* Debug */
				CURRENT_PROJECT_VERSION = 4000;
				MARKETING_VERSION = 4.0.0;
		};
		423ABCE = { /* Release */
				CURRENT_PROJECT_VERSION = 4000;
				MARKETING_VERSION = 4.1.0;
		};
`,
    );
    const ios = readProjectVersions(dir, rnAdapter).find((v) => v.platform === "ios");
    expect(ios?.problem).toMatch(/多 target MARKETING_VERSION 不一致/);
    expect(ios?.versionName).toBe("4.0.0"); // 读第一个
  });

  it("ios 的 xcodeproj 嵌套一层子目录也能定位（子目录扫描）", () => {
    fs.mkdirSync(path.join(dir, "ios", "Qy", "QyDriver.xcodeproj"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ios", "Qy", "QyDriver.xcodeproj", "project.pbxproj"), PBXPROJ);
    fs.mkdirSync(path.join(dir, "ios", "Qy", "QyDriver"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ios", "Qy", "QyDriver", "Info.plist"), PLIST);
    const ios = readProjectVersions(dir, rnAdapter).find((v) => v.platform === "ios");
    expect(ios).toMatchObject({ versionName: "4.0.0", versionCode: "4000" });
  });

  it("json 版本键：压缩单行走 JSON.parse 顶层；非 JSON 文本走首匹配", () => {
    // 压缩单行（无行锚点）：JSON.parse 取顶层
    fs.writeFileSync(path.join(dir, "package.json"), `{"name":"a","version":"3.3.3"}`);
    expect(readProjectVersions(dir, rnAdapter).find((v) => v.platform === "js")?.versionName).toBe(
      "3.3.3",
    );
    // 非 JSON 文本含 version 字符串：回退首匹配
    fs.writeFileSync(path.join(dir, "package.json"), `oops "version": "5.5.5" tail`);
    expect(readProjectVersions(dir, rnAdapter).find((v) => v.platform === "js")?.versionName).toBe(
      "5.5.5",
    );
  });

  it("flutter pubspec：空文件/无 version 行读取不炸；带注释写回保留注释", () => {
    fs.writeFileSync(path.join(dir, "pubspec.yaml"), "");
    expect(
      readProjectVersions(dir, flutterAdapter).find((v) => v.platform === "flutter")?.versionName,
    ).toBeUndefined(); // 空文件 → 无版本信息
    fs.writeFileSync(path.join(dir, "pubspec.yaml"), `name: demo\n`);
    expect(
      readProjectVersions(dir, flutterAdapter).find((v) => v.platform === "flutter")?.versionName,
    ).toBeUndefined(); // 无 version 行 → 不猜
    // 带行尾注释写回：值替换、注释保留
    fs.writeFileSync(path.join(dir, "pubspec.yaml"), `name: demo\nversion: 1.0.0+1 # released\n`);
    const r = writeProjectVersions(dir, flutterAdapter, [
      { platform: "flutter", versionName: "2.0.0", versionCode: 2 },
    ]);
    expect(r.skipped).toHaveLength(0);
    expect(fs.readFileSync(path.join(dir, "pubspec.yaml"), "utf8")).toContain(
      "version: 2.0.0+2 # released",
    );
  });

  it("写入遇 0 字节版本文件 → 该端被跳过并给出原因（不静默写坏文件）", () => {
    makeRnFixture();
    fs.writeFileSync(path.join(dir, "android", "app", "build.gradle"), "");
    const r = writeProjectVersions(dir, rnAdapter, [
      { platform: "android", versionName: "4.1.0", versionCode: 4001 },
    ]);
    expect(r.changed).toHaveLength(0);
    expect(r.skipped.map((s) => s.platform)).toContain("android");
  });

  it("expo app.json：无 versionCode 时 buildNumber 回退读取", () => {
    fs.writeFileSync(
      path.join(dir, "app.json"),
      `{\n  "expo": {\n    "name": "demo",\n    "ios": { "buildNumber": "42" }\n  }\n}\n`,
    );
    const expo = readProjectVersions(dir, rnAdapter).find((v) => v.platform === "expo");
    expect(expo?.versionCode).toBe("42"); // 无 versionCode → buildNumber 回退
  });

  it("catalog 引用形态读出但标注 problem（提示改造）", () => {
    fs.mkdirSync(path.join(dir, "android", "app"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "android", "app", "build.gradle.kts"),
      `versionCode = libs.versions.versionCode.get().toInt()\nversionName = libs.versions.versionName.get()\n`,
    );
    const vs = readProjectVersions(dir, rnAdapter);
    const android = vs.find((v) => v.platform === "android");
    expect(android?.problem).toMatch(/catalog/);
  });
});

describe("writeProjectVersions（幂等行级改写）", () => {
  it("全端写回：多 configuration 全替换、注释保留、跑两次内容不变", () => {
    makeRnFixture();
    const writes = [
      { platform: "android", versionName: "4.1.0", versionCode: 4001 },
      { platform: "ios", versionName: "4.1.0", versionCode: 4001 },
      { platform: "harmony", versionName: "4.1.0", versionCode: 4000001 },
      { platform: "js", versionName: "4.1.0", versionCode: 0 },
    ];
    const r1 = writeProjectVersions(dir, rnAdapter, writes);
    expect(r1.skipped).toHaveLength(0);

    const gradle = fs.readFileSync(path.join(dir, "android", "app", "build.gradle"), "utf8");
    expect(gradle).toContain("versionCode 4001");
    expect(gradle).toContain('versionName "4.1.0"');
    expect(gradle).toContain('applicationId "com.example.app"'); // 相邻行不动

    const pbx = fs.readFileSync(
      path.join(dir, "ios", "QyDriver.xcodeproj", "project.pbxproj"),
      "utf8",
    );
    expect(pbx.match(/MARKETING_VERSION = 4\.1\.0;/g)).toHaveLength(2); // Debug+Release
    expect(pbx.match(/CURRENT_PROJECT_VERSION = 4001;/g)).toHaveLength(2);

    const json5 = fs.readFileSync(path.join(dir, "harmony", "AppScope", "app.json5"), "utf8");
    expect(json5).toContain("// 版本注释要保住"); // 注释保留
    expect(json5).toContain('"versionCode": 4000001');

    expect(fs.readFileSync(path.join(dir, "package.json"), "utf8")).toContain('"version": "4.1.0"');

    // 幂等：同参数重写，内容不变
    const before = fs.readFileSync(path.join(dir, "android", "app", "build.gradle"), "utf8");
    writeProjectVersions(dir, rnAdapter, writes);
    expect(fs.readFileSync(path.join(dir, "android", "app", "build.gradle"), "utf8")).toBe(before);
  });

  it("catalog 引用形态拒绝写入（skip 并说明，不误伤其他端）", () => {
    fs.mkdirSync(path.join(dir, "android", "app"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "android", "app", "build.gradle"),
      `versionCode = libs.versions.versionCode.get().toInt()\nversionName = "4.0.0"\n`,
    );
    const r = writeProjectVersions(dir, rnAdapter, [
      { platform: "android", versionName: "4.1.0", versionCode: 4001 },
    ]);
    expect(r.changed).toHaveLength(0);
    expect(r.skipped[0]?.reason).toMatch(/catalog/);
  });

  it("版本值未变时不列为 changed（version 命令 --platform js 场景的写放大防护）", () => {
    makeRnFixture();
    const r = writeProjectVersions(dir, rnAdapter, [
      { platform: "js", versionName: "4.0.0", versionCode: 0 },
    ]);
    expect(r.changed).toHaveLength(0);
  });
});
