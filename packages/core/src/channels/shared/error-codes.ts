/**
 * 错误码人话化：消费各渠道自带 errorHints（平台内聚——表与渠道实现同文件）。
 * 网络类故障（AbortSignal 超时/断连/DNS）渠道层不转译，统一在此兜底提示。
 */

/** 网络故障特征 → 人话提示（命中即返回，按序优先：文件可读性 > 超时 > 网络故障） */
const NETWORK_HINTS: Array<[RegExp, string]> = [
  // fetch failed 只是外壳，真实原因在 cause（pipeline 的 errText 已解包进消息）
  [
    /NotReadableError/i,
    "产物/图标文件在上传期间被修改或不可读（惰性 Blob 读盘中途失败）：确认构建已完成、无并发进程改动产物，重跑",
  ],
  [
    /aborted due to timeout|TimeoutError/i,
    "请求超时（服务端无响应或网络不稳）：可重跑；大包上传建议在稳定网络环境执行",
  ],
  [
    /\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE)\b|socket hang up|fetch failed/i,
    "网络故障（连接被重置/DNS 解析失败等）：检查网络或代理后重跑",
  ],
];

/** 码匹配：纯数字码加数字边界（防 1003 误中 11003/10031）；其余按包含匹配 */
function matchesCode(message: string, code: string): boolean {
  if (/^\d+$/.test(code)) return new RegExp(`(?<!\\d)${code}(?!\\d)`).test(message);
  return message.includes(code);
}

export function humanizeError(hints: Record<string, string> | undefined, message: string): string {
  for (const [re, hint] of NETWORK_HINTS) {
    if (re.test(message)) return `${message}\n  提示: ${hint}`;
  }
  if (!hints) return message;
  for (const [code, hint] of Object.entries(hints)) {
    if (matchesCode(message, code)) {
      return `${message}\n  提示: ${hint}`;
    }
  }
  return message;
}
