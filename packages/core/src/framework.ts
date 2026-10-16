/**
 * 框架适配器：让 applift 框架无关（RN / Flutter / 原生安卓 / 原生 iOS / 原生鸿蒙）。
 * 探测规则 + 产物 pattern + 缺省构建命令；插件可用 'channel:register' 旁路注册自定义 FrameworkAdapter。
 */
import fs from "node:fs";
import path from "node:path";

/** 分发平台。内置移动三端 + 桌面三端；插件适配器可自报任意平台标识（如 'switch'） */
export type Platform =
  | "android"
  | "harmony"
  | "ios"
  | "windows"
  | "macos"
  | "linux"
  | (string & {});

export interface FrameworkAdapter {
  id: string;
  label: string;
  /** 探测项目根是否为本框架 */
  detect(cwd: string): boolean;
  /** 各平台产物 glob（相对项目根，支持 * 简单通配） */
  artifactPatterns(platform: Platform): string[];
  /** 缺省构建命令（null=不构建，仅用已有产物） */
  buildCommand(platform: Platform): string[] | null;
  /** 展示名细化（如 RN 检出 Expo），可选 */
  expoAwareLabel?(cwd: string): string;
}

/** 一层子目录列表（探测用，跳过隐藏目录与 node_modules/Pods） */
function subdirs(cwd: string, depth: number): string[] {
  if (depth <= 0) return [];
  const out: string[] = [];
  for (const name of fs.readdirSync(cwd, { withFileTypes: true })) {
    if (
      !name.isDirectory() ||
      name.name.startsWith(".") ||
      name.name === "node_modules" ||
      name.name === "Pods"
    )
      continue;
    const p = path.join(cwd, name.name);
    out.push(p, ...subdirs(p, depth - 1));
  }
  return out;
}

/** package.json 读取（容错） */
function readJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function deps(pkg: Record<string, unknown> | null): Record<string, unknown> {
  if (!pkg) return {};
  return {
    ...(pkg.dependencies as Record<string, unknown>),
    ...(pkg.devDependencies as Record<string, unknown>),
  };
}

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
    ];
  },
  buildCommand(platform) {
    if (platform === "android") return ["npm", "run", "build:test", "--", "--platform", "android"];
    if (platform === "ios") return null; // ipa 导出走 core build 流程（archive+export）
    return ["npm", "run", "build:test", "--", "--platform", "harmony"];
  },
};

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
  buildCommand(platform) {
    if (platform === "android") return ["flutter", "build", "apk", "--release"];
    if (platform === "ios") return ["flutter", "build", "ipa", "--release"];
    return ["flutter", "build", "hap", "--release"];
  },
};

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
  buildCommand() {
    return ["./gradlew", "assembleRelease"];
  },
};

export const nativeIosAdapter: FrameworkAdapter = {
  id: "native-ios",
  label: "原生 iOS",
  detect(cwd) {
    if (rnAdapter.detect(cwd)) return false;
    // Xcode 工程常嵌在子目录（如 newdriver-ios/clouddriver/）：两层内探测
    for (const dir of [cwd, ...subdirs(cwd, 1)]) {
      if (
        fs
          .readdirSync(dir)
          .some((f) => String(f).endsWith(".xcodeproj") || String(f).endsWith(".xcworkspace"))
      ) {
        return true;
      }
    }
    return false;
  },
  artifactPatterns() {
    return ["build/**/*.ipa"];
  },
  buildCommand() {
    return null; // xcodebuild 参数依赖 scheme 配置，M2 由项目配置 build.ios 指定
  },
};

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
    ];
  },
  buildCommand() {
    return [
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
    ];
  },
};

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
  buildCommand(platform) {
    if (platform === "windows") return ["npx", "electron-forge", "make", "--platform", "win32"];
    if (platform === "macos") return ["npx", "electron-forge", "make", "--platform", "darwin"];
    return ["npx", "electron-forge", "make", "--platform", "linux"];
  },
};

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
  buildCommand(platform) {
    if (platform === "macos") return ["npx", "tauri", "build"];
    return ["npx", "tauri", "build"];
  },
};

const BUILTIN_ADAPTERS: FrameworkAdapter[] = [
  rnAdapter,
  flutterAdapter,
  electronAdapter,
  tauriAdapter,
  nativeAndroidAdapter,
  nativeIosAdapter,
  nativeHarmonyAdapter,
];

/** 探测项目框架（可注入额外适配器，插件自定义框架的扩展点） */
export function detectFramework(
  cwd: string,
  extra: FrameworkAdapter[] = [],
): FrameworkAdapter | null {
  for (const adapter of [...extra, ...BUILTIN_ADAPTERS]) {
    try {
      if (adapter.detect(cwd)) return adapter;
    } catch {
      // 探测异常视为不匹配
    }
  }
  return null;
}

/** 按 pattern 扫描产物（支持 ** 与 * 简单通配，返回绝对路径，多产物按 mtime 新者在前） */
export function findArtifacts(cwd: string, patterns: string[]): string[] {
  const byPath = new Map<string, number>();
  for (const pattern of patterns) {
    for (const p of globWalk(path.resolve(cwd), pattern.split("/"))) {
      if (byPath.has(p)) continue;
      try {
        byPath.set(p, fs.statSync(p).mtimeMs);
      } catch {
        // 忽略 stat 失败
      }
    }
  }
  return [...byPath].sort((a, b) => b[1] - a[1]).map(([p]) => p);
}

