/**
 * resolveChannelTarget 取值链：stores 渠道配置 > 平台段配置（android/harmony/ios）> 包名自动推导。
 * 「配置可全空」：项目一个标识都没配时，渠道 target 仍能从工程文件推导兜底。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BundleIds, ProjectConfig } from "@applift/core";
import { ProjectConfigSchema } from "@applift/core";
import { discoverXiaomiIcon, resolveChannelTarget } from "./target.js";

const configOf = (over: Record<string, unknown>): ProjectConfig => ProjectConfigSchema.parse(over);

describe("resolveChannelTarget（项目配置 > 自动推导）", () => {
  const detected: BundleIds = {
    androidPkgName: "com.autodetect.app",
    harmonyBundleName: "com.autodetect.app.hm",
    iosBundleId: "com.autodetect.app.ios",
    iosScheme: "AutoApp",
  };

  it("配置全空：三端标识全部由自动推导兜底", () => {
    const config = configOf({});
    expect(resolveChannelTarget("vivo", config, detected)).toEqual({
      pkgName: "com.autodetect.app",
    });
    expect(resolveChannelTarget("agc", config, detected)).toEqual({
      bundleName: "com.autodetect.app.hm",
    });
    expect(resolveChannelTarget("asc", config, detected)).toEqual({
      bundleId: "com.autodetect.app.ios",
    });
  });

  it("平台段配置覆盖自动推导，stores 渠道配置覆盖平台段（android pkgName 三层）", () => {
    const config = configOf({
      android: { pkgName: "com.config.app", stores: { vivo: { pkgName: "com.store.app" } } },
    });
    expect(resolveChannelTarget("vivo", config, detected)).toEqual({ pkgName: "com.store.app" });
    expect(resolveChannelTarget("googleplay", config, detected)).toEqual({
      pkgName: "com.config.app",
    });
  });

  it("harmony/ios 平台段覆盖推导值，stores 附加键（appId）保留", () => {
    const config = configOf({
      harmony: { bundleName: "com.config.hm", appId: "agc-123" },
      ios: { scheme: "ConfigApp", bundleId: "com.config.ios" },
    });
    expect(resolveChannelTarget("agc", config, detected)).toEqual({
      bundleName: "com.config.hm",
      appId: "agc-123",
    });
    expect(resolveChannelTarget("asc", config, detected)).toMatchObject({
      bundleId: "com.config.ios",
      scheme: "ConfigApp",
    });
  });

  it("推导结果为空对象时保持 target 干净（不产生 undefined 键）", () => {
    const config = configOf({ android: { pkgName: "com.config.app", stores: {} } });
    expect(resolveChannelTarget("huawei", config, {})).toEqual({ pkgName: "com.config.app" });
    expect(resolveChannelTarget("pgyer", configOf({}), {})).toEqual({});
  });
});

describe("discoverXiaomiIcon（小米 icon 工程自动发现）", () => {
  const makeCwd = () => mkdtempSync(path.join(tmpdir(), "applift-icon-"));
  const put = (cwd: string, rel: string) => {
    const file = path.join(cwd, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "x");
    return file;
  };

  it("密度优先级：高密度优先（mipmap-xxxhdpi > xxhdpi > xhdpi > hdpi > mdpi）", () => {
    const cwd = makeCwd();
    try {
      put(cwd, "android/app/src/main/res/mipmap-mdpi/ic_launcher.png");
      put(cwd, "android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png");
      put(cwd, "android/app/src/main/res/mipmap-xhdpi/ic_launcher.png");
      expect(discoverXiaomiIcon(cwd)).toBe(
        path.join(cwd, "android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png"),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("双根：android/app 与扁平 app 布局都探测", () => {
    for (const root of ["android/app/src/main/res", "app/src/main/res"]) {
      const cwd = makeCwd();
      try {
        put(cwd, `${root}/mipmap-xhdpi/ic_launcher.png`);
        expect(discoverXiaomiIcon(cwd)).toBe(path.join(cwd, root, "mipmap-xhdpi/ic_launcher.png"));
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }
  });

  it("mipmap 优先于 drawable；round 兜底；多扩展名命中", () => {
    const cwd = makeCwd();
    try {
      put(cwd, "android/app/src/main/res/drawable-xxxhdpi/ic_launcher.png");
      put(cwd, "android/app/src/main/res/mipmap-mdpi/ic_launcher_round.png");
      expect(discoverXiaomiIcon(cwd)).toBe(
        path.join(cwd, "android/app/src/main/res/mipmap-mdpi/ic_launcher_round.png"),
      );

      const cwd2 = makeCwd();
      try {
        put(cwd2, "android/app/src/main/res/drawable-hdpi/ic_launcher.webp");
        expect(discoverXiaomiIcon(cwd2)).toBe(
          path.join(cwd2, "android/app/src/main/res/drawable-hdpi/ic_launcher.webp"),
        );
      } finally {
        rmSync(cwd2, { recursive: true, force: true });
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("Tauri 兜底：src-tauri/icons/icon.png 命中", () => {
    const cwd = makeCwd();
    try {
      put(cwd, "src-tauri/icons/icon.png");
      expect(discoverXiaomiIcon(cwd)).toBe(path.join(cwd, "src-tauri/icons/icon.png"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("Tauri 兜底：按序探测 512x512.png（icon.png 缺失时）", () => {
    const cwd = makeCwd();
    try {
      put(cwd, "src-tauri/icons/128x128.png");
      put(cwd, "src-tauri/icons/512x512.png");
      expect(discoverXiaomiIcon(cwd)).toBe(path.join(cwd, "src-tauri/icons/512x512.png"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("android res 优先于 Tauri icons", () => {
    const cwd = makeCwd();
    try {
      put(cwd, "src-tauri/icons/icon.png");
      put(cwd, "app/src/main/res/mipmap-mdpi/ic_launcher.png");
      expect(discoverXiaomiIcon(cwd)).toBe(
        path.join(cwd, "app/src/main/res/mipmap-mdpi/ic_launcher.png"),
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("工程里没有 launcher 图标 → undefined", () => {
    const cwd = makeCwd();
    try {
      put(cwd, "android/app/src/main/res/mipmap-xxhdpi/other.png");
      expect(discoverXiaomiIcon(cwd)).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
