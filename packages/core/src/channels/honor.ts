/**
 * 荣耀应用市场（安卓 APK）渠道 —— 自 v1 tools/publish/lib/stores/honor.mjs 迁移（逻辑不变）。
 * 链路: iam token（form client_credentials）
 *   → POST /openapi/v1/publish/get-file-upload-url（fileType=100 APK，返回 uploadUrl + objectId）
 *   → multipart POST 到签名地址（Bearer token；HTTP 200 也可能带错误 code）
 *   → POST /openapi/v1/publish/update-file-info（bindingFileList=[{objectId}]）
 *   → POST /openapi/v1/publish/update-language-info（best-effort）
 *   → POST /openapi/v1/publish/submit-audit（releaseType=1 全网发布；定时上架 releaseType=2）
 * 审核状态查询（v2 新增）: POST /openapi/v1/publish/get-audit-result —— API 形状按 apkgo
 * （PolyForm NC，仅参考端点/形状，未复制代码）验证；官方文档: https://developer.honor.com/cn/doc/guides/101359
 */
import fs from "node:fs";
import path from "node:path";
import { fileBlob } from "./shared/file-blob.js";
import { sha256File, formatSize } from "../util.js";
import type {
  Channel,
  ChannelCapabilities,
  ChannelContext,
  ReleasePlanEntry,
  ReviewStatus,
  StageResult,
  SubmitResult,
} from "../channel.js";

const TOKEN_URL = "https://iam.developer.honor.com/auth/token";
const PUBLISH_BASE = "https://appmarket-openapi-drcn.cloud.honor.com";

const FILE_TYPE_APK = 100; // 荣耀文件类型: 100=应用包, 1=icon, 3=竖屏截图

/** 荣耀统一响应壳：code=0 成功；HTTP 200 也可能带错误 code（含签名 URL 过期/摘要不匹配） */
interface HonorRet {
  code?: number;
  msg?: string;
}

/** get-app-current-release 数据项: 0=审核中 1=通过 2=不通过 3=未提交 4=编辑中 */
interface HonorAuditItem {
  auditResult?: number;
  auditMessage?: string;
}

/** get-app-detail 返回的现有多语言文案（取 zh-CN 透传用） */
interface HonorAppDetail {
  appName?: string;
  intro?: string;
}

/** 荣耀 iam token（client_credentials）；非 JSON 响应按 HTTP 状态报错 */
async function getHonorToken({
  clientId,
  clientSecret,
}: {
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
  }).toString();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!json.access_token) {
    throw new Error(
      `荣耀 token 失败: ${json.error ?? ""} ${json.error_description ?? `HTTP ${res.status}`}`.trim(),
    );
  }
  return json.access_token;
}

async function honorPost<T extends HonorRet>(
  apiPath: string,
  token: string,
  bodyObj: unknown,
  context: string,
): Promise<T> {
  const res = await fetch(PUBLISH_BASE + apiPath, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bodyObj),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json: T;
  try {
    json = JSON.parse(text) as T;
  } catch {
    throw new Error(`荣耀 ${context}返回非 JSON（HTTP ${res.status}）: ${text.slice(0, 300)}`);
  }
  if (json.code !== 0) {
    throw new Error(
      `荣耀 ${context}失败 code=${json.code} ${json.msg ?? ""}: ${text.slice(0, 200)}`,
    );
  }
  return json;
}

/** 带 appId query 的 POST（荣耀发布接口 appId 走 query 参数；get-audit-result 例外走 body） */
async function honorPostQ<T extends HonorRet>(
  apiPath: string,
  appId: string,
  token: string,
  bodyObj: unknown,
  context: string,
): Promise<T> {
  const qs = new URLSearchParams({ appId }).toString();
  return honorPost<T>(`${apiPath}?${qs}`, token, bodyObj, context);
}

