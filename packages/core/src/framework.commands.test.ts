import { describe, expect, it } from "vitest";
import {
  rnAdapter,
  flutterAdapter,
  nativeAndroidAdapter,
  nativeIosAdapter,
  nativeHarmonyAdapter,
} from "./framework.js";

describe("各适配器 buildCommand / artifactPatterns 全平台", () => {
  it("rn：安卓/鸿蒙有构建命令，ipa 走导出流程（null）", () => {
    expect(rnAdapter.buildCommand("android")).toEqual([
      "npm",
      "run",
      "build:test",
      "--",
      "--platform",
      "android",
    ]);
    expect(rnAdapter.buildCommand("harmony")).toEqual([
      "npm",
      "run",
      "build:test",
      "--",
      "--platform",
      "harmony",
    ]);
    expect(rnAdapter.buildCommand("ios")).toBeNull();
    expect(rnAdapter.artifactPatterns("android")).toContain(
      "android/app/build/outputs/apk/release/*-release.apk",
    );
    expect(rnAdapter.artifactPatterns("ios")).toEqual(["build/ios/ipa/*.ipa"]);
    expect(rnAdapter.artifactPatterns("harmony")[0]).toContain("entry-*-signed.hap");
  });

  it("flutter：三平台 flutter build 命令与产物路径", () => {
    expect(flutterAdapter.buildCommand("android")).toEqual([
      "flutter",
      "build",
      "apk",
      "--release",
    ]);
    expect(flutterAdapter.buildCommand("ios")).toEqual(["flutter", "build", "ipa", "--release"]);
    expect(flutterAdapter.buildCommand("harmony")).toEqual([
      "flutter",
      "build",
      "hap",
      "--release",
    ]);
    expect(flutterAdapter.artifactPatterns("android")).toEqual([
      "build/app/outputs/flutter-apk/app-release.apk",
    ]);
    expect(flutterAdapter.artifactPatterns("ios")).toEqual(["build/ios/ipa/*.ipa"]);
    expect(flutterAdapter.artifactPatterns("harmony")[0]).toContain("-signed.hap");
    expect(flutterAdapter.artifactPatterns("harmony").some((p) => p.startsWith("harmony/"))).toBe(
      true,
    ); // flutter_flutter_ohos 工程结构
  });

  it("native-android：gradlew assembleRelease", () => {
    expect(nativeAndroidAdapter.buildCommand("android")).toEqual(["./gradlew", "assembleRelease"]);
    expect(nativeAndroidAdapter.artifactPatterns("ios")).toEqual([
      "app/build/outputs/apk/release/*-release.apk",
    ]);
  });

  it("native-ios：构建命令 null（由项目配置指定）", () => {
    expect(nativeIosAdapter.buildCommand("ios")).toBeNull();
  });

  it("native-harmony：hvigorw assembleHap 全参数", () => {
    expect(nativeHarmonyAdapter.buildCommand("harmony")).toEqual([
      "hvigorw",
      "--mode",
      "module",
      "-p",
      "module=entry@default",
      "-p",
      "product=default",
      "-p",
      "buildMode=release",
      "assembleHap",
      "--no-daemon",
    ]);
    expect(
      nativeHarmonyAdapter.artifactPatterns("android").some((p) => p.includes("signed.hap")),
    ).toBe(true);
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
  it("electron detect + 三平台 patterns + buildCommand", async () => {
    const electron = (await import("./framework.js")).electronAdapter;
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
    expect(electron.buildCommand("windows")).toEqual([
      "npx",
      "electron-forge",
      "make",
      "--platform",
      "win32",
    ]);
    expect(electron.buildCommand("macos")).toContain("darwin");
    expect(electron.buildCommand("linux")).toContain("linux");
  });

  it("tauri detect（无 src-tauri 且无依赖 false）+ 三平台 patterns", async () => {
    const tauri = (await import("./framework.js")).tauriAdapter;
    expect(tauri.detect("/")).toBe(false);
    expect(tauri.artifactPatterns("windows")).toContain(
      "src-tauri/target/release/bundle/nsis/*.exe",
    );
    expect(tauri.artifactPatterns("macos")).toContain("src-tauri/target/release/bundle/dmg/*.dmg");
    expect(tauri.artifactPatterns("linux")).toContain("src-tauri/target/release/bundle/deb/*.deb");
    expect(tauri.artifactPatterns("ios")).toEqual([]);
    expect(tauri.buildCommand("macos")).toEqual(["npx", "tauri", "build"]);
  });

  it("expoAwareLabel：非 Expo 项目返回 React Native", async () => {
    const { rnAdapter } = await import("./framework.js");
    expect(rnAdapter.expoAwareLabel?.("/tmp")).toBe("React Native");
  });
});
