#!/usr/bin/env node
/**
 * e2e 桩 CLI：`applift status`（快照）与 `beta <platform> ...`（事件流/dry-run）的脚本化应答。
 *
 * 事件流模式（--interactive-events）：按序输出 hello → judgement → confirm_required →
 * （等 stdin confirm 回写）→ progress → result；stdin 回写内容记 APPLIFT_STUB_STDIN 附加文件。
 * dry-run 模式（--dry-run --json）：stdout 输出判定报告 JSON。
 * hang 模式（--stub-mode hang）：发 hello 后挂住（取消路径用）。
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv[0] === "status") {
  // 快照桩（含 honor 按调用次数翻转渠道，制造 FeedEvent）；
  // 单桩分发：快照轮询与 beta 任务走同一 bin，server.mjs 只注入一份
  const counterPath = process.env.APPLIFT_STUB_COUNTER;
  let n = 0;
  try {
    n = Number(readFileSync(counterPath, "utf8")) || 0;
  } catch {
    n = 0;
  }
  writeFileSync(counterPath, String(n + 1));
  const report = {
    fetchedAt: new Date().toISOString(),
    results: [
      { channel: "asc", platform: "ios", state: "approved", live: true },
      { channel: "xiaomi", platform: "android", state: "reviewing" },
      {
        channel: "honor",
        platform: "android",
        state: "rejected",
        reason: "拒绝理由：隐私权限用途说明不完整。补充「获取设备信息」的用途说明后重新提交。",
      },
      {
        channel: "oppo",
        platform: "android",
        state: Math.floor(n / 2) % 2 === 0 ? "approved" : "reviewing",
      },
    ],
  };
  process.stdout.write(JSON.stringify(report));
  process.exit(0);
}

// server spawn 固定带 beta 子命令头：["beta", platform, ...]
const platform = argv[0] === "beta" ? (argv[1] ?? "android") : (argv[0] ?? "android");
const dryRun = argv.includes("--dry-run");
const interactive = argv.includes("--interactive-events");
const mode = process.env.APPLIFT_STUB_BETA_MODE ?? "full";

if (dryRun) {
  // --json 与 --dry-run 同现（服务端 dry-run 路由固定拼这两个旗标）
  const report =
    platform === "ios"
      ? {
          platform,
          provider: "stub-update",
          recommendation: "native",
          confidence: "high",
          evidence: [
            { path: "ios/Podfile.lock", rule: "原生依赖", note: "锁文件变更" },
            { path: "ios/AppDelegate.mm", rule: "原生代码" },
          ],
          note: "判定：native（high）",
        }
      : platform === "harmony"
        ? {
            platform,
            provider: null,
            recommendation: null,
            confidence: null,
            evidence: [],
            note: "未接入热更（原生路径）",
          }
        : {
            platform,
            provider: "stub-update",
            recommendation: "ota",
            confidence: "high",
            evidence: [
              { path: "src/screens/TaskList.tsx", rule: "JS 层" },
              { path: "src/api.ts", rule: "JS 层" },
            ],
            note: "判定：ota（high）",
          };
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(0);
}

if (interactive) {
  const stdinLog = process.env.APPLIFT_STUB_STDIN;
  const emit = (e) => process.stdout.write(JSON.stringify(e) + "\n");
  emit({ type: "hello", protocol: 1, cli: "stub" });
  if (mode === "hang") {
    // 取消路径：hello 后挂住等 SIGTERM
    setInterval(() => {}, 60000);
  } else {
    emit({
      type: "judgement",
      platform,
      recommendation: "ota",
      confidence: "high",
      provider: "stub-update",
      evidence: [{ path: "src/a.ts", rule: "JS 层" }],
    });
    emit({
      type: "confirm_required",
      id: "delivery",
      question: "投递方式",
      choices: [
        { value: "ota", label: "热更（推荐：是）", recommended: true },
        { value: "native", label: "原生包（直接用现有产物发内测）" },
      ],
    });
    // 收到 stdin confirm 回写后：progress → result
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        if (stdinLog) appendFileSync(stdinLog, line + "\n");
        emit({ type: "stage", stage: "publish" });
        emit({ type: "progress", stage: "publish", pct: 40, msg: "打包热更" });
        emit({ type: "progress", stage: "publish", pct: 90, msg: "上传通道" });
        emit({
          type: "result",
          ok: true,
          summary: { versionName: "4.0.0-ota.1", channel: "stub-update", mode: "ota" },
        });
        process.exit(0);
      }
    });
    // keep alive 等 stdin
    setInterval(() => {}, 60000);
  }
  process.on("SIGTERM", () => process.exit(143));
}