/** 带 appId query 的 GET（查询类接口，仅 Bearer 鉴权无 body） */
async function honorGetQ<T extends HonorRet>(
  apiPath: string,
  appId: string,
  token: string,
  context: string,
): Promise<T> {
  const qs = new URLSearchParams({ appId }).toString();
  const res = await fetch(`${PUBLISH_BASE}${apiPath}?${qs}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json: T;
  try {
    json = JSON.parse(text) as T;
  } catch {
    throw new Error(`荣耀 ${context}返回非 JSON（HTTP ${res.status}）: ${text.slice(0, 300)}`);
  }
  if (json.code !== 0) {
    throw new Error(
      `荣耀 ${context}失败 code=${json.code} ${json.msg ?? ""}: ${text.slice(0, 200)}`,
    );
  }
  return json;
}

/** RFC3339 → 荣耀定时发布格式：偏移不带冒号（+08:00→+0800）、Z→+0000，如 2026-06-20T10:00:00+0800（形状参照 apkgo submitAudit） */
function honorReleaseTime(rfc3339: string): string {
  const converted = rfc3339.replace(/([+-]\d{2}):(\d{2})$/, "$1$2").replace(/Z$/, "+0000");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{4}$/.test(converted)) {
    throw new Error(`荣耀 releaseTime 格式异常（需 RFC3339）: ${rfc3339}`);
  }
  return converted;
}

export class HonorChannel implements Channel {
  readonly id = "honor";
  readonly label = "荣耀应用市场";
  readonly capabilities: ChannelCapabilities = {
    stage: true,
    submit: true,
    scheduled: true,
    status: true,
  };
  readonly errorHints = {
    // 现行文档高频错误码
    "10003": "token 过期（CLI 每次现取，若出现请重试）",
    "20022": "已有审核中的版本，需等待审核完成后再提交",
    "30006": "版本号必须大于等于已上架版本",
    "30011": "提交过于频繁，请稍后再试",
    // 以下两码未见于现行文档，保留历史经验值
    "100030001": "认证失败：Client ID/Secret 无效或未开通 API 权限",
    "100030002": "token 过期（CLI 每次现取，若出现请重试）",
  };

  private async fetchToken(ctx: Pick<ChannelContext, "credentials" | "target">): Promise<string> {
    return getHonorToken({
      clientId: required(ctx, "HONOR_CLIENT_ID"),
      clientSecret: required(ctx, "HONOR_CLIENT_SECRET"),
    });
  }

  async plan(ctx: ChannelContext): Promise<ReleasePlanEntry> {
    return {
      channel: this.id,
      platform: "android",
      artifactVersion: "",
      action: "stage+submit",
      afterApproval: ctx.releaseTime ? "scheduled" : "auto-publish",
      notes: "更新文案需控制台已填应用简介（未填仅警告不阻断）；定时上架走 releaseType=2",
    };
  }

  async stage(ctx: ChannelContext): Promise<StageResult> {
    const appId = required(ctx, "appId", "项目配置 android.stores.honor.appId");
    const fileName = path.basename(ctx.artifactPath);
    const fileSize = fs.statSync(ctx.artifactPath).size;
    const fileSha256 = sha256File(ctx.artifactPath);
    const token = await this.fetchToken(ctx);
    ctx.emit({ type: "phase", phase: "auth", message: "token 获取成功" });

    // step 1: 申请上传地址（fileType=100 APK；body 为数组支持多文件，取第一个）
    const urlJson = await honorPostQ<
      HonorRet & { data?: Array<{ uploadUrl?: string; objectId?: number }> }
    >(
      "/openapi/v1/publish/get-file-upload-url",
      appId,
      token,
      [{ fileName, fileType: FILE_TYPE_APK, fileSize, fileSha256 }],
      "获取上传地址",
    );
    const { uploadUrl, objectId } = urlJson.data?.[0] ?? {};
    if (!uploadUrl || objectId === undefined) {
      throw new Error(`荣耀上传地址响应异常: ${JSON.stringify(urlJson).slice(0, 300)}`);
    }

    // step 2: multipart 上传到签名地址（Bearer token；签名 URL 拒绝时 HTTP 可能仍 200 + code!=0）
    ctx.emit({
      type: "phase",
      phase: "upload",
      message: `上传 ${fileName}（${formatSize(fileSize)}）`,
    });
    const form = new FormData();
    // openAsBlob 惰性 Blob：按需分片读，零整读内存（旧运行时回退 readFile 整读）
    form.append("file", await fileBlob(ctx.artifactPath), fileName);
    const upRes = await fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(900_000),
    });
    const upText = await upRes.text();
    let upJson: HonorRet;
    try {
      upJson = JSON.parse(upText) as HonorRet;
    } catch {
      throw new Error(`荣耀上传返回非 JSON（HTTP ${upRes.status}）: ${upText.slice(0, 300)}`);
    }
    if (upJson.code !== 0) {
      throw new Error(
        `荣耀上传失败 code=${upJson.code} ${upJson.msg ?? ""}（签名 URL 过期或 sha256 不匹配）`,
      );
    }

    // step 3: 绑定文件（更新只传变更文件，其余继承上一版本）
    await honorPostQ<HonorRet>(
      "/openapi/v1/publish/update-file-info",
      appId,
      token,
      { bindingFileList: [{ objectId }] },
      "绑定文件",
    );
    ctx.emit({ type: "phase", phase: "bind", message: `软件包已绑定（objectId: ${objectId}）` });
    return { ok: true, ref: String(objectId) };
  }

  async submit(ctx: ChannelContext): Promise<SubmitResult> {
    const appId = required(ctx, "appId");
    const token = await this.fetchToken(ctx);

    // step 4: 更新文案（best-effort；现行文档要求 languageInfoList 携带现有 appName/intro 透传，
    // 故先查 get-app-detail 取回现有文案，查不到则 warn 跳过，不阻断提审主链路）
    if (ctx.updateDescription) {
      try {
        if (ctx.updateDescription.length > 500) {
          throw new Error(`更新文案超过 500 字（当前 ${ctx.updateDescription.length} 字）`);
        }
        const detail = await honorPostQ<HonorRet & { data?: HonorAppDetail }>(
          "/openapi/v1/publish/get-app-detail",
          appId,
          token,
          {},
          "查询应用详情",
        );
        const { appName, intro } = detail.data ?? {};
        if (!appName || !intro) {
          throw new Error(
            `应用详情缺 appName/intro: ${JSON.stringify(detail.data ?? {}).slice(0, 200)}`,
          );
        }
        // setAll=0 仅更新 zh-CN，防止误清空其他语种文案
        await honorPostQ<HonorRet>(
          "/openapi/v1/publish/update-language-info",
          appId,
          token,
          {
            languageInfoList: [
              { languageId: "zh-CN", appName, intro, newFeature: ctx.updateDescription },
            ],
            setAll: 0,
          },
          "更新文案",
        );
      } catch (e) {
        ctx.emit({ type: "warn", message: `更新文案未写入（不阻断）: ${(e as Error).message}` });
      }
    }

    // step 5: 提交审核（releaseType=1 全网发布；定时上架 releaseType=2 + releaseTime）
    ctx.emit({ type: "phase", phase: "submit" });
    const body: Record<string, string | number> = ctx.releaseTime
      ? { releaseType: 2, releaseTime: honorReleaseTime(ctx.releaseTime) }
      : { releaseType: 1 };
    const submit = await honorPostQ<HonorRet & { data?: string }>(
      "/openapi/v1/publish/submit-audit",
      appId,
      token,
      body,
      "提交审核",
    );
    ctx.emit({
      type: "phase",
      phase: "done",
      message: ctx.releaseTime
        ? `已提审（定时上架 ${ctx.releaseTime}，releaseId: ${submit.data ?? "?"}）`
        : `已提审（审核通过后自动上架，releaseId: ${submit.data ?? "?"}）`,
    });
    return { ok: true, ref: submit.data };
  }

  async status(ctx: Pick<ChannelContext, "credentials" | "target">): Promise<ReviewStatus> {
    const appId = required(ctx, "appId", "审核状态查询必需");
    const token = await this.fetchToken(ctx);

    // 查当前版本审核状态（query appId，无需 releaseId；appId 直接透传字符串）
    const json = await honorGetQ<HonorRet & { data?: HonorAuditItem }>(
      "/openapi/v1/publish/get-app-current-release",
      appId,
      token,
      "查询审核状态",
    );
    const item = json.data;
    if (!item || item.auditResult === undefined) {
      return {
        state: "unknown",
        raw: `get-app-current-release 无数据: ${JSON.stringify(json).slice(0, 200)}`,
      };
    }
    // 编号体系: 0=审核中 1=审核通过 2=审核不通过 3=未提交 4=编辑中
    switch (item.auditResult) {
      case 0:
        return { state: "reviewing" };
      case 1:
        // 荣耀接口不区分"已上架"；全网发布审核通过即自动上架，故 live=true（定时发布以 releaseTime 为准）
        return { state: "approved", live: true };
      case 2:
        return { state: "rejected", reason: item.auditMessage };
      case 3:
        return { state: "unknown", raw: "未提交审核（auditResult=3）" };
      case 4:
        return { state: "unknown", raw: "编辑中未提交（auditResult=4）" };
      default:
        return {
          state: "unknown",
          raw: `auditResult=${item.auditResult} ${item.auditMessage ?? ""}`.trim(),
        };
    }
  }
}

function required(
  ctx: Pick<ChannelContext, "credentials" | "target">,
  key: string,
  where?: string,
): string {
  // target 优先；凭据别名 HONOR_APP_ID 兜底（init/channels 指引写入）
  const alias = key === "appId" ? "HONOR_APP_ID" : "";
  const v = ctx.target[key] ?? ctx.credentials[key] ?? (alias && ctx.credentials[alias]);
  if (!v) {
    throw new Error(
      `荣耀渠道缺少 ${key}${where ? `（${where}）` : alias ? `（项目配置或凭据 ${alias}）` : ""}`,
    );
  }
  return v;
}
