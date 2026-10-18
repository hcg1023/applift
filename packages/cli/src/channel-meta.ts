/**
 * 渠道配置元数据：所需凭据键与获取指引（channels 命令消费，AI agent 自发现的依据）。
 * 与 lifecycle.ts 的 CREDENTIAL_FIELDS 保持单一来源：此处为 channel → keys 映射。
 */
export const REQUIRED_KEYS_BY_CHANNEL: Record<string, string[]> = {
  pgyer: ["PGYER_API_KEY"],
  huawei: ["HW_CLIENT_ID", "HW_CLIENT_SECRET", "HW_ANDROID_APP_ID"],
  agc: ["AGC_CLIENT_ID", "AGC_CLIENT_SECRET"],
  xiaomi: ["MI_USER_NAME", "MI_PASSWORD", "MI_CERT_PATH", "MI_APP_NAME"],
  oppo: ["OPPO_CLIENT_ID", "OPPO_CLIENT_SECRET"],
  vivo: ["VIVO_ACCESS_KEY", "VIVO_ACCESS_SECRET"],
  honor: ["HONOR_CLIENT_ID", "HONOR_CLIENT_SECRET", "HONOR_APP_ID"],
  yyb: ["YYB_USER_ID", "YYB_ACCESS_SECRET", "YYB_APP_ID"],
  asc: ["ASC_KEY_ID", "ASC_ISSUER_ID"],
  googleplay: ["GOOGLEPLAY_SA_JSON 或 GOOGLEPLAY_SA_KEY"],
};

/** 环境变量兼容的裸键名全集（渠道凭据键展开；release/status/listing/doctor 统一 resolveProfile 用） */
export const KNOWN_CREDENTIAL_KEYS = [
  ...new Set(
    Object.values(REQUIRED_KEYS_BY_CHANNEL)
      .flat()
      .flatMap((k) => k.split(" 或 ")),
  ),
];

export const CHANNEL_HINTS: Record<string, string> = {
  pgyer: "pgyer.com → 账号设置 → API（免费，内测分发三端）",
  huawei: "AGC → 项目设置 → API Client（安卓应用 App ID 独立）",
  agc: "AGC → 项目设置 → API Client（与华为安卓同源凭据，appId 可按 bundleName 自动查询）",
  xiaomi: "dev.mi.com → 管理中心 → API（需 dev.api.public.cer 证书路径）",
  oppo: "open.oppomobile.com → 管理中心 → API 传包",
  vivo: "dev.vivo.com.cn → 应用分发 → API 传包（有沙箱环境可免费真测）",
  honor: "developer.honor.com → 设置 → API",
  yyb: "app.open.qq.com 管理中心（UserID + AccessSecret）",
  asc: "App Store Connect → 用户和访问 → 集成 → 团队密钥；p8 放 ~/.applift/private_keys/",
  googleplay: "Google Cloud Console → Service Account（JSON 密钥）+ Play Console 关联",
};
