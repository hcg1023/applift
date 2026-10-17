/**
 * 华为 AppGallery Connect —— 鸿蒙（HarmonyOS）渠道。
 * 自 v1 tools/publish/lib/agc.mjs 的 releaseHarmonyApp / getHarmonyAppId / uploadToAgc(releaseType=6) 迁移（逻辑不变）。
 *
 * 正式上架 v3 全链路（.app 整包，流程经 apkgo（PolyForm NC，仅流程参考）真实验证可行）:
 *   0. （appId 缺省时）GET  /api/publish/v2/appid-list?packageTypes=7           bundleName → appId
 *   1. GET  /api/publish/v2/upload-url/for-obs   签名 PUT 地址（objectId，5 分钟有效）
 *   2. PUT  <urlInfo.url>                        .app 整包原始字节（AGC 不收单 .hap）
 *   3. PUT  /api/publish/v3/app-package-info     绑定 objectId → packageId
 *   4. PUT  /api/publish/v3/app-language-info    newFeatures 更新文案（lang 缺省取 defaultLang）
 *   5. GET  /api/publish/v3/package/compile/status  轮询编译（0=成功 2=拒绝终态 其他=编译中）
 *   6. POST /api/publish/v3/app-submit           提审（ret 204144719/204144727 = 编译中可重试）
 *
 * 测试发布（ctx.target.releaseType === '6'，2026-10 起走 Testing API；旧 releaseType=6 直绑 app-package-info 链路已下线，枚举仅剩 1/7）:
 *   0. GET  /api/publish/v2/upload-url/for-obs?releaseType=6   .hap 上传地址 → PUT OBS
 *   1. POST /api/publish/v2/test/app/version                   新建测试版本（testType 3=邀请测试）→ versionId
 *   2. POST /api/publish/v2/test/version/pkg                   添加测试软件包（distributeMode=1）→ pkgId
 *   3. GET  /api/publish/v3/package/compile/status             轮询云端编译
 *   4. PUT  /api/publish/v2/test/app/version                   {versionId, pkgId} 绑定；提交审核/测试群组由控制台人工完成。
 * 官方文档: https://developer.huawei.com/consumer/cn/doc/doccenter-connect-api/agc-help-test-api-guide-0000002236015562
 */
import fs from "node:fs";
import path from "node:path";
import { sha256File, formatSize, sleep } from "../util.js";
import { getAgcToken } from "./shared/agc-token.js";
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
const COMPILE_TIMEOUT_MS = 15 * 60 * 1000; // 编译轮询上限（AGC 文档 ~2 分钟，留余量）
const COMPILE_POLL_MS = 15_000;
/** AppTest 测试群组 API 前缀（与 publish API 同域不同路径段） */
const APP_TEST_BASE = "https://connect-api.cloud.huawei.com/api/app-test/v1";

/** AGC 返回体外壳（ret.code !== 0 即失败） */
interface AgcRet {
  ret?: { code?: number; msg?: string };
}

/** OBS 上传地址信息（urlInfo 与顶层字段两种历史形态都可能出现） */
interface ObsUrlInfo {
  url?: string;
  objectId?: string;
  method?: string;
  headers?: Record<string, string>;
}

interface UploadUrlResp extends AgcRet, ObsUrlInfo {
  urlInfo?: ObsUrlInfo;
}

/** appid-list 条目（历史字段名 appId/AppId、bundleName/BundleName 不统一） */
interface AppIdEntry {
  appId?: string;
  AppId?: string;
  bundleName?: string;
  BundleName?: string;
}

interface AppIdListResp extends AgcRet {
  appIds?: AppIdEntry[];
  appIdList?: AppIdEntry[];
  /** 2026-10 实测新形态：packageName 由服务端过滤，返回 {key: 应用名, value: appId} */
  appids?: Array<{ key?: string; value?: string }>;
}

interface AppInfoResp extends AgcRet {
  appInfo?: { defaultLang?: string };
}

interface BindPkgResp extends AgcRet {
  packageId?: string;
}

interface CompileStatusResp extends AgcRet {
  pkgStateList?: Array<{ pkgId?: string; successStatus?: number }>;
}

