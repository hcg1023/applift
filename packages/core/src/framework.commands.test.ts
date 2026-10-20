import { describe, expect, it } from "vitest";
import {
  electronAdapter,
  flutterAdapter,
  nativeAndroidAdapter,
  nativeHarmonyAdapter,
  nativeIosAdapter,
  rnAdapter,
  tauriAdapter,
} from "./plugins/frameworks.js";

describe("内置框架产物 pattern（构建命令只走 config.build，adapter 不携带）", () => {
  it("rn：产物 pattern 按 RN 惯例（无内置构建命令，项目特化经 config.build）", () => {
    expect(rnAdapter.artifactPatterns("android")).toContain(
      "android/app/build/outputs/apk/release/*-release.apk",
    );
    expect(rnAdapter.artifactPatterns("ios")).toEqual(["build/ios/ipa/*.ipa"]);
    expect(rnAdapter.artifactPatterns("harmony")[0]).toContain("entry-*-signed.hap");
  });

  it("flutter：三平台产物路径", () => {
    expect(flutterAdapter.artifactPatterns("android")).toEqual([
      "build/app/outputs/flutter-apk/app-release.apk",
    ]);
    expect(flutterAdapter.artifactPatterns("ios")).toEqual(["build/ios/ipa/*.ipa"]);
    expect(flutterAdapter.artifactPatterns("harmony")[0]).toContain("-signed.hap");
    expect(flutterAdapter.artifactPatterns("harmony").some((p) => p.startsWith("harmony/"))).toBe(
      true,
    ); // flutter_flutter_ohos 工程结构
  });

  it("native-android：apk 产物路径", () => {
    expect(nativeAndroidAdapter.artifactPatterns("android")).toEqual([
      "app/build/outputs/apk/release/*-release.apk",
    ]);
  });

  it("native-harmony：signed hap/app 产物路径", () => {
    expect(
      nativeHarmonyAdapter.artifactPatterns("harmony").some((p) => p.includes("signed.hap")),
    ).toBe(true);
    expect(nativeHarmonyAdapter.artifactPatterns("harmony").some((p) => p.endsWith(".app"))).toBe(
      true,
    );
  });
});

describe("适配器探测边界", () => {
  it("native-ios 让位于 RN（react-native 依赖优先）", () => {
    expect(nativeIosAdapter.detect("/")).toBe(false);
  });
  it("native-android 让位于 RN", () => {
    expect(nativeAndroidAdapter.detect("/")).toBe(false);
  });
  it("flutter 对无 pubspec 目录 false", () => {
    expect(flutterAdapter.detect("/")).toBe(false);
  });
  it("harmony 探测 harmony/ 子目录", () => {
    expect(nativeHarmonyAdapter.detect("/")).toBe(false);
  });
});

describe("桌面适配器（Electron/Tauri）全平台", () => {
  it("electron：三桌面平台 patterns，移动平台为空", async () => {
    const electron = electronAdapter;
    // detect 走 deps（非 electron 项目 false）
    expect(electron.detect("/")).toBe(false);
    expect(electron.artifactPatterns("windows")).toEqual([
      "dist/*.exe",
      "dist/**/*.exe",
      "out/make/*.exe",
    ]);
    expect(electron.artifactPatterns("macos")).toContain("dist/*.dmg");
    expect(electron.artifactPatterns("linux")).toContain("dist/*.AppImage");
    expect(electron.artifactPatterns("android")).toEqual([]);
  });

  it("tauri detect（无 src-tauri 且无依赖 false）+ 三平台 patterns", async () => {
    const tauri = tauriAdapter;
    expect(tauri.detect("/")).toBe(false);
    expect(tauri.artifactPatterns("windows")).toContain(
      "src-tauri/target/release/bundle/nsis/*.exe",
    );
    expect(tauri.artifactPatterns("macos")).toContain("src-tauri/target/release/bundle/dmg/*.dmg");
    expect(tauri.artifactPatterns("linux")).toContain("src-tauri/target/release/bundle/deb/*.deb");
    expect(tauri.artifactPatterns("ios")).toEqual([]);
  });

  it("expoAwareLabel：非 Expo 项目返回 React Native", () => {
    expect(rnAdapter.expoAwareLabel?.("/tmp")).toBe("React Native");
  });
});
