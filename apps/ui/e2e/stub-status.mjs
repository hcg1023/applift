#!/usr/bin/env node
/**
 * e2e 桩 CLI：`applift status --json` 的固定应答（honor 渠道按调用次数翻转，制造 FeedEvent）。
 * 计数文件由 server.mjs 经 APPLIFT_STUB_COUNTER 注入。
 */
import { readFileSync, writeFileSync } from "node:fs";

const counterPath = process.env.APPLIFT_STUB_COUNTER;
let n = 0;
try {
  n = Number(readFileSync(counterPath, "utf8")) || 0;
} catch {
  n = 0;
}
n += 1;
writeFileSync(counterPath, String(n));

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
    // 翻转渠道：每两次调用变一次状态（approved ↔ reviewing），驱动 FeedEvent
    {
      channel: "oppo",
      platform: "android",
      state: Math.floor(n / 2) % 2 === 0 ? "approved" : "reviewing",
    },
  ],
};
process.stdout.write(JSON.stringify(report));