/** Testing API：新建测试版本响应 */
interface TestVersionResp extends AgcRet {
  versionId?: string;
}

/** Testing API：添加测试软件包响应 */
interface TestPkgResp extends AgcRet {
  pkgVersion?: string[];
}

/** AppTest 测试群组列表响应（rtnCode 外壳，非 publish API 的 ret.code） */
interface TestGroupListResp {
  rtnCode?: number | string;
  rtnDesc?: string;
  businessCode?: number | string;
  groups?: Array<{ groupId?: string; groupName?: string; groupType?: number }>;
  pageInfo?: { current?: number; pageSize?: number; totalRecord?: number; totalPage?: number };
}

/** AGC JSON API 封装：判 ret.code !== 0 抛错 —— v1 agc.mjs agcJson 原样 */
async function agcJson<T extends AgcRet>(
  url: string,
  init: RequestInit,
  context: string,
): Promise<T> {
  const res = await fetch(url, init);
  let json: T;
  try {
    json = (await res.json()) as T;
  } catch {
    throw new Error(`AGC ${context}返回非 JSON（HTTP ${res.status}）`);
  }
  if (!res.ok || json.ret?.code !== 0) {
    const code = json.ret?.code ?? res.status;
    const desc = json.ret?.msg ?? JSON.stringify(json).slice(0, 300);
    throw new Error(`AGC ${context}失败 ${code}: ${desc}`);
  }
  return json;
}

/**
 * 按 bundleName 查鸿蒙应用 appId（packageTypes=7 为鸿蒙过滤值）—— v1 agc.mjs getHarmonyAppId 原样。
 * appId 缺省时由渠道内部调用，也可独立复用。
 */
export async function getHarmonyAppId(opts: {
  clientId: string;
  token: string;
  bundleName: string;
}): Promise<string> {
  const qs = new URLSearchParams({ packageTypes: "7", packageName: opts.bundleName });
  const json = await agcJson<AppIdListResp>(
    `${BASE}/publish/v2/appid-list?${qs}`,
    {
      headers: { client_id: opts.clientId, Authorization: `Bearer ${opts.token}` },
    },
    "查询应用列表",
  );
  // 2026-10 实测新形态：appids=[{key:应用名, value:appId}]，packageName 已由服务端过滤，首条即目标
  const fresh = json.appids?.[0]?.value;
  if (fresh) return fresh;
  // 旧形态兜底（appIds / appIdList 历史字段名不统一，大小写不敏感匹配 bundleName）
  const list = json.appIds ?? json.appIdList ?? [];
  const hit = (Array.isArray(list) ? list : []).find(
    (e) =>
      String(e.bundleName ?? e.BundleName ?? "").toLowerCase() === opts.bundleName.toLowerCase(),
  );
  if (!hit)
    throw new Error(`AGC 未找到 bundleName=${opts.bundleName} 的鸿蒙应用（packageTypes=7）`);
  return hit.appId ?? hit.AppId ?? "";
}

/** 取应用默认语言（更新文案落用户实际看到的语言位）—— v1 agc.mjs getDefaultLang 原样 */
async function getDefaultLang(headers: Record<string, string>, appId: string): Promise<string> {
  const qs = new URLSearchParams({ appId, releaseType: "1" });
  const json = await agcJson<AppInfoResp>(
    `${BASE}/publish/v3/app-info?${qs}`,
    { headers },
    "查询应用信息",
  );
  return json.appInfo?.defaultLang || "zh-CN";
}

export class AgcHarmonyChannel implements Channel {
  readonly id = "agc";
  readonly label = "华为 AGC(鸿蒙)";
  readonly capabilities: ChannelCapabilities = {
    stage: true,
    submit: true,
    scheduled: true,
    status: false,
  };
  readonly errorHints = {
    "204144719": "软件包正在编译中（正常时序，CLI 已自动重试；持续出现请到 AGC 控制台看包状态）",
    "204144727": "编译中，官方建议 3-5 分钟后再试（CLI 已自动重试）",
    "204144660": "提交失败，包可能仍在解析（稍后重试或到控制台查看）",
    "1003": "client_id/client_secret 无效（AGC → 项目设置 → 常规 → API Client 重新获取）",
    "204144702": "签名/证书不匹配：检查签名证书指纹（SHA256）与 AGC 后台登记是否一致",
    "204144677": "bundleName 与应用不匹配：确认 appId 对应的应用包名",
    "204144692":
      "提审前置校验失败（按 msg 判断）：privacyPolicy → 控制台「更多服务→协议服务」登记隐私政策；count of harmony test in audit → 在审测试版本超限，先停止/删除在审的测试版本再提",
  };

