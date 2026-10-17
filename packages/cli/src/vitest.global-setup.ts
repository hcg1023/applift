/**
 * vitest globalSetup：测试前单次构建（spawn 型 CLI 测试消费 dist/bin.mjs）。
 * 替代各测试文件 beforeAll 里的 `pnpm -r build`——多 worker 并发跑 tsdown --clean
 * 会清写 dist/ 造成兄弟 worker spawn 到半成品（间歇 flaky）。
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  const root = fileURLToPath(new URL("./", import.meta.url));
  const r = spawnSync("pnpm", ["-r", "build"], { cwd: root, stdio: "pipe", timeout: 180_000 });
  if (r.status !== 0) {
    throw new Error(
      `globalSetup build failed (exit ${r.status}): ${r.stdout ?? ""}${r.stderr ?? ""}`.slice(
        0,
        2000,
      ),
    );
  }
}
