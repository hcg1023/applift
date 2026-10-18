/**
 * 小米应用商店（安卓 APK）渠道 —— 自 v1 lib/stores/xiaomi.mjs 迁移（逻辑不变）。
 *
 * 小米特色: SIG 用 X.509 证书公钥 RSA PKCS1_v1_5 分段加密（非 HMAC）:
 *   sig = RSA_encrypt(证书公钥, JSON({sig: [{name, hash: MD5}...], password}))
 *   分段: 1024bit key → 每段 117 字节（128 - PKCS1 padding 11）
 * 链路: /dev/query 校验账号对包名权限 + 提审前版本回归预检 → /dev/push 上传即提审（synchroType=1 更新包，
 *       icon 现行文档（pId=1134，2026-02）标必选，apkgo 同（每次 push 必带）；旧官方 PDF（pId=33）标可选，
 *       分歧按现行文档从严处理——applift 默认从工程 mipmap 自动发现（android.stores.xiaomi.icon 可覆盖），
 *       未找到才中止；privacyUrl 是否强制仍待真机验证（apkgo 未传该字段）。
 *       另 2026-02-04 起 testAccount 须用新结构化格式（如 {"zh_CN":{"accounts":[...]}}），当前未传暂不受影响。
 * 移植自（MIT）: AngChow/android-publish scripts/_mi_common.py + mi_submit.py
 * 官方文档: https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1134
 */
import { publicEncrypt, constants, X509Certificate } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { md5String, md5File } from "./shared/sign.js";
import { fileBlob } from "./shared/file-blob.js";
import type {
  Channel,
  ChannelCapabilities,
  ChannelContext,
  ReleasePlanEntry,
  ReviewStatus,
  StageResult,
  SubmitResult,
} from "../channel.js";

const MI_API_BASE = "https://api.developer.xiaomi.com/devupload";

/** 文件项：参与 SIG 签名的上传文件（字段名 → 本地路径） */
type FileItem = readonly [name: string, filePath: string];

/**
 * X.509 证书公钥 RSA PKCS1_v1_5 分段加密 → hex。
 * Node 的 publicEncrypt 单次上限 = keySize - 11；1024bit key = 117 字节。
 */
export function rsaEncryptSegmented(plain: string, certPem: string): string {
  const cert = new X509Certificate(certPem);
  const keyObj = cert.publicKey;
  const keySize = (keyObj.asymmetricKeyDetails?.modulusLength ?? 1024) / 8;
  const chunkSize = keySize - 11;
  const buf = Buffer.from(plain, "utf8");
  const out: Buffer[] = [];
  for (let i = 0; i < buf.length; i += chunkSize) {
    out.push(
      publicEncrypt(
        { key: keyObj, padding: constants.RSA_PKCS1_PADDING },
        buf.subarray(i, i + chunkSize),
      ),
    );
  }
  return Buffer.concat(out).toString("hex");
}

/** 生成小米 SIG：RequestData MD5 + 各文件 MD5 + 密码，整体 RSA 分段加密 */
export function generateMiSig(
  requestDataJson: string,
  fileItems: readonly FileItem[],
  password: string,
  certPem: string,
): string {
  const sigList = [{ name: "RequestData", hash: md5String(requestDataJson) }];
  for (const [name, filePath] of fileItems) {
    sigList.push({ name, hash: md5File(filePath) });
  }
  return rsaEncryptSegmented(JSON.stringify({ sig: sigList, password }), certPem);
}

/** 小米接口统一返回体（result=0 为成功）；错误文案 message/errMsg 双检（对拍 python mi_submit.py 读 message，apkgo 见 errMsg） */
interface MiRet {
  result?: number;
  message?: string;
  errMsg?: string;
}

/** /dev/query 响应（对拍 python mi_query.py / apkgo xiaomi.go query）：packageInfo 为线上在架信息 */
interface MiQueryRet extends MiRet {
  packageInfo?: {
    versionCode?: number | string;
    onlineVersionCode?: number | string; // 未见于现行文档（packageInfo 仅四字段），实测兼容字段，权威以 versionCode 为准
    versionName?: string;
  };
  /** 允许更新版本开关（mi_query.py「允许更新版本」；布尔，非版本号） */
  updateVersion?: boolean;
}