  private async authHeaders(ctx: ChannelContext) {
    const clientId = required(ctx, "AGC_CLIENT_ID");
    const clientSecret = required(ctx, "AGC_CLIENT_SECRET");
    const token = await getAgcToken({ clientId, clientSecret });
    return { clientId, token, headers: { client_id: clientId, Authorization: `Bearer ${token}` } };
  }

  /** appId 缺省时按 bundleName 查（v1 全链路 step 0，可选） */
  private async resolveAppId(
    ctx: ChannelContext,
    clientId: string,
    token: string,
  ): Promise<string> {
    const appId = ctx.target.appId;
    if (appId) return appId;
    const bundleName = required(ctx, "bundleName", "项目配置 appId / bundleName 至少配一个");
    ctx.emit({
      type: "progress",
      detail: `appId 缺省，按 bundleName=${bundleName} 查询 AGC 应用列表…`,
    });
    return getHarmonyAppId({ clientId, token, bundleName });
  }

  async plan(ctx: ChannelContext): Promise<ReleasePlanEntry> {
    if (ctx.target.releaseType === "6") {
      return {
        channel: this.id,
        platform: "harmony",
        artifactVersion: "",
        action: "stage-only",
        afterApproval: "none(beta)",
        notes:
          ctx.target.submitTest === "true"
            ? "Testing API 邀请测试：上传→新建测试版本→绑定软件包→（可选绑测试群组）自动提交测试审核"
            : "Testing API 邀请测试：上传→新建测试版本→绑定软件包；提交审核与测试群组到控制台完成，不自动提审",
      };
    }
    return {
      channel: this.id,
      platform: "harmony",
      artifactVersion: "",
      action: "stage+submit",
      afterApproval: ctx.releaseTime ? "scheduled" : "auto-publish",
      notes: ".app 整包 v3 全链路：上传 → 绑定 → 等云端编译 → 提审（编译中自动重试）",
    };
  }

  /** stage = 上传+绑定（不提审）：正式 .app 走 v3 绑定；ctx.target.releaseType==='6' 走测试发布（.hap） */
  async stage(ctx: ChannelContext): Promise<StageResult> {
    const { clientId, token, headers } = await this.authHeaders(ctx);
    const appId = await this.resolveAppId(ctx, clientId, token);
    ctx.emit({ type: "phase", phase: "auth", message: "token 获取成功" });
    if (ctx.target.releaseType === "6") {
      return this.uploadBeta(ctx, appId, headers);
    }
    const { objectId, packageId } = await this.uploadFormal(ctx, appId, headers);
    return { ok: true, ref: packageId || objectId };
  }

