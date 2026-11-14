/**
 * Tauri 壳前端准备（beforeDevCommand / beforeBuildCommand）：
 *   1. 校验 apps/ui-server/dist/public 存在（vite 构建直指该目录；缺失=先在仓库根 pnpm build）
 *   2. 把壳启动页（startup.html / node-required.html）拷入该目录——Tauri 只能导航到
 *      frontendDist 内的 asset，壳页面与前端同目录才能零切换成本。
 */
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, "..", "..", "ui-server", "dist", "public");
const pagesDir = join(here, "..", "frontend");

if (!existsSync(join(publicDir, "index.html"))) {
  console.error(`[shell] 缺少前端产物（${publicDir}/index.html）：请先在仓库根执行 pnpm build`);
  process.exit(1);
}
for (const page of ["startup.html", "node-required.html"]) {
  copyFileSync(join(pagesDir, page), join(publicDir, page));
}
console.log(`[shell] frontend ready: ${publicDir}`);
