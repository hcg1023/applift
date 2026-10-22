/**
 * App Store Connect（iOS）渠道。
 *
 * - stage 上传双引擎（2026-10-22 重构）：
 *   1) iTMSTransporter（首选）：Xcode 26 起 iTMSTransporter 已从 Xcode 剥离，需从 Mac App Store
 *      安装 Transporter.app（CLI 位于 /Applications/Transporter.app/Contents/itms/bin/）。
 *      JWT 认证与 ASC API 同源——Apple 官方建议 API 用户用同一 JWT 上传二进制
 *      （App Store Connect Help "Upload builds"）。注意两点（fastlane deliver 实证）：
 *      -assetFile 成功后 Apple 侧会删除源文件、多字节文件名上传失败，故复制到临时随机
 *      ASCII 名再传；JWT 20 分钟有效期覆盖典型上传时长（5-15 分钟），超长上传会认证过期。
 *   2) xcrun altool 兜底：Xcode 自带、零额外安装；altool 的 --upload-app 并未弃用
 *      （Apple 官方文档仍列名为四条官方上传路径之一，弃用的是其公证功能），
 *      但 altool 依赖 private_keys 目录查找，Transporter+JWT 是长期方向。
 *   凭据 ASC_TRANSPORTER_PATH 可显式指定 iTMSTransporter 路径（校验存在性）；
 *   缺省探测默认安装路径，不存在则回退 altool。
 *   约定 p8 私钥：凭据 ASC_P8_PATH（支持 ~ 前缀）或 ~/.applift/private_keys/AuthKey_<ASC_KEY_ID>.p8
 * - submit: ASC REST API 提审（含提审前预检：本地化描述完备性），按 ASC 官方文档实现，未经真实链路验证
 *   官方文档: https://developer.apple.com/documentation/appstoreconnectapi
 * - status: 查最新 appStoreVersion 的 appVersionState（AppVersionState 15 枚举 → ReviewStatus）
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
/** appStoreVersions 资源属性（appVersionState 枚举见 AppVersionState；releaseType: MANUAL / AFTER_APPROVAL / SCHEDULED） */
type AscVersionAttrs = { versionString?: string; appVersionState?: string; releaseType?: string };
/** appStoreVersionLocalizations 资源属性（description 为提审硬性要求） */
type AscVersionLocAttrs = { locale?: string; description?: string };

