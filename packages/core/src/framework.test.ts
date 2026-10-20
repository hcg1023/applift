import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectBundleIds,
  findArtifacts,
  resolveFramework,
  type FrameworkAdapter,
} from "./framework.js";
import {
  flutterAdapter,
  nativeAndroidAdapter,
  nativeHarmonyAdapter,
  nativeIosAdapter,
  rnAdapter,
} from "./plugins/frameworks.js";

function tmpProject(setup: (dir: string) => void): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-fw-"));
  setup(dir);
  return dir;
}

describe("adapter detect（插件适配器的工程识别）", () => {
  it("识别 RN（package.json 含 react-native）", () => {
    const dir = tmpProject((d) => {
      fs.writeFileSync(
        path.join(d, "package.json"),
        JSON.stringify({ dependencies: { "react-native": "0.84.0" } }),
      );
    });
    expect(rnAdapter.detect(dir)).toBe(true);
  });

  it("识别 Flutter（pubspec.yaml 含 flutter sdk）", () => {
    const dir = tmpProject((d) => {
      fs.writeFileSync(
        path.join(d, "pubspec.yaml"),
        'name: demo\nenvironment:\n  sdk: ">=3.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n',
      );
    });
    expect(flutterAdapter.detect(dir)).toBe(true);
  });

  it("识别原生 Android（settings.gradle 且非 RN）", () => {
    const dir = tmpProject((d) => {
      fs.writeFileSync(path.join(d, "settings.gradle"), "include ':app'\n");
    });
    expect(nativeAndroidAdapter.detect(dir)).toBe(true);
  });

  it("识别原生鸿蒙（oh-package.json5）", () => {
    const dir = tmpProject((d) => {
      fs.writeFileSync(path.join(d, "oh-package.json5"), '{ "name": "entry" }');
    });
    expect(nativeHarmonyAdapter.detect(dir)).toBe(true);
  });

  it("注册自定义 framework adapter 时 resolveFramework 生效（插件扩展点）", () => {
    const dir = tmpProject((d) => {
      fs.writeFileSync(path.join(d, "UnityProject.txt"), "x");
    });
    const custom: FrameworkAdapter = {
      id: "unity",
      label: "Unity",
      detect: (d) => fs.existsSync(path.join(d, "UnityProject.txt")),
      artifactPatterns: () => ["Build/*.apk"],
    };
    expect(resolveFramework(dir, [custom])?.id).toBe("unity");
  });
});

describe("resolveFramework（声明式：插件注册是唯一来源）", () => {
  it("未注册任何 adapter 返回 null（CLI 层负责提示声明）", () => {
    const dir = tmpProject(() => {});
    expect(resolveFramework(dir, [])).toBeNull();
  });

  it("注册单个 adapter 且 detect 通过 → 返回该 adapter", () => {
    const dir = tmpProject((d) => {
      fs.writeFileSync(
        path.join(d, "package.json"),
        JSON.stringify({ dependencies: { "react-native": "0.84.0" } }),
      );
    });
    expect(resolveFramework(dir, [rnAdapter])?.id).toBe("rn");
  });

  it("注册单个 adapter 但 detect 不通过 → 抛错（声明与工程不符）", () => {
    const dir = tmpProject((d) => {
      fs.writeFileSync(path.join(d, "pubspec.yaml"), "name: demo\n");
    });
    expect(() => resolveFramework(dir, [rnAdapter])).toThrow(/不匹配/);
  });

  it("注册多个 adapter → 抛错（只能声明一个 framework）", () => {
    const dir = tmpProject(() => {});
    expect(() => resolveFramework(dir, [rnAdapter, flutterAdapter])).toThrow(/多个/);
  });
});

