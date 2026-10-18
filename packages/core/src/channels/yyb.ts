/**
 * 腾讯应用宝（安卓 APK）渠道。
 * 权威: AngChow/android-publish scripts/_yyb_common.py + submit_apk.py + query_status.py（MIT），apkgo pkg/store/tencent 交叉验证
 * 官方文档: https://wikinew.open.qq.com/index.html#/iwiki/4015262492
 * v2 链路: query_app_detail（校验应用）→ get_file_upload_info（pkg_name/app_id/file_type=apk/file_name → COS 预签名 URL + serial_number）
 *   → PUT 预签名 URL 直传 COS（预签名自带鉴权，无需自签 sign）→ update_app 提审（serial_number + md5）
 * 签名: HmacSHA256（公共参数 user_id + timestamp(秒) + 业务参数，按 key ASCII 升序）——仅 open API 需要，COS 上传不需要
 * 限额: 上传 100 次/天、更新 50 次/天；审核状态 audit_status 1=审核中 2=驳回 3=通过 8=撤销
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { hmacSign, tsSeconds, formPost } from "./shared/sign.js";
import { formatSize } from "../util.js";
import { isApkArm64Only } from "./shared/apk-abi.js";
import type {
  Channel,
  ChannelCapabilities,
  ChannelContext,
  ReleasePlanEntry,
  ReviewStatus,
  StageResult,
  SubmitResult,
} from "../channel.js";

const API_BASE = "https://p.open.qq.com/open_file/developer_api";

/** 应用宝 API 响应外壳：ret=0 成功（旧接口回 Ret） */
interface YybRet {
  ret?: number;
  Ret?: number;
}

/** /query_app_detail 响应（扁平字段 app_name；官方 API 不提供线上版本号） */
interface YybAppDetail extends YybRet {
  app_name?: string;
}

/** /get_file_upload_info 响应 —— 对拍 python/android-publish get_upload_info: pre_sign_url + serial_number */
interface YybUploadInfo extends YybRet {
  pre_sign_url?: string;
  serial_number?: number | string;
}

