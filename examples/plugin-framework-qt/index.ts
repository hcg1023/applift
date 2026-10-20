/**
 * 官方示例插件：Qt 桌面框架适配器（framework:register 完整样板）。
 *
 * 演示自定义框架接入的全部成员——与内置 electron/tauri 适配器同接口同权：
 * - detect: CMakeLists.txt 含 qt_add_executable / find_package(Qt) 即认为 Qt 工程
 * - artifactPatterns: 三桌面平台产物（cpack/标准构建布局）
 * - buildCommand: null（Qt 构建系统多样：qmake/cmake/ninja，建议项目配置 build 段指定）
 *
 * 使用（applift.config.ts）：
 *   import { qtAdapter } from './examples/plugin-framework-qt/index.js';
 *   export default defineConfig({
 *     plugins: [{ name: 'qt', 'framework:register'(adapters) { adapters.push(qtAdapter); } }],
 *   });
 *   // 之后 applift release windows --cwd <qt工程> 自动探测 build/ 下的 .exe
 */
import fs from "node:fs";
import path from "node:path";
import type { FrameworkAdapter } from "@applift/core";

export const qtAdapter: FrameworkAdapter = {
  id: "qt",
  label: "Qt",
  detect(cwd: string): boolean {
    for (const name of ["CMakeLists.txt", "CMakeLists.cmake"]) {
      const p = path.join(cwd, name);
      if (!fs.existsSync(p)) continue;
      const text = fs.readFileSync(p, "utf8");
      if (/qt_add_executable|find_package\s*\(\s*Qt\d?/i.test(text)) return true;
    }
    return false;
  },
  artifactPatterns(platform: string): string[] {
    if (platform === "windows") return ["build/*.exe", "build/**/*.exe", "packages/*.exe"];
    if (platform === "macos") return ["build/*.app/**/*.app", "packages/*.dmg"];
    if (platform === "linux") return ["build/*.AppImage", "packages/*.AppImage", "packages/*.deb"];
    return [];
  },
};
