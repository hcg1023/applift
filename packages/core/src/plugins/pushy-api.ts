/**
 * pushy OpenAPI HTTP 客户端（x-api-token 鉴权），替代原 spawn pushy CLI 的服务端操作。
 * 端点与载荷对照 react-native-update-cli 2.29.3 源码（官方参考客户端）反推：
 *   publish     POST /app/:id/version/create {name, hash, description} + POST /app/:id/binding
 *   uploadApp   POST /upload {ext, appId, size} → 对象存储直传 → POST /app/:id/package/create {name, hash, buildTime}
 *   rebind      GET /app/:id/package/list → POST /app/:id/binding {versionId, rollout, packageId}
 *   versions    GET /app/:id/version/list?offset&limit（服务端封顶 limit=100，逐页取尽）
 *   上传指令    POST /upload → {url, formData}（multipart 直传，formData.key 即 hash）
 *               或自托管节点 {method:'PUT', key}（预签名 PUT 直传用户对象存储）
 * ppk 不在此层：热更包是构建产物，由调用方先行产出（--artifact 显式或 ppkPatterns 探测，
 * 见 rn-update.ts）——applift 不 spawn 构建命令（架构不变量 1）。
 * cresc/自建服务差异仅在 baseUrl（同一套服务端代码），serverUrl 由 rnUpdate 配置注入。
 * uploadApp 相对官方 CLI 的有意降级（记录在案）：传原始产物而非 slim 包、不带 bundleHash/
 * bytecodeVersion/bundleLocation（服务端无法将该基线用作 hermes-base 或 package-origin diff）、
 * buildTime 为上传时刻而非包内提取、不校验包内 appId 与目标 app 一致（配错 appId 会传到别的 app——
 * 由配置审查保证）、不做 maxSize 预检（超限撞对象存储错误）。需要 hermes-base 能力时在此补齐。
 */
import fs from "node:fs";
import path from "node:path";
import nodeHttp from "node:http";
import nodeHttps from "node:https";
import { spawnSync } from "node:child_process";

/**
 * pushy 服务端操作契约（全 OpenAPI 实现；注入点：测试 mock）。
 * ppk 不在此层：热更包是构建产物，由调用方先行产出（--artifact 显式或 ppkPatterns 探测，
 * 见 rn-update.ts）——applift 不 spawn 构建命令（架构不变量 1）。
 */
export interface PushyCli {
  /** 发布热更版本（version/create + 绑定目标原生版本），返回版本 id。
   *  deps 为服务端强校验所需（2026-09-17 后创建的应用要求 deps 里有 react-native-update
   *  >= 10.53.1——实测缺省被 400 拒绝），由调用方用 readDepVersions 从工程读取。
   *  不上报 commit：实测带 commit（官方 getCommitInfo 同构形态）被 version/create 以
   *  「上传凭据无效」拒绝（2026-10-21 实证，去 commit 即过）；溯源走本地 history.jsonl */
  publish(input: {
    appId: number;
    ppk: string;
    platform: string;
    name: string;
    description?: string;
    packageVersion: string;
    rollout?: number;
    deps: Record<string, string>;
  }): Promise<{ versionId: number }>;
  /** 上传原生基线（versionName 由调用方从产物读取后显式传入；deps 同 publish） */
  uploadApp(
    appId: number,
    appFile: string,
    versionName: string,
    deps: Record<string, string>,
  ): Promise<{ packageId: number; version: string }>;
  /** 版本重绑（promote 语义：测试通道版本重绑正式原生版本 + 灰度） */
  rebind(input: {
    appId: number;
    versionId: number;
    packageVersion: string;
    rollout?: number;
  }): Promise<void>;
  /** 版本列表（取号与状态展示用）。packageVersion：该热更绑定的原生基线版本名
   *  （基线自动替换的安全判据；服务端未回显时字段缺省，调用方按无法确认处理） */
  versions(
    appId: number,
  ): Promise<Array<{ id: number; hash: string; name: string; packageVersion?: string }>>;
  /** 基线包列表（GET /app/:id/package/list；409 自动替换的发现手段） */
  packages(
    appId: number,
  ): Promise<Array<{ id: number; hash: string; name: string; status: string }>>;
  /** 删除基线包（DELETE /app/:id/package/:packageId，2026-10-25 实测端点存在）。
   *  调用方必须先确认该基线无热更版本绑定（删除被绑定的基线会孤儿化热更）。 */
  deletePackage(appId: number, packageId: number): Promise<void>;
}

