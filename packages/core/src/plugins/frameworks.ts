/**
 * framework 插件工厂：内置七个框架适配器的声明式形态。
 *
 * applift.config.ts 的 plugins 数组声明其一（如 rnFramework({...})），
 * 经 'framework:register' 钩子注册 adapter；声明即唯一来源（见 resolveFramework）。
 * 项目特化（如自定义构建命令）通过工厂参数覆盖，不进 applift core。
 */
import fs from "node:fs";
import path from "node:path";
import type { AppliftPlugin } from "../plugin.js";
import { deps, readJson, subdirs, type FrameworkAdapter } from "../framework.js";

function frameworkPlugin(name: string, adapter: FrameworkAdapter): AppliftPlugin {
  return {
    name,
    "framework:register"(adapters) {
      adapters.push(adapter);
    },
  };
}

// ── React Native ───────────────────────────────────────────────────────────

/** 生态通用 RN adapter：产物 pattern 按 RN 社区惯例；构建命令无统一标准（项目覆盖） */
export const rnAdapter: FrameworkAdapter = {
  id: "rn",
  label: "React Native",
  detect(cwd) {
    const pkg = readJson(path.join(cwd, "package.json"));
    return "react-native" in deps(pkg);
  },
  /** Expo 项目（依赖 expo 包）：同走 RN 产物路径（prebuild 生成原生工程），label 区分展示 */
  expoAwareLabel(cwd: string): string {
    const pkg = readJson(path.join(cwd, "package.json"));
    return "expo" in deps(pkg) ? "Expo (React Native)" : "React Native";
  },
  artifactPatterns(platform) {
    if (platform === "android") {
      return ["android/app/build/outputs/apk/release/*-release.apk"];
    }
    if (platform === "ios") return ["build/ios/ipa/*.ipa"];
    return [
      "harmony/entry/build/default/outputs/**/entry-*-signed.hap",
      "harmony/entry/build/default/outputs/**/entry-*.app",
      // assembleApp 整包（AGC 测试发布/上架用）在工程级 build/outputs
      "harmony/build/outputs/**/*.app",
      "build/outputs/**/*.app",
    ];
  },
};

export function rnFramework(): AppliftPlugin {
  return frameworkPlugin("framework-react-native", rnAdapter);
}

// ── Flutter ────────────────────────────────────────────────────────────────

export const flutterAdapter: FrameworkAdapter = {
  id: "flutter",
  label: "Flutter",
  detect(cwd) {
    const pubspec = readJson(path.join(cwd, "pubspec.yaml")); // pubspec 是 YAML，readJson 失败则退文本探测
    if (pubspec) return true;
    try {
      const text = fs.readFileSync(path.join(cwd, "pubspec.yaml"), "utf8");
      return /^sdk:\s*flutter$/m.test(text) || /^name:/m.test(text);
    } catch {
      return false;
    }
  },
  artifactPatterns(platform) {
    if (platform === "android") return ["build/app/outputs/flutter-apk/app-release.apk"];
    if (platform === "ios") return ["build/ios/ipa/*.ipa"];
    return [
      "build/**/outputs/**/*-signed.hap",
      "harmony/entry/build/**/outputs/**/*-signed.hap",
      "ohos/entry/build/**/outputs/**/*-signed.hap",
      "build/**/outputs/**/*.app",
    ];
  },
};

export function flutterFramework(): AppliftPlugin {
  return frameworkPlugin("framework-flutter", flutterAdapter);
}

// ── 原生 Android ───────────────────────────────────────────────────────────

export const nativeAndroidAdapter: FrameworkAdapter = {
  id: "native-android",
  label: "原生 Android",
  detect(cwd) {
    if (rnAdapter.detect(cwd)) return false;
    return (
      fs.existsSync(path.join(cwd, "settings.gradle")) ||
      fs.existsSync(path.join(cwd, "settings.gradle.kts"))
    );
  },
  artifactPatterns() {
    return ["app/build/outputs/apk/release/*-release.apk"];
  },
};

export function nativeAndroidFramework(): AppliftPlugin {
  return frameworkPlugin("framework-native-android", nativeAndroidAdapter);
}

// ── 原生 iOS ───────────────────────────────────────────────────────────────