describe("findArtifacts", () => {
  it("按 pattern 扫描并按 mtime 新者在前", () => {
    const dir = tmpProject((d) => {
      fs.mkdirSync(path.join(d, "build/app/outputs/flutter-apk"), { recursive: true });
      const oldApk = path.join(d, "build/app/outputs/flutter-apk/app-release.apk");
      fs.writeFileSync(oldApk, "old");
      const ut = fs.utimesSync;
      ut(oldApk, new Date("2020-01-01"), new Date("2020-01-01"));
      fs.mkdirSync(path.join(d, "build/app/outputs/flutter-apk/v2"), { recursive: true });
      fs.writeFileSync(path.join(d, "build/app/outputs/flutter-apk/v2/app-release.apk"), "new");
    });
    const found = findArtifacts(dir, ["build/app/outputs/flutter-apk/**/app-release.apk"]);
    expect(found.length).toBe(2);
    expect(path.basename(found[0]!)).toBe("app-release.apk");
    expect(found[0]!.includes("/v2/")).toBe(true);
  });

  it("不存在的 pattern 返回空", () => {
    expect(findArtifacts(os.tmpdir(), ["no/such/*.apk"])).toEqual([]);
  });

  it("多 pattern 重复命中同一文件 → 去重只返回一次", () => {
    const dir = tmpProject((d) => {
      fs.mkdirSync(path.join(d, "build/app/outputs"), { recursive: true });
      fs.writeFileSync(path.join(d, "build/app/outputs/app-release.apk"), "x");
    });
    const found = findArtifacts(dir, ["build/**/*.apk", "build/app/outputs/*.apk"]);
    expect(found).toEqual([path.join(dir, "build/app/outputs/app-release.apk")]);
  });

  it("** 递归跳过隐藏目录与 node_modules", () => {
    const dir = tmpProject((d) => {
      for (const sub of ["build/.hidden", "build/node_modules/pkg", "build/real"]) {
        const subDir = path.join(d, sub);
        fs.mkdirSync(subDir, { recursive: true });
        fs.writeFileSync(path.join(subDir, "app-release.apk"), "x");
      }
    });
    const found = findArtifacts(dir, ["build/**/*.apk"]);
    expect(found).toEqual([path.join(dir, "build/real/app-release.apk")]);
  });
});