/** credentials.json 中的 pushy token 键名 */
export const PUSHY_TOKEN_KEY = "PUSHY_API_TOKEN";

/** pushy 官方 API 根（官方 CLI 默认端点簇的主端点） */
export const PUSHY_DEFAULT_BASE_URL = "https://update.reactnative.cn/api";

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface PushyApiOptions {
  /** 服务端 API 根；缺省 pushy 官方，cresc 自建传如 https://cresc.example.com/api */
  baseUrl?: string;
  /** x-api-token（credentials.json 的 PUSHY_API_TOKEN） */
  token: string;
  /** 注入点：测试 mock（缺省 globalThis.fetch） */
  fetchImpl?: FetchImpl;
  /** 直传实现注入（缺省 node:http(s) 原生；测试 mock） */
  httpUpload?: HttpUploadImpl;
}

interface UploadInstruction {
  url: string;
  formData?: Record<string, string>;
  method?: string;
  headers?: Record<string, string>;
  key?: string;
  maxSize?: string;
}

/** 分页硬顶（×limit=100/页）：服务端异常恒返整页时的死循环防线（官方 findVersion 同款硬顶） */
const PAGES_HARD_CAP = 100;
// UA 必须精确为官方形态单 token：服务端按 `react-native-update-cli/<版本>` 做版本门禁
// （2026-09-17 后创建的应用要求 >=2.22.9；附加标识如 "2.29.3 applift" 会被当版本号解析而拒绝——
// 实测 applift 自有 UA → 400「请升级 cli」，官方 UA → 200）。版本号 = 载荷反推基准的参考实现版本。
const UA = "react-native-update-cli/2.29.3";

