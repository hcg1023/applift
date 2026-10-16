/**
 * 渠道 target 取值链：stores 渠道配置 > 平台段配置（android/harmony/ios）> 包名自动推导（detectBundleIds）。
 * 让「配置可全空」——渠道要的 pkgName/bundleName/bundleId 在项目没写时从工程文件兜底。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { BundleIds, ProjectConfig } from "@applift/core";

export function resolveChannelTarget(
  id: string,
  config: ProjectConfig,
  detected: BundleIds,
): Record<string, string> {
  const store = config.android?.stores?.[id] ?? {};
  // detected 是最底层兜底，逐键放行让上层配置覆盖（项目配置 > 自动推导）
  if (id === "agc") {
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

/** launcher 图标密度优先级（高 → 低） */
const ICON_DENSITIES = ["xxxhdpi", "xxhdpi", "xhdpi", "hdpi", "mdpi"] as const;
/** res 根：原生工程 android/app/... 与扁平 RN/Capacitor app/... 两种布局 */
const RES_ROOTS = ["android/app/src/main/res", "app/src/main/res"] as const;
/** 单目录内候选文件：ic_launcher 四扩展优先，ic_launcher_round.png 兜底 */
const ICON_FILES = [
  "ic_launcher.png",
  "ic_launcher.jpg",
  "ic_launcher.jpeg",
  "ic_launcher.webp",
  "ic_launcher_round.png",
] as const;
/** Tauri 2 工程图标目录候选（src-tauri/icons/，仅 png，按序探测） */
const TAURI_ICON_FILES = [
  "icon.png",
  "512x512.png",
  "128x128@2x.png",
  "128x128.png",
  "Square107x107Logo.png",
] as const;

/**
 * 小米提审 icon 工程自动发现：按 mipmap（高→低密度）→ drawable-<dpi>（同序）扫两个 res 根，
 * 都没命中再兜底 Tauri 2 工程图标目录 src-tauri/icons/（按文件名序探测，仅 png），
 * 找到返回绝对路径，找不到返回 undefined（渠道层报错指引配置 android.stores.xiaomi.icon）。
 */
export function discoverXiaomiIcon(cwd: string): string | undefined {
  for (const kind of ["mipmap", "drawable"] as const) {
    for (const density of ICON_DENSITIES) {
      for (const file of ICON_FILES) {
        for (const root of RES_ROOTS) {
          const candidate = path.join(cwd, root, `${kind}-${density}`, file);
          if (existsSync(candidate)) return candidate;
        }
      }
    }
  }
  for (const file of TAURI_ICON_FILES) {
    const candidate = path.join(cwd, "src-tauri", "icons", file);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
