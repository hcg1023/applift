#!/usr/bin/env node
/**
 * Playwright webServer：真 createServer + 桩 runner。
 * 前置条件：`pnpm -r build`（ui-server dist 与 ui 静态产物都在）。
 * HOME 隔离到临时目录（registry / baseline 均不落真实用户目录）。
 * runner 桩：stub-beta.mjs 一份分发两职——argv[0]==="status" 走快照（含翻转渠道），
 * beta/dry-run 走脚本化事件流/判定报告。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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

const { createServer, ProjectRegistry, AppliftRunner } =
  await import("../../ui-server/dist/index.mjs");

const registry = new ProjectRegistry(join(tmp, "projects.json"));
const projDir = join(tmp, "stub-project");
mkdirSync(projDir, { recursive: true });
await registry.add(projDir);

const betaBin = fileURLToPath(new URL("./stub-beta.mjs", import.meta.url));
const server = await createServer({
  port: 47810,
  registry,
  runnerFactory: (cwd) => new AppliftRunner({ cwd, bin: [process.execPath, betaBin] }),
});

// 立即拉一轮快照 + 周期刷新（翻转渠道制造 FeedEvent）
await server.aggregator.refreshNow();
setInterval(() => {
  server.aggregator.refreshNow().catch(() => {});
}, 2000);

process.stdout.write(`applift-ui e2e server on http://127.0.0.1:${server.port}\n`);
