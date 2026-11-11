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
 * - submit: ASC REST API 提审（含提审前预检：本地化描述完备性），按 ASC 官方文档实现，未经真实链路验证；
 *   releaseType 三档（2026-11-11）：releaseTime→SCHEDULED 定时 / releaseMode=manual→MANUAL /
 *   默认 AFTER_APPROVAL 审核通过自动上架（官方确认首版亦可自动，唯一强制手动场景=预购且从未上架）
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
import type { ArtifactVersion } from "../version/artifact.js";
import { readArtifactVersion } from "../version/artifact.js";
import { pollUntil, PollTimeoutError } from "./shared/poll.js";
import { AscClient, makeAscJwt } from "./shared/asc-jwt.js";

/** ASC 构建处理轮询：30s 间隔，30 分钟上限（fastlane BuildWatcher 同款量级） */
const BUILD_POLL_MS = 30_000;
const BUILD_TIMEOUT_MS = 30 * 60_000;

/** 可编辑版本状态全集（fastlane get_edit_app_store_version 同款；含被拒四态——被拒后重跑续用不再撞同号建重复版本） */
const EDITABLE_STATES = [
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
] as const;
const REJECTED_STATES = new Set(["DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED"]);
/** reviewSubmission 终态（枚举真实链路首用核对，spec 风险节） */
const SUBMISSION_TERMINAL_STATES = new Set(["COMPLETED", "CANCELLED"]);
/** ASC JSON:API 资源文档（data/included 元素的最小字段） */
interface AscDoc<A = Record<string, unknown>> {
  id?: string;
  type?: string;
  attributes?: A;
  /** JSON:API 关系链接（builds → preReleaseVersion；reviewSubmissionItems → appStoreVersion） */
  relationships?: {
    preReleaseVersion?: { data?: { id?: string; type?: string } };
    appStoreVersion?: { data?: { id?: string; type?: string } };
  };
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
/** builds 资源属性（processingState: PROCESSING / INVALID / FAILED / VALID；usesNonExemptEncryption null=未声明） */
type AscBuildAttrs = {
  version?: string;
  uploadedDate?: string;
  processingState?: string;
  usesNonExemptEncryption?: boolean | null;
};
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
      // 上架方式：releaseTime → SCHEDULED 定时；releaseMode=manual → MANUAL 手动；默认 AFTER_APPROVAL 自动
      // （2026-11-11 定稿默认自动：官方确认首版亦可自动发布，仅"预购且从未上架"场景被官方强制手动）
      afterApproval: ctx.releaseTime
        ? "scheduled"
        : ctx.releaseMode === "manual"
          ? "manual"
          : "auto-publish",
      notes:
        "stage=iTMSTransporter（或 altool 兜底）上传构建（TestFlight，约 10 分钟完成处理）；submit=ASC API 提审（含预检），默认审核通过自动上架（--release-mode manual 改手动）",
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

    // build 号预检（§9）：ios build 号全 app 唯一，占用则上传必失败——提前拦截省 5-15 分钟
    const av = ctx.artifactPath ? readArtifactVersion(ctx.artifactPath) : undefined;
    if (av?.versionCode) {
      const asc = new AscClient(auth);
      const appId = await this.resolveAppId(asc, ctx);
      const dup = await asc.get<AscListResponse<AscBuildAttrs>>(
        `/v1/builds?filter[app]=${appId}&filter[version]=${encodeURIComponent(av.versionCode)}&limit=1`,
      );
      if (dup.data.length > 0)
        throw new Error(
          `build 号已被占用（版本 ${av.versionName ?? "?"} 构建号 ${av.versionCode} 已在 App Store Connect）` +
            "——升 versionCode 重新出包后重试（versionCode 以工程文件为准）",
        );
    }

