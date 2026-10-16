/**
 * App Store Connect JWT（ES256）与 REST 封装 —— 自 v1 tools/publish/lib/asc.mjs 迁移（逻辑不变）。
 *
 * - makeAscJwt: ES256 签名 JWT（aud=appstoreconnect-v1，有效期 20 分钟）
 * - ascGet / ascRequest: ASC REST API 请求封装（错误信息截断 300 字符，与 v1 一致）
 * 官方文档: https://developer.apple.com/documentation/appstoreconnectapi
 */
import { createSign } from "node:crypto";
import fs from "node:fs";

const ASC_API_BASE = "https://api.appstoreconnect.apple.com";

/** ASC 官方错误响应 errors[] 中的单条错误 */
export interface AscErrorItem {
  id?: string;
  status?: string;
  code?: string;
  title?: string;
  detail?: string;
}

/** ASC 错误响应体外壳 */
export interface AscErrorBody {
  errors?: AscErrorItem[];
}

/** makeAscJwt 凭据三元组 */
export interface AscJwtOptions {
  keyId: string;
  issuerId: string;
  p8Path: string;
}

/**
 * 生成 App Store Connect API JWT（ES256，有效期 20 分钟）。
 * 来源: v1 tools/publish/lib/asc.mjs 的 makeAscJwt（逻辑不变）
 */
export function makeAscJwt({ keyId, issuerId, p8Path }: AscJwtOptions): string {
  const header = { alg: "ES256", kid: keyId };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: issuerId, iat: now, exp: now + 20 * 60, aud: "appstoreconnect-v1" };
  const b64url = (obj: unknown): string => {
    const buf = Buffer.isBuffer(obj) ? obj : Buffer.from(JSON.stringify(obj));
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  // p8 为 PEM PKCS#8 私钥；dsaEncoding=ieee-p1363 使 ES256 直接输出 raw r||s（JWS 要求），免手写 DER 解析
  const signer = createSign("SHA256");
  signer.update(signingInput);
  const raw = signer.sign({ key: fs.readFileSync(p8Path, "utf8"), dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64url(raw)}`;
}

/** ASC REST API GET 封装。来源: v1 asc.mjs 的 ascGet（新增 30s AbortSignal 超时，P2-4） */
export async function ascGet<T = unknown>(jwt: string, apiPath: string): Promise<T> {
  const res = await fetch(`${ASC_API_BASE}${apiPath}`, {
    headers: { Authorization: `Bearer ${jwt}` },
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json()) as T & AscErrorBody;
  if (!res.ok) {
    throw new Error(
      `ASC API ${apiPath} 失败 HTTP ${res.status}: ${JSON.stringify(json.errors ?? json).slice(0, 300)}`,
    );
  }
  return json;
}

/** ASC REST API 请求封装（POST/PATCH）。来源: v1 asc.mjs 的 ascRequest（新增 30s AbortSignal 超时，P2-4） */
export async function ascRequest<T = unknown>(
  jwt: string,
  apiPath: string,
  method: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${ASC_API_BASE}${apiPath}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as T & AscErrorBody;
  if (!res.ok) {
    throw new Error(
      `ASC API ${method} ${apiPath} 失败 HTTP ${res.status}: ${JSON.stringify(json.errors ?? json).slice(0, 300)}`,
    );
  }
  return json;
}