/** 自动推导的三端应用标识（配置缺省时的兜底来源，全部可选） */
export interface BundleIds {
  /** 安卓包名：RN app.json android.applicationId / 原生 app/build.gradle(.kts) applicationId */
  androidPkgName?: string;
  /** 鸿蒙 bundleName：AppScope/app.json5（根或 harmony/ 下） */
  harmonyBundleName?: string;
  /** iOS bundleId：RN app.json ios.bundleIdentifier / pbxproj PRODUCT_BUNDLE_IDENTIFIER */
  iosBundleId?: string;
  /** iOS 工程名（xcodeproj 名，即缺省 scheme） */
  iosScheme?: string;
}

/** 文本读取（容错：不存在/不可读返回 null，绝不抛；detectBundleIds 各源共用） */
function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/** 从 JSON 对象按路径取非空字符串（任一层缺失/非字符串返回 undefined） */
function pickString(obj: Record<string, unknown> | null, ...keys: string[]): string | undefined {
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return typeof cur === "string" && cur.trim() ? cur.trim() : undefined;
}

/** 原生安卓 applicationId（groovy/kts 两种赋值语法；app/ 与 android/app/ 两处布局；不中返回 undefined） */
function gradleApplicationId(cwd: string): string | undefined {
  const candidates = [
    path.join(cwd, "app", "build.gradle"),
    path.join(cwd, "app", "build.gradle.kts"),
    path.join(cwd, "android", "app", "build.gradle"),
    path.join(cwd, "android", "app", "build.gradle.kts"),
  ];
  for (const file of candidates) {
    const text = readText(file);
    if (!text) continue;
    const m = /(?:^|\s)applicationId\s*[=:]?\s*["']([^"'\s]+)["']/.exec(text);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

/** 鸿蒙 AppScope/app.json5 的 bundleName（json5 允许注释/尾逗号，正则取值而非 JSON 解析） */
function appJson5BundleName(file: string): string | undefined {
  const text = readText(file);
  const m = text && /"bundleName"\s*:\s*"([^"]+)"/.exec(text);
  return m?.[1];
}

/** 两层子目录内找首个 *.xcodeproj：pbxproj 第一个非变量（含 $ 的 $(...) 与 ${...}）的 PRODUCT_BUNDLE_IDENTIFIER + 工程名（Pods 已被 subdirs 排除） */
function findPbxproj(cwd: string): { bundleId: string; scheme: string } | null {
  for (const dir of [cwd, ...subdirs(cwd, 2)]) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const projects = entries
      .filter((e) => e.isDirectory() && e.name.endsWith(".xcodeproj"))
      .map((e) => e.name)
      .sort();
    for (const name of projects) {
      const pbx = readText(path.join(dir, name, "project.pbxproj"));
      if (!pbx) continue;
      for (const m of pbx.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;]+);/g)) {
        const value = m[1]!.trim().replace(/^["']|["']$/g, "");
        if (value && !value.includes("$")) {
          return { bundleId: value, scheme: name.slice(0, -".xcodeproj".length) };
        }
      }
    }
  }
  return null;
}

/**
 * 自动推导三端应用标识（项目配置缺省时的兜底，配置可全空）：
 * android：RN app.json android.applicationId > 原生 gradle applicationId；
 * harmony：AppScope/app.json5（根或 harmony/ 下）> RN app.json harmony.bundleName；
 * ios：RN app.json ios.bundleIdentifier > 两层内 xcodeproj 的 PRODUCT_BUNDLE_IDENTIFIER（scheme=工程名）。
 * 容错：文件不存在/正则不中只置 undefined，绝不抛。
 */
export function detectBundleIds(cwd: string): BundleIds {
  const appJson = readJson(path.join(cwd, "app.json"));
  const pbx = findPbxproj(cwd);
  // Expo：app.json 的 expo 段（expo.android.package / expo.ios.bundleIdentifier）优先于 prebuild 产物
  const expo = (appJson?.expo ?? null) as Record<string, unknown> | null;
  const expoAndroid = expo
    ? pickString(expo as Record<string, unknown>, "android", "package")
    : undefined;
  const expoIos = expo
    ? pickString(expo as Record<string, unknown>, "ios", "bundleIdentifier")
    : undefined;
  const expoName = expo && typeof expo.name === "string" ? expo.name : undefined;
  return {
    androidPkgName:
      expoAndroid ?? pickString(appJson, "android", "applicationId") ?? gradleApplicationId(cwd),
    harmonyBundleName:
      appJson5BundleName(path.join(cwd, "AppScope", "app.json5")) ??
      appJson5BundleName(path.join(cwd, "harmony", "AppScope", "app.json5")) ??
      pickString(appJson, "harmony", "bundleName"),
    iosBundleId: expoIos ?? pickString(appJson, "ios", "bundleIdentifier") ?? pbx?.bundleId,
    iosScheme: pbx?.scheme ?? expoName,
  };
}

/** 极简 glob 目录游走（** 跨层，* 单段），避免引入 minimatch 依赖 */
function globWalk(dir: string, segments: string[]): string[] {
  const [head, ...rest] = segments;
  if (!head) return [dir];
  if (!fs.existsSync(dir)) return [];
  if (head === "**") {
    const out: string[] = [];
    // ** 匹配零层或多层：对自身与每个子孙目录各做一次 rest 匹配（去重）；递归跳过隐藏目录与 node_modules（依赖目录无产物，大目录下代价高）
    const walkAll = (d: string) => {
      out.push(...globWalk(d, rest));
      for (const name of fs.readdirSync(d, { withFileTypes: true })) {
        if (!name.isDirectory() || name.name.startsWith(".") || name.name === "node_modules")
          continue;
        walkAll(path.join(d, name.name));
      }
    };
    walkAll(dir);
    return [...new Set(out)];
  }
  if (head.includes("*")) {
    const re = new RegExp(`^${head.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
    const out: string[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (re.test(name)) out.push(...globWalk(path.join(dir, name), rest));
    }
    return out;
  }
  return globWalk(path.join(dir, head), rest);
}
