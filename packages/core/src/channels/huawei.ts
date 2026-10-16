/**
 * 华为应用市场（安卓 APK）渠道 —— 自 v1 lib/stores/huawei.mjs 迁移（逻辑不变）。
 * v2 链路: token → upload-url/for-obs → PUT → app-file-info(fileType=5) → language-info → 等120s → app-submit
 */
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { sha256File, formatSize } from "../util.js";
import { sleep } from "../util.js";
import { getAgcToken } from "./shared/agc-token.js";
import {
  resolveListing,
  type ListingCapableChannel,
  type ListingInput,
  type ListingResult,
} from "../listing.js";
import type {
  Channel,
  ChannelCapabilities,
  ChannelContext,
  ReleasePlanEntry,
  ReviewStatus,
  StageResult,
  SubmitResult,
} from "../channel.js";

const BASE = "https://connect-api.cloud.huawei.com/api";
export const WAIT_BEFORE_SUBMIT_MS = 120_000;

interface HuaweiRet {
  ret?: { code?: number; msg?: string };
}

async function hwJson<T extends HuaweiRet>(
  url: string,
  init: RequestInit,
  context: string,
): Promise<T> {
  const res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(60_000) });
  let json: T;
  try {
    json = (await res.json()) as T;
  } catch {
    throw new Error(`华为 ${context}返回非 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok || json.ret?.code !== 0) {
    const code = json.ret?.code ?? res.status;
    throw new Error(
      `华为 ${context}失败 ${code}: ${json.ret?.msg ?? JSON.stringify(json).slice(0, 300)}`,
    );
  }
  return json;
}

export class HuaweiAndroidChannel implements Channel, ListingCapableChannel {
  readonly id = "huawei";
  readonly label = "华为应用市场";
  readonly capabilities: ChannelCapabilities = {
    stage: true,
    submit: true,
    scheduled: true,
    status: true,
  };
  readonly errorHints = {
    "204144719": "软件包正在编译中（正常时序，CLI 已自动重试；持续出现请到 AGC 控制台看包状态）",
    "204144727": "编译中，官方建议 3-5 分钟后再试（CLI 已自动重试）",
    "204144660": "提交失败，包可能仍在解析（稍后重试或到控制台查看）",
    "1003": "client_id/client_secret 无效（AGC → 项目设置 → 常规 → API Client 重新获取）",
    "204144702": "签名/证书不匹配：检查签名证书指纹（SHA256）与 AGC 后台登记是否一致",
    "204144677": "bundleName 与应用不匹配：确认 appId 对应的应用包名",
  };

  private async authHeaders(ctx: Pick<ChannelContext, "credentials" | "target">) {
    const clientId = required(ctx, "HW_CLIENT_ID");
    const clientSecret = required(ctx, "HW_CLIENT_SECRET");
    const token = await getAgcToken({ clientId, clientSecret });
    return { clientId, headers: { client_id: clientId, Authorization: `Bearer ${token}` } };
  }

  async plan(ctx: ChannelContext): Promise<ReleasePlanEntry> {
    return {
      channel: this.id,
      platform: "android",
      artifactVersion: "",
      action: "stage+submit",
      afterApproval: ctx.releaseTime ? "scheduled" : "auto-publish",
      notes: "提审前需等 120s 软件包解析（华为文档要求）",
    };
  }

  async stage(ctx: ChannelContext): Promise<StageResult> {
    const appId = required(ctx, "appId", "项目配置 android.stores.huawei.appId");
    const fileName = path.basename(ctx.artifactPath);
    const fileSize = fs.statSync(ctx.artifactPath).size;
    const { headers } = await this.authHeaders(ctx);
    ctx.emit({ type: "phase", phase: "auth", message: "token 获取成功" });
    ctx.emit({
      type: "phase",
      phase: "upload",
      message: `上传 ${fileName}（${formatSize(fileSize)}）`,
    });

    const sha256 = sha256File(ctx.artifactPath);
    const qs = new URLSearchParams({ appId, fileName, sha256, contentLength: String(fileSize) });
    const urlJson = await hwJson<
      HuaweiRet & {
        urlInfo?: {
          url: string;
          objectId?: string;
          method?: string;
          headers?: Record<string, string>;
        };
      }
    >(`${BASE}/publish/v2/upload-url/for-obs?${qs}`, { headers }, "获取上传地址");
    const urlInfo = urlJson.urlInfo;
    if (!urlInfo?.url)
      throw new Error(`华为上传地址为空: ${JSON.stringify(urlJson).slice(0, 200)}`);

    const method = (urlInfo.method ?? "PUT").toUpperCase();
    const upHeaders: Record<string, string> = { ...urlInfo.headers };
    if (!Object.keys(upHeaders).some((k) => k.toLowerCase() === "content-type")) {
      upHeaders["Content-Type"] = "application/octet-stream";
    }
    upHeaders["Content-Length"] = String(fileSize);
    // 流式上传 body：避免 readFileSync 整读 + fetch 内部拷贝双份内存（P2-3）；undici 流 body 需 duplex:'half'，
    // Content-Length 已显式携带（上方），保持与旧 Buffer body 相同的请求框架（非 chunked）
    const upRes = await fetch(urlInfo.url, {
      method,
      headers: upHeaders,
      body: Readable.toWeb(fs.createReadStream(ctx.artifactPath)),
      duplex: "half",
      signal: AbortSignal.timeout(900_000),
    });
    if (![200, 201, 204].includes(upRes.status))
      throw new Error(`华为 OBS 上传失败 HTTP ${upRes.status}`);

    await hwJson(
      `${BASE}/publish/v2/app-file-info?appId=${encodeURIComponent(appId)}`,
      {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ fileType: 5, files: { fileName, fileDestUrl: urlInfo.objectId } }),
      },
      "登记软件包",
    );
    ctx.emit({ type: "phase", phase: "bind", message: "软件包已登记（草稿）" });
    return { ok: true, ref: urlInfo.objectId };
  }

  async submit(ctx: ChannelContext): Promise<SubmitResult> {
    const appId = required(ctx, "appId");
    const { headers } = await this.authHeaders(ctx);
    if (ctx.updateDescription) {
      try {
        await hwJson(
          `${BASE}/publish/v2/app-language-info?appId=${encodeURIComponent(appId)}`,
          {
            method: "PUT",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ lang: "zh-CN", newFeatures: ctx.updateDescription }),
          },
          "更新文案",
        );
      } catch (e) {
        ctx.emit({ type: "warn", message: `更新文案未写入（不阻断）: ${(e as Error).message}` });
      }
    }
    ctx.emit({
      type: "phase",
      phase: "wait",
      message: "等待 120s（软件包异步解析，华为文档要求）",
    });
    await sleep(WAIT_BEFORE_SUBMIT_MS);
    ctx.emit({ type: "phase", phase: "submit" });
    // 定时上架（capabilities.scheduled 兑现）：v2 app-submit 支持 releaseTime（华为格式 2026-06-20T10:00:00+0800）
    const releaseTimeQ: Record<string, string> = ctx.releaseTime
      ? { releaseTime: toHuaweiTime(ctx.releaseTime) }
      : {};
    const qs = new URLSearchParams({
      appId,
      releaseType: "1",
      ...releaseTimeQ,
      ...(ctx.remark ? { remark: ctx.remark } : {}),
    });
    const submit = await hwJson(
      `${BASE}/publish/v2/app-submit?${qs}`,
      { method: "POST", headers: { ...headers, "Content-Type": "application/json" } },
      "提交发布",
    );
    ctx.emit({ type: "phase", phase: "done", message: "已提审（审核通过后自动上架）" });
    return { ok: true, ref: JSON.stringify(submit).slice(0, 80) };
  }

  /**
   * 更新商店应用信息：简介/描述走 v3 app-language-info（briefInfo/appDesc）。
   * 图标/截图：华为 v3 app-file-info 的 fileType 取值未在官方文档确证（软件包=5 已验证，图标清单值不确定），
   * 未经真机验证前只上传 OBS 不做 file-info 绑定（skip 并在结果中标注），避免误写损坏草稿。
   */
  async updateListing(
    ctx: Pick<ChannelContext, "credentials" | "target" | "emit">,
    listing: ListingInput,
  ): Promise<ListingResult> {
    const appId = required(ctx, "appId", "项目配置 android.stores.huawei.appId");
    const effective = resolveListing(listing, this.id);
    const updated: string[] = [];
    const skipped: string[] = [];

    if (effective.brief !== undefined || effective.description !== undefined) {
      const { headers } = await this.authHeaders(ctx);
      // 华为 v3 接口：简介 briefInfo + 描述 appDesc，同一接口按 lang 写入
      const body: Record<string, string> = { lang: "zh-CN" };
      if (effective.brief !== undefined) body.briefInfo = effective.brief;
      if (effective.description !== undefined) body.appDesc = effective.description;
      await hwJson(
        `${BASE}/publish/v3/app-language-info?appId=${encodeURIComponent(appId)}`,
        {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        "更新 listing 文案",
      );
      if (effective.brief !== undefined) updated.push("brief");
      if (effective.description !== undefined) updated.push("description");
    }

    if (effective.iconPath !== undefined) {
      // 已验证链路：upload-url/for-obs 可拿 objectId；未验证：app-file-info 图标 fileType —— 先跳过绑定
      skipped.push("iconPath");
      ctx.emit({
        type: "warn",
        message: "图标更新未真机验证（fileType 不确定），已跳过绑定，仅文案生效",
      });
    }
    if (effective.screenshots?.length) {
      skipped.push("screenshots");
      ctx.emit({ type: "warn", message: "截图更新未真机验证，已跳过" });
    }

    return { ok: true, store: this.id, updated, skipped };
  }

  /**
   * 审核状态查询: GET /api/publish/v2/app-info → appInfo.releaseState。
   * releaseState 全表 —— 对拍 python/android-publish hw_query.py（真机验证权威）:
   *   0=已上架 1=审核不通过 2=已下架 3=待上架 4=审核中 5=升级审核中
   *   7=草稿 8=升级审核不通过 11=撤销上架
   * （apkgo huawei.go 交叉验证一致，另收录 6=申请下架 9=下架审核不通过 10=开发者下架 12=预审中 13=预审不通过）
   */
  async status(ctx: Pick<ChannelContext, "credentials" | "target">): Promise<ReviewStatus> {
    const appId = required(ctx, "appId", "审核状态查询必需");
    const { headers } = await this.authHeaders(ctx);
    const json = await hwJson<
      HuaweiRet & { appInfo?: { releaseState?: number; auditDesc?: string } }
    >(
      `${BASE}/publish/v2/app-info?appId=${encodeURIComponent(appId)}`,
      { headers },
      "查询审核状态",
    );
    const releaseState = json.appInfo?.releaseState;
    if (releaseState === undefined) {
      return {
        state: "unknown",
        raw: `app-info 无 releaseState: ${JSON.stringify(json).slice(0, 200)}`,
      };
    }
    switch (releaseState) {
      case 0:
        return { state: "approved", live: true };
      case 3:
        return { state: "approved", live: false }; // 待上架：审核通过、尚未上架
      case 4:
      case 5:
        return { state: "reviewing" }; // 审核中 / 升级审核中
      case 1:
      case 8:
        return { state: "rejected", reason: json.appInfo?.auditDesc }; // 审核不通过 / 升级审核不通过
      case 2:
        return { state: "unknown", raw: "已下架（releaseState=2）" };
      case 7:
        return { state: "unknown", raw: "草稿，未提审（releaseState=7）" };
      case 11:
        return { state: "unknown", raw: "撤销上架（releaseState=11）" };
      default:
        return {
          state: "unknown",
          raw: `releaseState=${releaseState}（hw_query.py 全表未收录编号）`,
        };
    }
  }
}

/** RFC3339 → 华为 releaseTime 格式（偏移无冒号：+0800） */
function toHuaweiTime(rfc3339: string): string {
  return rfc3339.replace(/([+-]\d{2}):(\d{2})$/, "$1$2").replace("Z", "+0000");
}

function required(
  ctx: Pick<ChannelContext, "credentials" | "target">,
  key: string,
  where?: string,
): string {
  // target（项目配置 android.stores.huawei.appId）优先；凭据别名 HW_ANDROID_APP_ID 兜底（init/channels 指引写入）
  const alias = key === "appId" ? "HW_ANDROID_APP_ID" : "";
  const v = ctx.target[key] ?? ctx.credentials[key] ?? (alias && ctx.credentials[alias]);
  if (!v) {
    throw new Error(
      `华为渠道缺少 ${key}${where ? `（${where}）` : alias ? `（项目配置 android.stores.huawei.appId 或凭据 ${alias}）` : ""}`,
    );
  }
  return v;
}