  /** submit = v1 releaseHarmonyApp 完整链路：上传+绑定+文案 → 等编译轮询 → 提审（带重试） */
  async submit(ctx: ChannelContext): Promise<SubmitResult> {
    if (ctx.target.releaseType === "6") {
      return {
        ok: false,
        error:
          "AGC 测试发布（releaseType=6）的自动提审走 beta 配置 test['agc'].submit=true（上传绑定后自动提交测试版本审核）",
      };
    }
    const { clientId, token, headers } = await this.authHeaders(ctx);
    const appId = await this.resolveAppId(ctx, clientId, token);
    ctx.emit({ type: "phase", phase: "auth", message: "token 获取成功" });
    const { packageId } = await this.uploadFormal(ctx, appId, headers);

    // step 5: 轮询编译状态
    if (packageId) await this.awaitCompile(ctx, appId, packageId, headers);

    // 官方要求：升级版本 newFeatures 必填——缺失可能在提审被拒（审计 2026-10）
    if (!ctx.updateDescription)
      ctx.emit({
        type: "warn",
        message: "未提供更新说明（--note）：AGC 升级版本要求 newFeatures 必填，提审可能被拒",
      });

    // step 6: 提审（204144719/204144727 = 仍在编译，可重试）
    ctx.emit({ type: "phase", phase: "submit" });
    const submitDeadline = Date.now() + COMPILE_TIMEOUT_MS;
    for (;;) {
      try {
        await agcJson(
          `${BASE}/publish/v3/app-submit?appId=${encodeURIComponent(appId)}`,
          {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify(
              // 定时上架（对拍 apkgo harmony.go）：releaseType 恒 1，releaseTime 为独立可选字段（+0800 无冒号偏移）
              {
                releaseType: 1,
                ...(ctx.releaseTime
                  ? {
                      releaseTime: ctx.releaseTime
                        .replace(/([+-]\d{2}):(\d{2})$/, "$1$2")
                        .replace("Z", "+0000"),
                    }
                  : {}),
              },
            ),
          },
          "提交审核",
        );
      } catch (e) {
        // 只认 204144719/204144727（仍在编译）；不能按“编译”字样匹配——驳回原因含“编译”的不可重试错误会被拖到超时
        const compiling = /204144719|204144727/.test((e as Error).message);
        if (!compiling) throw e;
        if (Date.now() > submitDeadline) throw e;
        ctx.emit({
          type: "warn",
          message: `提审暂缓（包仍在编译），${COMPILE_POLL_MS / 1000}s 后重试…`,
        });
        await sleep(COMPILE_POLL_MS);
        continue;
      }
      ctx.emit({
        type: "phase",
        phase: "done",
        message: "鸿蒙已提交审核！请在 AGC 控制台跟踪审核进度",
      });
      return { ok: true };
    }
  }

  /** 轮询软件包云端编译：successStatus 0=成功 2=拒绝（终态，多为签名/证书/bundleName 不匹配）其他=编译中 */
  private async awaitCompile(
    ctx: ChannelContext,
    appId: string,
    pkgId: string,
    headers: Record<string, string>,
  ): Promise<void> {
    ctx.emit({ type: "phase", phase: "wait", message: `等待 AGC 云端编译（pkgId: ${pkgId}）` });
    const deadline = Date.now() + COMPILE_TIMEOUT_MS;
    for (;;) {
      const stQs = new URLSearchParams({ appId, pkgIds: pkgId });
      const st = await agcJson<CompileStatusResp>(
        `${BASE}/publish/v3/package/compile/status?${stQs}`,
        { headers },
        "查询编译状态",
      );
      const state = st.pkgStateList?.find((p) => p.pkgId === pkgId) ?? st.pkgStateList?.[0];
      const s = state?.successStatus;
      if (s === 0) {
        ctx.emit({ type: "progress", detail: "软件包编译完成" });
        return;
      }
      if (s === 2) {
        throw new Error(
          `AGC 编译拒绝（pkgId ${pkgId}）：签名/证书/bundleName 不匹配，到 AGC 控制台核对`,
        );
      }
      if (Date.now() > deadline)
        throw new Error(`AGC 编译超时（${COMPILE_TIMEOUT_MS / 60000} 分钟，pkgId ${pkgId}）`);
      ctx.emit({
        type: "progress",
        detail: `编译中（successStatus=${s}），${COMPILE_POLL_MS / 1000}s 后重查…`,
      });
      await sleep(COMPILE_POLL_MS);
    }
  }

  async status(): Promise<ReviewStatus> {
    return { state: "unknown", raw: "AGC 鸿蒙审核状态查询未接入（v1 亦无）" };
  }