export class XiaomiChannel implements Channel {
  readonly id = "xiaomi";
  readonly label = "小米应用商店";
  readonly capabilities: ChannelCapabilities = {
    stage: false,
    submit: true,
    scheduled: false,
    status: true,
  };
  /** 平台错误码 → 人话（result 码：依据为本仓测试已固化的真实失败路径文案） */
  readonly errorHints = {
    "401": "签名无效或账号无该包名权限（检查 MI_CLIENT_SECRET 与 /dev/query 权限）",
    "1005": "push SIG 校验失败（检查证书公钥与密码是否匹配）",
  };

  async plan(_ctx: ChannelContext): Promise<ReleasePlanEntry> {
    return {
      channel: this.id,
      platform: "android",
      artifactVersion: "",
      action: "submit-only",
      afterApproval: "auto-publish",
      notes: "小米 push 上传即提审（不可只传包），撤回需到小米开放平台控制台",
    };
  }

  /** 小米不支持只传包：push 接口上传即提审 */
  async stage(_ctx: ChannelContext): Promise<StageResult> {
    return { ok: false, error: "小米上传与提审一体" };
  }

  async submit(ctx: ChannelContext): Promise<SubmitResult> {
    const userName = required(ctx, "MI_USER_NAME");
    const password = miPassword(ctx);
    const certPath = required(ctx, "MI_CERT_PATH");
    const appName = required(ctx, "MI_APP_NAME");
    const pkgName = required(ctx, "pkgName", "项目配置 android.stores.xiaomi.pkgName");
    const certPem = fs.readFileSync(certPath, "utf8");

    // 先查一次应用信息（校验账号对包名的权限；提审前版本回归预检也依赖此响应）
    ctx.emit({ type: "phase", phase: "auth" });
    const queryReq = JSON.stringify({ userName, packageName: pkgName });
    const querySig = generateMiSig(queryReq, [], password, certPem);
    const queryRes = await fetch(`${MI_API_BASE}/dev/query`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ RequestData: queryReq, SIG: querySig }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    let query: MiQueryRet;
    try {
      query = (await queryRes.json()) as MiQueryRet;
    } catch {
      throw new Error(`小米 查询应用返回非 JSON（HTTP ${queryRes.status}）`);
    }
    if (query.result !== 0) {
      throw new Error(
        `小米查询应用失败 result=${query.result}: ${query.message ?? query.errMsg ?? JSON.stringify(query).slice(0, 200)}`,
      );
    }
    ctx.emit({ type: "progress", detail: `小米: 应用 ${pkgName} 校验通过` });

    // 提审前版本回归预检（对拍 python mi_query.py / apkgo xiaomi.go audit 的版本比较）：
    //   updateVersion 为「允许更新版本」布尔开关，显式 false=线上锁定（如审核中），直接拒；
    //   待提审 versionCode（项目配置 android.stores.xiaomi.versionCode，可选）低于线上版本 → 版本回退，拒绝并
    //   提示。线上版本取 packageInfo.versionCode（现行文档字段）；onlineVersionCode 未见于现行文档，仅为
    //   实测兼容回退字段（历史接口曾返回）。
    if (query.updateVersion === false) {
      throw new Error(
        "小米提审中止：线上不允许更新版本（updateVersion=false，可能审核中），请稍后再试或到小米开放平台确认",
      );
    }
    const localVc = Number(ctx.target.versionCode);
    const liveVc = Number(query.packageInfo?.onlineVersionCode ?? query.packageInfo?.versionCode);
    if (Number.isFinite(localVc) && Number.isFinite(liveVc) && localVc < liveVc) {
      throw new Error(
        `小米提审中止：待提审 versionCode ${localVc} 低于线上 ${liveVc}（版本回退），请确认 APK 版本或项目配置`,
      );
    }

    // push（上传即提审）；icon 每次必带（apkgo xiaomi.go:219-237 仲裁：所有 synchroType 均要求，
    // SIG 的 sig 数组需覆盖实际附带的每个文件），取项目配置 android.stores.xiaomi.icon
    const iconPath = String(ctx.target.icon ?? "");
    if (!iconPath)
      throw new Error(
        "小米提审缺少 icon：applift.config.ts → android.stores.xiaomi.icon 配置图标路径（官方必选，apkgo 同）",
      );
    if (!fs.existsSync(iconPath)) throw new Error(`小米 icon 文件不存在: ${iconPath}`);
    const appInfo = {
      appName,
      packageName: pkgName,
      updateDesc: ctx.updateDescription || "修复已知问题，优化用户体验",
    };
    const request = { userName, appInfo: JSON.stringify(appInfo), synchroType: 1 };
    const requestJson = JSON.stringify(request);
    const sig = generateMiSig(
      requestJson,
      [
        ["apk", ctx.artifactPath],
        ["icon", iconPath],
      ],
      password,
      certPem,
    );

    const fileName = path.basename(ctx.artifactPath);
    ctx.emit({ type: "phase", phase: "upload", message: `上传 ${fileName}（上传即提审）` });
    const form = new FormData();
    form.append("RequestData", requestJson);
    form.append("SIG", sig);
    // openAsBlob 惰性 Blob：按需分片读，零整读内存（旧运行时回退 readFile 整读）
    form.append("apk", await fileBlob(ctx.artifactPath), fileName);
    form.append("icon", await fileBlob(iconPath), path.basename(iconPath));
    const res = await fetch(`${MI_API_BASE}/dev/push`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(900_000),
    });
    let json: MiRet;
    try {
      json = (await res.json()) as MiRet;
    } catch {
      throw new Error(`小米 push返回非 JSON（HTTP ${res.status}）`);
    }
    if (json.result !== 0) {
      throw new Error(
        `小米 push 失败 result=${json.result}: ${json.message ?? json.errMsg ?? JSON.stringify(json).slice(0, 300)}`,
      );
    }
    ctx.emit({
      type: "phase",
      phase: "done",
      message: "已提交（上传即提审，撤回需到小米开放平台控制台）",
    });
    return { ok: true, ref: JSON.stringify(json).slice(0, 80) };
  }

  /**
   * 审核状态查询: POST /dev/query（SIG 同 push，RequestData={userName,packageName}）。
   * 小米无专用审核接口，返回含 status 字段但取值文档缺失 → 统一 unknown+raw 透出原始响应。
   */
  async status(ctx: Pick<ChannelContext, "credentials" | "target">): Promise<ReviewStatus> {
    const userName = required(ctx, "MI_USER_NAME");
    const password = miPassword(ctx);
    const certPath = required(ctx, "MI_CERT_PATH");
    const pkgName = required(ctx, "pkgName", "审核状态查询必需");
    const certPem = fs.readFileSync(certPath, "utf8");

    const req = JSON.stringify({ userName, packageName: pkgName });
    const sig = generateMiSig(req, [], password, certPem);
    const res = await fetch(`${MI_API_BASE}/dev/query`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ RequestData: req, SIG: sig }).toString(),
      signal: AbortSignal.timeout(30_000),
    });
    let json: Record<string, unknown>;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new Error(`小米 查询审核状态返回非 JSON（HTTP ${res.status}）`);
    }
    if (json.result !== 0) {
      throw new Error(
        `小米查询审核状态失败 result=${json.result}: ${String(json.message ?? json.errMsg ?? JSON.stringify(json).slice(0, 200))}`,
      );
    }
    return { state: "unknown", raw: JSON.stringify(json).slice(0, 200) };
  }
}

/**
 * MI_PASSWORD 为主键名（applift 沿用）；兼容 python 权威键名 MI_PRIVATE_KEY（_mi_common.get_mi_credentials）。
 * 值为小米开放平台的「API 私钥」（SIG 加密的 password 材料），非开发者账号登录密码 ——
 * 文档明确：访问密码即私钥，重置私钥后私钥变、小米分配的公钥不变。
 */
function miPassword(ctx: Pick<ChannelContext, "credentials" | "target">): string {
  const v = ctx.credentials.MI_PASSWORD ?? ctx.credentials.MI_PRIVATE_KEY;
  if (!v) throw new Error("小米渠道缺少 MI_PASSWORD（兼容别名 MI_PRIVATE_KEY）");
  return v;
}

function required(
  ctx: Pick<ChannelContext, "credentials" | "target">,
  key: string,
  where?: string,
): string {
  const v = ctx.credentials[key] ?? ctx.target[key];
  if (!v) throw new Error(`小米渠道缺少 ${key}${where ? `（${where}）` : ""}`);
  return v;
}
