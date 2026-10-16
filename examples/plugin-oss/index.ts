/**
 * 官方示例插件：自建 OSS 分发渠道（S3 兼容 / 阿里云 OSS / 公司 NAS 的通用样板）。
 *
 * 这是一个「最小但完整」的 Channel 实现，演示自定义分发平台的全部成员：
 * - 上传 = stage（PUT 到对象存储，无提审概念）
 * - 无审核流 = capabilities 全 false（submit 明确报不支持）
 * - 状态 = 永远 approved（静态文件无审核）
 *
 * 使用（applift.config.ts）：
 *   import { ossChannel } from './examples/plugin-oss/index.js';
 *   export default defineConfig({ plugins: [{ name: 'oss', 'channel:register'(r) { r.register(ossChannel({ endpoint: 'https://oss.example.com', bucket: 'releases', accessKeyId: '...', accessSecret: '...' })); } }] });
 *
 * 注意：示例用最简 HMAC 签名（阿里云 OSS Header 签名变体），生产自建存储按自己的鉴权改这里。
 */
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  Channel,
  ChannelCapabilities,
  ChannelContext,
  ReleasePlanEntry,
  ReviewStatus,
  StageResult,
  SubmitResult,
} from "../../core/src/channel.js";

export interface OssChannelOptions {
  endpoint: string; // https://oss.example.com
  bucket: string;
  accessKeyId: string;
  accessSecret: string;
  /** 对象前缀（如 apps/driver/），缺省根 */
  prefix?: string;
}

export function ossChannel(options: OssChannelOptions): Channel {
  return {
    id: "oss",
    label: "自建 OSS",
    capabilities: {
      stage: true,
      submit: false,
      scheduled: false,
      status: false,
    } satisfies ChannelCapabilities,

    async plan(ctx: ChannelContext): Promise<ReleasePlanEntry> {
      return {
        channel: "oss",
        platform: "android",
        artifactVersion: "",
        action: "stage-only",
        afterApproval: "none(beta)",
        notes: `上传到 ${options.bucket}/${options.prefix ?? ""}${path.basename(ctx.artifactPath)}`,
      };
    },

    async stage(ctx: ChannelContext): Promise<StageResult> {
      const fileName = path.basename(ctx.artifactPath);
      const objectKey = `${options.prefix ?? ""}${fileName}`;
      const url = `${options.endpoint}/${options.bucket}/${objectKey}`;
      // 阿里云 OSS 简化 Header 签名（示例级；生产换成你的存储鉴权）
      const date = new Date().toUTCString();
      const signature = createHmac("sha1", options.accessSecret)
        .update(`PUT\n\napplication/octet-stream\n${date}\n/${options.bucket}/${objectKey}`)
        .digest("base64");
      ctx.emit({ type: "phase", phase: "upload", message: `PUT ${objectKey}` });
      const res = await fetch(url, {
        method: "PUT",
        headers: {
          Date: date,
          "Content-Type": "application/octet-stream",
          Authorization: `OSS ${options.accessKeyId}:${signature}`,
        },
        body: fs.readFileSync(ctx.artifactPath),
        signal: AbortSignal.timeout(900_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { ok: false, error: `OSS 上传失败 HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      ctx.emit({ type: "phase", phase: "done", message: url });
      return { ok: true, ref: objectKey };
    },

    async submit(): Promise<SubmitResult> {
      return { ok: false, error: "OSS 为静态分发，无提审概念" };
    },

    async status(): Promise<ReviewStatus> {
      return { state: "approved", live: true };
    },
  };
}