describe("适配器 detect 分支补测", () => {
  /** tmpProject 不自动清理；残留目录可能干扰其他探测测试，用完即删 */
  function withTmpProject(setup: (dir: string) => void, run: (dir: string) => void): void {
    const dir = tmpProject(setup);
    try {
      run(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("pubspec.yaml 恰为合法 JSON 时 flutter 直接识别", () => {
    withTmpProject(
      (d) =>
        fs.writeFileSync(
          path.join(d, "pubspec.yaml"),
          JSON.stringify({ name: "app", sdk: "flutter" }),
        ),
      (dir) => expect(flutterAdapter.detect(dir)).toBe(true),
    );
  });

  it("nativeIos artifactPatterns 返回 ipa glob", () => {
    expect(nativeIosAdapter.artifactPatterns("ios")).toEqual(["build/**/*.ipa"]);
  });

  it("RN 项目里原生 Android/iOS 适配器均让位（detect 返回 false）", () => {
    withTmpProject(
      (d) => {
        fs.writeFileSync(
          path.join(d, "package.json"),
          JSON.stringify({ dependencies: { "react-native": "0.84.0" } }),
        );
        fs.writeFileSync(path.join(d, "settings.gradle"), "");
        fs.mkdirSync(path.join(d, "ios"));
      },
      (dir) => {
        expect(nativeAndroidAdapter.detect(dir)).toBe(false);
        expect(nativeIosAdapter.detect(dir)).toBe(false);
      },
    );
  });

  it("目录仅含 .xcworkspace（无 .xcodeproj）时原生 iOS 识别", () => {
    withTmpProject(
      (d) => fs.mkdirSync(path.join(d, "MyApp.xcworkspace")),
      (dir) => expect(nativeIosAdapter.detect(dir)).toBe(true),
    );
  });
});

describe("detectBundleIds", () => {
  /** 沿用 withTmpProject：用完即删，避免残留 tmp 目录被后续探测扫到 */
  function withTmp(setup: (dir: string) => void, run: (dir: string) => void): void {
    const dir = tmpProject(setup);
    try {
      run(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("RN app.json：android.applicationId / ios.bundleIdentifier / harmony.bundleName 一次读齐", () => {
    withTmp(
      (d) =>
        fs.writeFileSync(
          d + "/app.json",
          JSON.stringify({
            name: "Demo",
            android: { applicationId: "com.rn.demo" },
            ios: { bundleIdentifier: "com.rn.demo.ios" },
            harmony: { bundleName: "com.rn.demo.hm" },
          }),
        ),
      (dir) => {
        expect(detectBundleIds(dir)).toEqual({
          androidPkgName: "com.rn.demo",
          harmonyBundleName: "com.rn.demo.hm",
          iosBundleId: "com.rn.demo.ios",
          iosScheme: undefined,
        });
      },
    );
  });

  it("原生安卓：app/build.gradle(.kts) applicationId 正则（groovy/kts 两种赋值）", () => {
    withTmp(
      (d) => {
        fs.writeFileSync(d + "/settings.gradle", "");
        fs.mkdirSync(path.join(d, "app"));
        fs.writeFileSync(
          d + "/app/build.gradle",
          'android {\n  namespace "com.groovy.ns"\n  applicationId "com.native.groovy"\n  applicationIdSuffix ".debug"\n}\n',
        );
      },
      (dir) => expect(detectBundleIds(dir).androidPkgName).toBe("com.native.groovy"),
    );
    withTmp(
      (d) => {
        fs.writeFileSync(d + "/settings.gradle.kts", "");
        fs.mkdirSync(path.join(d, "app"));
        fs.writeFileSync(
          d + "/app/build.gradle.kts",
          'android {\n  namespace = "com.kts.ns"\n  applicationId = "com.native.kts"\n}\n',
        );
      },
      (dir) => expect(detectBundleIds(dir).androidPkgName).toBe("com.native.kts"),
    );
  });

  it("RN 工程的 android/app/build.gradle 也能兜底读 applicationId", () => {
    withTmp(
      (d) => {
        fs.writeFileSync(
          d + "/package.json",
          JSON.stringify({ dependencies: { "react-native": "0.84.0" } }),
        );
        fs.mkdirSync(path.join(d, "android/app"), { recursive: true });
        fs.writeFileSync(
          d + "/android/app/build.gradle",
          'android { applicationId "com.rn.gradle" }',
        );
      },
      (dir) => expect(detectBundleIds(dir).androidPkgName).toBe("com.rn.gradle"),
    );
  });

  it("鸿蒙：AppScope/app.json5 的 bundleName（根目录或 harmony/ 下；json5 注释/尾逗号容错）", () => {
    withTmp(
      (d) => {
        fs.mkdirSync(path.join(d, "AppScope"));
        fs.writeFileSync(
          d + "/AppScope/app.json5",
          '{\n  // 应用全局配置\n  "app": { "bundleName": "com.hm.root", },\n}\n',
        );
      },
      (dir) => expect(detectBundleIds(dir).harmonyBundleName).toBe("com.hm.root"),
    );
    withTmp(
      (d) => {
        fs.mkdirSync(path.join(d, "harmony/AppScope"), { recursive: true });
        fs.writeFileSync(
          d + "/harmony/AppScope/app.json5",
          '{ "app": { "bundleName": "com.hm.nested" } }',
        );
      },
      (dir) => expect(detectBundleIds(dir).harmonyBundleName).toBe("com.hm.nested"),
    );
  });

  it("原生 iOS：两层内 xcodeproj 的 pbxproj 取第一个非 $(...) 的 PRODUCT_BUNDLE_IDENTIFIER，scheme=工程名", () => {
    withTmp(
      (d) => {
        fs.mkdirSync(path.join(d, "sub/MyApp.xcodeproj"), { recursive: true });
        fs.writeFileSync(
          d + "/sub/MyApp.xcodeproj/project.pbxproj",
          'buildSettings = {\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = "$(inherited)";\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = org.cocoapods.${PRODUCT_NAME:rfc1034identifier};\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = "com.ios.native";\n\t\t\t};\n',
        );
      },
      (dir) => {
        expect(detectBundleIds(dir)).toMatchObject({
          iosBundleId: "com.ios.native",
          iosScheme: "MyApp",
        });
      },
    );
  });

  it("Pods 目录被排除，不误取 cocoapods 工程的 bundleId", () => {
    withTmp(
      (d) => {
        fs.mkdirSync(path.join(d, "ios/Pods/Pods.xcodeproj"), { recursive: true });
        fs.writeFileSync(
          d + "/ios/Pods/Pods.xcodeproj/project.pbxproj",
          "PRODUCT_BUNDLE_IDENTIFIER = org.cocoapods.${PRODUCT_NAME:rfc1034identifier};\n",
        );
      },
      (dir) => expect(detectBundleIds(dir).iosBundleId).toBeUndefined(),
    );
  });

  it("空目录：全部 undefined 且不抛", () => {
    withTmp(
      () => {},
      (dir) => {
        expect(detectBundleIds(dir)).toEqual({
          androidPkgName: undefined,
          harmonyBundleName: undefined,
          iosBundleId: undefined,
          iosScheme: undefined,
        });
      },
    );
  });

  // 测试文件位于 applift/packages/core/src，真实工程在 monorepo 隔壁 ../../../../qy-driver（不存在则跳过，CI 无该目录）
  const qyDriver = path.resolve(import.meta.dirname, "../../../../qy-driver");
  it.skipIf(!fs.existsSync(qyDriver))("qy-driver 实测：三端标识与工程实际值一致", () => {
    expect(detectBundleIds(qyDriver)).toEqual({
      androidPkgName: "com.thclouds.driver",
      harmonyBundleName: "com.thclouds.driver.hm",
      iosBundleId: "com.thclouds.driver",
      iosScheme: "QyDriver",
    });
  });
});
