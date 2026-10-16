/**
 * Google Play 渠道（安卓 AAB/APK）—— Android Publisher API v3（官方公开 API）。
 * 链路: Service Account JSON（GOOGLEPLAY_SA_JSON 文件路径 / GOOGLEPLAY_SA_KEY 内容）
 *   → RS256 JWT（node:crypto 签名）POST oauth2.googleapis.com/token 换 access_token
 *   → POST /edits 开 edit → 上传 bundles(.aab)/apks(.apk)（/upload/ 媒体端点 + uploadType=media）
 *   → PUT /edits/{id}/tracks/{track} 部署轨道 → POST /edits/{id}:commit
 * 两段式映射: stage = internal 内测轨道（不对外）；submit = production（status=completed，
 *   Google 审核通过自动发布，不支持定时 → scheduled=false）
 * 文档: https://developers.google.com/android-publisher
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { formatSize } from "../util.js";
import type {
  Channel,
  ChannelCapabilities,
  ChannelContext,
  ReleasePlanEntry,
  ReviewStatus,
  StageResult,
  SubmitResult,
} from "../channel.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
// 媒体上传端点：同 host 走 /upload/ 前缀（对拍 apkgo googleplay.go uploadBase 权威；REST JSON 端点不混用）
const UPLOAD_BASE =
  "https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
/** Service Account JSON 关键字段 */
interface ServiceAccount {
  client_email: string;
  private_key: string;
}

/** 上传产物响应（bundles 与 apks 形状一致） */
interface UploadResult {
  versionCode?: number;
}

/** track releases 条目（status: completed/inProgress/halted/draft；userFraction 为分阶段发布比例，合并 PUT 时原样透传） */
interface TrackRelease {
  versionCodes?: number[];
  status?: string;
  userFraction?: number;
  releaseNotes?: Array<{ language?: string; text?: string }>;
}

/**
 * 解析 Service Account JSON：优先 GOOGLEPLAY_SA_KEY（内容），其次 GOOGLEPLAY_SA_JSON（文件路径，支持 ~）。
 * 失败时错误信息带凭据键名与获取指引。
 */
function loadServiceAccount(credentials: Readonly<Record<string, string>>): ServiceAccount {
  const guide = "在 Google Cloud Console → IAM 和管理 → 服务账号 创建服务账号并导出 JSON 密钥，";
  let raw: string | undefined = credentials.GOOGLEPLAY_SA_KEY;
  if (!raw) {
    const filePath = credentials.GOOGLEPLAY_SA_JSON;
    if (!filePath) {
      throw new Error(
        `Google Play 渠道缺少凭据：GOOGLEPLAY_SA_JSON（密钥文件路径）或 GOOGLEPLAY_SA_KEY（密钥 JSON 内容）至少配一项。${guide}并在 Google Play Console → 用户和权限 中用该服务账号邮箱邀请用户、授予发布权限`,
      );
    }
    const expanded = filePath.startsWith("~/")
      ? path.join(os.homedir(), filePath.slice(2))
      : filePath;
    try {
      raw = fs.readFileSync(expanded, "utf8");
    } catch (e) {
      throw new Error(
        `GOOGLEPLAY_SA_JSON 读取失败（${expanded}）: ${(e as Error).message}。${guide}`,
      );
    }
  }
  let sa: ServiceAccount;
  try {
    sa = JSON.parse(raw) as ServiceAccount;
  } catch {
    throw new Error(
      `Service Account JSON 解析失败（GOOGLEPLAY_SA_KEY/GOOGLEPLAY_SA_JSON 内容不是合法 JSON）。${guide}`,
    );
  }
  if (!sa.client_email || !sa.private_key) {
    throw new Error(`Service Account JSON 缺少 client_email 或 private_key 字段。${guide}`);
  }
  return sa;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 构造并签名 RS256 JWT（SA 授权，scope=androidpublisher） */
function signJwt(sa: ServiceAccount): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 };
  const encoded = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(payload)))}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(encoded);
  const signature = base64url(signer.sign(sa.private_key));
  return `${encoded}.${signature}`;
}

/** SA JWT 换 access_token；非 JSON 或缺 access_token 按 HTTP 状态/响应体报错 */
async function getAccessToken(credentials: Readonly<Record<string, string>>): Promise<string> {
  const sa = loadServiceAccount(credentials);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: signJwt(sa),
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json: { access_token?: string; error_description?: string; error?: string };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    throw new Error(
      `Google OAuth2 token 接口返回非 JSON（HTTP ${res.status}）: ${text.slice(0, 300)}`,
    );
  }
  if (!res.ok || !json.access_token) {
    throw new Error(
      `Google OAuth2 token 获取失败（HTTP ${res.status}）: ${json.error_description ?? json.error ?? text.slice(0, 200)}。请检查 Service Account 密钥有效性（GOOGLEPLAY_SA_JSON/GOOGLEPLAY_SA_KEY）`,
    );
  }
  return json.access_token;
}