  /** v1 releaseHarmonyApp step 1-4：.app 校验 → 上传地址 → PUT 整包 → v3 绑定（releaseType=1）→ 文案（不阻断） */
  private async uploadFormal(
    ctx: ChannelContext,
    appId: string,
    headers: Record<string, string>,
  ): Promise<{ objectId: string; packageId: string }> {
    const fileName = path.basename(ctx.artifactPath);
    const contentLength = fs.statSync(ctx.artifactPath).size;
    const sha256 = sha256File(ctx.artifactPath);
    ctx.emit({
      type: "phase",
      phase: "upload",
      message: `AGC 鸿蒙上传 ${fileName}（${formatSize(contentLength)}）`,
    });
    if (path.extname(ctx.artifactPath).toLowerCase() !== ".app") {
      throw new Error(
        "鸿蒙上架只接受 DevEco 打出的 .app 整包（AGC 不收单 .hap）。内测 .hap 请走 beta harmony（蒲公英或 releaseType=6）",
      );
    }

    // step 1: 上传地址
    const qs1 = new URLSearchParams({
      appId,
      fileName,
      contentLength: String(contentLength),
      sha256,
    });
    const urlJson = await agcJson<UploadUrlResp>(
      `${BASE}/publish/v2/upload-url/for-obs?${qs1}`,
      { headers },
      "获取上传地址",
    );
    const urlInfo = urlJson.urlInfo ?? urlJson;
    const objectId = urlInfo.objectId ?? "";
    if (!urlInfo.url || !objectId)
      throw new Error(`AGC 上传地址响应异常: ${JSON.stringify(urlJson).slice(0, 300)}`);
    ctx.emit({ type: "progress", detail: `上传地址获取成功（objectId: ${objectId}）` });

    // step 2: PUT 上传（headers 照华为返回；Content-Type 缺失才补——强制覆盖会破坏 OBS 签名）
    const method = (urlInfo.method ?? "PUT").toUpperCase();
    const upHeaders: Record<string, string> = { ...urlInfo.headers };
    if (!Object.keys(upHeaders).some((k) => k.toLowerCase() === "content-type")) {
      upHeaders["Content-Type"] = "application/octet-stream";
    }
    upHeaders["Content-Length"] = String(contentLength);
    const upRes = await fetch(urlInfo.url, {
      method,
      headers: upHeaders,
      body: fs.readFileSync(ctx.artifactPath),
      signal: AbortSignal.timeout(1800_000),
    });
    if (![200, 201, 204].includes(upRes.status)) {
      throw new Error(`AGC 文件上传失败 HTTP ${upRes.status}`);
    }
    ctx.emit({ type: "progress", detail: "整包上传完成" });

    // step 3: 绑定（v3 app-package-info → packageId，用于轮询编译）
    const qs3 = new URLSearchParams({ appId, releaseType: "1" });
    const bindJson = await agcJson<BindPkgResp>(
      `${BASE}/publish/v3/app-package-info?${qs3}`,
      {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ fileName, objectId }),
      },
      "绑定软件包",
    );
    const packageId = bindJson.packageId ?? "";
    ctx.emit({ type: "phase", phase: "bind", message: `软件包已绑定（packageId: ${packageId}）` });

    // step 4: 更新文案（落默认语言位，不阻断）
    await this.updateReleaseNotes(ctx, appId, headers, qs3);
    return { objectId, packageId };
  }

  /**
   * 测试发布（releaseType=6，2026-10 起走 Testing API——旧 app-package-info 直绑链路已被华为下线，
   * 其 releaseType 枚举仅剩 1=全网 / 7=企业非公开）：
   * 上传 .app → 新建测试版本（testType 3=邀请测试 4=公开测试）→ 添加测试软件包 → 等云端编译 → 更新测试版本绑定；
   * target.submitTest='true' 时：（可选按 testGroup 绑测试群组）自动提交测试版本审核；否则由控制台人工完成。
   */
  private async uploadBeta(
    ctx: ChannelContext,
    appId: string,
    headers: Record<string, string>,
  ): Promise<StageResult> {
    const fileName = path.basename(ctx.artifactPath);
    const contentLength = fs.statSync(ctx.artifactPath).size;
    const sha256 = sha256File(ctx.artifactPath);
    if (path.extname(ctx.artifactPath).toLowerCase() !== ".app") {
      throw new Error(
        "AGC 测试发布需要 .app 整包（DevEco「构建 App」产物，发布签名）；Testing API 不再接受 .hap（实测 204144641）",
      );
    }
    ctx.emit({
      type: "phase",
      phase: "upload",
      message: `AGC 上传 ${fileName}（${formatSize(contentLength)}，测试发布）`,
    });

    const qs = new URLSearchParams({
      appId,
      fileName,
      contentLength: String(contentLength),
      sha256,
      releaseType: "6",
    });
    const urlJson = await agcJson<UploadUrlResp>(
      `${BASE}/publish/v2/upload-url/for-obs?${qs}`,
      { headers },
      "获取上传地址",
    );
    const urlInfo = urlJson.urlInfo ?? urlJson;
    const objectId = urlInfo.objectId ?? "";
    if (!urlInfo.url)
      throw new Error(`AGC 返回的上传地址为空: ${JSON.stringify(urlJson).slice(0, 300)}`);
    if (!objectId) throw new Error("AGC 上传响应缺 objectId（Testing API 添加软件包必需）");
    ctx.emit({ type: "progress", detail: "上传地址获取成功（5 分钟内有效）" });

    const method = (urlInfo.method ?? "PUT").toUpperCase();
    const upHeaders: Record<string, string> = { ...urlInfo.headers };
    if (!Object.keys(upHeaders).some((k) => k.toLowerCase() === "content-type")) {
      upHeaders["Content-Type"] = "application/octet-stream";
    }
    upHeaders["Content-Length"] = String(contentLength);
    const upRes = await fetch(urlInfo.url, {
      method,
      headers: upHeaders,
      body: fs.readFileSync(ctx.artifactPath),
      signal: AbortSignal.timeout(900_000),
    });
    if (![200, 201, 204].includes(upRes.status)) {
      throw new Error(`AGC 文件上传失败 HTTP ${upRes.status}`);
    }
    ctx.emit({ type: "progress", detail: "文件上传完成" });

    // step 1：新建测试版本（releaseType=6 HarmonyOS 测试发布；testType 3=邀请测试 4=公开测试，target.testType 透传）
    const testType = ctx.target.testType === "4" ? 4 : 3;
    const verJson = await agcJson<TestVersionResp>(
      `${BASE}/publish/v2/test/app/version?appId=${encodeURIComponent(appId)}`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          releaseType: 6,
          testType,
          testDesc: (ctx.updateDescription ?? "applift 测试发布").slice(0, 50),
        }),
      },
      "新建测试版本",
    );
    const versionId = verJson.versionId ?? "";
    if (!versionId) throw new Error("AGC 新建测试版本未返回 versionId");
    ctx.emit({
      type: "phase",
      phase: "bind",
      message: `测试版本已创建（versionId: ${versionId}）`,
    });

    // step 2：添加测试软件包（distributeMode 1=测试专区）
    const pkgJson = await agcJson<TestPkgResp>(
      `${BASE}/publish/v2/test/version/pkg?appId=${encodeURIComponent(appId)}`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ distributeMode: 1, file: { fileName, objectId } }),
      },
      "添加测试软件包",
    );
    const pkgId = pkgJson.pkgVersion?.[0] ?? "";
    if (!pkgId) throw new Error("AGC 添加测试软件包未返回 pkgVersion");

    // step 3：等云端编译完成（官方建议：解析完成后再绑定）
    await this.awaitCompile(ctx, appId, pkgId, headers);

    // step 4：更新测试版本，绑定软件包
    await agcJson(
      `${BASE}/publish/v2/test/app/version?appId=${encodeURIComponent(appId)}`,
      {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ versionId, pkgId }),
      },
      "绑定测试软件包",
    );

    // step 5（可选，target.submitTest='true'）：绑定测试群组 → 提交测试审核
    // 提审接口：POST /api/publish/v2/test/app/version/submit?appId=xx，body { versionId }
    if (ctx.target.submitTest === "true") {
      const groupName = ctx.target.testGroup?.trim();
      if (groupName) {
        const groupId = await this.resolveTestGroupId(ctx, appId, groupName, headers);
        // 群组绑定走「更新测试版本」openTestInfo.testTaskInfo.groupInfos；
        // 实测 203489281：openTestInfo 一旦携带，startTime/endTime 必填（毫秒时间戳）——缺省给 30 天测试有效期
        const now = Date.now();
        await agcJson(
          `${BASE}/publish/v2/test/app/version?appId=${encodeURIComponent(appId)}`,
          {
            method: "PUT",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({
              versionId,
              pkgId,
              openTestInfo: {
                startTime: now,
                endTime: now + 30 * 24 * 60 * 60 * 1000,
                testTaskInfo: { groupInfos: [{ groupId, groupName }] },
              },
            }),
          },
          "绑定测试群组",
        );
        ctx.emit({
          type: "progress",
          detail: `测试群组「${groupName}」已绑定（groupId: ${groupId}）`,
        });
      }
      ctx.emit({ type: "phase", phase: "submit", message: "提交测试版本审核…" });
      await agcJson(
        `${BASE}/publish/v2/test/app/version/submit?appId=${encodeURIComponent(appId)}`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ versionId }),
        },
        "提交测试审核",
      );
      ctx.emit({
        type: "phase",
        phase: "done",
        message: `测试版本已提交审核（versionId: ${versionId}）`,
      });
      return { ok: true, ref: versionId };
    }

    ctx.emit({
      type: "phase",
      phase: "done",
      message: "测试版本已就绪（未提交审核）；到控制台提交或配置 test['agc'].submit 自动提审",
    });
    return { ok: true, ref: versionId };
  }

  /**
   * 按群组名查测试群组 groupId（AppTest API GET /test-group/list，appId 走 header，rtnCode 外壳）。
   * 分页遍历；匹配不到报错提示到控制台建组。
   * 文档: agc-help-test-api-get-test-grouplist-0000002271000717
   */
  private async resolveTestGroupId(
    ctx: ChannelContext,
    appId: string,
    groupName: string,
    headers: Record<string, string>,
  ): Promise<string> {
    ctx.emit({ type: "progress", detail: `按群组名「${groupName}」查询 AGC 测试群组…` });
    for (let current = 1; current <= 50; current++) {
      const qs = new URLSearchParams({ current: String(current), pageSize: "50" });
      const res = await fetch(`${APP_TEST_BASE}/test-group/list?${qs}`, {
        headers: { ...headers, appId },
      });
      if (!res.ok) throw new Error(`AGC 查询测试群组失败 HTTP ${res.status}`);
      const json = (await res.json()) as TestGroupListResp;
      if (Number(json.rtnCode) !== 0) {
        throw new Error(
          `AGC 查询测试群组失败: rtnCode=${json.rtnCode ?? "?"}${json.rtnDesc ? ` ${json.rtnDesc}` : ""}`,
        );
      }
      const hit = json.groups?.find((g) => g.groupName === groupName);
      if (hit?.groupId) return hit.groupId;
      const totalPage = json.pageInfo?.totalPage ?? current;
      if (current >= totalPage) break;
    }
    throw new Error(
      `AGC 未找到名为「${groupName}」的测试群组：到 AGC 控制台「测试 → 测试群组」创建后再试`,
    );
  }

  /** v1 更新文案段（releaseHarmonyApp step 4 / uploadToAgc 尾段）：查默认语言 → 写 newFeatures，失败仅警告不阻断 */
  private async updateReleaseNotes(
    ctx: ChannelContext,
    appId: string,
    headers: Record<string, string>,
    qs: URLSearchParams,
  ): Promise<void> {
    if (!ctx.updateDescription) return;
    try {
      const lang = await getDefaultLang(headers, appId).catch(() => "zh-CN");
      await agcJson(
        `${BASE}/publish/v3/app-language-info?${qs}`,
        {
          method: "PUT",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ lang, newFeatures: ctx.updateDescription }),
        },
        "更新文案",
      );
      ctx.emit({ type: "progress", detail: `更新文案已写入（${lang}）` });
    } catch (e) {
      ctx.emit({ type: "warn", message: `更新文案未写入（不阻断）: ${(e as Error).message}` });
    }
  }
}

function required(ctx: ChannelContext, key: string, where?: string): string {
  // target 优先；凭据别名 AGC_APP_ID 兜底（init/channels 指引写入）
  const alias = key === "appId" ? "AGC_APP_ID" : "";
  const v = ctx.target[key] ?? ctx.credentials[key] ?? (alias && ctx.credentials[alias]);
  if (!v) {
    throw new Error(
      `AGC 鸿蒙渠道缺少 ${key}${where ? `（${where}）` : alias ? `（项目配置或凭据 ${alias}）` : ""}`,
    );
  }
  return v;
}
