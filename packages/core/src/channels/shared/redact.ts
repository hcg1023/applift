/**
 * 凭据脱敏（对拍 apkgo pkg/httptrace/redact.go 权威）。
 * 判定依据是“名字”：JSON 键 / 表单字段 / query 参数 / header 名携带凭据语义即整值掩码为
 * [REDACTED <len>]（保留长度线索），空串保持空串——“签名为空”本身就是排查线索。
 * 非敏感名下的值仍递归扫内容（signed URL / 内嵌 JSON / name=value 自由文本）。
 * 故意分歧：掩码不做 percent-encode（日志可读性优先）；JSON 再序列化保持原键序（Go map 序随机）。
 * 挂接点：CLI / 错误消息层接入（core 先提供能力）。
 */

/** 归一化后「包含即敏感」的词（对拍 redact.go sensitiveWords） */
const SENSITIVE_WORDS = [
  "secret",
  "token",
  "password",
  "passwd",
  "authorization",
  "credential",
  "cookie",
  "privatekey",
  "apikey",
  "assertion",
  "jwt",
  "signature",
] as const;

/** 归一化后全等即敏感的名字（对拍 redact.go sensitiveNames） */
const SENSITIVE_NAMES: Record<string, true> = { sig: true, sign: true, pwd: true, auth: true };

/** 名字是否携带凭据语义（JSON 键 / 表单字段 / query 参数 / header 名通用；归一化 = 小写去非字母数字） */
export function isSensitiveName(name: string): boolean {
  // x-cos-security-token → xcossecuritytoken
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (n in SENSITIVE_NAMES) return true;
  // 仅“提及”凭据的名字不敏感：token_type: "Bearer"、CORS 的 Access-Control-Allow-Credentials
  if (n === "tokentype" || n.startsWith("accesscontrol")) return false;
  // api_sign / x-sign 等 *sign 后缀均敏感，但 design 例外
  if (n.endsWith("sign") && n !== "design") return true;
  return SENSITIVE_WORDS.some((w) => n.includes(w));
}

/** 整值掩码：保留长度；空串保持（“签名为空”是有效诊断信息）。3 处调用点需锁步一致 */
function mask(v: string): string {
  return v === "" ? "" : `[REDACTED ${v.length}]`;
}

/**
 * 按名字脱敏单个值：敏感名 → 整值掩码；Authorization 保留 scheme（"Bearer [REDACTED 812]"，
 * 对拍 redact.go redactHeaders）；非敏感名 → 递归 redactText 扫值内凭据。
 */
export function redactValue(name: string, v: string): string {
  if (/^authorization$/i.test(name) && v.includes(" ")) {
    const schemeEnd = v.indexOf(" ");
    return `${v.slice(0, schemeEnd)} ${mask(v.slice(schemeEnd + 1))}`;
  }
  return isSensitiveName(name) ? mask(v) : redactText(v);
}

/** redactURL：剥离 userinfo + query 参数按名脱敏，路径/fragment 原样保留 */
function redactUrlString(v: string): string {
  let out = v.replace(/^(https?:\/\/)[^/?#]*@/, "$1");
  const hashIdx = out.indexOf("#");
  const hash = hashIdx >= 0 ? out.slice(hashIdx) : "";
  if (hashIdx >= 0) out = out.slice(0, hashIdx);
  const qIdx = out.indexOf("?");
  if (qIdx < 0) return out + hash;
  const query = new URLSearchParams(out.slice(qIdx + 1));
  const pairs: string[] = [];
  for (const [k, val] of query) pairs.push(`${k}=${isSensitiveName(k) ? mask(val) : val}`);
  return `${out.slice(0, qIdx)}?${pairs.join("&")}${hash}`;
}

/** free 文本中的 name=value / "name":"value" 凭据对（对拍 redact.go scrubRe；掩码无长度） */
const SCRUB_RE =
  /([\w.-]*(?:secret|token|password|passwd|signature|credential|authorization|api_?key|assertion)[\w.-]*"?\s*[=:]\s*"?)([^"&\s,;<}]+)/gi;

/** JSON 树递归：敏感名下字符串掩码、数字/布尔置 [REDACTED]，数组元素继承外层键名 */
function redactTree(name: string, v: unknown): unknown {
  if (v === null || typeof v !== "object") {
    if (typeof v === "string") return redactValue(name, v);
    return isSensitiveName(name) ? "[REDACTED]" : v;
  }
  if (Array.isArray(v)) return v.map((x) => redactTree(name, x));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = redactTree(k, val);
  return out;
}

/**
 * 文本脱敏（三层层叠，逐层尝试）：
 *   1) http(s) URL 带 query/userinfo → query 按名脱敏 + 剥 userinfo
 *   2) { / [ 开头且整串为合法 JSON → 递归按键名脱敏
 *   3) 其余 → name=value 正则扫（错误消息等无结构文本）
 */
export function redactText(v: string): string {
  if (/^https?:\/\//i.test(v) && (v.includes("?") || /^https?:\/\/[^/?#]*@/i.test(v))) {
    return redactUrlString(v);
  }
  if (v.length > 1 && (v.startsWith("{") || v.startsWith("["))) {
    try {
      return JSON.stringify(redactTree("", JSON.parse(v)));
    } catch {
      // 整串非合法 JSON → 落到自由文本扫描
    }
  }
  return v.replace(SCRUB_RE, "$1[REDACTED]");
}
