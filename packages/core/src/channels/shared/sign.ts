/**
 * 国产商店共用签名/哈希工具（自 v1 tools/publish/lib/stores/_sign.mjs 迁移，逻辑不变）。
 *
 * 通用规则（应用宝/OPPO/vivo 三家一致）：
 *   1) 参数按 key ASCII 升序拼 k1=v1&k2=v2（值为 null/undefined 不参与）
 *   2) HmacSHA256(key=secret) 转小写 hex
 *   3) 签名计算时值不 URL 编码，发送时才编码
 * 差异：应用宝/OPPO timestamp 秒级；vivo 毫秒级且 file 不参与签名
 */
import { createHmac, createHash } from "node:crypto";
import fs from "node:fs";

export function sortedQueryString(
  params: Record<string, string | number | undefined | null>,
): string {
  const filtered = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null),
  ) as Record<string, string | number>;
  return Object.keys(filtered)
    .sort()
    .map((k) => `${k}=${filtered[k]}`)
    .join("&");
}

export function hmacSign(
  secret: string,
  params: Record<string, string | number | undefined | null>,
): string {
  return createHmac("sha256", secret).update(sortedQueryString(params)).digest("hex");
}

export function tsSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

export function tsMillis(): string {
  return String(Date.now());
}

export function md5String(s: string): string {
  return createHash("md5").update(s, "utf8").digest("hex");
}

/** 分块计算文件 MD5（apk 较大，8MB 分块避免整读） */
export function md5File(filePath: string): string {
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.alloc(8 * 1024 * 1024);
  const hash = createHash("md5");
  try {
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/** POST application/x-www-form-urlencoded */
export async function formPost<T = unknown>(
  url: string,
  params: Record<string, string>,
  { timeout = 60_000 }: { timeout?: number } = {},
): Promise<T> {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`HTTP ${res.status} 非 JSON 响应: ${text.slice(0, 300)}`);
  }
}