/** Publisher v3 JSON 请求统一封装：非 2xx 抛错（含 error.message）。媒体上传传流式 body（自动补 duplex:'half'）与更长超时 */
async function apiFetch<T>(
  url: string,
  token: string,
  init: {
    method: string;
    body?: string | Buffer | ReadableStream<Uint8Array>;
    contentType?: string;
    /** AbortSignal.timeout 毫秒数：查询默认 30s，上传传 900s（全仓约定） */
    timeoutMs?: number;
    /** 已知长度时显式携带（流式 body undici 不再自动计算），保持与旧 Buffer body 相同的非 chunked 框架 */
    contentLength?: number;
  },
  context: string,
): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (init.body !== undefined) headers["Content-Type"] = init.contentType ?? "application/json";
  if (init.contentLength !== undefined) headers["Content-Length"] = String(init.contentLength);
  const isStreamBody =
    init.body !== undefined && typeof init.body !== "string" && !(init.body instanceof Buffer);
  const res = await fetch(url, {
    method: init.method,
    headers,
    body: init.body,
    // undici 要求流式 body 声明 duplex，非流 body 不允许携带该字段
    ...(isStreamBody ? { duplex: "half" as const } : {}),
    signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const err = (json as { error?: { message?: string } } | undefined)?.error?.message;
    throw new Error(
      `Google Play ${context}失败（HTTP ${res.status}）: ${err ?? text.slice(0, 300)}`,
    );
  }
  return (json ?? {}) as T;
}

export class GooglePlayChannel implements Channel {
  readonly id = "googleplay";
  readonly label = "Google Play";
  readonly capabilities: ChannelCapabilities = {
    stage: true,
    submit: true,
    scheduled: false,
    status: true,
  };

  async plan(_ctx: ChannelContext): Promise<ReleasePlanEntry> {
    return {
      channel: this.id,
      platform: "android",
      artifactVersion: "",
      action: "stage+submit",
      afterApproval: "auto-publish",
      notes:
        "stage 走 internal 内测轨道（不对外）；submit 走 production，Google 审核通过自动发布；不支持定时上架",
    };
  }

  async stage(ctx: ChannelContext): Promise<StageResult> {
    const result = await this.uploadAndAssign(ctx, "internal", undefined);
    return { ok: true, ref: result };
  }

  async submit(ctx: ChannelContext): Promise<SubmitResult> {
    const result = await this.uploadAndAssign(ctx, "production", ctx.updateDescription);
    return { ok: true, ref: result };
  }