export const nativeIosAdapter: FrameworkAdapter = {
  id: "native-ios",
  label: "原生 iOS",
  detect(cwd) {
    if (rnAdapter.detect(cwd)) return false;
    // Xcode 工程常嵌在子目录（如 newdriver-ios/clouddriver/）：两层内探测
    for (const dir of [cwd, ...subdirs(cwd, 1)]) {
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue; // 无权限目录跳过
      }
      if (
        entries.some((f) => String(f).endsWith(".xcodeproj") || String(f).endsWith(".xcworkspace"))
      ) {
        return true;
      }
    }
    return false;
  },
  artifactPatterns() {
    return ["build/**/*.ipa"];
  },
};

export function nativeIosFramework(): AppliftPlugin {
  return frameworkPlugin("framework-native-ios", nativeIosAdapter);
}

// ── 原生鸿蒙（ArkTS）───────────────────────────────────────────────────────

export const nativeHarmonyAdapter: FrameworkAdapter = {
  id: "native-harmony",
  label: "原生鸿蒙 (ArkTS)",
  detect(cwd) {
    // RN 鸿蒙与原生鸿蒙共享 hvigor 工程；以 oh-package.json5 存在即认（产物路径一致）
    return (
      fs.existsSync(path.join(cwd, "oh-package.json5")) ||
      fs.existsSync(path.join(cwd, "harmony/oh-package.json5"))
    );
  },
  artifactPatterns() {
    return [
      "entry/build/default/outputs/**/entry-*-signed.hap",
      "entry/build/default/outputs/**/entry-*.app",
      "harmony/entry/build/default/outputs/**/*-signed.hap",
      // assembleApp 整包（AGC 测试发布/正式上架用）在工程级 build/outputs
      "build/outputs/**/*.app",
      "harmony/build/outputs/**/*.app",
      "ohos/build/outputs/**/*.app",
    ];
  },
};

export function nativeHarmonyFramework(): AppliftPlugin {
  return frameworkPlugin("framework-native-harmony", nativeHarmonyAdapter);
}

// ── Electron / Tauri（桌面）────────────────────────────────────────────────

export const electronAdapter: FrameworkAdapter = {
  id: "electron",
  label: "Electron",
  detect(cwd) {
    const pkg = readJson(path.join(cwd, "package.json"));
    return "electron" in deps(pkg);
  },
  artifactPatterns(platform) {
    if (platform === "windows") return ["dist/*.exe", "dist/**/*.exe", "out/make/*.exe"];
    if (platform === "macos") return ["dist/*.dmg", "dist/**/*.dmg", "out/make/*.dmg"];
    if (platform === "linux")
      return ["dist/*.AppImage", "dist/**/*.AppImage", "out/make/*.AppImage"];
    return [];
  },
};

export function electronFramework(): AppliftPlugin {
  return frameworkPlugin("framework-electron", electronAdapter);
}

export const tauriAdapter: FrameworkAdapter = {
  id: "tauri",
  label: "Tauri",
  detect(cwd) {
    const pkg = readJson(path.join(cwd, "package.json"));
    return "@tauri-apps/cli" in deps(pkg) || fs.existsSync(path.join(cwd, "src-tauri"));
  },
  artifactPatterns(platform) {
    if (platform === "windows")
      return [
        "src-tauri/target/release/bundle/nsis/*.exe",
        "src-tauri/target/release/bundle/msi/*.msi",
      ];
    if (platform === "macos")
      return [
        "src-tauri/target/release/bundle/dmg/*.dmg",
        "src-tauri/target/release/bundle/macos/*.app",
      ];
    if (platform === "linux")
      return [
        "src-tauri/target/release/bundle/deb/*.deb",
        "src-tauri/target/release/bundle/appimage/*.AppImage",
      ];
    return [];
  },
};

// ── 探测建议（init/doctor 向导场景；发布链路一律走 resolveFramework 声明式）──

export const knownFrameworkAdapters: FrameworkAdapter[] = [
  rnAdapter,
  flutterAdapter,
  electronAdapter,
  tauriAdapter,
  nativeAndroidAdapter,
  nativeIosAdapter,
  nativeHarmonyAdapter,
];

/** 按已知框架表探测建议（仅供 init/doctor 展示，不是发布依据） */
export function suggestFramework(cwd: string): FrameworkAdapter | null {
  for (const adapter of knownFrameworkAdapters) {
    try {
      if (adapter.detect(cwd)) return adapter;
    } catch {
      // 探测异常视为不匹配
    }
  }
  return null;
}

export function tauriFramework(): AppliftPlugin {
  return frameworkPlugin("framework-tauri", tauriAdapter);
}
