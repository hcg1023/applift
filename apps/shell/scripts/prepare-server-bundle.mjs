/**
 * 打包资源装配（beforeBuildCommand 链第二步，仅 tauri build）：
 *   把 ui-server 运行时装配到 src-tauri/resources/ui-server/ ——
 *     dist/（含 public 前端与壳启动页）+ package.json + node_modules（仅生产依赖 ws 及其传递依赖）。
 *   壳 release 用 resource_dir 解析该目录 spawn `node ui-server/dist/main.mjs`（不捆绑 node 本体）。
 *   每次全量重建（先删旧装配），npm install --omit=dev --ignore-scripts --no-audit --no-fund 生成精简 node_modules。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const serverDir = join(repoRoot, "apps", "ui-server");
const distDir = join(serverDir, "dist");
const staging = join(here, "..", "src-tauri", "resources", "ui-server");

if (!existsSync(join(distDir, "main.mjs"))) {
  console.error(`[shell] 缺少 ui-server 产物（${distDir}/main.mjs）：请先在仓库根执行 pnpm build`);
  process.exit(1);
}

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

// dist 全量（main.mjs/index.mjs + public 前端 + startup.html/node-required.html——由 prepare-frontend 拷入）
cpSync(distDir, join(staging, "dist"), { recursive: true });
// package.json：npm install 依它解析生产依赖
cpSync(join(serverDir, "package.json"), join(staging, "package.json"));
// 精简 node_modules：仅生产依赖（当前= ws，无传递必需依赖；optional peer 不装）
// win32 的 npm.cmd 经 cmd.exe /c 包装直 spawn（无 shell 会 EINVAL——与 ui-server runner toSpawnCommand 同款策略）
const npmRun = process.platform === "win32" ? ["cmd.exe", "/c", "npm"] : ["npm"];
execFileSync(
  npmRun[0],
  [
    ...npmRun.slice(1),
    "install",
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--loglevel",
    "error",
  ],
  { cwd: staging, stdio: "inherit" },
);

const pkg = JSON.parse(readFileSync(join(staging, "package.json"), "utf8"));
const depCount = Object.keys(pkg.dependencies ?? {}).length;
const size = (p) => {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
};
console.log(
  `[shell] server bundle staged: ${staging}（deps=${depCount}，main.mjs=${size(join(staging, "dist", "main.mjs"))}B）`,
);
