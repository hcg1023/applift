/**
 * 官方示例插件 —— 钉钉机器人通知。
 * 用法（applift.config.ts）：
 *   import { defineConfig } from '@applift/core';
 *   import { dingtalkNotify } from '@applift/core/plugins';
 *   export default defineConfig({ plugins: [dingtalkNotify({ webhook: 'https://oapi.dingtalk.com/robot/send?...' })] });
 */
import { createHmac } from "node:crypto";
import { redactText } from "../channels/shared/redact.js";
import type { AppliftPlugin } from "../plugin.js";

export interface DingtalkNotifyOptions {
  webhook: string;
  /** 钉钉机器人加签密钥（SEC 开头，可选） */
  secret?: string;
  atMobiles?: string[];
}

export function dingtalkNotify(options: DingtalkNotifyOptions): AppliftPlugin {
  return {
    name: "dingtalk-notify",
    async notify(summary) {
      // stage-only（release 未带 --submit）也走 notify：标题标明草稿态，避免被误读为最终发布结果
      const title =
        summary.submit.length === 0 ? "applift stage 草稿（未提审）" : "applift 发布结果";
      const lines: string[] = [title];
      for (const e of [...summary.stage, ...summary.submit]) {
        // 外发前脱敏：错误消息可能内嵌凭据/响应体切片（预签名 URL），不把秘密推到群机器人
        lines.push(
          `- ${e.label}: ${e.ok ? "✅ 成功" : `❌ ${redactText(e.stageError ?? e.submitError ?? "失败")}`}`,
        );
      }
      const body: Record<string, unknown> = {
        msgtype: "markdown",
        markdown: { title, text: `### ${title}\n\n${lines.join("\n\n")}` },
      };
      if (options.atMobiles?.length) {
        body.at = { atMobiles: options.atMobiles, isAtAll: false };
      }
      let url = options.webhook;
      if (options.secret) {
        // 钉钉加签：timestamp + "\n" + secret 的 HmacSHA256 base64
        const timestamp = Date.now();
        const sign = encodeURIComponent(
          createHmac("sha256", options.secret)
            .update(`${timestamp}\n${options.secret}`)
            .digest("base64"),
        );
        url += `${url.includes("?") ? "&" : "?"}timestamp=${timestamp}&sign=${sign}`;
      }
      // 通知失败不阻断发布，静默容错
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
    },
  };
}
