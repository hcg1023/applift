/**
 * App Store Connect（iOS）渠道。
 *
 * - stage: xcrun altool 上传 ipa（免 fastlane/Ruby 依赖，底层即 App Store Connect API）
 *   —— 自 v1 tools/publish/lib/asc.mjs 的 uploadIpaToAsc 迁移（逻辑不变）。
 *   约定 p8 私钥：凭据 ASC_P8_PATH（支持 ~ 前缀）或 ~/.applift/private_keys/AuthKey_<ASC_KEY_ID>.p8
 *   （v1 放 tools/publish/private_keys/；altool 本身认 <cwd>/private_keys、~/private_keys、
 *    ~/.private_keys、~/.appstoreconnect/private_keys，见 xcrun altool --help）
 * - submit: ASC REST API 提审 —— 按 ASC 官方文档新实现，未经真实链路验证
 *   官方文档: https://developer.apple.com/documentation/appstoreconnectapi
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  Channel,
  ChannelCapabilities,
  ChannelContext,
  ReleasePlanEntry,
  ReviewStatus,
  StageResult,
  SubmitResult,
} from "../channel.js";
import { ascGet, ascRequest, makeAscJwt } from "./shared/asc-jwt.js";

/** ASC JSON:API 资源文档（data/included 元素的最小字段） */
interface AscDoc<A = Record<string, unknown>> {
  id?: string;
  type?: string;
  attributes?: A;
  /** JSON:API 关系链接（builds → preReleaseVersion） */
  relationships?: { preReleaseVersion?: { data?: { id?: string; type?: string } } };
}

/** ASC 列表响应外壳 */
interface AscListResponse<A> {
  data: AscDoc<A>[];
  included?: AscDoc[];
}

/** ASC 单资源响应外壳 */
interface AscSingleResponse<A> {
  data: AscDoc<A> | null;
}

/** apps 资源属性 */
type AscAppAttrs = { bundleId?: string; name?: string };
/** builds 资源属性（processingState: PROCESSING / INVALID / FAILED / VALID） */
type AscBuildAttrs = { version?: string; uploadedDate?: string; processingState?: string };
/** preReleaseVersions 资源属性（version 即 CFBundleShortVersionString 营销版本号） */
type AscPreReleaseAttrs = { version?: string };
/** appStoreVersions 资源属性（releaseType: MANUAL / AUTOMATIC / SCHEDULED） */
type AscVersionAttrs = { versionString?: string; appStoreState?: string; releaseType?: string };

export class AscChannel implements Channel {
  readonly id = "asc";
  readonly label = "App Store Connect";
  readonly capabilities: ChannelCapabilities = {
    stage: true,
    submit: true,
    scheduled: true,
    status: false,
  };

  async plan(ctx: ChannelContext): Promise<ReleasePlanEntry> {
    return {
      channel: this.id,
      platform: "ios",
      artifactVersion: "",
      action: "stage+submit",
      // iOS 默认手动发布（审核通过后人工上架）；提供 releaseTime 时走 SCHEDULED 定时上架
      afterApproval: ctx.releaseTime ? "scheduled" : "manual",
      notes:
        "stage=xcrun altool 上传构建（TestFlight，约 10 分钟完成处理）；submit=ASC API 提审，默认手动发布",
    };
  }

  /** 凭据三元组（Key ID / Issuer ID / p8 路径，缺任一抛错） */
  private resolveAuth(ctx: ChannelContext): { keyId: string; issuerId: string; p8Path: string } {
    const keyId = required(ctx, "ASC_KEY_ID");
    const issuerId = required(ctx, "ASC_ISSUER_ID");
    const p8Path = resolveP8Path(ctx, keyId);
    if (!fs.existsSync(p8Path)) {
      throw new Error(
        `ASC 渠道 p8 私钥不存在: ${p8Path}（请设置凭据 ASC_P8_PATH，或将密钥放至 ~/.applift/private_keys/AuthKey_<ASC_KEY_ID>.p8；` +
          "在 App Store Connect → 用户和访问 → 集成 → App Store Connect API 创建密钥）",
      );
    }
    return { keyId, issuerId, p8Path };
  }