export class AscChannel implements Channel {
  readonly id = "asc";
  readonly label = "App Store Connect";
  readonly capabilities: ChannelCapabilities = {
    stage: true,
    submit: true,
    scheduled: true,
    status: true,
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
        "stage=iTMSTransporter（或 altool 兜底）上传构建（TestFlight，约 10 分钟完成处理）；submit=ASC API 提审（含预检），默认手动发布",
    };
  }

  /** 凭据三元组（Key ID / Issuer ID / p8 路径，缺任一抛错） */
  private resolveAuth(ctx: Pick<ChannelContext, "credentials" | "target">): {
    keyId: string;
    issuerId: string;
    p8Path: string;
  } {
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
   * 双引擎：iTMSTransporter（JWT 认证，官方推荐 API 用户）优先，未装 Transporter.app 时回退 altool。
   */
  async stage(ctx: ChannelContext): Promise<StageResult> {
    const auth = this.resolveAuth(ctx);
    const transporter = this.resolveTransporterPath(ctx);
    if (transporter) return this.stageWithTransporter(ctx, auth, transporter);
    return this.stageWithAltool(ctx, auth);
  }

  /**
   * iTMSTransporter 路径：凭据 ASC_TRANSPORTER_PATH 显式指定（支持 ~ 前缀，校验存在性），
   * 缺省探测 Transporter.app 默认安装路径；都不存在返回 undefined（回退 altool）。
   * public 便于测试注入（spyOn 覆写返回值）。
   */
  resolveTransporterPath(ctx: Pick<ChannelContext, "credentials">): string | undefined {
    const explicit = ctx.credentials["ASC_TRANSPORTER_PATH"];
    if (explicit) {
      const p = explicit.startsWith("~/")
        ? path.join(os.homedir(), explicit.slice(2))
        : path.resolve(explicit);
      if (!fs.existsSync(p))
        throw new Error(
          `ASC_TRANSPORTER_PATH 指向的 iTMSTransporter 不存在: ${p}` +
            "（iTMSTransporter 需从 Mac App Store 安装 Transporter.app，或清空该凭据回退 altool）",
        );
      return p;
    }
    const def = "/Applications/Transporter.app/Contents/itms/bin/iTMSTransporter";
    return fs.existsSync(def) ? def : undefined;
  }

  /**
   * 引擎一：iTMSTransporter + JWT 上传（-m upload -jwt -assetFile）。
   * - JWT 与 ASC REST API 同源（Apple 官方建议：Upload builds），20 分钟有效期覆盖典型上传时长；
   * - -assetFile 成功后 Apple 侧删除源文件、多字节文件名上传失败 → 复制到临时随机 ASCII 名
   *   再传（对齐 fastlane deliver 的防御做法），临时文件 finally 清理；
   * - 成败判定（fastlane itunes_transporter 语义）：exit 0 且 DBG-X: Returning 0（或无该行）为成功；
   *   Returning 非 0 或 exit 非 0 为失败，错误信息优先取 ERROR 行。
   */
  private async stageWithTransporter(
    ctx: ChannelContext,
    auth: { keyId: string; issuerId: string; p8Path: string },
    transporterPath: string,
  ): Promise<StageResult> {
    const jwt = makeAscJwt(auth);
    ctx.emit({
      type: "phase",
      phase: "upload",
      message: `iTMSTransporter 上传 ${path.basename(ctx.artifactPath)}（JWT 认证，约 5-15 分钟）`,
    });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-asc-itms-"));
    const tmpIpa = path.join(tmpDir, `${randomUUID()}.ipa`);
    fs.copyFileSync(ctx.artifactPath, tmpIpa);
    try {
      const r = spawnSync(
        transporterPath,
        ["-m", "upload", "-jwt", jwt, "-assetFile", tmpIpa, "-k", "100000"],
        { encoding: "utf8", timeout: 30 * 60 * 1000 },
      );
      if (r.error) {
        if ("code" in r.error && r.error.code === "ETIMEDOUT")
          throw new Error("iTMSTransporter 超时（30min）——检查网络/上传体积");
        throw new Error(
          `无法执行 iTMSTransporter: ${r.error.message}（需 macOS + Transporter.app）`,
        );
      }
      const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
      const ret = output.match(/DBG-X:\s*Returning\s+(\d+)/);
      if (r.status !== 0 || (ret !== null && ret[1] !== "0")) {
        const errLines = output
          .split(/\r?\n/)
          .filter((l) => /ERROR:/i.test(l))
          .slice(-5)
          .join("\n");
        throw new Error(
          `iTMSTransporter 上传失败（exit ${r.status ?? "?"}${ret !== null ? `，Returning ${ret[1]}` : ""}）: ` +
            (errLines || output.slice(-2000) || "无输出"),
        );
      }
      if (output) ctx.emit({ type: "progress", detail: output.slice(-2000) });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
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
   * 引擎二（兜底）：xcrun altool 上传。
   * 来源: v1 tools/publish/lib/asc.mjs 的 uploadIpaToAsc（逻辑不变；v1 经 run 继承 stdio 输出，
   * v2 输出统一走 ctx.emit，故改为捕获后透传，失败语义与 v1 run 一致）
   */
  private async stageWithAltool(
    ctx: ChannelContext,
    auth: { keyId: string; issuerId: string; p8Path: string },
  ): Promise<StageResult> {
    const { keyId, issuerId, p8Path } = auth;
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
        { cwd, encoding: "utf8", timeout: 30 * 60 * 1000 },
      );
      if (r.error) {
        // spawnSync timeout 到点回传 ETIMEDOUT 错误
        if ("code" in r.error && r.error.code === "ETIMEDOUT")
          throw new Error("xcrun altool 超时（30min）——检查网络/钥匙串/CI 无 TTY 弹窗");
        throw new Error(`无法执行 xcrun: ${r.error.message}（altool 需 macOS + Xcode）`);
      }
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
   * 文档: reviewSubmissions / Create a Review Submission / Submit a Review Submission
   *   https://developer.apple.com/documentation/appstoreconnectapi
   * 链路: 查 app（bundleId → 数字 id）→ 查最新已处理(VALID)构建 → 读取/创建 appStoreVersion
   *   （releaseType 默认 MANUAL，ctx.releaseTime 提供时 SCHEDULED + earliestReleaseDate）
   *   → 提审前预检（本地化描述）→ 绑定构建到版本 → reviewSubmissions 三步流提交进入审核
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

    // 3) 读取可编辑版本（appVersionState=PREPARE_FOR_SUBMISSION），无则按构建版本号创建；
    //    releaseType 默认 MANUAL（审核通过后手动上架），ctx.releaseTime 提供时 SCHEDULED 定时上架
    const releaseType = ctx.releaseTime ? "SCHEDULED" : "MANUAL";
    const releaseAttrs = ctx.releaseTime
      ? { releaseType, earliestReleaseDate: ctx.releaseTime }
      : { releaseType };
    const versions = await ascGet<AscListResponse<AscVersionAttrs>>(
      jwt,
      `/v1/apps/${app.id}/appStoreVersions?filter[platform]=IOS&filter[appVersionState]=PREPARE_FOR_SUBMISSION&limit=5`,
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

    // 3.5) 提审前预检：本地化描述是 Apple 提审硬性要求，缺失会在提交最后一步被拒（提前到提交前暴露）
    await this.preflightLocalizations(jwt, versionId, ctx);

    // 4) 把构建绑定到版本（builds 为 to-many 关系，data 传数组）
    await ascRequest(jwt, `/v1/appStoreVersions/${versionId}/relationships/builds`, "PATCH", {
      data: [{ type: "builds", id: build.id }],
    });

    // 5) 提交审核（reviewSubmissions 三步流；旧 appStoreVersionSubmissions 端点已废弃下线）
    //    a) 创建 reviewSubmission（关联 App）
    const reviewSubmission = await ascRequest<AscSingleResponse<Record<string, unknown>>>(
      jwt,
      "/v1/reviewSubmissions",
      "POST",
      {
        data: {
          type: "reviewSubmissions",
          attributes: {},
          relationships: { app: { data: { type: "apps", id: app.id } } },
        },
      },
    );
    const reviewSubmissionId = reviewSubmission.data?.id;
    if (!reviewSubmissionId) throw new Error("ASC 创建 reviewSubmission 未返回 id");
    //    b) 添加条目（关联 appStoreVersion）
    await ascRequest(jwt, `/v1/reviewSubmissions/${reviewSubmissionId}/items`, "POST", {
      data: {
        type: "reviewSubmissionItems",
        attributes: {},
        relationships: {
          appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
        },
      },
    });
    //    c) 确认提交（action=SUBMIT）
    await ascRequest(jwt, `/v1/reviewSubmissions/${reviewSubmissionId}`, "PATCH", {
      data: { type: "reviewSubmissions", attributes: { action: "SUBMIT" } },
    });
    ctx.emit({
      type: "phase",
      phase: "done",
      message: `已提交 App Store 审核（releaseType=${releaseType}，审核通过后${releaseType === "MANUAL" ? "手动" : "定时"}上架）`,
    });
    return { ok: true, ref: reviewSubmissionId };
  }

  /**
   * 查询审核状态：最新 appStoreVersion 的 appVersionState 映射到 ReviewStatus。
   * 枚举见 AppVersionState（15 值）：审核中/被拒/已批准未发布/已上架，未识别状态归 unknown。
   * 跳过 PREPARE_FOR_SUBMISSION / REPLACED_WITH_NEW_VERSION（非活跃提审记录）。
   */
  async status(ctx: Pick<ChannelContext, "credentials" | "target">): Promise<ReviewStatus> {
    const auth = this.resolveAuth(ctx);
    const bundleId = ctx.target["bundleId"] ?? ctx.target["bundleName"];
    if (!bundleId) throw new Error("ASC 渠道缺少 bundleId（项目配置 ios.bundleId）");
    const jwt = makeAscJwt(auth);

    const apps = await ascGet<AscListResponse<AscAppAttrs>>(
      jwt,
      `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=5`,
    );
    const app = apps.data.find((a) => a.attributes?.bundleId === bundleId) ?? apps.data[0];
    if (!app?.id) throw new Error(`ASC 未找到 bundleId=${bundleId} 对应的 App`);

    const versions = await ascGet<AscListResponse<AscVersionAttrs>>(
      jwt,
      `/v1/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=10`,
    );
    const active =
      versions.data.find(
        (v) =>
          v.attributes?.appVersionState !== "PREPARE_FOR_SUBMISSION" &&
          v.attributes?.appVersionState !== "REPLACED_WITH_NEW_VERSION",
      ) ?? versions.data[0];
    if (!active?.id) return { state: "unknown", raw: "ASC 无 IOS appStoreVersion 记录" };
    const state = active.attributes?.appVersionState ?? "UNKNOWN";
    const label = `${active.attributes?.versionString ?? "?"}（${state}）`;
    switch (state) {
      case "WAITING_FOR_REVIEW":
      case "IN_REVIEW":
      case "WAITING_FOR_EXPORT_COMPLIANCE":
      case "READY_FOR_REVIEW":
        return { state: "reviewing" };
      case "REJECTED":
      case "METADATA_REJECTED":
      case "DEVELOPER_REJECTED":
      case "INVALID_BINARY":
        return { state: "rejected", reason: label };
      case "ACCEPTED":
      case "PENDING_APPLE_RELEASE":
      case "PENDING_DEVELOPER_RELEASE":
      case "PROCESSING_FOR_DISTRIBUTION":
        return { state: "approved", live: false };
      case "READY_FOR_DISTRIBUTION":
        return { state: "approved", live: true };
      default:
        return { state: "unknown", raw: label };
    }
  }

  /**
   * 提审前预检（只读）：目标版本的全部本地化必须有商店描述（description）。
   * Apple 提审硬性要求；缺失时提前报错，避免 reviewSubmissions 最后一步被拒的返工。
   */
  private async preflightLocalizations(
    jwt: string,
    versionId: string,
    ctx: Pick<ChannelContext, "emit">,
  ): Promise<void> {
    const locs = await ascGet<AscListResponse<AscVersionLocAttrs>>(
      jwt,
      `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=50`,
    );
    if (locs.data.length === 0)
      throw new Error(
        "ASC 版本无任何本地化记录，无法提审——请在 ASC 后台补全商店元数据（描述/关键词/截图）后重试",
      );
    const missing = locs.data
      .filter((d) => !(d.attributes?.description ?? "").trim())
      .map((d) => d.attributes?.locale ?? d.id);
    if (missing.length > 0)
      throw new Error(
        `以下本地化缺少商店描述（description），无法提审: ${missing.join(", ")}——请在 ASC 后台或经 API 补全后重试`,
      );
    ctx.emit({
      type: "progress",
      detail: `提审预检通过：本地化 ${locs.data.map((d) => d.attributes?.locale ?? d.id).join(", ")} 描述齐备`,
    });
    ctx.emit({
      type: "progress",
      detail:
        "出口合规提示：Info.plist 声明 ITSAppUsesNonExemptEncryption（按实际加密用途取值）可免每次提审被问询",
    });
  }
}

function required(ctx: Pick<ChannelContext, "credentials" | "target">, key: string): string {
  const v = ctx.credentials[key] ?? ctx.target[key];
  if (!v) throw new Error(`ASC 渠道缺少 ${key}`);
  return v;
}

/** p8 路径：凭据 ASC_P8_PATH（支持 ~ 前缀）优先，否则 ~/.applift/private_keys/AuthKey_<KeyID>.p8 */
function resolveP8Path(ctx: Pick<ChannelContext, "credentials">, keyId: string): string {
  const explicit = ctx.credentials["ASC_P8_PATH"];
  if (explicit) {
    return explicit.startsWith("~/")
      ? path.join(os.homedir(), explicit.slice(2))
      : path.resolve(explicit);
  }
  return path.join(os.homedir(), ".applift", "private_keys", `AuthKey_${keyId}.p8`);
}
