#!/usr/bin/env node
import { redactText } from "@applift/core";
import { program } from "./index.js";

program.parseAsync().catch((e: Error) => {
  // 用户主动取消（clack cancel / Ctrl-C）按 Unix SIGINT 惯例退 130，与常规失败 1 区分（脚本可判别中止）
  if (e.message.startsWith("已取消")) process.exit(130);
  // 错误打印前脱敏：渠道异常消息可能内嵌 token/签名等凭据
  process.stderr.write(`✗ ${redactText(e.message)}\n`);
  process.exit(1);
});
