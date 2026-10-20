/**
 * init 向导（PM 视角：发版小白一次配置完成）、use 个人 profile 切换与 status 审核跟踪。
 */
import * as p from "@clack/prompts";
import pc from "picocolors";
import fs from "node:fs";
import path from "node:path";
import {
  saveCredentials,
  loadProjectConfig,
  loadProjectProfileMap,
  resolveProfileFor,
  setProjectProfile,
  suggestFramework,
  detectBundleIds,
  readEntries,
  loadCredentialsLayered,
  resolveProfile,
  redactText,
} from "@applift/core";
import { resolveChannelTarget } from "./target.js";
import type { Command } from "commander";
import type { ChannelRegistry } from "@applift/core";
import { KNOWN_CREDENTIAL_KEYS } from "./channel-meta.js";

/** 各渠道在 init/status 场景需要的凭据键与获取指引（导出供与 CREDENTIAL_GROUPS 一致性测试对拍） */
export const CREDENTIAL_FIELDS: Array<{ key: string; label: string; where: string }> = [
  { key: "PGYER_API_KEY", label: "蒲公英（内测）", where: "pgyer.com → 账号设置 → API" },
  {
    key: "AGC_CLIENT_ID",
    label: "华为 AGC Client ID",
    where: "AGC → 项目设置 → 常规 → API Client",
  },
  { key: "AGC_CLIENT_SECRET", label: "华为 AGC Secret", where: "同上" },
  {
    key: "HW_CLIENT_ID",
    label: "华为 Client ID",
    where: "AGC → 项目设置 → 常规 → API Client（与 AGC_* 同源）",
  },
  { key: "HW_CLIENT_SECRET", label: "华为 Client Secret", where: "同上" },
  { key: "HW_ANDROID_APP_ID", label: "华为安卓 App ID", where: "AGC 我的应用（安卓）" },
  { key: "MI_USER_NAME", label: "小米账号", where: "dev.mi.com → 管理中心" },
  { key: "MI_PASSWORD", label: "小米上传密码", where: "同上" },
  { key: "MI_CERT_PATH", label: "小米证书路径", where: "dev.api.public.cer 绝对路径" },
  { key: "MI_APP_NAME", label: "小米应用名", where: "dev.mi.com → 管理中心 → 应用信息" },
  { key: "OPPO_CLIENT_ID", label: "OPPO Client ID", where: "open.oppomobile.com → API 传包" },
  { key: "OPPO_CLIENT_SECRET", label: "OPPO Secret", where: "同上" },
  { key: "VIVO_ACCESS_KEY", label: "vivo Access Key", where: "dev.vivo.com.cn → API 传包" },
  { key: "VIVO_ACCESS_SECRET", label: "vivo Secret", where: "同上" },
  { key: "HONOR_CLIENT_ID", label: "荣耀 Client ID", where: "developer.honor.com → 设置 → API" },
  { key: "HONOR_CLIENT_SECRET", label: "荣耀 Secret", where: "同上" },
  { key: "HONOR_APP_ID", label: "荣耀 App ID", where: "荣耀开发者后台" },
  { key: "YYB_USER_ID", label: "应用宝 UserID", where: "app.open.qq.com 管理中心" },
  { key: "YYB_ACCESS_SECRET", label: "应用宝 AccessSecret", where: "同上" },
  { key: "YYB_APP_ID", label: "应用宝 App ID", where: "同上" },
  { key: "ASC_KEY_ID", label: "ASC Key ID", where: "App Store Connect → 集成 → 团队密钥" },
  { key: "ASC_ISSUER_ID", label: "ASC Issuer ID", where: "同上" },
];