  /** 上传 + 部署到指定轨道 + commit，返回 `editId:versionCode` */
  private async uploadAndAssign(
    ctx: ChannelContext,
    track: string,
    releaseNotes: string | undefined,
  ): Promise<string> {
    const pkgName = this.requirePkgName(ctx);
    const token = await getAccessToken(ctx.credentials);
    ctx.emit({ type: "phase", phase: "auth", message: "OAuth2 token 获取成功" });

    // step 1: 开 edit
    const edit = await apiFetch<{ id?: string }>(
      `${API_BASE}/${pkgName}/edits`,
      token,
      { method: "POST", body: "{}" },
      "创建 edit",
    );
    if (!edit.id)
      throw new Error(`Google Play 创建 edit 响应缺少 id: ${JSON.stringify(edit).slice(0, 300)}`);
    const editId = edit.id;

    // step 2: 上传（.aab → bundles，.apk → apks，均 uploadType=media）
    const fileName = path.basename(ctx.artifactPath);
    const ext = path.extname(fileName).toLowerCase();
    if (ext !== ".aab" && ext !== ".apk") {
      throw new Error(`Google Play 仅支持 .aab/.apk 产物，收到: ${fileName}`);
    }
    const endpoint = ext === ".aab" ? "bundles" : "apks";
    const fileSize = fs.statSync(ctx.artifactPath).size;
    ctx.emit({
      type: "phase",
      phase: "upload",
      message: `上传 ${fileName} 到 ${track} 轨道（${formatSize(fileSize)}）`,
    });
    // 流式上传 body：避免 readFileSync 整读 + fetch 内部拷贝双份内存（P2-3）；Content-Length 显式携带，等价旧 Buffer body 的非 chunked 框架
    const uploaded = await apiFetch<UploadResult>(
      `${UPLOAD_BASE}/${pkgName}/edits/${editId}/${endpoint}?uploadType=media`,
      token,
      {
        method: "POST",
        body: Readable.toWeb(fs.createReadStream(ctx.artifactPath)),
        contentType: "application/octet-stream",
        timeoutMs: 900_000,
        contentLength: fileSize,
      },
      `${endpoint} 上传`,
    );
    const versionCode = uploaded.versionCode;
    if (versionCode === undefined) {
      throw new Error(
        `Google Play 上传响应缺少 versionCode: ${JSON.stringify(uploaded).slice(0, 300)}`,
      );
    }
    ctx.emit({ type: "progress", detail: `上传成功（versionCode: ${versionCode}）` });

    // step 3: 部署到轨道（completed；releaseNotes zh-CN，仅 submit 有文案时携带）
    // 先 GET 轨道现有 releases 再合并 PUT：目标 release（同 status=completed 配置）追加新 versionCode，
    // 其余 releases 原样保留（status/userFraction 不变），避免整轨覆盖把旧版本从轨道剔除
    const currentTrack = await apiFetch<{ releases?: TrackRelease[] }>(
      `${API_BASE}/${pkgName}/edits/${editId}/tracks/${track}`,
      token,
      { method: "GET" },
      `读取 ${track} 轨道现有 releases`,
    );
    const releases: TrackRelease[] = [...(currentTrack.releases ?? [])];
    const release: TrackRelease = { versionCodes: [versionCode], status: "completed" };
    if (releaseNotes) release.releaseNotes = [{ language: "zh-CN", text: releaseNotes }];
    const target = releases.find((r) => r.status === "completed");
    if (target) {
      target.versionCodes = [...(target.versionCodes ?? []), versionCode];
      if (release.releaseNotes) target.releaseNotes = release.releaseNotes;
    } else {
      releases.push(release);
    }
    await apiFetch(
      `${API_BASE}/${pkgName}/edits/${editId}/tracks/${track}`,
      token,
      { method: "PUT", body: JSON.stringify({ releases }) },
      `部署 ${track} 轨道`,
    );
    ctx.emit({
      type: "phase",
      phase: "bind",
      message: `已部署到 ${track} 轨道（versionCode: ${versionCode}）`,
    });

    // step 4: commit（:commit 冒号语法，对拍 apkgo googleplay.go 权威；对 production 含提交审核语义，internal 即生效）
    await apiFetch(
      `${API_BASE}/${pkgName}/edits/${editId}:commit`,
      token,
      { method: "POST" },
      "commit",
    );
    ctx.emit({
      type: "phase",
      phase: "done",
      message:
        track === "production"
          ? `已提交 production 发布（Google 审核通过后自动上架，versionCode: ${versionCode}）`
          : `已发布到 internal 内测轨道（versionCode: ${versionCode}）`,
    });
    return `${editId}:${versionCode}`;
  }

  async status(ctx: Pick<ChannelContext, "credentials" | "target">): Promise<ReviewStatus> {
    const pkgName = this.requirePkgName(ctx);
    const token = await getAccessToken(ctx.credentials);
    // 官方只读端点（无 editId）：GET /applications/{pkg}/tracks/production 直接读正式轨当前状态
    const track = await apiFetch<{ releases?: TrackRelease[] }>(
      `${API_BASE}/${pkgName}/tracks/production`,
      token,
      { method: "GET" },
      "查询 production 轨道",
    );
    const release = track.releases?.[0];
    if (!release || !release.status) {
      return { state: "unknown", raw: "production 轨道无 release" };
    }
    switch (release.status) {
      case "completed":
        // production 已 completed = 审核通过且已对全量用户发布
        return { state: "approved", live: true };
      case "inProgress":
        // 分阶段发布中：审核已通过、正在放量
        return { state: "approved", live: false };
      case "halted":
        return { state: "approved", live: false };
      case "draft":
        return { state: "reviewing" };
      default:
        return { state: "unknown", raw: `release status=${release.status}` };
    }
  }

  private requirePkgName(ctx: Pick<ChannelContext, "credentials" | "target">): string {
    const pkgName = ctx.target.pkgName;
    if (!pkgName)
      throw new Error(
        "Google Play 渠道缺少 pkgName（项目配置 android.stores.googleplay.pkgName，即 Play 商店包名如 com.example.app）",
      );
    return pkgName;
  }
}