  /**
   * 上传 ipa 到 App Store Connect（TestFlight / 正式皆走此入口）。
   * 来源: v1 tools/publish/lib/asc.mjs 的 uploadIpaToAsc（逻辑不变；v1 经 run 继承 stdio 输出，
   * v2 输出统一走 ctx.emit，故改为捕获后透传，失败语义与 v1 run 一致）
   */
  async stage(ctx: ChannelContext): Promise<StageResult> {
    const { keyId, issuerId, p8Path } = this.resolveAuth(ctx);
    const ipaPath = ctx.artifactPath;
    ctx.emit({
      type: "phase",
      phase: "upload",
      message: `altool 上传 ${path.basename(ipaPath)}（约 5-15 分钟，p8: ${p8Path}）`,
    });

    // altool 只在 <cwd>/private_keys、~/private_keys、~/.private_keys、~/.appstoreconnect/private_keys
    // 查找 AuthKey_<KeyID>.p8；p8 所在目录名不是 private_keys 时（如 ASC_P8_PATH 指向任意目录），
    // 用临时目录 + private_keys 软链兜底，跑完即删（软链不复制密钥）
    const p8Dir = path.dirname(p8Path);
    let cwd = path.basename(p8Dir) === "private_keys" ? path.dirname(p8Dir) : "";
    let tmpDir = "";
    if (!cwd) {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-asc-"));
      fs.symlinkSync(p8Dir, path.join(tmpDir, "private_keys"), "dir");
      cwd = tmpDir;
    }
    try {
      const r = spawnSync(
        "xcrun",
        [
          "altool",
          "--upload-app",
          "--type",
          "ios",
          "-f",
          ipaPath,
          "--apiKey",
          keyId,
          "--apiIssuer",
          issuerId,
        ],
        { cwd, encoding: "utf8" },
      );
      if (r.error) throw new Error(`无法执行 xcrun: ${r.error.message}（altool 需 macOS + Xcode）`);
      // altool 输出含敏感路径，v1 直接透传，这里同样经 emit 透传（脱敏由 logger 层负责）
      const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().slice(-2000);
      if (r.status !== 0)
        throw new Error(`altool 上传失败（exit ${r.status}）: ${output || "无输出"}`);
      if (output) ctx.emit({ type: "progress", detail: output });
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    ctx.emit({
      type: "phase",
      phase: "done",
      message: "ipa 已上传至 App Store Connect（约 10 分钟后出现在 TestFlight）",
    });
    ctx.emit({
      type: "progress",
      detail: "内部测试员即刻可装；外部测试组首次需在 ASC 后台过 Beta 审核",
    });
    return { ok: true };
  }

  /**
   * 提审 App Store —— 按 ASC 官方文档新实现，未经真实链路验证。
   * 文档: appStoreVersionSubmissions / Create a Version Submission
   *   https://developer.apple.com/documentation/appstoreconnectapi
   * 链路: 查 app（bundleId → 数字 id）→ 查最新已处理(VALID)构建 → 读取/创建 appStoreVersion
   *   （releaseType 默认 MANUAL，ctx.releaseTime 提供时 SCHEDULED + earlyReleaseDate）
   *   → 绑定构建到版本 → POST appStoreVersionSubmissions 进入审核
   */
  async submit(ctx: ChannelContext): Promise<SubmitResult> {
    const { keyId, issuerId, p8Path } = this.resolveAuth(ctx);
    const bundleId = ctx.target["bundleId"] ?? ctx.target["bundleName"];
    if (!bundleId) throw new Error("ASC 渠道缺少 bundleId（项目配置 ios.bundleId）");
    const jwt = makeAscJwt({ keyId, issuerId, p8Path });
    ctx.emit({ type: "phase", phase: "auth", message: "ASC JWT 已生成（20 分钟有效）" });

    // 1) 按 bundleId 定位 App（ASC 内部数字 id）
    const apps = await ascGet<AscListResponse<AscAppAttrs>>(
      jwt,
      `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=5`,
    );
    const app = apps.data.find((a) => a.attributes?.bundleId === bundleId) ?? apps.data[0];
    if (!app?.id) throw new Error(`ASC 未找到 bundleId=${bundleId} 对应的 App`);

    // 2) 找最新已处理构建（processingState=VALID；altool 上传后约 10 分钟才从 PROCESSING 变 VALID）
    const builds = await ascGet<AscListResponse<AscBuildAttrs>>(
      jwt,
      `/v1/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=20&include=preReleaseVersion`,
    );
    const build = builds.data.find((b) => b.attributes?.processingState === "VALID");
    if (!build?.id) {
      const states =
        builds.data.map((b) => b.attributes?.processingState ?? "UNKNOWN").join(", ") || "无构建";
      throw new Error(
        `ASC 未找到已处理（VALID）的构建，最近状态: ${states}；构建上传后约 10 分钟完成处理，请稍后重试`,
      );
    }
    // 营销版本号（CFBundleShortVersionString）取该构建关联的 preReleaseVersion。
    // included 可能并存多个 train（如 1.9.9 修复版 + 2.0.0 新版并行），必须按
    // build.relationships.preReleaseVersion.data.id 匹配，included[0] 会取错版本号
    const preId = build.relationships?.preReleaseVersion?.data?.id;
    const pre = builds.included?.find((d) => d.type === "preReleaseVersions" && d.id === preId);
    const versionString = (pre?.attributes as AscPreReleaseAttrs | undefined)?.version;
    if (!versionString)
      throw new Error("ASC 构建缺少 preReleaseVersion 版本号，无法定位/创建 App Store 版本");
    ctx.emit({
      type: "progress",
      detail: `最新构建 build ${build.attributes?.version ?? ""}（版本 ${versionString}）`,
    });

    // 3) 读取可编辑版本（PREPARE_FOR_SUBMISSION / READY_FOR_SUBMISSION），无则按构建版本号创建；
    //    releaseType 默认 MANUAL（审核通过后手动上架），ctx.releaseTime 提供时 SCHEDULED 定时上架
    const releaseType = ctx.releaseTime ? "SCHEDULED" : "MANUAL";
    const releaseAttrs = ctx.releaseTime
      ? { releaseType, earlyReleaseDate: ctx.releaseTime }
      : { releaseType };
    const versions = await ascGet<AscListResponse<AscVersionAttrs>>(
      jwt,
      `/v1/apps/${app.id}/appStoreVersions?filter[platform]=IOS&filter[appStoreState]=PREPARE_FOR_SUBMISSION,READY_FOR_SUBMISSION&limit=5`,
    );
    let versionId = versions.data[0]?.id;
    if (versionId) {
      await ascRequest(jwt, `/v1/appStoreVersions/${versionId}`, "PATCH", {
        data: { type: "appStoreVersions", id: versionId, attributes: releaseAttrs },
      });
      ctx.emit({
        type: "phase",
        phase: "bind",
        message: `复用可编辑版本 ${versions.data[0]?.attributes?.versionString ?? ""}（releaseType=${releaseType}）`,
      });
    } else {
      const created = await ascRequest<AscSingleResponse<AscVersionAttrs>>(
        jwt,
        "/v1/appStoreVersions",
        "POST",
        {
          data: {
            type: "appStoreVersions",
            attributes: { platform: "IOS", versionString, ...releaseAttrs },
            relationships: { app: { data: { type: "apps", id: app.id } } },
          },
        },
      );
      versionId = created.data?.id;
      if (!versionId) throw new Error(`ASC 创建 appStoreVersion（${versionString}）未返回 id`);
      ctx.emit({
        type: "phase",
        phase: "bind",
        message: `已创建版本 ${versionString}（releaseType=${releaseType}）`,
      });
    }

    // 4) 把构建绑定到版本（builds 为 to-many 关系，data 传数组）
    await ascRequest(jwt, `/v1/appStoreVersions/${versionId}/relationships/builds`, "PATCH", {
      data: [{ type: "builds", id: build.id }],
    });

    // 5) 创建版本提交（进入 App Store 审核）
    const submission = await ascRequest<AscSingleResponse<Record<string, unknown>>>(
      jwt,
      "/v1/appStoreVersionSubmissions",
      "POST",
      {
        data: {
          type: "appStoreVersionSubmissions",
          relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: versionId } } },
        },
      },
    );
    ctx.emit({
      type: "phase",
      phase: "done",
      message: `已提交 App Store 审核（releaseType=${releaseType}，审核通过后${releaseType === "MANUAL" ? "手动" : "定时"}上架）`,
    });
    return { ok: true, ref: submission.data?.id };
  }

  async status(): Promise<ReviewStatus> {
    return {
      state: "unknown",
      raw: "ASC 审核状态查询（appStoreVersions 的 appStoreState）M2 接入",
    };
  }
}

function required(ctx: ChannelContext, key: string, where?: string): string {
  const v = ctx.credentials[key] ?? ctx.target[key];
  if (!v) throw new Error(`ASC 渠道缺少 ${key}${where ? `（${where}）` : ""}`);
  return v;
}

/** p8 路径：凭据 ASC_P8_PATH（支持 ~ 前缀）优先，否则 ~/.applift/private_keys/AuthKey_<KeyID>.p8 */
function resolveP8Path(ctx: ChannelContext, keyId: string): string {
  const explicit = ctx.credentials["ASC_P8_PATH"];
  if (explicit) {
    return explicit.startsWith("~/")
      ? path.join(os.homedir(), explicit.slice(2))
      : path.resolve(explicit);
  }
  return path.join(os.homedir(), ".applift", "private_keys", `AuthKey_${keyId}.p8`);
}