    const transporter = this.resolveTransporterPath(ctx);
    if (transporter) return this.stageWithTransporter(ctx, auth, transporter);
    return this.stageWithAltool(ctx, auth);
  }

  /** 按 bundleId 定位 App（ASC 内部数字 id）；submit / stage 预检共用 */
  private async resolveAppId(
    asc: AscClient,
    ctx: Pick<ChannelContext, "credentials" | "target">,
  ): Promise<string> {
    const bundleId = ctx.target["bundleId"] ?? ctx.target["bundleName"];
    if (!bundleId) throw new Error("ASC 渠道缺少 bundleId（项目配置 ios.bundleId）");
    const apps = await asc.get<AscListResponse<AscAppAttrs>>(
      `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=5`,
    );
    const app = apps.data.find((a) => a.attributes?.bundleId === bundleId) ?? apps.data[0];
    if (!app?.id) throw new Error(`ASC 未找到 bundleId=${bundleId} 对应的 App`);
    return app.id;
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
   * 链路: 查 app（bundleId → 数字 id）→ 等构建处理完成（有界轮询，产物可读时锚定防绑错包）→ 读取/创建 appStoreVersion
   *   （releaseType 默认 AFTER_APPROVAL 自动上架，releaseMode=manual 时 MANUAL，releaseTime 时 SCHEDULED + earliestReleaseDate）
   *   → 提审前预检（本地化描述）→ 绑定构建到版本 → reviewSubmissions 三步流提交进入审核
   */
  async submit(ctx: ChannelContext): Promise<SubmitResult> {
    const { keyId, issuerId, p8Path } = this.resolveAuth(ctx);
    const asc = new AscClient({ keyId, issuerId, p8Path });
    ctx.emit({
      type: "phase",
      phase: "auth",
      message: "ASC 客户端就绪（JWT 惰性续签，20 分钟有效）",
    });

    // 1) 按 bundleId 定位 App（ASC 内部数字 id）
    const appId = await this.resolveAppId(asc, ctx);

    // 2) 等本次构建处理完成（PROCESSING→VALID；产物可读时按 versionName/versionCode 锚定防绑错包）
    const av = ctx.artifactPath ? readArtifactVersion(ctx.artifactPath) : undefined;
    const build = await this.awaitValidBuild(asc, appId, av, ctx);

    // 3) 读取/创建可编辑版本（五态；同号复用 / 异号改名 / 被拒异号报错）；
    //    releaseType：releaseTime → SCHEDULED 定时；releaseMode=manual → MANUAL；
    //    默认 AFTER_APPROVAL 自动上架（配置 ios.release / 旗标 --release-mode 已由 CLI 层解析进 ctx.releaseMode）
    const releaseType = ctx.releaseTime
      ? "SCHEDULED"
      : ctx.releaseMode === "manual"
        ? "MANUAL"
        : "AFTER_APPROVAL";
    const releaseAttrs: Record<string, string> = ctx.releaseTime
      ? { releaseType, earliestReleaseDate: ctx.releaseTime }
      : { releaseType };
    const warns: string[] = [];
    const versionId = await this.resolveEditableVersion(
      asc,
      appId,
      build.versionString,
      releaseAttrs,
      ctx,
      warns,
    );

    // 3.5) 提审前预检（规则化，§8）：error 抛出阻断 / warn 仅提示
    await this.preflight(asc, versionId, ctx, warns);

    // 4) 把构建绑定到版本（builds 为 to-many 关系，data 传数组）
    await asc.request(`/v1/appStoreVersions/${versionId}/relationships/builds`, "PATCH", {
      data: [{ type: "builds", id: build.buildId }],
    });

    // 4.5) 出口合规代答（§6）：build 未声明（null）才写——幂等判据（fastlane 同款）；
    //      Info.plist 已声明（ITSAppUsesNonExemptEncryption）的 build 此处为非 null，自动跳过
    if (build.attrs.usesNonExemptEncryption == null) {
      if (ctx.exportCompliance) {
        await asc.request(`/v1/builds/${build.buildId}`, "PATCH", {
          data: {
            type: "builds",
            id: build.buildId,
            attributes: { usesNonExemptEncryption: ctx.exportCompliance.usesNonExemptEncryption },
          },
        });
        ctx.emit({
          type: "progress",
          detail: `已代答出口合规（usesNonExemptEncryption=${ctx.exportCompliance.usesNonExemptEncryption}）`,
        });
      } else {
        ctx.emit({
          type: "progress",
          detail:
            "出口合规提示：Info.plist 声明 ITSAppUsesNonExemptEncryption（按实际加密用途取值）可免每次提审被问询",
        });
      }
    }

    // 4.7) phased release（§7，7 天 1%→100% 自动更新灰度）。官方限制：仅后续版本可用
    //      （"not available for the first version of an app"）——版本记录数 ≤1 判首版，warn 跳过
    if (ctx.phasedRelease) {
      const all = await asc.get<AscListResponse<AscVersionAttrs>>(
        `/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=2`,
      );
      if (all.data.length > 1) {
        await asc.request("/v1/appStoreVersionPhasedReleases", "POST", {
          data: {
            type: "appStoreVersionPhasedReleases",
            relationships: {
              appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
            },
          },
        });
        ctx.emit({ type: "progress", detail: "已开启分阶段发布（7 天 1%→100%，仅自动更新用户）" });
      } else {
        ctx.emit({
          type: "warn",
          message:
            "phased release 已配置但本 app 尚无在架版本（官方：首版不可用）——本次跳过，下一版本自动生效",
        });
      }
    }

    // 5) 提审三查（§3）：已在审拒绝 / 草稿复用 / 他人条目拒绝，然后三步流
    const subs = await asc.get<AscListResponse<{ state?: string }>>(
      `/v1/reviewSubmissions?filter[app]=${appId}&include=items&limit=10`,
    );
    const items = subs.included?.filter((d) => d.type === "reviewSubmissionItems") ?? [];
    const active = subs.data.find(
      (s) => !SUBMISSION_TERMINAL_STATES.has(s.attributes?.state ?? ""),
    );
    let reviewSubmissionId: string;
    if (active?.id && active.attributes?.state !== undefined) {
      const mine = items.find(
        (it) => it.relationships?.appStoreVersion?.data?.id === versionId, // AscDoc 的 relationships 类型按需扩 appStoreVersion
      );
      if (mine && active.attributes.state !== "READY")
        throw new Error(
          `版本已在审核流程中（submission state=${active.attributes.state}），勿重复提交——改文案先在 ASC 控制台撤回`,
        );
      if (!mine && items.some((it) => it.relationships?.appStoreVersion))
        throw new Error(
          "存在进行中的提审且含其他条目——到 ASC 网页（App Review → 草稿）人工处置后再试",
        );
      reviewSubmissionId = active.id; // 草稿复用（state=READY 且无冲突条目）
      ctx.emit({ type: "progress", detail: `复用未提交的提审草稿 ${reviewSubmissionId}` });
    } else {
      const created = await asc.request<AscSingleResponse<Record<string, unknown>>>(
        "/v1/reviewSubmissions",
        "POST",
        {
          data: {
            type: "reviewSubmissions",
            attributes: {},
            relationships: { app: { data: { type: "apps", id: appId } } },
          },
        },
      );
      reviewSubmissionId = created.data?.id ?? "";
      if (!reviewSubmissionId) throw new Error("ASC 创建 reviewSubmission 未返回 id");
    }
    //    b) 添加条目（关联 appStoreVersion）
    await asc.request(`/v1/reviewSubmissions/${reviewSubmissionId}/items`, "POST", {
      data: {
        type: "reviewSubmissionItems",
        attributes: {},
        relationships: {
          appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
        },
      },
    });
    //    c) 确认提交（action=SUBMIT）
    await asc.request(`/v1/reviewSubmissions/${reviewSubmissionId}`, "PATCH", {
      data: { type: "reviewSubmissions", attributes: { action: "SUBMIT" } },
    });
    ctx.emit({
      type: "phase",
      phase: "done",
      message: `已提交 App Store 审核（releaseType=${releaseType}，审核通过后${releaseType === "MANUAL" ? "手动" : releaseType === "SCHEDULED" ? "定时" : "自动"}上架）`,
    });
    return { ok: true, ref: reviewSubmissionId };
  }

  /**
   * 等待本次构建处理完成（§2）。锚定优先：产物 versionName/versionCode 精确匹配
   * （preReleaseVersions?filter[version] → builds?filter[preReleaseVersion]&filter[version]），
   * 防"多 train 并存取最新绑错包"；锚定链路任一环节失角（查询失败/无记录）退回"最新 VALID"（现状兼容）。
   * X.Y ≡ X.Y.0（ASC 只按先传格式可查，fastlane #22248）：双格式查询去重。
   */
  private async awaitValidBuild(
    asc: AscClient,
    appId: string,
    av: ArtifactVersion | undefined,
    ctx: Pick<ChannelContext, "emit">,
  ): Promise<{ buildId: string; versionString: string; attrs: AscBuildAttrs }> {
    ctx.emit({
      type: "phase",
      phase: "wait",
      message: "等待 App Store Connect 构建处理完成（约 10 分钟）",
    });
    const trainIds = av?.versionName ? await this.resolveTrainIds(asc, appId, av.versionName) : [];
    const anchored = trainIds.length > 0 && !!av?.versionCode;
    try {
      return await pollUntil<{ buildId: string; versionString: string; attrs: AscBuildAttrs }>({
        label: "ASC 构建处理",
        intervalMs: BUILD_POLL_MS,
        timeoutMs: BUILD_TIMEOUT_MS,
        onWait: ({ attempt, elapsedMs }) =>
          ctx.emit({
            type: "progress",
            detail: `构建处理中（已等 ${Math.round(elapsedMs / 60000)} 分钟，第 ${attempt} 次探测，${BUILD_POLL_MS / 1000}s 后重查）`,
          }),
        attempt: async () => {
          const qs = anchored
            ? `filter[app]=${appId}&filter[preReleaseVersion]=${trainIds.join(",")}&filter[version]=${encodeURIComponent(av!.versionCode!)}`
            : `filter[app]=${appId}&sort=-uploadedDate&limit=20`;
          const builds = await asc.get<AscListResponse<AscBuildAttrs>>(
            `/v1/builds?${qs}&include=preReleaseVersion`,
          );
          const valid = builds.data.find((b) => b.attributes?.processingState === "VALID");
          if (valid?.id) {
            // versionString 恒按 build 的 preReleaseVersion 关系推导（现状逻辑，防 included[0] 误取）
            const preId = valid.relationships?.preReleaseVersion?.data?.id;
            const pre = builds.included?.find(
              (d) => d.type === "preReleaseVersions" && d.id === preId,
            );
            const versionString = (pre?.attributes as AscPreReleaseAttrs | undefined)?.version;
            if (!versionString)
              throw new Error(
                "ASC 构建缺少 preReleaseVersion 版本号，无法定位/创建 App Store 版本",
              );
            ctx.emit({
              type: "progress",
              detail: `构建处理完成 build ${valid.attributes?.version ?? ""}（版本 ${versionString}）`,
            });
            return {
              done: true as const,
              value: { buildId: valid.id, versionString, attrs: valid.attributes ?? {} },
            };
          }
          const bad = builds.data.find(
            (b) =>
              b.attributes?.processingState === "INVALID" ||
              b.attributes?.processingState === "FAILED",
          );
          if (bad && anchored)
            throw new Error(
              `构建处理失败（${bad.attributes?.processingState}，versionCode=${av!.versionCode}）——到 App Store Connect 网页查看原因（常见：签名/缺 entitlement/缺 Info.plist 键）`,
            );
          return { done: false as const };
        },
      });
    } catch (e) {
      if (e instanceof PollTimeoutError)
        throw new Error(
          "构建处理超时（30 分钟）——构建完成后用 applift release ios --submit --skip-stage 重跑提审（提审幂等，重跑安全）",
        );
      throw e;
    }
  }

  /**
   * 定位/创建本次提审的 appStoreVersion（§4）：
   * - editable 五态按 versionString 取最大者（semver 分段数值比较）
   * - 同号 → PATCH releaseAttrs（现状）；PREPARE/INVALID_BINARY 异号 → PATCH versionString 改名续用；
   *   被拒态异号 → 报错（被拒记录连着审核沟通历史，不自动改名——比 fastlane 保守，控制台人工处置）
   * - 无 editable → POST 创建（现状）
   */
  private async resolveEditableVersion(
    asc: AscClient,
    appId: string,
    versionString: string,
    releaseAttrs: Record<string, string>,
    ctx: Pick<ChannelContext, "emit">,
    warns: string[], // 预检 warn 事实收集（被拒续用等）
  ): Promise<string> {
    const versions = await asc.get<AscListResponse<AscVersionAttrs>>(
      `/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&filter[appVersionState]=${EDITABLE_STATES.join(",")}&limit=10`,
    );
    const picked = versions.data
      .filter((v) => v.id)
      .sort((a, b) =>
        cmpVersion(b.attributes?.versionString ?? "", a.attributes?.versionString ?? ""),
      )[0];
    if (!picked?.id) {
      const created = await asc.request<AscSingleResponse<AscVersionAttrs>>(
        "/v1/appStoreVersions",
        "POST",
        {
          data: {
            type: "appStoreVersions",
            attributes: { platform: "IOS", versionString, ...releaseAttrs },
            relationships: { app: { data: { type: "apps", id: appId } } },
          },
        },
      );
      if (!created.data?.id)
        throw new Error(`ASC 创建 appStoreVersion（${versionString}）未返回 id`);
      ctx.emit({ type: "phase", phase: "bind", message: `已创建版本 ${versionString}` });
      return created.data.id;
    }
    const state = picked.attributes?.appVersionState ?? "";
    const existing = picked.attributes?.versionString ?? "";
    if (existing === versionString) {
      if (REJECTED_STATES.has(state)) warns.push("rejected-reuse");
      await asc.request(`/v1/appStoreVersions/${picked.id}`, "PATCH", {
        data: { type: "appStoreVersions", id: picked.id, attributes: releaseAttrs },
      });
      ctx.emit({ type: "phase", phase: "bind", message: `复用版本 ${existing}（state=${state}）` });
      return picked.id;
    }
    if (REJECTED_STATES.has(state))
      throw new Error(
        `ASC 存在被拒版本 ${existing}（${state}）与目标版本 ${versionString} 不同——被拒记录需人工在控制台处置（放弃该版本或改号续用）后再重跑`,
      );
    await asc.request(`/v1/appStoreVersions/${picked.id}`, "PATCH", {
      data: {
        type: "appStoreVersions",
        id: picked.id,
        attributes: { versionString, ...releaseAttrs },
      },
    });
    ctx.emit({
      type: "phase",
      phase: "bind",
      message: `续用版本记录并改名 ${existing} → ${versionString}（state=${state}）`,
    });
    return picked.id;
  }

  /** preReleaseVersions 双格式查询（X.Y / X.Y.0 + 前导零归一）；任何失败返回 []（走退回路径） */
  private async resolveTrainIds(
    asc: AscClient,
    appId: string,
    versionName: string,
  ): Promise<string[]> {
    const norm = versionName
      .split(".")
      .map((s) => String(Number(s)))
      .join(".");
    const alt = norm.endsWith(".0")
      ? norm.slice(0, norm.length - 2)
      : norm.split(".").length === 2
        ? `${norm}.0`
        : undefined;
    const ids = new Set<string>();
    for (const v of [norm, alt]) {
      if (!v) continue;
      try {
        const r = await asc.get<AscListResponse<AscPreReleaseAttrs>>(
          `/v1/preReleaseVersions?filter[app]=${appId}&filter[version]=${encodeURIComponent(v)}&limit=5`,
        );
        for (const d of r.data) if (d.id) ids.add(d.id);
      } catch {
        return []; // 锚定是优化不是依赖：失败退回"最新 VALID"
      }
    }
    return [...ids];
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
    const asc = new AscClient(auth);

    const apps = await asc.get<AscListResponse<AscAppAttrs>>(
      `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=5`,
    );
    const app = apps.data.find((a) => a.attributes?.bundleId === bundleId) ?? apps.data[0];
    if (!app?.id) throw new Error(`ASC 未找到 bundleId=${bundleId} 对应的 App`);

    const versions = await asc.get<AscListResponse<AscVersionAttrs>>(
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
   * 提审前预检规则（§8）：error 抛出阻断，warn 仅提示。规则接口可移植（不提升 core）。
   */
  private async preflight(
    asc: AscClient,
    versionId: string,
    ctx: Pick<ChannelContext, "emit">,
    warns: string[], // 上游（resolveEditableVersion 等）收集的 warn 事实
  ): Promise<void> {
    const rules: Array<{
      key: string;
      level: "warn" | "error";
      check: () => Promise<string | null>;
    }> = [
      {
        key: "localizations-description",
        level: "error",
        check: async () => {
          const locs = await asc.get<AscListResponse<AscVersionLocAttrs>>(
            `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=50`,
          );
          if (locs.data.length === 0)
            return "ASC 版本无任何本地化记录，无法提审——请在 ASC 后台补全商店元数据（描述/关键词/截图）后重试";
          const missing = locs.data
            .filter((d) => !(d.attributes?.description ?? "").trim())
            .map((d) => d.attributes?.locale ?? d.id);
          if (missing.length > 0)
            return `以下本地化缺少商店描述（description），无法提审: ${missing.join(", ")}——请在 ASC 后台或经 API 补全后重试`;
          ctx.emit({
            type: "progress",
            detail: `提审预检通过：本地化 ${locs.data.map((d) => d.attributes?.locale ?? d.id).join(", ")} 描述齐备`,
          });
          return null;
        },
      },
      {
        key: "rejected-version-reuse",
        level: "warn",
        check: async () =>
          warns.includes("rejected-reuse") ? "续用被拒版本记录：请确认拒审原因已解决" : null,
      },
    ];
    for (const r of rules) {
      const msg = await r.check();
      if (!msg) continue;
      if (r.level === "error") throw new Error(msg);
      ctx.emit({ type: "warn", message: msg });
    }
    ctx.emit({ type: "progress", detail: "提审预检通过" });
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

/** semver 风格分段数值比较（"4.0.1000" > "4.0.999"） */
function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
