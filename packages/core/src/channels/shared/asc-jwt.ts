/**
 * App Store Connect JWT（ES256）与 API 客户端（docs/fastlane-adoption §5）。
 * - makeAscJwt: iat = now-60（时钟偏移防御，fastlane token.rb），有效期 20 分钟
 * - AscClient: JWT 惰性续签（18 分钟余量）+ 401 重签重试 1 次；
 *   GET 幂等自动重试（429 指数退避封顶 60s/总上限 10min；500/502/503/504 ≤3 次）；
 *   POST/PATCH 不自动重试（防重复创建/重复提审），错误文案提示先 status 确认；
 *   403 REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED → 专属人话。
 * 官方文档: https://developer.apple.com/documentation/appstoreconnectapi
 */
import { createSign } from "node:crypto";
import fs from "node:fs";
import { sleep } from "../../util.js";

const ASC_API_BASE = "https://api.appstoreconnect.apple.com";
const JWT_TTL_MS = 20 * 60 * 1000;
const JWT_REFRESH_MARGIN_MS = 2 * 60 * 1000; // 剩 2 分钟即续签
const RETRY_5XX_DELAYS_MS = [2000, 4000, 8000];
const RETRY_429_START_MS = 1000;
const RETRY_429_CAP_MS = 60_000;
const RETRY_429_TOTAL_MS = 10 * 60_000;

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

/** ASC API 凭据三元组 */
export interface AscAuth {
  keyId: string;
  issuerId: string;
  p8Path: string;
}

export type AscJwtOptions = AscAuth;

/**
 * 生成 App Store Connect API JWT（ES256，自 iat 起有效期 20 分钟）。
 * iat = now - 60（时钟偏移防御，对齐 fastlane fastlane_core/lib/fastlane/core/token.rb）。
 */
export function makeAscJwt({ keyId, issuerId, p8Path }: AscJwtOptions): string {
  const header = { alg: "ES256", kid: keyId };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: issuerId,
    iat: now - 60,
    exp: now + 20 * 60 - 60,
    aud: "appstoreconnect-v1",
  };
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

/**
 * ASC REST API 客户端：JWT 惰性续签 + 重试矩阵 + 错误分类（docs/fastlane-adoption §5）。
 * - get: 幂等 GET，429/5xx 自动重试
 * - request: 写操作（POST/PATCH/DELETE），不自动重试（防重复创建/重复提审）
 */
export class AscClient {
  private jwt?: { token: string; issuedAt: number };

  constructor(private readonly auth: AscAuth) {}

  get<T = unknown>(apiPath: string): Promise<T> {
    return this.request<T>(apiPath, "GET");
  }

  async request<T = unknown>(apiPath: string, method: string, body?: unknown): Promise<T> {
    const idempotent = method === "GET";
    let refreshed401 = false;
    let n5xx = 0;
    let backoff429 = RETRY_429_START_MS;
    let spent429 = 0;
    for (;;) {
      const res = await fetch(`${ASC_API_BASE}${apiPath}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token()}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return (await parseBody<T>(res, apiPath)) as T;
      if (res.status === 401 && !refreshed401) {
        refreshed401 = true;
        this.jwt = undefined; // 强制重签后重试一次
        continue;
      }
      if (idempotent && res.status === 429 && spent429 < RETRY_429_TOTAL_MS) {
        await sleep(backoff429);
        spent429 += backoff429;
        backoff429 = Math.min(backoff429 * 2, RETRY_429_CAP_MS);
        continue;
      }
      if (
        idempotent &&
        [500, 502, 503, 504].includes(res.status) &&
        n5xx < RETRY_5XX_DELAYS_MS.length
      ) {
        await sleep(RETRY_5XX_DELAYS_MS[n5xx]!);
        n5xx += 1;
        continue;
      }
      throw await httpError(res, apiPath, method, idempotent);
    }
  }

  /** JWT 惰性续签：无/临期（剩 <2 分钟）即重签 */
  private token(): string {
    const now = Date.now();
    if (!this.jwt || now - this.jwt.issuedAt > JWT_TTL_MS - JWT_REFRESH_MARGIN_MS) {
      this.jwt = { token: makeAscJwt(this.auth), issuedAt: now };
    }
    return this.jwt.token;
  }
}

async function parseBody<T>(res: Response, apiPath: string): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`ASC API ${apiPath} 返回非 JSON（HTTP ${res.status}）: ${text.slice(0, 300)}`);
  }
}

async function httpError(
  res: Response,
  apiPath: string,
  method: string,
  idempotent: boolean,
): Promise<Error> {
  const json = (await res.json().catch(() => ({}))) as AscErrorBody;
  const first = json.errors?.[0];
  if (res.status === 403 && first?.code === "REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED")
    return new Error(
      `ASC API ${method} ${apiPath} 失败：付费协议未签或已过期——到 App Store Connect 网页（商务 → 协议）签署后重试`,
    );
  const retryHint = idempotent
    ? ""
    : "（写操作不自动重试：可能已成功，先跑 applift status --stores asc 确认再重试）";
  const methodPrefix = method === "GET" ? "" : `${method} `;
  return new Error(
    `ASC API ${methodPrefix}${apiPath} 失败 HTTP ${res.status}: ${JSON.stringify(json.errors ?? json).slice(0, 300)}${retryHint}`,
  );
}
