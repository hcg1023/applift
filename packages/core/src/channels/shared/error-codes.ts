/**
 * 错误码人话化：消费各渠道自带 errorHints（平台内聚——表与渠道实现同文件）。
 */
export function humanizeError(hints: Record<string, string> | undefined, message: string): string {
  if (!hints) return message;
  for (const [code, hint] of Object.entries(hints)) {
    if (message.includes(code)) {
      return `${message}\n  提示: ${hint}`;
    }
  }
  return message;
}
