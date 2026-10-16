/**
 * 渠道 target 取值链：stores 渠道配置 > 平台段配置（android/harmony/ios）> 包名自动推导（detectBundleIds）。
 * 让「配置可全空」——渠道要的 pkgName/bundleName/bundleId 在项目没写时从工程文件兜底。
 */
import type { BundleIds, ProjectConfig } from "@applift/core";

export function resolveChannelTarget(
  id: string,
  config: ProjectConfig,
  detected: BundleIds,
): Record<string, string> {
  const store = config.android?.stores?.[id] ?? {};
  // detected 是最底层兜底，逐键放行让上层配置覆盖（项目配置 > 自动推导）
  if (id === "agc-harmony") {
    return {
      ...(detected.harmonyBundleName ? { bundleName: detected.harmonyBundleName } : {}),
      ...config.harmony,
      ...store,
    };
  }
  if (id === "asc") {
    return {
      ...(detected.iosBundleId ? { bundleId: detected.iosBundleId } : {}),
      ...config.ios,
      ...store,
    };
  }
  // 安卓系渠道（pgyer/huawei/xiaomi/oppo/vivo/honor/yyb/googleplay）：pkgName 三层兜底
  return {
    ...(detected.androidPkgName ? { pkgName: detected.androidPkgName } : {}),
    ...(config.android?.pkgName ? { pkgName: config.android.pkgName } : {}),
    ...store,
  };
}
