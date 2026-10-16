/**
 * vivo 应用市场（安卓 APK）渠道 —— 自 v1 lib/stores/vivo.mjs 迁移，已对拍 python/android-publish 权威修正。
 * 链路: app.query.details（复用 compatibleDevice/onlineType）→ app.upload.apk.app（上传）→ app.sync.update.app（提审）
 *
 * 要点（勿"优化"掉）：
 *   - 单一端点 method 区分接口；公共参数 method/access_key/timestamp(毫秒)/format/v/sign_method/target_app_key
 *   - 签名 HmacSHA256，file 参数不参与签名（上传走 multipart，先签公共+业务参数再 append file）
 *   - 提审字段集对拍 python vivo_submit.py：apk=上传流水号（字段名非 serialnumber）+ versionCode（上传响应透传）
 *     + fileMd5 + onlineType/compatibleDevice（app.query.details 线上复用）
 *   - code 与 subCode 双层检查；限额 50 次/天/接口
 */
import fs from "node:fs";
import path from "node:path";
import { hmacSign, tsMillis, md5File } from "./shared/sign.js";
import { formatSize } from "../util.js";
import type {
  Channel,
  ChannelCapabilities,
  ChannelContext,
  ReleasePlanEntry,
  StageResult,
  SubmitResult,
  ReviewStatus,
} from "../channel.js";

const API_BASE = "https://developer-api.vivo.com.cn/router/rest";

/** vivo 响应外壳：code/subCode 双检 + data 业务体 */
export interface VivoRet {
  code?: number;
  subCode?: number | string;
  msg?: string;
  data?: Record<string, unknown>;
}

/** 公共参数（v1 commonParams，timestamp 为毫秒） */
function commonParams(accessKey: string, method: string): Record<string, string> {
  return {
    method,
    access_key: accessKey,
    timestamp: tsMillis(),
    format: "json",
    v: "1.0",
    // sign_method 官方字面值为小写 hmac-sha256（developer.vivo.com/doc/detail?id=95；
    // apkgo 发大写 HMAC-SHA256 亦可用，服务端宽松——按文档字面最稳）
    sign_method: "hmac-sha256",
    target_app_key: "developer",
  };
}

/** code 与 subCode 双层检查（v1 checkCode） */
function checkCode<T extends VivoRet>(data: T, context: string): T {
  if (data.code !== 0) throw new Error(`vivo ${context}失败 code=${data.code} ${data.msg ?? ""}`);
  if (data.subCode !== undefined && String(data.subCode) !== "0") {
    throw new Error(`vivo ${context}业务失败 subCode=${data.subCode} ${data.msg ?? ""}`);
  }
  return data;
}

export class VivoChannel implements Channel {
  readonly id = "vivo";
  readonly label = "vivo 应用市场";
  readonly capabilities: ChannelCapabilities = {
    stage: true,
    submit: true,
    scheduled: false,
    status: true,
  };
  readonly errorHints = {
    "10001": "签名校验失败（检查 VIVO_ACCESS_SECRET 是否正确）",
    "10005": "时间戳失效（检查系统时间偏差）",
    "10011": "当天调用次数超限（约 50 次/天）",
    "12010": "应用审核中，不允许更新",
  };

  /**
   * stage→submit 之间传递上传结果：Channel 接口不透传 ref，
   * 常规编排为同一进程内先 stage 后 submit，用实例字段承接；
   * 直接 submit（跳过 stage）时回退为现场上传。
   * 对拍 python upload_apk：serialnumber/versionCode 均取自上传响应，提审都要回传。
   */
  private lastUpload?: { serialnumber: string; versionCode: string; fileMd5: string };

  private creds(ctx: Pick<ChannelContext, "credentials" | "target">) {
    const accessKey = required(ctx, "VIVO_ACCESS_KEY");
    const accessSecret = required(ctx, "VIVO_ACCESS_SECRET");
    return { accessKey, accessSecret };
  }

