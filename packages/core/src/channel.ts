/**
 * 渠道适配器统一接口 —— applift 可扩展性的核心。
 *
 * 每个渠道（六商店/AGC/ASC/蒲公英…）实现本接口并注册到 registry；
 * 编排引擎（pipeline）只面对本接口，不感知任何渠道细节。
 *
 * 两段式安全模型：
 *   stage  = 只把包送到渠道草稿区，不动线上（iOS 上传构建≈只进 TestFlight）
 *   submit = 提审；除 iOS（默认 manual 发布）外，审核通过即自动上架 —— 不可逆，需计划确认
 */
import type { Platform } from "./framework.js";

/** 渠道能力声明（编排与确认界面据此渲染/拦截） */
export interface ChannelCapabilities {
  /** 支持只传包不提审（小米 push 一体 → false，submit 即上传） */
  stage: boolean;
  /** 支持提审 */
  submit: boolean;
  /** 支持定时上架（releaseTime 透传） */
  scheduled: boolean;
  /** 支持查询审核状态 */
  status: boolean;
}

/** 一次发布动作针对单个渠道的上下文（凭据/目标应用/工件/文案） */
export interface ChannelContext {
  /** 凭据（已按 profile 解析，脱敏由 logger 层负责） */
  credentials: Readonly<Record<string, string>>;
  /** 渠道侧应用标识（appId / bundleName / pkgName，由项目配置映射） */
  target: Readonly<Record<string, string>>;
  /** 构建产物绝对路径（apk/hap/app/ipa） */
  artifactPath: string;
  /** 用户可见更新文案 */
  updateDescription?: string;
  /** 提审备注（给审核员） */
  remark?: string;
  /** 安装密码（蒲公英密码安装等，可选） */
  installPassword?: string;
  /** 定时上架时间（RFC3339），仅 capabilities.scheduled 渠道生效 */
  releaseTime?: string;
  /** 事件发射（进度/日志，唯一输出通道，不直接 console） */
  emit: (event: ChannelEvent) => void;
}

export type ChannelEvent =
  | {
      type: "phase";
      phase: "auth" | "upload" | "bind" | "wait" | "submit" | "done";
      message?: string;
    }
  | { type: "progress"; detail: string }
  | { type: "warn"; message: string };

/** 发布计划条目：干跑/确认界面渲染的数据（无副作用产出） */
export interface ReleasePlanEntry {
  channel: string;
  platform: Platform;
  /** 渠道侧当前线上版本（尽力而为，查不到为空） */
  onlineVersion?: string;
  /** 本地包版本（读自工件） */
  artifactVersion: string;
  /** 本渠道将执行的动作 */
  action: "stage-only" | "stage+submit" | "submit-only";
  /** 审核通过后的行为（用于确认界面警示） */
  afterApproval: "auto-publish" | "manual" | "scheduled" | "none(beta)";
  notes?: string;
}

export interface StageResult {
  ok: boolean;
  /** 渠道侧包标识（objectId/serialnumber/buildNumber…），submit 阶段复用 */
  ref?: string;
  error?: string;
}

export interface SubmitResult {
  ok: boolean;
  /** 提审单标识（releaseId/审核单号） */
  ref?: string;
  error?: string;
}

export type ReviewStatus =
  | { state: "reviewing" }
  | { state: "approved"; live: boolean }
  | { state: "rejected"; reason?: string }
  | { state: "unknown"; raw?: string };

export interface Channel {
  id: string;
  label: string;
  capabilities: ChannelCapabilities;
  /** 平台错误码 → 人话提示（平台内聚：与本渠道实现放一起，humanize 层消费） */
  errorHints?: Record<string, string>;
  /** 生成计划条目（只读，允许调渠道查询接口获取线上版本） */
  plan(ctx: ChannelContext): Promise<ReleasePlanEntry>;
  /** 传包到草稿（capabilities.stage=false 的渠道返回明确错误） */
  stage(ctx: ChannelContext): Promise<StageResult>;
  /**
   * 提审（=审核通过自动上架，L3 不可逆操作）。
   * stagedRef = 同渠道 stage 成功返回的 ref（如 googleplay 的 `editId:versionCode`），
   * 供实现复用 stage 已上传的草稿、避免重复上传；实现方可忽略。
   */
  submit(ctx: ChannelContext, stagedRef?: string): Promise<SubmitResult>;
  /** 查询审核状态（capabilities.status=false 时抛 NotSupported） */
  status(ctx: Pick<ChannelContext, "credentials" | "target">): Promise<ReviewStatus>;
}

/** 渠道注册表：新渠道 = 实现接口 + 注册，主流程零改动 */
export interface ChannelRegistry {
  register(channel: Channel): void;
  get(id: string): Channel | undefined;
  all(): Channel[];
}
