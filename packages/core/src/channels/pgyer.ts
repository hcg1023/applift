/**
 * 蒲公英（内测分发）渠道 —— 自 v1 lib/pgyer.mjs 迁移，逻辑不变；包一层 Channel 接口。
 * 内测渠道：stage=上传即发布（不影响任何线上商店），submit 不适用。
 */
import fs from "node:fs";
import path from "node:path";
import { sleep } from "../util.js";
import type {
  Channel,
  ChannelCapabilities,
  ChannelContext,
  ReleasePlanEntry,
  ReviewStatus,
  StageResult,
  SubmitResult,
} from "../channel.js";

const HOSTS = ["api.pgyer.com", "api.xcxwo.com", "api.pgyerapp.com"] as const;
const BUILD_TYPE_BY_EXT: Record<string, string> = {
  ".ipa": "ios",
  ".apk": "android",
  ".hap": "harmony",
};

async function pgyerPost<T>(
  host: string,
  apiPath: string,
  form: Record<string, string>,
): Promise<T> {
  const body = new URLSearchParams(form).toString();
  const res = await fetch(`https://${host}${apiPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`蒲公英 ${apiPath} 返回非 JSON（HTTP ${res.status}）: ${text.slice(0, 200)}`);
  }
}

interface CosTokenResp {
  code: number;
  message?: string;
  data?: {
    endpoint: string;
    buildKey: string;
    params: { signature: string; "x-cos-security-token": string; key: string };
  };
}

interface BuildInfoResp {
  code: number;
  message?: string;
  data?: {
    buildName?: string;
    buildVersion?: string;
    buildShortcutUrl?: string;
    buildQRCodeURL?: string;
  };
}

export class PgyerChannel implements Channel {
  readonly id = "pgyer";
  readonly label = "蒲公英";
  readonly capabilities: ChannelCapabilities = {
    stage: true,
    submit: false,
    scheduled: false,
    status: false,
  };

  async plan(ctx: ChannelContext): Promise<ReleasePlanEntry> {
    return {
      channel: this.id,
      platform: platformOf(ctx.artifactPath),
      artifactVersion: "",
      action: "stage-only",
      afterApproval: "none(beta)",
      notes: "内测分发，扫码即装，不影响线上商店",
    };
  }

  async stage(ctx: ChannelContext): Promise<StageResult> {
    const apiKey = ctx.credentials["PGYER_API_KEY"];
    if (!apiKey) throw new Error("蒲公英缺少 PGYER_API_KEY");
    const ext = path.extname(ctx.artifactPath).toLowerCase();
    const buildType = BUILD_TYPE_BY_EXT[ext];
    if (!buildType) throw new Error(`不支持的文件类型 ${ext}，蒲公英仅支持 .ipa/.apk/.hap`);

    ctx.emit({ type: "phase", phase: "auth", message: "获取上传凭证" });
    const tokenParams: Record<string, string> = { _api_key: apiKey, buildType };
    if (ctx.updateDescription) tokenParams.buildUpdateDescription = ctx.updateDescription;
    // 密码安装（v1 逻辑回归：buildInstallType=2 + buildPassword）
    if (ctx.installPassword) {
      tokenParams.buildInstallType = "2";
      tokenParams.buildPassword = ctx.installPassword;
    }

    let token: CosTokenResp | undefined;
    let lastErr: unknown;
    for (const host of HOSTS) {
      try {
        const r = await pgyerPost<CosTokenResp>(host, "/apiv2/app/getCOSToken", tokenParams);
        if (r.code !== 0) throw new Error(`getCOSToken 失败 ${r.code}: ${r.message}`);
        token = r;
        break;
      } catch (e) {
        lastErr = e;
        ctx.emit({ type: "warn", message: `${host} 不可用，尝试备用域名` });
      }
    }
    if (!token?.data) throw lastErr instanceof Error ? lastErr : new Error("蒲公英凭证获取失败");
    const { endpoint, params, buildKey } = token.data;

    ctx.emit({
      type: "phase",
      phase: "upload",
      message: `上传 ${path.basename(ctx.artifactPath)}`,
    });
    const form = new FormData();
    form.append("signature", params.signature);
    form.append("x-cos-security-token", params["x-cos-security-token"]);
    form.append("key", params.key);
    form.append("x-cos-meta-file-name", path.basename(ctx.artifactPath));
    // FormData 无法携带流式 body（Blob 需完整材料，undici 限制），整读内存代价已知（docs/REVIEW.md P2-3）
    form.append(
      "file",
      new Blob([fs.readFileSync(ctx.artifactPath)]),
      path.basename(ctx.artifactPath),
    );
    const upRes = await fetch(endpoint, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(900_000),
    });
    if (!upRes.ok) throw new Error(`COS 上传失败 HTTP ${upRes.status}`);

    ctx.emit({ type: "phase", phase: "wait", message: "等待蒲公英处理" });
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(3000);
      const info = await pgyerPost<BuildInfoResp>(HOSTS[0], "/apiv2/app/buildInfo", {
        _api_key: apiKey,
        buildKey,
      });
      // 成功判定：code===0 且已出短链（对拍 apkgo pgyer.go 权威：code 0 + buildUpdated 非空才算发布完成）
      if (info.code === 0 && info.data?.buildShortcutUrl) {
        ctx.emit({
          type: "phase",
          phase: "done",
          message: `https://www.pgyer.com/${info.data.buildShortcutUrl}`,
        });
        return { ok: true, ref: buildKey };
      }
      // 1247 = buildKey 尚未就绪（COS 上传仍在入库）：视为处理中继续轮询（对拍 apkgo pgyer.go）；
      // 其余非 0 码为明确失败，不再按 message 文案正则判败（会误杀“处理中”类文案）
      if (info.code !== 0 && info.code !== 1247) {
        return { ok: false, error: `蒲公英处理失败 ${info.code}: ${info.message ?? ""}` };
      }
      // code===0 但短链未出，或 1247 入库中 → 继续轮询
    }
    return { ok: false, error: "蒲公英 5 分钟内未完成处理" };
  }

  async submit(): Promise<SubmitResult> {
    return { ok: false, error: "蒲公英为内测渠道，无提审概念" };
  }

  async status(): Promise<ReviewStatus> {
    return { state: "unknown", raw: "蒲公英无审核状态" };
  }
}

function platformOf(artifactPath: string): "android" | "harmony" | "ios" | "desktop" {
  const ext = path.extname(artifactPath).toLowerCase();
  if (ext === ".hap" || ext === ".app") return "harmony";
  if (ext === ".ipa") return "ios";
  if ([".exe", ".msi", ".dmg", ".pkg", ".appimage", ".deb"].includes(ext)) return "desktop";
  return "android";
}