/** init 向导凭据组 → 键映射（导出供一致性测试：每组键 ⊆ CREDENTIAL_FIELDS，huawei 组覆盖渠道元数据 huawei+agc） */
export const CREDENTIAL_GROUPS: Record<string, string[]> = {
  beta: ["PGYER_API_KEY"],
  huawei: [
    "HW_CLIENT_ID",
    "HW_CLIENT_SECRET",
    "HW_ANDROID_APP_ID",
    "AGC_CLIENT_ID",
    "AGC_CLIENT_SECRET",
  ],
  xiaomi: ["MI_USER_NAME", "MI_PASSWORD", "MI_CERT_PATH", "MI_APP_NAME"],
  oppo: ["OPPO_CLIENT_ID", "OPPO_CLIENT_SECRET"],
  vivo: ["VIVO_ACCESS_KEY", "VIVO_ACCESS_SECRET"],
  honor: ["HONOR_CLIENT_ID", "HONOR_CLIENT_SECRET", "HONOR_APP_ID"],
  yyb: ["YYB_USER_ID", "YYB_ACCESS_SECRET", "YYB_APP_ID"],
  asc: ["ASC_KEY_ID", "ASC_ISSUER_ID"],
};

export function registerLifecycleCommands(
  program: Command,
  registryRef: { setup: () => void; registry: ChannelRegistry },
): void {
  program
    .command("init")
    .description("向导：检测项目 → 生成 applift.config.ts → 引导配置凭据")
    .option("--cwd <dir>", "项目目录", process.cwd())
    .action(async (cmdOpts: { cwd: string }) => {
      const cwd = path.resolve(cmdOpts.cwd);
      p.intro(pc.bgCyan(pc.black(" applift init ")));

      // 1) 框架探测
      const framework = suggestFramework(cwd);
      if (framework) p.log.success(`框架识别: ${pc.bold(framework.label)}`);
      else p.log.warn("未识别框架（可继续，产物路径用 --artifact 指定）");

      // 2) 已有配置检测
      const configPath = path.join(cwd, "applift.config.ts");
      if (fs.existsSync(configPath)) {
        const overwrite = await p.confirm({ message: `已存在 ${configPath}，覆盖重生成？` });
        if (p.isCancel(overwrite) || !overwrite) {
          p.outro("保留现有配置，跳过生成");
          return;
        }
      }

      // 3) 收集项目信息
      const androidPkg = await p.text({
        message: "安卓包名（如 com.thclouds.driver，可空跳过安卓渠道）",
        placeholder: "com.example.app",
      });
      const harmonyBundle = await p.text({
        message: "鸿蒙 bundleName（可空跳过鸿蒙）",
        placeholder: "com.example.app.hm",
      });
      const iosScheme = await p.text({
        message: "iOS scheme（可空跳过 iOS）",
        placeholder: "MyApp",
      });
      const profileName = await p.text({ message: "凭据 profile 名", initialValue: "default" });
      if (
        p.isCancel(androidPkg) ||
        p.isCancel(harmonyBundle) ||
        p.isCancel(iosScheme) ||
        p.isCancel(profileName)
      ) {
        p.cancel("已取消");
        return;
      }

      // 4) 生成 applift.config.ts
      const stores = androidPkg
        ? `
  android: {
    pkgName: ${JSON.stringify(String(androidPkg))},
    // 按需启用渠道（appId/证书路径等渠道侧配置）
    stores: {
      // huawei: { appId: 'xxx' },
      // honor: { appId: 'xxx' },
      // oppo: {}, vivo: {}, yyb: { appId: 'xxx' },
    },
  },`
        : "";
      const harmony = harmonyBundle
        ? `
  harmony: {
    bundleName: ${JSON.stringify(String(harmonyBundle))},
    // appId: 'xxx',  // 缺省按 bundleName 自动查询
  },`
        : "";
      const ios = iosScheme
        ? `
  ios: {
    scheme: ${JSON.stringify(String(iosScheme))},
  },`
        : "";
      const content = `import { defineConfig } from '@applift/core';

export default defineConfig({
  profile: ${JSON.stringify(String(profileName || "default"))},${stores}${harmony}${ios}
  // plugins: [],  // vite 风格钩子：拦截提审/改文案/自定义渠道，见 README
});
`;
      fs.writeFileSync(configPath, content);
      p.log.success(`已生成 ${pc.bold("applift.config.ts")}`);

      // 5) 凭据引导（可选，也可直接编辑 ~/.applift/credentials.json）
      const doCreds = await p.confirm({
        message: "现在配置凭据？（写入 ~/.applift/credentials.json，0600）",
        initialValue: false,
      });
      if (p.isCancel(doCreds)) return;
      if (doCreds) {
        const creds = loadCredentialsLayered(cmdOpts.cwd);
        const profile = String(profileName || "default");
        creds.profiles[profile] ??= {};
        const group = await p.multiselect({
          message: "选择要配置的凭据组（空格选择，回车确认）",
          options: [
            { value: "beta", label: "内测（蒲公英）" },
            { value: "huawei", label: "华为（安卓+鸿蒙）" },
            { value: "xiaomi", label: "小米" },
            { value: "oppo", label: "OPPO" },
            { value: "vivo", label: "vivo" },
            { value: "honor", label: "荣耀" },
            { value: "yyb", label: "应用宝" },
            { value: "asc", label: "iOS App Store Connect" },
          ],
          required: false,
        });
        if (!p.isCancel(group)) {
          for (const g of group) {
            for (const key of CREDENTIAL_GROUPS[String(g)] ?? []) {
              const meta = CREDENTIAL_FIELDS.find((f) => f.key === key)!;
              // clack v0.11 无 password 选项；敏感值输入时终端可见，也可直接编辑文件
              const v = await p.text({
                message: `${meta.label}（${pc.dim(meta.where)}）`,
                defaultValue: "",
              });
              if (!p.isCancel(v) && String(v).trim())
                creds.profiles[profile]![key] = String(v).trim();
            }
          }
          saveCredentials(creds);
          p.log.success(
            `凭据已写入 ~/.applift/credentials.json（profile: ${pc.bold(profile)}，0600）`,
          );
        }
      }
      p.outro(
        `下一步: ${pc.cyan("applift doctor")} 体检 → ${pc.cyan("applift beta android")} 发内测`,
      );
    });

  program
    .command("use")
    .description(
      "查看/切换本项目凭据 profile（个人选择写 ~/.applift/projects.json，不进项目/git；项目配置 profile 是团队默认）",
    )
    .argument("[profile]", "目标 profile 名；缺省=查看当前生效与可用列表")
    .option("--cwd <dir>", "项目目录", process.cwd())
    .action(async (profile: string | undefined, cmdOpts: { cwd: string }) => {
      const cwd = path.resolve(cmdOpts.cwd);
      const available = Object.keys(loadCredentialsLayered(cmdOpts.cwd).profiles);
      p.intro(pc.bgCyan(pc.black(" applift use ")));
      const target = profile?.trim();
      if (!target) {
        const { config } = await loadProjectConfig(cwd);
        const source = loadProjectProfileMap()[cwd]
          ? "个人选择 ~/.applift/projects.json"
          : config.profile !== "default"
            ? `项目默认 applift.config.ts → profile: ${config.profile}`
            : "全局默认";
        p.log.message(
          `当前生效 profile: ${pc.bold(resolveProfileFor(cwd, config.profile))} ${pc.dim(`（来源: ${source}）`)}`,
        );
        p.log.message(
          available.length > 0
            ? `可用 profiles: ${available.join(", ")}`
            : "可用 profiles: (无 — 先在 ~/.applift/credentials.json 配置)",
        );
        p.outro(
          `个人切换: ${pc.cyan("applift use <profile>")}（改团队默认 → applift.config.ts 的 profile 字段）`,
        );
        return;
      }
      setProjectProfile(cwd, target);
      p.log.success(
        `本项目已切换到 profile ${pc.bold(target)}（写 ~/.applift/projects.json，不进项目/git）`,
      );
      if (!available.includes(target)) {
        p.log.warn(
          `~/.applift/credentials.json 还没有 profile "${target}"（可用: ${available.join(", ") || "无"}），发版前记得补凭据`,
        );
      }
    });

  program
    .command("status")
    .description("查询各渠道审核状态")
    .option("--stores <list>", "渠道列表（逗号分隔），缺省=项目配置全部")
    .option("--cwd <dir>", "项目目录", process.cwd())
    .option("--json", "结构化输出（stdout 给机器）")
    .action(async (cmdOpts: { stores?: string; cwd: string; json?: boolean }) => {
      registryRef.setup();
      const { config } = await loadProjectConfig(cmdOpts.cwd);
      const creds = loadCredentialsLayered(cmdOpts.cwd);
      const profile = resolveProfile(
        creds,
        resolveProfileFor(cmdOpts.cwd, config.profile),
        KNOWN_CREDENTIAL_KEYS,
      );
      const storeIds = (
        cmdOpts.stores ? cmdOpts.stores.split(",") : Object.keys(config.android?.stores ?? {})
      ).filter(Boolean);
      if (storeIds.length === 0)
        throw new Error("未指定渠道（--stores 或项目配置 android.stores）");
      const detected = detectBundleIds(cmdOpts.cwd);

      const isJson = Boolean(cmdOpts.json);
      const results: Array<{
        channel: string;
        state: string;
        live?: boolean;
        reason?: string;
        error?: string;
      }> = [];
      let hasError = false;
      if (!isJson) p.intro(pc.bgBlue(pc.black(" applift status ")));
      for (const id of storeIds) {
        const channel = registryRef.registry.get(id);
        if (!channel) {
          results.push({ channel: id, state: "unknown", error: "未知渠道" });
          hasError = true;
          if (!isJson) p.log.error(`${id}: 未知渠道`);
          continue;
        }
        // target 取值链与 release 一致：stores 渠道配置 > 平台段配置 > 包名自动推导
        const target = resolveChannelTarget(id, config, detected);
        if (!channel.capabilities.status) {
          results.push({ channel: id, state: "unknown", error: "该渠道状态查询暂未接入" });
          continue;
        }
        try {
          const st = await channel.status({ credentials: profile, target });
          results.push({ channel: id, ...st });
          if (!isJson) {
            const icon =
              st.state === "approved"
                ? pc.green("●")
                : st.state === "rejected"
                  ? pc.red("✗")
                  : st.state === "reviewing"
                    ? pc.yellow("●")
                    : pc.dim("◌");
            const text =
              st.state === "approved"
                ? `审核通过${st.live ? pc.green("（已上架）") : pc.dim("（未上架）")}`
                : st.state === "rejected"
                  ? `被驳回${st.reason ? ` — ${st.reason}` : ""}`
                  : st.state === "reviewing"
                    ? "审核中"
                    : (st.raw ?? "未知");
            p.log.message(`  ${icon} ${pc.bold(channel.label)} ${text}`);
          }
        } catch (e) {
          // status 查询抛错可能内嵌凭据/响应体：--json results 与人话提示共用同一脱敏值
          const msg = redactText((e as Error).message);
          results.push({ channel: id, state: "unknown", error: msg });
          hasError = true;
          if (!isJson) p.log.error(`${channel.label}: ${msg}`);
        }
      }
      if (isJson) process.stdout.write(JSON.stringify({ status: results }, null, 2) + "\n");
      else p.outro("状态查询完成");
      if (hasError) process.exitCode = 1;
    });

  program
    .command("history")
    .description("发版历史（stage/submit 记录，~/.applift/history.jsonl）")
    .option("--channel <id>", "按渠道过滤")
    .option("--sha256 <hash>", "按产物 sha256 过滤")
    .option("--limit <n>", "最近 n 条（缺省 20）", "20")
    .option("--json", "JSON 输出（AI agent 友好）")
    .action(
      async (cmdOpts: { channel?: string; sha256?: string; limit: string; json?: boolean }) => {
        const entries = readEntries({ channel: cmdOpts.channel, sha256: cmdOpts.sha256 });
        const limit = Number(cmdOpts.limit);
        const recent = (
          Number.isFinite(limit) && limit > 0 ? entries.slice(-limit) : entries
        ).reverse();
        if (cmdOpts.json) {
          console.log(JSON.stringify(recent, null, 2));
          return;
        }
        p.intro(pc.bgBlue(pc.black(" applift history ")));
        if (recent.length === 0) {
          p.log.message(pc.dim("暂无记录（发版执行 release 后自动落一条）"));
        }
        for (const e of recent) {
          const time = new Date(e.ts).toLocaleString();
          const icon = e.ok ? pc.green("✓") : pc.red("✗");
          p.log.message(
            `  ${icon} ${pc.dim(time)} ${pc.bold(e.channel.padEnd(10))} ${e.action.padEnd(6)} ${e.artifactVersion ? pc.dim(e.artifactVersion) : ""}${e.ref ? pc.dim(` ref=${e.ref}`) : ""}`,
          );
        }
        p.outro(`共 ${recent.length} 条`);
      },
    );
}