/** 带公共参数与签名的 API 调用 —— 来源: _yyb_common.py api_call */
async function yybApi<T extends YybRet>(
  callPath: string,
  creds: { userId: string; accessSecret: string },
  businessParams: Record<string, string>,
): Promise<T> {
  const allParams: Record<string, string> = {
    user_id: creds.userId,
    timestamp: tsSeconds(),
    ...businessParams,
  };
  allParams["sign"] = hmacSign(creds.accessSecret, allParams);
  const data = await formPost<T>(API_BASE + callPath, allParams);
  const ret = data.ret ?? data.Ret;
  if (ret !== 0) {
    throw new Error(`应用宝 ${callPath} 失败 ret=${ret}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

/** 文件 MD5（小写 hex）—— 对拍 submit_apk.py calc_md5 */
function calcMd5(filePath: string): string {
  return crypto.createHash("md5").update(fs.readFileSync(filePath)).digest("hex");
}

export class YybChannel implements Channel {
  readonly id = "yyb";
  readonly label = "腾讯应用宝";
  readonly capabilities: ChannelCapabilities = {
    stage: true,
    submit: true,
    scheduled: true,
    status: true,
  };
  /** 平台错误码 → 人话（ret 码：依据为本仓测试已固化的真实失败路径） */
  readonly errorHints = {
    "10010": "应用不存在（检查 YYB_APP_ID 与 user_id 是否匹配该应用）",
  };

  /** stage 产物暂存（serial_number + md5），submit 按 appId 取回 */
  private readonly staged = new Map<string, { serialNumber: string; md5: string }>();

  private required(
    ctx: Pick<ChannelContext, "credentials" | "target">,
    key: string,
    where?: string,
  ): string {
    const v = ctx.credentials[key] ?? ctx.target[key];
    if (!v) throw new Error(`应用宝渠道缺少 ${key}${where ? `（${where}）` : ""}`);
    return v;
  }

  private creds(ctx: ChannelContext): {
    userId: string;
    accessSecret: string;
    appId: string;
    pkgName: string;
  } {
    return {
      userId: this.required(ctx, "YYB_USER_ID"),
      accessSecret: this.required(ctx, "YYB_ACCESS_SECRET"),
      appId: this.required(ctx, "YYB_APP_ID"),
      pkgName: this.required(ctx, "pkgName", "项目配置 android.stores.yyb.pkgName"),
    };
  }

  async plan(ctx: ChannelContext): Promise<ReleasePlanEntry> {
    return {
      channel: this.id,
      platform: "android",
      artifactVersion: "",
      action: "stage+submit",
      afterApproval: ctx.releaseTime ? "scheduled" : "auto-publish",
      notes: "上传限 100 次/天、提审限 50 次/天；stage 仅上传不提审",
    };
  }

  async stage(ctx: ChannelContext): Promise<StageResult> {
    const { userId, accessSecret, appId, pkgName } = this.creds(ctx);
    const fileName = path.basename(ctx.artifactPath);
    const fileSize = fs.statSync(ctx.artifactPath).size;

    // step 1: 查询应用详情（校验 app 存在；pkg_name 与 update_app 一致，官方无 app_info 包装层、也无线上版本号）
    ctx.emit({ type: "progress", detail: "查询应用详情" });
    const detail = await yybApi<YybAppDetail>(
      "/query_app_detail",
      { userId, accessSecret },
      { pkg_name: pkgName, app_id: appId },
    );
    ctx.emit({
      type: "progress",
      detail: `应用「${detail.app_name ?? appId}」校验通过`,
    });

    // step 2: 获取上传信息 —— 对拍 python/android-publish get_upload_info: pkg_name+app_id+file_type=apk+file_name
    const upInfo = await yybApi<YybUploadInfo>(
      "/get_file_upload_info",
      { userId, accessSecret },
      { pkg_name: pkgName, app_id: appId, file_type: "apk", file_name: fileName },
    );
    const preSignUrl = upInfo.pre_sign_url ?? "";
    const serialNumber = upInfo.serial_number !== undefined ? String(upInfo.serial_number) : "";
    if (!preSignUrl || !serialNumber) {
      throw new Error(
        `应用宝返回缺少 pre_sign_url 或 serial_number: ${JSON.stringify(upInfo).slice(0, 300)}`,
      );
    }

    // step 3: PUT COS 预签名 URL 直传（预签名自带鉴权，无需自签 sign）—— 对拍 python upload_to_cos
    ctx.emit({
      type: "phase",
      phase: "upload",
      message: `上传 ${fileName}（${formatSize(fileSize)}）`,
    });
    const upRes = await fetch(preSignUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: fs.readFileSync(ctx.artifactPath),
      signal: AbortSignal.timeout(900_000),
    });
    if (upRes.status !== 200 && upRes.status !== 204) {
      const upText = await upRes.text().catch(() => "");
      throw new Error(`应用宝 COS 上传失败 HTTP ${upRes.status}: ${upText.slice(0, 300)}`);
    }

    const md5 = calcMd5(ctx.artifactPath);
    ctx.emit({ type: "phase", phase: "bind", message: "APK 上传成功（未提审）" });
    this.staged.set(appId, { serialNumber, md5 });
    return { ok: true, ref: serialNumber };
  }

  async submit(ctx: ChannelContext): Promise<SubmitResult> {
    const { userId, accessSecret, appId, pkgName } = this.creds(ctx);

    // 跨进程 --skip-stage 回退：CLI 两处推荐 --skip-stage 复用草稿，但进程内 Map 无法跨进程取回；
    // 无内存暂存时现场重新上传再提审（产物即当前文件，无提审旧包风险——参照 vivo.submit 同构）
    let stagedInfo = this.staged.get(appId);
    if (!stagedInfo) {
      ctx.emit({
        type: "warn",
        message: "无本进程 stage 记录（--skip-stage 跨进程），重新上传当前包后提审",
      });
      const r = await this.stage(ctx);
      if (!r.ok) throw new Error(`应用宝重新上传失败: ${r.error ?? "未知错误"}`);
      stagedInfo = this.staged.get(appId);
      if (!stagedInfo) throw new Error("应用宝重新上传后仍缺少流水号（内部状态异常）");
    }

    // update_app 字段集 —— 对拍 apkgo tencent.go（2026-10 源码仲裁）：
    // pkg_name/app_id/deploy_type(1 立即|2 定时) + feature(文案)；
    // apk32_flag 分支：arm64-only 包须 apk32_flag=2 + apk64_flag=1 + apk64 流水号/md5（否则服务端 4000045 拒），
    // 32/64 兼容与无 native 库的通用包走 apk32_flag=1（flag 取值域 1/2，不能传 0）
    ctx.emit({ type: "phase", phase: "submit" });
    const arm64Only = isApkArm64Only(ctx.artifactPath);
    const businessParams: Record<string, string> = {
      pkg_name: pkgName,
      app_id: appId,
      ...(arm64Only
        ? {
            apk32_flag: "2",
            apk64_flag: "1",
            apk64_file_serial_number: stagedInfo.serialNumber,
            apk64_file_md5: stagedInfo.md5,
          }
        : {
            apk32_flag: "1",
            apk32_file_serial_number: stagedInfo.serialNumber,
            apk32_file_md5: stagedInfo.md5,
          }),
      feature: ctx.updateDescription ?? "",
    };
    if (ctx.releaseTime) {
      // 定时发布: deploy_type=2 + deploy_time 秒级时间戳（北京时间）—— 对拍 python --deploy-type 2 --deploy-time
      const deployTime = Math.floor(Date.parse(ctx.releaseTime) / 1000);
      if (!Number.isFinite(deployTime))
        throw new Error(`应用宝 releaseTime 格式异常（需 RFC3339）: ${ctx.releaseTime}`);
      businessParams["deploy_type"] = "2";
      businessParams["deploy_time"] = String(deployTime);
    } else {
      businessParams["deploy_type"] = "1";
    }

    await yybApi("/update_app", { userId, accessSecret }, businessParams);
    // done 消息不内嵌响应体（预签名 URL 等泄露面）：给受理流水号（与 ref 同源），响应体排查走错误路径
    ctx.emit({
      type: "phase",
      phase: "done",
      message: `已提交审核（流水号 ${stagedInfo.serialNumber}）`,
    });
    return { ok: true, ref: stagedInfo.serialNumber };
  }

  /**
   * 审核状态查询: POST /query_app_update_status（pkg_name+app_id）→ audit_status + audit_reason。
   * —— 对拍 python/android-publish query_status.py: 1=审核中 2=驳回 3=通过 8=撤销。
   */
  async status(ctx: Pick<ChannelContext, "credentials" | "target">): Promise<ReviewStatus> {
    const userId = this.required(ctx, "YYB_USER_ID");
    const accessSecret = this.required(ctx, "YYB_ACCESS_SECRET");
    const appId = this.required(ctx, "YYB_APP_ID", "审核状态查询必需");
    const pkgName = this.required(ctx, "pkgName", "项目配置 android.stores.yyb.pkgName");
    const json = await yybApi<YybRet & { audit_status?: number; audit_reason?: string }>(
      "/query_app_update_status",
      { userId, accessSecret },
      { pkg_name: pkgName, app_id: appId },
    );
    const auditStatus = json.audit_status;
    if (auditStatus === undefined) {
      return {
        state: "unknown",
        raw: `query_app_update_status 无 audit_status: ${JSON.stringify(json).slice(0, 200)}`,
      };
    }
    const auditReason = json.audit_reason || undefined;
    switch (auditStatus) {
      case 1:
        return { state: "reviewing" };
      case 2:
        return { state: "rejected", reason: auditReason };
      case 3:
        return { state: "approved", live: true };
      case 8:
        return { state: "unknown", raw: "已撤销（audit_status=8）" };
      default:
        return { state: "unknown", raw: `audit_status=${auditStatus}（未验证编号）` };
    }
  }
}
