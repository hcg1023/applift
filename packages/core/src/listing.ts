/**
 * 商店 listing（应用信息）模型：简介/描述/图标/截图 + 按渠道覆盖。
 * 渠道通过可选 updateListing 方法消费合并后的 ListingInput；未实现的渠道在 CLI 层提示。
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig as c12Load } from "c12";
import type { ChannelContext } from "./channel.js";

/** listing 输入（基础值 + 按渠道覆盖） */
export interface ListingInput {
  /** 应用简介（一句话，商店列表页展示） */
  brief?: string;
  /** 应用描述（长文案，详情页） */
  description?: string;
  /** 图标文件绝对/相对路径 */
  iconPath?: string;
  /** 截图文件路径列表 */
  screenshots?: string[];
  /** 渠道级覆盖：键=渠道 id，值为该渠道生效的字段覆盖 */
  stores?: Record<string, Partial<Omit<ListingInput, "stores">>>;
}

/** listing 更新结果（单渠道） */
export interface ListingResult {
  ok: boolean;
  store: string;
  /** 已写入渠道的字段名 */
  updated: string[];
  /** 输入存在但渠道跳过（不支持/未验证）的字段名 */
  skipped: string[];
  error?: string;
}

/** 渠道可选能力：更新商店应用信息（listing） */
export interface ListingCapableChannel {
  /** 更新商店 listing；实现方自报 updated/skipped 字段 */
  updateListing(
    ctx: Pick<ChannelContext, "credentials" | "target" | "emit">,
    listing: ListingInput,
  ): Promise<ListingResult>;
}

/** 合并基础值与渠道覆盖（覆盖优先，仅取显式传入的键） */
export function resolveListing(listing: ListingInput, store: string): ListingInput {
  const override = listing.stores?.[store] ?? {};
  return {
    ...(listing.brief !== undefined || override.brief !== undefined
      ? { brief: override.brief ?? listing.brief }
      : {}),
    ...(listing.description !== undefined || override.description !== undefined
      ? { description: override.description ?? listing.description }
      : {}),
    ...(listing.iconPath !== undefined || override.iconPath !== undefined
      ? { iconPath: override.iconPath ?? listing.iconPath }
      : {}),
    ...(listing.screenshots !== undefined || override.screenshots !== undefined
      ? { screenshots: override.screenshots ?? listing.screenshots }
      : {}),
  };
}

/**
 * 装载 listing 配置文件（TS：`export default { brief, description, stores: {...} }`）。
 * 相对路径基于文件所在目录解析为绝对路径（iconPath/screenshots）。
 */
export async function loadListingFile(filePath: string): Promise<ListingInput> {
  const abs = path.resolve(filePath);
  const dir = path.dirname(abs);
  const result = await c12Load<ListingInput>({
    name: "listing",
    cwd: dir,
    configFile: abs,
    rcFile: false,
    packageJson: false,
  });
  const listing = result.config;
  if (!listing || typeof listing !== "object" || Array.isArray(listing)) {
    throw new Error(
      `listing 配置 ${abs} 缺少默认导出对象（export default { brief, description, ... }）`,
    );
  }
  return {
    ...listing,
    iconPath: listing.iconPath ? path.resolve(dir, listing.iconPath) : undefined,
    screenshots: listing.screenshots?.map((s) => path.resolve(dir, s)),
  };
}

/** 校验 listing 引用的本地文件存在（icon/截图）；dry-run 也校验，避免发到一半才失败 */
export function assertListingFiles(listing: ListingInput): void {
  for (const f of [listing.iconPath, ...(listing.screenshots ?? [])]) {
    if (f && !fs.existsSync(f)) throw new Error(`listing 引用的文件不存在: ${f}`);
  }
}
