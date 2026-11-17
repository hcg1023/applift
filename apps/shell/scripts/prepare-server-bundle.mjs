/**
 * 打包资源装配（beforeBuildCommand 链第二步，仅 tauri build）：
 *   把 ui-server 运行时装配到 src-tauri/resources/ui-server/ ——
 *     dist/（含 public 前端与壳启动页）+ package.json + node_modules（仅生产依赖 ws 及其传递依赖）。
 *   壳 release 用 resource_dir 解析该目录 spawn `node ui-server/dist/main.mjs`（不捆绑 node 本体）。
 *   每次全量重建（先删旧装配），npm install --omit=dev --ignore-scripts --no-audit --no-fund 生成精简 node_modules。
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
// package.json：npm install 依它解析生产依赖。workspace:* 是 pnpm 协议 npm 不认——
// @applift/* 不进 npm（file: 目录形态会被 npm symlink，打包悬空）：其运行时实体由下方手动复制，
// 它们的传递依赖（zod/c12/jiti…）平铺并入本包 dependencies 一起安装（npm 只装 registry 真包）。
const serverPkg = JSON.parse(readFileSync(join(serverDir, "package.json"), "utf8"));
const rewritten = { ...serverPkg, dependencies: { ...(serverPkg.dependencies ?? {}) } };
const localApplift = []; // 需手动复制的 @applift/*（仓库内目录）
for (const [name, spec] of Object.entries(rewritten.dependencies)) {
  if (spec !== "workspace:*") continue;
  delete rewritten.dependencies[name];
  const map = {
    "@applift/core": join(repoRoot, "packages", "core"),
    "@applift/cli": join(repoRoot, "packages", "cli"),
  };
  const dir = map[name] ?? join(repoRoot, "packages", name.replace("@applift/", ""));
  localApplift.push([name, dir]);
  // 传递依赖平铺（运行时解析发生在 node_modules 顶层）
  const dep = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  Object.assign(rewritten.dependencies, dep.dependencies ?? {});
}
writeFileSync(join(staging, "package.json"), JSON.stringify(rewritten, null, 2));
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

// @applift/* 实体复制（npm 只装了它的传递依赖，包本体不进 npm——file: 会被 symlink 化）：
// 复制运行时必需面 package.json + dist/。
for (const [name, dir] of localApplift) {
  const scope = join(staging, "node_modules", "@applift");
  mkdirSync(scope, { recursive: true });
  const p = join(scope, name.replace("@applift/", ""));
  rmSync(p, { recursive: true, force: true });
  mkdirSync(p, { recursive: true });
  cpSync(join(dir, "package.json"), join(p, "package.json"));
  cpSync(join(dir, "dist"), join(p, "dist"), { recursive: true });
  console.log(`[shell] local dep 实体: ${name}`);
}
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
