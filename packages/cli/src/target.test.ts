/**
 * resolveChannelTarget 取值链：stores 渠道配置 > 平台段配置（android/harmony/ios）> 包名自动推导。
 * 「配置可全空」：项目一个标识都没配时，渠道 target 仍能从工程文件推导兜底。
 */
import { describe, expect, it } from "vitest";
import type { BundleIds, ProjectConfig } from "@applift/core";
import { ProjectConfigSchema } from "@applift/core";
import { resolveChannelTarget } from "./target.js";

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
    expect(resolveChannelTarget("agc-harmony", config, detected)).toEqual({
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
    expect(resolveChannelTarget("agc-harmony", config, detected)).toEqual({
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
