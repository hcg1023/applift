/**
 * listing 命令：更新商店应用信息（简介/描述/图标/截图，按渠道覆盖）。
 * --dry-run 只打印合并后的 per-store 生效字段；--json 结构化输出（AI agent 友好）。
 */
import * as p from "@clack/prompts";
import pc from "picocolors";
import type { Command } from "commander";
import {
  loadCredentialsLayered,
  loadProjectConfig,
  resolveProfile,
  resolveListing,
  resolveProfileFor,
  loadListingFile,
  assertListingFiles,
  redactText,
  type ChannelRegistry,
  type ListingCapableChannel,
  type ListingInput,
  type ListingResult,
} from "@applift/core";
import { KNOWN_CREDENTIAL_KEYS } from "./channel-meta.js";

interface ListingOpts {
  stores?: string;
  file?: string;
  brief?: string;
  description?: string;
  cwd?: string;
  json?: boolean;
  dryRun?: boolean;
}

export function registerListingCommand(
  program: Command,
  registryRef: { setup: () => void; registry: ChannelRegistry },
): void {
  program
    .command("listing")
    .description("更新商店应用信息（--dry-run 预览，--json 结构化输出）")
    .requiredOption("--stores <list>", "渠道列表（逗号分隔），如 huawei")
    .option(
      "--file <path>",
      "listing 配置文件（TS：export default { brief, description, stores }）",
    )
    .option("--brief <text>", "应用简介（直传，覆盖 --file 中的值）")
    .option("--description <text>", "应用描述（直传，覆盖 --file 中的值）")
    .option("--cwd <dir>", "项目目录", process.cwd())
    .option("--json", "JSON 输出")
    .option("--dry-run", "只预览各渠道生效字段，不调用接口")
    .action(async (opts: ListingOpts) => {
      registryRef.setup();
      if (!opts.file && opts.brief === undefined && opts.description === undefined) {
        throw new Error("未提供 listing 内容（--file 或 --brief/--description）");
      }
      let listing: ListingInput = {};
      if (opts.file) listing = await loadListingFile(opts.file);
      // 直传参数优先于配置文件
      if (opts.brief !== undefined) listing.brief = opts.brief;
      if (opts.description !== undefined) listing.description = opts.description;
      assertListingFiles(listing);

      const storeIds = (opts.stores ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (storeIds.length === 0) throw new Error("未指定渠道（--stores huawei[,xiaomi]）");

      const cwd = opts.cwd ?? process.cwd();
      const { config } = await loadProjectConfig(cwd);
      // 与 release/doctor 同链：项目级 .applift/credentials.json + profile 解析链（use 个人选择 > 项目默认）
      const creds = loadCredentialsLayered(cwd);
      const profile = resolveProfile(
        creds,
        resolveProfileFor(cwd, config.profile),
        KNOWN_CREDENTIAL_KEYS,
      );

      if (opts.dryRun) {
        const preview = storeIds.map((id) => ({ store: id, ...resolveListing(listing, id) }));
        if (opts.json) {
          console.log(JSON.stringify({ dryRun: true, stores: preview }));
        } else {
          p.intro(pc.bgBlue(pc.black(" applift listing (dry-run) ")));
          for (const item of preview) {
            const fields = {
              brief: item.brief,
              description: item.description,
              iconPath: item.iconPath,
              screenshots: item.screenshots,
            };
            p.log.message(`  ${pc.bold(item.store)} ${pc.dim(JSON.stringify(fields))}`);
          }
          p.outro("预览完成（未调用任何接口）");
        }
        return;
      }

      const results: Array<ListingResult & { label?: string }> = [];
      if (!opts.json) p.intro(pc.bgBlue(pc.black(" applift listing ")));
      for (const id of storeIds) {
        const channel = registryRef.registry.get(id);
        if (!channel) {
          results.push({ ok: false, store: id, updated: [], skipped: [], error: "未知渠道" });
          if (!opts.json) p.log.error(`${id}: 未知渠道`);
          continue;
        }
        const listingChannel = channel as Partial<ListingCapableChannel>;
        if (typeof listingChannel.updateListing !== "function") {
          results.push({
            ok: false,
            store: id,
            updated: [],
            skipped: [],
            error: "该渠道暂不支持 listing 更新",
          });
          if (!opts.json)
            p.log.message(
              `  ${pc.yellow("◌")} ${pc.bold(channel.label)} ${pc.dim("listing 更新暂未接入")}`,
            );
          continue;
        }
        try {
          const res = await listingChannel.updateListing(
            {
              credentials: profile,
              target: config.android?.stores?.[id] ?? {},
              emit: (e) => {
                if (!opts.json && e.type === "warn") p.log.warn(redactText(e.message));
              },
            },
            listing,
          );
          results.push({ ...res, label: channel.label });
          if (!opts.json) {
            const up = res.updated.length
              ? pc.green(`已更新: ${res.updated.join(", ")}`)
              : pc.dim("无可写字段");
            const skip = res.skipped.length ? pc.yellow(` 跳过: ${res.skipped.join(", ")}`) : "";
            p.log.message(`  ${pc.green("●")} ${pc.bold(channel.label)} ${up}${skip}`);
          }
        } catch (e) {
          // listing 更新抛错可能内嵌凭据/响应体：--json results 与人话提示共用同一脱敏值
          const msg = redactText((e as Error).message);
          results.push({
            ok: false,
            store: id,
            updated: [],
            skipped: [],
            error: msg,
            label: channel.label,
          });
          if (!opts.json) p.log.error(`${channel.label}: ${msg}`);
        }
      }
      // 任何渠道失败（未知渠道/不支持/接口异常）→ exit 1（CI 可判失败；JSON 形态仍完整输出）
      if (results.some((r) => !r.ok)) process.exitCode = 1;
      if (opts.json) console.log(JSON.stringify({ stores: results }));
      else p.outro("listing 更新完成");
    });
}
