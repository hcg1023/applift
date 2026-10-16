/**
 * 测试共享基建：fetch mock（契约测试）——零依赖，vitest vi.stubGlobal 惯用法。
 * 断言各渠道请求形状（URL/method/headers/body），商店 API 变更时测试立红。
 */
import { vi } from "vitest";

export interface MockCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | FormData | Buffer;
  /** 渠道 fetch 是否带超时信号（P2-4 契约：全部 fetch 必须带 AbortSignal.timeout） */
  signal?: AbortSignal | null | undefined;
}

export interface MockResponseSpec {
  status?: number;
  json?: unknown;
  text?: string;
}

/** 构造 Response-like（渠道代码用 res.json()/res.text()/res.status/res.ok） */
function makeResponse(spec: MockResponseSpec): Response {
  const status = spec.status ?? 200;
  const body = spec.json !== undefined ? JSON.stringify(spec.json) : (spec.text ?? "");
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => (spec.json !== undefined ? spec.json : JSON.parse(body)),
    text: async () => body,
  } as unknown as Response;
}

/**
 * 安装 fetch mock：routes 按 URL 前缀/包含匹配（首个命中生效），未命中抛错（意外请求=测试失败）。
 * @returns calls 收集器（含断言辅助）
 */
export function mockFetch(
  routes: Array<{
    match: string | RegExp;
    /** 可选：限定 HTTP 方法（同 URL 不同 method 的接口区分用） */
    method?: string;
    response: MockResponseSpec | ((req: { method: string; url: string }) => MockResponseSpec);
  }>,
) {
  const calls: MockCall[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    const h = init?.headers as Record<string, string> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) headers[k] = v;
    calls.push({
      url,
      method,
      headers,
      body: init?.body as string | undefined,
      signal: init?.signal,
    });
    const route = routes.find(
      (r) =>
        (typeof r.match === "string" ? url.includes(r.match) : r.match.test(url)) &&
        (!r.method || r.method.toUpperCase() === method),
    );
    if (!route) throw new Error(`测试未预期的请求: ${method} ${url}`);
    const spec =
      typeof route.response === "function" ? route.response({ method, url }) : route.response;
    return makeResponse(spec);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    restore() {
      vi.unstubAllGlobals();
    },
    /** 找到命中 url 片段（可选限定 method）的调用 */
    find(urlPart: string, method?: string): MockCall | undefined {
      return calls.find(
        (c) => c.url.includes(urlPart) && (!method || c.method === method.toUpperCase()),
      );
    },
  };
}

/** 读尽 web ReadableStream 为 Buffer（流式上传 body 的字节级断言用） */
export async function readStreamToBuffer(body: unknown): Promise<Buffer> {
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** 构造渠道上下文（凭据/target/产物路径 + 事件收集） */
export function makeTestCtx(
  overrides: {
    credentials?: Record<string, string>;
    target?: Record<string, string>;
    artifactPath?: string;
    updateDescription?: string;
    releaseTime?: string;
  } = {},
) {
  const events: Array<{ type: string; [k: string]: unknown }> = [];
  return {
    events,
    ctx: {
      credentials: overrides.credentials ?? {},
      target: overrides.target ?? {},
      artifactPath: overrides.artifactPath ?? "/tmp/app-release.apk",
      updateDescription: overrides.updateDescription,
      releaseTime: overrides.releaseTime,
      emit: (e: { type: string; [k: string]: unknown }) => {
        events.push(e);
      },
    } as import("./channel.js").ChannelContext,
  };
}
