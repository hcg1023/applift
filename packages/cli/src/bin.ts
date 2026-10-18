#!/usr/bin/env node
import { redactText } from "@applift/core";
import { program } from "./index.js";

// undici ≥7.20（Node ≥24.14 捆绑）已知问题：上传 body 流错误以 unhandled rejection 崩溃而非拒绝 fetch；
// 兜住转人话退出，避免并发渠道上传被进程级打断且无输出
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  process.stderr.write(
    `✗ 未捕获异步错误（常见于上传流中断，如产物文件在上传期间被改动）：${redactText(msg)}\n`,
  );
  process.exit(1);
});
program.parseAsync().catch((e: Error) => {
  // 用户主动取消（clack cancel / Ctrl-C）按 Unix SIGINT 惯例退 130，与常规失败 1 区分（脚本可判别中止）
  if (e.message.startsWith("已取消")) process.exit(130);
  // 错误打印前脱敏：渠道异常消息可能内嵌 token/签名等凭据
  process.stderr.write(`✗ ${redactText(e.message)}\n`);
  process.exit(1);
});
