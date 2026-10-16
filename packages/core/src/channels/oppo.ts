/**
 * OPPO 应用市场（安卓 APK）渠道 —— app/upd 发布字段集/参数名以 python/android-publish oppo_submit.py 为权威对拍。
 * v2 链路: GET token（48h 有效）→ get-upload-url → multipart 上传（stage）→ 查 app/info（复用线上字段）→ app/upd 发布（submit）
 * 签名: HmacSHA256（公共参数 access_token + timestamp(秒) + api_sign）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { hmacSign, tsSeconds } from "./shared/sign.js";
import type {
  Channel,
  ChannelCapabilities,
  ChannelContext,
  ReleasePlanEntry,
  ReviewStatus,
  StageResult,
  SubmitResult,
} from "../channel.js";

const API_BASE = "https://oop-openapi-cn.heytapmobi.com";

/** OPPO 开放平台响应外壳：errno=0 成功，错误信息在 data.message */
interface OppoRet {
  errno?: number;
  data?: Record<string, unknown> & { message?: string; access_token?: string };
}

/** stage→submit 跨调用传递的上传产物（apkUrl/md5） */
interface OppoUploadRef {
  apkUrl: string;
  md5: string;
}

/** 获取 OPPO access_token（GET，48h 有效）—— 来源: oppo.mjs getOppoToken */
async function getOppoToken(clientId: string, clientSecret: string): Promise<string> {
  const qs = new URLSearchParams({ client_id: clientId, client_secret: clientSecret });
  const res = await fetch(`${API_BASE}/developer/v1/token?${qs}`, {
    signal: AbortSignal.timeout(30_000),
  });
  let data: OppoRet;
  try {
    data = (await res.json()) as OppoRet;
  } catch {
    throw new Error(`OPPO token返回非 JSON（HTTP ${res.status}）`);
  }
  if (data.errno !== 0) {
    throw new Error(`OPPO token 失败 errno=${data.errno}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  const token = data.data?.access_token;
  if (!token)
    throw new Error(`OPPO token 响应缺少 access_token: ${JSON.stringify(data).slice(0, 200)}`);
  return token;
}

/** 带签名 API 调用（POST form / GET query）—— 来源: oppo.mjs oppoApi */
async function oppoApi(
  callPath: string,
  creds: { clientId: string; clientSecret: string; token: string },
  businessParams: Record<string, string | undefined>,
  method: "GET" | "POST" = "POST",
  context = callPath,
): Promise<OppoRet> {
  const allParams: Record<string, string> = {
    access_token: creds.token,
    timestamp: tsSeconds(),
    ...businessParams,
  };
  allParams.api_sign = hmacSign(creds.clientSecret, allParams);

  let res: Response;
  if (method === "GET") {
    const qs = new URLSearchParams(allParams).toString();
    res = await fetch(`${API_BASE}${callPath}?${qs}`, { signal: AbortSignal.timeout(30_000) });
  } else {
    res = await fetch(API_BASE + callPath, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(allParams).toString(),
      signal: AbortSignal.timeout(60_000),
    });
  }
  try {
    return (await res.json()) as OppoRet;
  } catch {
    throw new Error(`OPPO ${context}返回非 JSON（HTTP ${res.status}）`);
  }
}

/** errno 非 0 统一抛错 —— 来源: oppo.mjs checkErrno */
function checkErrno(data: OppoRet, context: string): OppoRet {
  if (data.errno !== 0) {
    const msg = typeof data.data === "object" ? (data.data?.message ?? "") : "";
    throw new Error(
      `OPPO ${context}失败 errno=${data.errno} ${msg}: ${JSON.stringify(data).slice(0, 300)}`,
    );
  }
  return data;
}

/**
 * app/info 字段读取：null/undefined/空串 → 默认值，其余 String 化（分类/年龄等级等字段线上返回数值）。
 * 对拍 python/android-publish oppo_submit.py build_publish_params 的 str(existing_info.get(...))。
 */
function infoField(info: Record<string, unknown>, key: string, dflt = ""): string {
  const v = info[key];
  return v === undefined || v === null || v === "" ? dflt : String(v);
}

/**
 * 从 APK 解析 versionCode —— 对拍 python/android-publish oppo_submit.py get_apk_version_code。
 * 顺序: 项目配置显式指定（android.stores.oppo.versionCode，等价 python --version-code）
 * → aapt2/aapt dump badging（PATH + ANDROID_HOME/~/Library/Android/sdk build-tools，新版本优先）
 * → 兜底读 build.gradle（APK 相对路径 ../../../../app/build.gradle，即 android/app/build.gradle）。
 */
export function resolveVersionCode(
  ctx: Pick<ChannelContext, "target" | "artifactPath" | "emit">,
): string {
  const override = ctx.target["versionCode"];
  if (override) {
    ctx.emit({ type: "progress", detail: `versionCode=${override}（来源: 项目配置）` });
    return override;
  }
  const tools = ["aapt2", "aapt"];
  const sdkDir = process.env.ANDROID_HOME ?? path.join(os.homedir(), "Library/Android/sdk");
  const btDir = path.join(sdkDir, "build-tools");
  if (fs.existsSync(btDir)) {
    for (const bt of fs.readdirSync(btDir).sort().reverse()) {
      for (const tool of ["aapt2", "aapt"]) {
        const p = path.join(btDir, bt, tool);
        if (fs.existsSync(p)) tools.push(p);
      }
    }
  }
  for (const tool of tools) {
    const r = spawnSync(tool, ["dump", "badging", ctx.artifactPath], {
      timeout: 10_000,
      encoding: "utf8",
    });
    if (!r.error && r.status === 0) {
      const m = /versionCode='(\d+)'/.exec(r.stdout ?? "");
      if (m) {
        ctx.emit({ type: "progress", detail: `versionCode=${m[1]}（来源: ${tool}）` });
        return m[1]!;
      }
    }
  }
  for (const gradle of [
    path.resolve(path.dirname(ctx.artifactPath), "..", "..", "..", "..", "app", "build.gradle"),
    path.join(process.cwd(), "app", "build.gradle"),
  ]) {
    if (fs.existsSync(gradle)) {
      const m = /versionCode\s+(\d+)/.exec(fs.readFileSync(gradle, "utf8"));
      if (m) {
        ctx.emit({
          type: "progress",
          detail: `versionCode=${m[1]}（来源: ${path.basename(gradle)}）`,
        });
        return m[1]!;
      }
    }
  }
  throw new Error(
    "OPPO 渠道无法解析 versionCode（aapt2/aapt 不可用且未找到 build.gradle），请在项目配置 android.stores.oppo.versionCode 显式指定",
  );
}

/**
 * 构建 app/upd 发布参数（snake_case 全集，apk_url 为 JSON 数组）—— 对拍 python/android-publish
 * oppo_submit.py build_publish_params；商务联系人 trim 与 copyright_url 兜底 —— 对拍 apkgo oppo.go
 * （app/info 返回带前导空白的邮箱会被 app/upd 以 [800002] 拒绝；电子版权证书账号 copyright_url 为空、URL 只在 electronic_cert_url）。
 */
function buildUpdParams(
  appInfo: Record<string, unknown>,
  apkUrl: string,
  apkMd5: string,
  versionCode: string,
  updateDesc: string,
): Record<string, string> {
  const params: Record<string, string> = {
    pkg_name: infoField(appInfo, "pkg_name"),
    version_code: versionCode,
    apk_url: JSON.stringify([{ url: apkUrl, md5: apkMd5, cpu_code: 0 }]),
    app_name: infoField(appInfo, "app_name"),
    second_category_id: infoField(appInfo, "second_category_id"),
    third_category_id: infoField(appInfo, "third_category_id"),
    summary: infoField(appInfo, "summary").slice(0, 13),
    detail_desc: infoField(appInfo, "detail_desc"),
    update_desc: updateDesc,
    privacy_source_url: infoField(appInfo, "privacy_source_url"),
    icon_url: infoField(appInfo, "icon_url"),
    pic_url: infoField(appInfo, "pic_url"),
    online_type: "1",
    test_desc: infoField(appInfo, "test_desc"),
    business_username: infoField(appInfo, "business_username").trim(),
    business_email: infoField(appInfo, "business_email").trim(),
    business_mobile: infoField(appInfo, "business_mobile").trim(),
    age_level: infoField(appInfo, "age_level", "3"),
    adaptive_equipment: infoField(appInfo, "adaptive_equipment", "4"),
    adaptive_type: infoField(appInfo, "adaptive_type", "1"),
    copyright_url: infoField(appInfo, "copyright_url") || infoField(appInfo, "electronic_cert_url"),
  };
  // 可选字段: 线上有就传（python 原文同序）
  for (const key of ["landscape_pic_url", "electronic_cert_url", "icp_url"]) {
    const v = infoField(appInfo, key);
    if (v) params[key] = v;
  }
  return params;
}

export class OppoChannel implements Channel {
  readonly id = "oppo";
  readonly label = "OPPO 应用市场";
  readonly capabilities: ChannelCapabilities = {
    stage: true,
    submit: true,
    scheduled: false,
    status: true,
  };
  readonly errorHints = {
    "911215": "应用已有版本在审核中（等待审核完成或到控制台撤回后再提）",
    "911216": "版本更新任务处理中（稍后用 status 查询结果）",
    "800002": "参数校验失败：常见于简介/截图等商店资料不符合规格",
  };

  /** stage 产物暂存（apkUrl/md5），submit 按 pkgName 取回 */
  private readonly staged = new Map<string, OppoUploadRef>();

  private required(
    ctx: Pick<ChannelContext, "credentials" | "target">,
    key: string,
    where?: string,
  ): string {
    const v = ctx.credentials[key] ?? ctx.target[key];
    if (!v) throw new Error(`OPPO 渠道缺少 ${key}${where ? `（${where}）` : ""}`);
    return v;
  }

  private async auth(
    ctx: ChannelContext,
  ): Promise<{ clientId: string; clientSecret: string; pkgName: string; token: string }> {
    const clientId = this.required(ctx, "OPPO_CLIENT_ID");
    const clientSecret = this.required(ctx, "OPPO_CLIENT_SECRET");
    const pkgName = this.required(ctx, "pkgName", "项目配置 android.stores.oppo.pkgName");
    const token = await getOppoToken(clientId, clientSecret);
    ctx.emit({ type: "phase", phase: "auth", message: "token 获取成功（48h 有效）" });
    return { clientId, clientSecret, pkgName, token };
  }

  async plan(_ctx: ChannelContext): Promise<ReleasePlanEntry> {
    return {
      channel: this.id,
      platform: "android",
      artifactVersion: "",
      action: "stage+submit",
      afterApproval: "auto-publish",
      notes: "发布字段从线上 app/info 复用，只替换包与更新说明",
    };
  }

  async stage(ctx: ChannelContext): Promise<StageResult> {
    const auth = await this.auth(ctx);
    const { apkUrl, md5 } = await this.uploadApk(ctx, auth);
    this.staged.set(auth.pkgName, { apkUrl, md5 });
    return { ok: true, ref: md5 };
  }

  /**
   * 上传 APK 到 OPPO 文件服务器（get-upload-url → multipart），返回 apkUrl/md5。
   * stage 与 submit 回退共用；app/info 有频控且仅 submit 复用线上字段需要，stage 不查。
   */
  private async uploadApk(
    ctx: ChannelContext,
    auth: { clientId: string; clientSecret: string; token: string },
  ): Promise<OppoUploadRef> {
    const fileName = path.basename(ctx.artifactPath);

    // step 1: 获取上传配置
    const upCfg = checkErrno(
      await oppoApi("/resource/v1/upload/get-upload-url", auth, {}, "GET", "获取上传配置"),
      "获取上传配置",
    );
    const uploadUrl = upCfg.data?.["upload_url"] as string | undefined;
    const sign = upCfg.data?.["sign"] as string | undefined;
    if (!uploadUrl || !sign)
      throw new Error(`OPPO 上传配置缺失: ${JSON.stringify(upCfg).slice(0, 200)}`);

    // step 2: multipart 上传（文件服务器，非 openapi 域名，无 api_sign）
    ctx.emit({ type: "phase", phase: "upload", message: `上传 ${fileName}` });
    const form = new FormData();
    form.append("type", "apk");
    form.append("sign", sign);
    // FormData 无法携带流式 body（Blob 需完整材料，undici 限制），整读内存代价已知（docs/REVIEW.md P2-3）
    form.append("file", new Blob([fs.readFileSync(ctx.artifactPath)]), fileName);
    const upRes = await fetch(uploadUrl, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(900_000),
    });
    let upJson: OppoRet;
    try {
      upJson = (await upRes.json()) as OppoRet;
    } catch {
      throw new Error(`OPPO 文件上传返回非 JSON（HTTP ${upRes.status}）`);
    }
    checkErrno(upJson, "文件上传");
    const apkUrl = upJson.data?.["url"] as string | undefined;
    const md5 = upJson.data?.["md5"] as string | undefined;
    if (!apkUrl || !md5)
      throw new Error(`OPPO 上传响应缺少 url/md5: ${JSON.stringify(upJson).slice(0, 200)}`);
    ctx.emit({ type: "phase", phase: "bind", message: `上传成功（md5: ${md5}）` });
    return { apkUrl, md5 };
  }

  async submit(ctx: ChannelContext): Promise<SubmitResult> {
    const auth = await this.auth(ctx);

    // step 3: 查询应用详情（发布字段从线上复用）
    const info = checkErrno(
      await oppoApi(
        "/resource/v1/app/info",
        auth,
        { pkgName: auth.pkgName },
        "GET",
        "查询应用详情",
      ),
      "查询应用详情",
    );
    const appInfo = (info.data ?? {}) as Record<string, unknown>;

    // apkUrl/md5 优先取 stage 暂存；跨进程 --skip-stage 无暂存时重走上传链路获取（同应用宝回退思路）
    let staged = this.staged.get(auth.pkgName);
    if (!staged) {
      ctx.emit({ type: "progress", detail: "无 stage 产物，重新上传 APK 获取 apkUrl/md5" });
      staged = await this.uploadApk(ctx, auth);
      this.staged.set(auth.pkgName, staged);
    }

    // step 4: 发布版本（复用线上字段，只换包与更新说明）—— 字段集/参数名对拍 python oppo_submit.py build_publish_params
    const updateDesc =
      ctx.updateDescription || infoField(appInfo, "update_desc") || "修复已知问题，优化用户体验";
    // 更新说明不少于 5 个字 —— 对拍 python oppo_submit.py main() 参数校验
    if (updateDesc.length < 5) {
      throw new Error(`OPPO 更新说明不少于 5 个字（当前 ${updateDesc.length}）`);
    }
    const versionCode = resolveVersionCode(ctx);
    const updParams = buildUpdParams(appInfo, staged.apkUrl, staged.md5, versionCode, updateDesc);
    ctx.emit({ type: "phase", phase: "submit" });
    const upd = await oppoApi("/resource/v1/app/upd", auth, updParams, "POST", "发布版本");
    // errno 911215/911216 非失败语义 —— 对拍 apkgo oppo.go（python 无 task-state 轮询，确认不补轮询）:
    //   911215 应用审核中 —— 该版本已在 OPPO 审核队列，本次未重复创建任务（apkgo 视为成功终态）
    //   911216 版本更新任务处理中 —— 上一提交任务仍在处理，OPPO 保留了早前提交
    if (upd.errno === 911215 || upd.errno === 911216) {
      const inReview = upd.errno === 911215;
      ctx.emit({
        type: "warn",
        message: inReview
          ? "errno=911215 应用审核中：该版本已在 OPPO 审核队列，本次未重复创建任务"
          : "errno=911216 版本更新任务处理中：上一提交任务仍在处理，本次未创建新任务，稍后可用 status 查询审核状态",
      });
      ctx.emit({ type: "phase", phase: "done", message: `已受理（errno=${upd.errno}）` });
      return { ok: true, ref: `errno=${upd.errno} ${inReview ? "已在审核队列" : "任务处理中"}` };
    }
    checkErrno(upd, "发布版本");
    ctx.emit({
      type: "phase",
      phase: "done",
      message: `已提交（${JSON.stringify(upd.data ?? {}).slice(0, 120)}）`,
    });
    return { ok: true, ref: JSON.stringify(upd.data ?? {}).slice(0, 80) };
  }

  /**
   * 审核状态查询: GET /resource/v1/app/info（公共参数 + api_sign，同 stage）
   * → data.audit_status（android-publish oppo_query.py: 1=待提审 2=审核中 3=通过 4=驳回）。
   */
  async status(ctx: Pick<ChannelContext, "credentials" | "target">): Promise<ReviewStatus> {
    const clientId = this.required(ctx, "OPPO_CLIENT_ID");
    const clientSecret = this.required(ctx, "OPPO_CLIENT_SECRET");
    const pkgName = this.required(ctx, "pkgName", "审核状态查询必需");
    const token = await getOppoToken(clientId, clientSecret);
    const info = checkErrno(
      await oppoApi(
        "/resource/v1/app/info",
        { clientId, clientSecret, token },
        { pkgName },
        "GET",
        "查询审核状态",
      ),
      "查询审核状态",
    );
    const data = info.data ?? {};
    const auditStatus = data["audit_status"] ?? data["auditStatus"];
    if (auditStatus === undefined) {
      return {
        state: "unknown",
        raw: `app/info 无 audit_status: ${JSON.stringify(info).slice(0, 200)}`,
      };
    }
    const num = Number(auditStatus);
    if (!Number.isFinite(num)) {
      return { state: "unknown", raw: `audit_status=${String(auditStatus)}` };
    }
    switch (num) {
      case 2:
        return { state: "reviewing" };
      case 3:
        return { state: "approved", live: true };
      case 4: {
        // 驳回原因字段 refuse_reason —— 对拍 apkgo oppo.go appData（v1 的 audit_reject_reason/rejectReason 为推测字段名，删除）
        const reason = data["refuse_reason"];
        return {
          state: "rejected",
          reason: typeof reason === "string" && reason ? reason : undefined,
        };
      }
      case 1:
        return { state: "unknown", raw: "待提审（audit_status=1）" };
      default:
        return { state: "unknown", raw: `audit_status=${num}（未验证编号）` };
    }
  }
}