  async plan(ctx: ChannelContext): Promise<ReleasePlanEntry> {
    required(ctx, "pkgName", "项目配置 android.stores.vivo.pkgName");
    return {
      channel: this.id,
      platform: "android",
      artifactVersion: "",
      action: "stage+submit",
      afterApproval: "auto-publish",
      notes: "vivo：上传后同步提审（app.sync.update.app），审核通过即自动上架",
    };
  }

  /** 查应用详情（提审复用 compatibleDevice/onlineType；审核状态 auditStatus 也出于此） */
  private async queryDetails(
    ctx: Pick<ChannelContext, "credentials" | "target">,
  ): Promise<Record<string, unknown>> {
    const { accessKey, accessSecret } = this.creds(ctx);
    const pkgName = required(ctx, "pkgName");
    const detail = checkCode(
      await this.vivoApi(
        accessKey,
        accessSecret,
        "app.query.details",
        { packageName: pkgName },
        "查询应用详情",
      ),
      "查询应用详情",
    );
    return detail.data ?? {};
  }

  /** 普通 JSON 接口（签名覆盖公共+业务参数） */
  private async vivoApi(
    accessKey: string,
    accessSecret: string,
    method: string,
    businessParams: Record<string, string>,
    context = method,
    timeout = 60_000,
  ): Promise<VivoRet> {
    const params = { ...commonParams(accessKey, method), ...businessParams };
    params.sign = hmacSign(accessSecret, params);
    const res = await fetch(API_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(timeout),
    });
    let data: VivoRet;
    try {
      data = (await res.json()) as VivoRet;
    } catch {
      throw new Error(`vivo ${context}返回非 JSON（HTTP ${res.status}）`);
    }
    return data;
  }

  async stage(ctx: ChannelContext): Promise<StageResult> {
    const { accessKey, accessSecret } = this.creds(ctx);
    const pkgName = required(ctx, "pkgName", "项目配置 android.stores.vivo.pkgName");
    const fileName = path.basename(ctx.artifactPath);
    const fileSize = fs.statSync(ctx.artifactPath).size;

    ctx.emit({
      type: "phase",
      phase: "upload",
      message: `上传 ${fileName}（${formatSize(fileSize)}）`,
    });

    // 上传 APK（multipart；file 不参与签名：先签 params 再 append file）
    const fileMd5 = md5File(ctx.artifactPath);
    const params: Record<string, string> = {
      ...commonParams(accessKey, "app.upload.apk.app"),
      packageName: pkgName,
      fileMd5,
    };
    params.sign = hmacSign(accessSecret, params);
    const form = new FormData();
    for (const [k, v] of Object.entries(params)) form.append(k, v);
    // FormData 无法携带流式 body（Blob 需完整材料，undici 限制），整读内存代价已知（docs/REVIEW.md P2-3）
    form.append("file", new Blob([fs.readFileSync(ctx.artifactPath)]), fileName);
    const upRes = await fetch(API_BASE, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(900_000),
    });
    let upJson: VivoRet;
    try {
      upJson = (await upRes.json()) as VivoRet;
    } catch {
      throw new Error(`vivo 文件上传返回非 JSON（HTTP ${upRes.status}）`);
    }
    checkCode(upJson, "文件上传");
    const data = upJson.data ?? {};
    // 对拍 python upload_apk：serialnumber/versionCode 取自上传响应（数值/字符串形式都可能出现，统一 String）
    const upload = {
      serialnumber: data.serialnumber !== undefined ? String(data.serialnumber) : "",
      versionCode: data.versionCode !== undefined ? String(data.versionCode) : "",
      fileMd5,
    };
    this.lastUpload = upload;
    ctx.emit({ type: "phase", phase: "bind", message: "上传成功（草稿）" });
    return { ok: true, ref: upload.serialnumber || undefined };
  }

  async submit(ctx: ChannelContext): Promise<SubmitResult> {
    const pkgName = required(ctx, "pkgName");

    // 提审需回传 compatibleDevice/onlineType，先查应用详情
    const appInfo = await this.queryDetails(ctx);

    // 上传结果：优先复用 stage() 的（serialnumber+versionCode+fileMd5）；跳过 stage 时回退为现场上传
    if (!this.lastUpload) await this.stage(ctx);
    const { serialnumber, versionCode, fileMd5 } = this.lastUpload!;
    if (!serialnumber) throw new Error("vivo 提审缺少 serialnumber（上传未返回）");

    // updateDesc 需 5-200 字（对拍 python vivo_submit.py：短于 5 字服务端拒收，超 200 字同样拒收，本地先行校验）；
    // 缺文案时不再伪造占位，直接拒绝并提示补 --update-desc
    const updateDesc = (ctx.updateDescription ?? "").trim();
    if (updateDesc.length < 5) {
      throw new Error(
        `vivo 提审 updateDesc 需 5-200 字（当前 ${updateDesc.length} 字），请提供更新说明`,
      );
    }
    if (updateDesc.length > 200) {
      throw new Error(
        `vivo 提审 updateDesc 需 5-200 字（当前 ${updateDesc.length} 字，超出上限），请精简更新说明`,
      );
    }

    const { accessKey, accessSecret } = this.creds(ctx);
    ctx.emit({ type: "phase", phase: "submit" });
    // 提审字段集对拍 python vivo_submit.py update_params：
    //   apk=上传流水号（字段名 apk，非 serialnumber；apkgo vivo.go 同）+ versionCode（上传响应透传）
    //   + fileMd5（上传时算好的工件 MD5）+ onlineType/compatibleDevice（app.query.details 线上复用，缺省 1）
    const upd = checkCode(
      await this.vivoApi(
        accessKey,
        accessSecret,
        "app.sync.update.app",
        {
          packageName: pkgName,
          versionCode,
          apk: serialnumber,
          fileMd5,
          onlineType: String(appInfo.onlineType ?? 1),
          compatibleDevice: String(appInfo.compatibleDevice ?? 1),
          updateDesc,
        },
        "提审",
      ),
      "提审",
    );
    ctx.emit({ type: "phase", phase: "done", message: "已提交审核（审核通过后自动上架）" });
    return { ok: true, ref: JSON.stringify(upd).slice(0, 80) };
  }

  /**
   * 审核状态查询: 复用 app.query.details 的 data.status（apkgo vivo.go mapVivoAuditState 权威，
   * 2026-10 源码仲裁：编号 1=草稿 2=待审核 3=审核通过 4=审核不通过 5=已撤销；
   * 旧 auditStatus 字段与 0/1/2 编号表系 v1 python 误记，已弃用）。
   */
  async status(ctx: Pick<ChannelContext, "credentials" | "target">): Promise<ReviewStatus> {
    required(ctx, "pkgName", "审核状态查询必需");
    const data = await this.queryDetails(ctx);
    const st = data.status ?? data.auditStatus ?? data.audit_status; // apkgo 读 status；旧字段兜底兼容
    if (st === undefined) {
      return {
        state: "unknown",
        raw: `app.query.details 无 status: ${JSON.stringify(data).slice(0, 200)}`,
      };
    }
    const num = Number(st);
    if (!Number.isFinite(num)) {
      return { state: "unknown", raw: `status=${String(st)}` };
    }
    switch (num) {
      case 2:
        return { state: "reviewing" };
      case 3:
        return { state: "approved", live: true };
      case 4:
        return { state: "rejected", reason: this.auditReason(data) };
      case 1:
        return { state: "unknown", raw: "status=1（草稿，未提交审核）" };
      case 5:
        return { state: "unknown", raw: "status=5（已撤销）" };
      default:
        return { state: "unknown", raw: `status=${num}（未验证编号）` };
    }
  }

  /** 驳回原因字段名文档未明确，按常见命名兜底取（auditMessage/auditMsg） */
  private auditReason(data: Record<string, unknown>): string | undefined {
    const v = data.auditMessage ?? data.auditMsg;
    return typeof v === "string" && v ? v : undefined;
  }
}

function required(
  ctx: Pick<ChannelContext, "credentials" | "target">,
  key: string,
  where?: string,
): string {
  const v = ctx.credentials[key] ?? ctx.target[key];
  if (!v) throw new Error(`vivo 渠道缺少 ${key}${where ? `（${where}）` : ""}`);
  return v;
}
