#!/usr/bin/env node
/**
 * Playwright webServer：真 createServer + 桩 runner。
 * 前置条件：`pnpm -r build`（ui-server dist 与 ui 静态产物都在）。
 * HOME 隔离到临时目录（registry / baseline 均不落真实用户目录）。
 * runner 桩：stub-beta.mjs 一份分发两职——argv[0]==="status" 走快照（含翻转渠道），
 * beta/dry-run 走脚本化事件流/判定报告。
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const tmp = mkdtempSync(join(tmpdir(), "applift-ui-e2e-"));
process.env.HOME = tmp;
process.env.APPLIFT_STUB_COUNTER = join(tmp, "stub-counter.txt");
process.env.APPLIFT_STUB_STDIN = join(tmp, "stub-stdin.log");
// full：hello → judgement → confirm_required →（stdin confirm）→ progress → result
process.env.APPLIFT_STUB_BETA_MODE = "full";
writeFileSync(process.env.APPLIFT_STUB_STDIN, "");
// 引导安装桩：npmBin 注入 node 桩脚本（不走 PATH，规避 childEnv 把 node 目录前置致真 npm 抢跑）；
// validate 桩以「marker 且 15s 内」判定。PATH 仅剔除含 applift 的目录（availability sources 全空）。
const installMarker = join(tmp, "install-marker.txt");
process.env.APPLIFT_E2E_INSTALL_MARKER = installMarker;
writeFileSync(installMarker, "");
const delim = process.platform === "win32" ? ";" : ":";
// 开发机可能全局装有 applift（fnm bin）——剔除含 applift 的 PATH 段，保证 availability sources 全空
process.env.PATH = process.env.PATH.split(delim)
  .filter((d) => d.trim() !== "" && !existsSync(join(d, "applift")))
  .join(delim);

const { createServer, ProjectRegistry, AppliftRunner } =
  await import("../../ui-server/dist/index.mjs");

const registry = new ProjectRegistry(join(tmp, "projects.json"));
const projDir = join(tmp, "stub-project");
mkdirSync(projDir, { recursive: true });
await registry.add(projDir);
writeFileSync(join(projDir, "applift.config.ts"), "export default {}\n");

const betaBin = fileURLToPath(new URL("./stub-beta.mjs", import.meta.url));
const server = await createServer({
  port: 47810,
  registry,
  runnerFactory: (cwd) => new AppliftRunner({ cwd, bin: [process.execPath, betaBin] }),
  npmBin: [process.execPath, fileURLToPath(new URL("./stub-npm.mjs", import.meta.url))],
  // validate 桩：安装 marker 15s 内才认 applift 可用（复用旧 server 的陈旧 marker 不影响首轮失败）
  validate: async () => {
    try {
      const ts = Number(readFileSync(installMarker, "utf8"));
      return { ok: Date.now() - ts < 15_000 };
    } catch {
      return { ok: false, error: "applift 不可用（未安装）" };
    }
  },
});

// 立即拉一轮快照 + 周期刷新（翻转渠道制造 FeedEvent）
await server.aggregator.refreshNow();
setInterval(() => {
  server.aggregator.refreshNow().catch(() => {});
}, 2000);

process.stdout.write(`applift-ui e2e server on http://127.0.0.1:${server.port}\n`);