async function query<T>(
  f: FetchImpl,
  baseUrl: string,
  token: string,
  api: string,
  init?: { method?: string; body?: string },
): Promise<T> {
  let res: Response;
  try {
    res = await f(`${baseUrl}${api}`, {
      method: init?.method ?? "GET",
      headers: {
        "User-Agent": UA,
        "x-api-token": token,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(init?.body ? { body: init.body } : {}),
    });
  } catch (e) {
    throw new Error(`pushy API 网络错误：${api}——${(e as Error).message}`);
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    if (res.ok)
      throw new Error(
        `pushy API ${api} 返回 200 但响应体非 JSON（${text.length} 字节，疑似网关劫持）`,
      );
  }
  if (!res.ok) {
    const msg =
      (json as { message?: string } | undefined)?.message || res.statusText || `HTTP ${res.status}`;
    const err = new Error(
      res.status === 401
        ? `pushy API 鉴权失败（token 无效或过期）：请更新 credentials.json 的 ${PUSHY_TOKEN_KEY}`
        : `pushy API ${api} 失败（HTTP ${res.status}）：${msg}`,
    );
    // 结构化 status：调用方（基线 409 自动替换等）按状态码分支，不靠 message 匹配
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return (json ?? {}) as T;
}

/** 文件 part 的 Content-Type（对照官方 fileContentType 的扩展名表；未列出走 octet-stream） */
function fileContentType(fileName: string): string {
  switch (path.extname(fileName).toLowerCase()) {
    case ".apk":
      return "application/vnd.android.package-archive";
    case ".zip":
      return "application/zip";
    case ".json":
    case ".map":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

/**
 * 对象存储直传，返回服务端侧 hash/key。
 * Buffer 整体读入：ppk/原生基线在发版机场景为几十 MB 量级，换取 content-length 精确与实现简单
 * （旧 CLI 流式是为进度条与代理改写，非容量需求）。不申请 chunked（响应分支少一半，
 * ppk 增量优化留待 diffStatus 端点，见设计说明）。
 */
async function uploadFile(
  f: FetchImpl,
  baseUrl: string,
  token: string,
  appId: number,
  file: string,
  upload?: HttpUploadImpl,
): Promise<string> {
  if (!fs.existsSync(file)) throw new Error(`pushy 上传文件不存在：${file}`);
  const size = fs.statSync(file).size;
  const instr = await query<UploadInstruction>(f, baseUrl, token, "/upload", {
    method: "POST",
    // chunked: true 与官方恒同（响应仍为整文件表单形态——chunked 指令是 GCS 后端特性）
    body: JSON.stringify({ ext: path.extname(file), appId, chunked: true, size }),
  });
  const httpUpload = upload ?? nodeHttpUpload;
  if (instr.method === "PUT") {
    // 自托管节点（rnu-node）预签名 PUT：字节直达用户对象存储
    const putBody = fs.readFileSync(file);
    const res = await httpUpload(
      "PUT",
      instr.url,
      { "content-length": String(size), ...(instr.headers ?? {}) },
      putBody,
    );
    if (res.status > 299) throw new Error(`pushy 基线直传失败（HTTP ${res.status}）：${instr.url}`);
    return instr.key!;
  }
  // 标准对象存储 multipart：官方契约 = formData 字段在前、file part 在后（名称固定 "file"）
  const fields = Object.entries(instr.formData ?? {});
  const boundary = `--------------------------${Array.from({ length: 24 }, () =>
    Math.floor(Math.random() * 16).toString(16),
  ).join("")}`;
  let head = "";
  for (const [name, value] of fields)
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  head +=
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${path.basename(file)}"\r\n` +
    `Content-Type: ${fileContentType(file)}\r\n\r\n`;
  const body = Buffer.concat([
    Buffer.from(head),
    fs.readFileSync(file),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await httpUpload(
    "POST",
    instr.url,
    {
      accept: "*/*",
      "user-agent": UA,
      "content-type": `multipart/form-data;boundary=${boundary}`,
      "content-length": String(body.length),
    },
    body,
  );
  if (res.status > 299) throw new Error(`pushy 文件直传失败（HTTP ${res.status}）：${instr.url}`);
  const key = fields.find(([name]) => name === "key")?.[1];
  if (!key) throw new Error(`pushy /upload 指令缺 formData.key（服务端响应异常）：${instr.url}`);
  return key;
}

/** 直传实现（node:http(s) 原生；测试注入 mock） */
export type HttpUploadImpl = (
  method: "POST" | "PUT",
  url: string,
  headers: Record<string, string>,
  body: Buffer,
) => Promise<{ status: number }>;

export async function nodeHttpUpload(
  method: "POST" | "PUT",
  url: string,
  headers: Record<string, string>,
  body: Buffer,
): Promise<{ status: number }> {
  const mod = url.startsWith("https:") ? nodeHttps : nodeHttp;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method, headers });
    req.on("response", (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on("error", (e) => reject(new Error(`pushy 直传网络错误：${url}——${e.message}`)));
    req.end(body);
  });
}

/** packageVersion → packageId 精确匹配（对照 CLI update：pkg.name === packageVersion） */
async function bind(
  q: <T>(api: string, init?: { method?: string; body?: string }) => Promise<T>,
  appId: number,
  versionId: number,
  packageVersion: string,
  rollout: number | undefined,
): Promise<void> {
  const pkgs = await listAllPackages(q, appId);
  const pkg = pkgs.find((p) => p.name === packageVersion);
  if (!pkg)
    throw new Error(
      `pushy 未找到原生包版本 ${packageVersion}（appId=${appId}，已有 ${pkgs.length} 个基线）——` +
        `原生包尚未上传？先发一次原生版（stage:after 会自动上传基线）`,
    );
  await q(`/app/${appId}/binding`, {
    method: "POST",
    body: JSON.stringify({ versionId, rollout, packageId: pkg.id }),
  });
}

async function listAllPackages(
  q: <T>(api: string, init?: { method?: string; body?: string }) => Promise<T>,
  appId: number,
): Promise<Array<{ id: number; name: string }>> {
  const out: Array<{ id: number; name: string }> = [];
  const limit = 100;
  for (let offset = 0; offset < limit * PAGES_HARD_CAP; offset += limit) {
    const { data } = await q<{ data?: Array<{ id: number; name: string }> }>(
      `/app/${appId}/package/list?offset=${offset}&limit=${limit}`,
    );
    if (!data?.length) break;
    out.push(...data);
    if (data.length < limit) break;
  }
  return out;
}

/** 项目直接依赖（dependencies+devDependencies）的实装版本映射（逐级向上找 node_modules，键排序）。
 *  对照官方 dep-versions.js 同构：服务端按 deps["react-native-update"] 做热更兼容门禁与变更提示 */
export function readDepVersions(cwd: string): Record<string, string> {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
  } catch {
    return {};
  }
  const versions: Record<string, string> = {};
  for (const dep of new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ])) {
    let dir = path.resolve(cwd);
    for (;;) {
      try {
        const installed = JSON.parse(
          fs.readFileSync(path.join(dir, "node_modules", dep, "package.json"), "utf8"),
        ) as { version?: string };
        if (typeof installed.version === "string") versions[dep] = installed.version;
        break;
      } catch {
        // 该层级未安装，向上找
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return Object.fromEntries(
    Object.keys(versions)
      .sort()
      .map((k) => [k, versions[k]!]),
  );
}

/** OpenAPI 实现 PushyCli 的服务端操作（ppk 由调用方产出，见 PushyCli 契约注释） */
export function createPushyApi(opts: PushyApiOptions): PushyCli {
  const baseUrl = opts.baseUrl ?? PUSHY_DEFAULT_BASE_URL;
  const f = opts.fetchImpl ?? fetch.bind(globalThis);
  const q = <T>(api: string, init?: { method?: string; body?: string }) =>
    query<T>(f, baseUrl, opts.token, api, init);

  return {
    async publish(input) {
      const hash = await uploadFile(
        f,
        baseUrl,
        opts.token,
        input.appId,
        input.ppk,
        opts.httpUpload,
      );
      const { id } = await q<{ id: number }>(`/app/${input.appId}/version/create`, {
        method: "POST",
        body: JSON.stringify({
          name: input.name,
          hash,
          description: input.description ?? "",
          metaInfo: "",
          deps: input.deps,
        }),
      });
      // packageVersion + rollout = 绑定目标原生版本（对照 CLI publish --packageVersion 的隐式 update）
      await bind(q, input.appId, id, input.packageVersion, input.rollout);
      return { versionId: id };
    },

    async uploadApp(appId, appFile, versionName, deps) {
      const hash = await uploadFile(f, baseUrl, opts.token, appId, appFile, opts.httpUpload);
      const { id } = await q<{ id: number }>(`/app/${appId}/package/create`, {
        method: "POST",
        body: JSON.stringify({
          name: versionName,
          hash,
          buildTime: String(Date.now()),
          deps,
        }),
      });
      return { packageId: id, version: versionName };
    },

    async rebind(input) {
      await bind(q, input.appId, input.versionId, input.packageVersion, input.rollout);
    },

    async versions(appId) {
      const out: Array<{ id: number; hash: string; name: string; packageVersion?: string }> = [];
      const limit = 100;
      for (let offset = 0; offset < limit * PAGES_HARD_CAP; offset += limit) {
        const { data } = await q<{
          data?: Array<{ id: number; hash?: string; name: string; packageVersion?: string }>;
        }>(`/app/${appId}/version/list?offset=${offset}&limit=${limit}`);
        if (!data?.length) break;
        for (const v of data)
          out.push({
            id: v.id,
            hash: v.hash ?? "",
            name: v.name,
            // 服务端回显才有（基线自动替换的安全判据；缺失时调用方按无法确认处理）
            ...(v.packageVersion !== undefined ? { packageVersion: v.packageVersion } : {}),
          });
        if (data.length < limit) break;
      }
      return out;
    },

    async packages(appId) {
      const out: Array<{ id: number; hash: string; name: string; status: string }> = [];
      const limit = 100;
      for (let offset = 0; offset < limit * PAGES_HARD_CAP; offset += limit) {
        const { data } = await q<{
          data?: Array<{ id: number; hash?: string; name: string; status?: string }>;
        }>(`/app/${appId}/package/list?offset=${offset}&limit=${limit}`);
        if (!data?.length) break;
        for (const p of data)
          out.push({ id: p.id, hash: p.hash ?? "", name: p.name, status: p.status ?? "" });
        if (data.length < limit) break;
      }
      return out;
    },

    async deletePackage(appId, packageId) {
      // 2026-10-25 实测：DELETE /app/:id/package/:pid 存在且对不存在 id 也 200（宽松语义）
      await q(`/app/${appId}/package/${packageId}`, { method: "DELETE" });
    },
  };
}
