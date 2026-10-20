/**
 * 配置三层：项目 applift.config.ts > 内置默认（全局行为配置独立于 ~/.applift/config.toml）。
 * 凭据独立存放 ~/.applift/credentials.json（0600，按 profile 组织，永不进项目目录/git）。
 * 加载用社区主流 c12（TS 配置执行 + 多层 merge），config.toml 用 smol-toml 解析，非自研。
 */
import { z } from "zod";

export const CredentialsProfileSchema = z.record(z.string(), z.string());
export type CredentialsProfile = z.infer<typeof CredentialsProfileSchema>;

export const CredentialsFileSchema = z.object({
  /** profiles.default = 所有项目缺省继承；项目配置可用 profile 字段覆盖 */
  profiles: z.record(z.string(), CredentialsProfileSchema),
});
export type CredentialsFile = z.infer<typeof CredentialsFileSchema>;

/** 单渠道配置（appId、pkgName 等渠道侧键） */
export const StoreConfigSchema = z.record(z.string(), z.string());
export type StoreConfig = z.infer<typeof StoreConfigSchema>;

/**
 * stores 等价写法，统一规范化为 record：
 * ① 对象：{ huawei: { appId: 'x' } }（原有写法，原样保留）
 * ② 数组：['oppo', 'vivo'] → { oppo: {}, vivo: {} }（无配置渠道）
 * ③ 字符串值：{ huawei: '10xxx' } → { huawei: { appId: '10xxx' } }（appId 简写）
 * ④ 混排数组（README 首例）：['huawei', { yyb: 'appId值' }] → 元素对象须单键 { 渠道: 值 }，
 *    值走 ③ 同款 appId 简写归一
 */
const storesNormalize = (
  stores: Record<string, Record<string, string> | string> | Array<string | Record<string, string>>,
): Record<string, Record<string, string>> => {
  if (Array.isArray(stores))
    return Object.fromEntries(
      stores.flatMap((el): Array<[string, Record<string, string>]> => {
        if (typeof el === "string") return [[el, {}]];
        // 单键已由 superRefine 保证；此处防御性跳过异常形态（理论不可达）
        const [id, cfg] = Object.entries(el)[0] ?? [];
        if (id === undefined || cfg === undefined) return [];
        return [[id, typeof cfg === "string" ? { appId: cfg } : cfg]];
      }),
    );
  return Object.fromEntries(
    Object.entries(stores).map(([id, cfg]) => [id, typeof cfg === "string" ? { appId: cfg } : cfg]),
  );
};

export const StoresSchema = z
  .union([
    z.record(z.string(), z.union([StoreConfigSchema, z.string()])),
    z.array(z.union([z.string(), StoreConfigSchema])),
  ])
  // 混排数组的单键约束走 zod issue（而非 transform 内裸抛）：错误进入 safeParse 结果，被 loadProjectConfig 人话化
  .superRefine((val, ctx) => {
    if (!Array.isArray(val)) return;
    for (const el of val) {
      if (typeof el === "string") continue;
      if (Object.keys(el).length !== 1)
        ctx.addIssue({
          code: "custom",
          message: `stores 数组内的对象元素必须形如 { 渠道id: appId简写 }（单键），收到: ${JSON.stringify(el)}`,
        });
    }
  })
  .transform(storesNormalize)
  .default({});
export type Stores = z.infer<typeof StoresSchema>;

/** 项目级配置（applift.config.ts 的形状）；beta 段见上方 BetaConfigSchema */
/**
 * 内测分发配置（applift beta 无平台参数时并行发布的渠道开关）：
 * - pgyer: 蒲公英多平台上传（缺省只发 android）
 * - agc: AGC 邀请测试（Testing API，submit=true 上传绑定后自动提审）
 * - testflight: App Store Connect 上传（ipa 进 TestFlight）
 */
export const BetaConfigSchema = z.object({
  pgyer: z
    .object({
      platforms: z.array(z.enum(["android", "harmony", "ios"])).default(["android"]),
      installPassword: z.string().optional(),
    })
    .optional(),
  agc: z
    .object({
      /** 上传绑定后自动提交测试审核（默认 false：只到「已就绪」，群组/提审到控制台人工完成） */
      submit: z.boolean().default(false),
      /** 测试群组名（submit 时按名查 groupId 绑定；匹配不到报错提示到控制台建组） */
      group: z.string().optional(),
      /** 3=邀请测试（默认）4=公开测试 */
      testType: z.union([z.literal(3), z.literal(4)]).default(3),
    })
    .optional(),
  testflight: z
    .object({
      note: z.string().optional(),
    })
    .optional(),
});

/** versionCode 策略："increment"(默认 +1) | 公式（可限定平台） */
export const VersionCodeConfigSchema = z.union([
  z.literal("increment"),
  z.object({
    /** 白名单表达式：major/minor/patch 与 + - * ( )，如 "major*1000000+minor*1000+patch" */
    formula: z.string(),
    /** 仅限平台（缺省全部）；实际写入 = max(公式值, 现值+1) */
    platforms: z.array(z.string()).optional(),
  }),
]);
export type VersionCodeConfig = z.infer<typeof VersionCodeConfigSchema>;

export const VersionConfigSchema = z.object({
  versionCode: VersionCodeConfigSchema.default("increment"),
});
export type VersionConfig = z.infer<typeof VersionConfigSchema>;

export const ProjectConfigSchema = z.object({
  /** 项目显示名 */
  name: z.string().optional(),
  /** 团队默认凭据 profile（个人用 applift use / --profile 覆盖），缺省 default */
  profile: z.string().default("default"),
  android: z
    .object({
      /** 缺省经 detectBundleIds 从工程文件自动推导（README 首例即只有 stores 的最小配置） */
      pkgName: z.string().optional(),
      /** 渠道 → 渠道侧配置（appId 等）；stores 里列出的渠道才发 */
      stores: StoresSchema,
    })
    .optional(),
  harmony: z
    .object({
      /** 缺省自动推导（AppScope/app.json5） */
      bundleName: z.string().optional(),
      appId: z.string().optional(),
    })
    .optional(),
  ios: z
    .object({
      /** 缺省自动推导（工程 scheme 探测） */
      scheme: z.string().optional(),
      workspace: z.string().optional(),
      /** App Store Connect 按 bundleId 定位 App（asc 渠道 submit 用） */
      bundleId: z.string().optional(),
    })
    .optional(),
  /** 产物目录覆盖（非标准工程）：每平台 glob 数组，优先于框架内置 pattern（桌面平台 + 插件自报平台经 catchall 收） */
  artifacts: z
    .object({
      android: z.array(z.string()).optional(),
      harmony: z.array(z.string()).optional(),
      ios: z.array(z.string()).optional(),
      windows: z.array(z.string()).optional(),
      macos: z.array(z.string()).optional(),
      linux: z.array(z.string()).optional(),
    })
    .catchall(z.array(z.string()).optional())
    .optional(),
  /** 版本管理（versionCode 策略等） */
  version: VersionConfigSchema.optional(),
  /** 内测分发（beta 无平台参数时的多渠道并行配置） */
  beta: BetaConfigSchema.optional(),
});

export type BetaConfig = z.infer<typeof BetaConfigSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/** 全局行为配置（~/.applift/config.toml） */
export const GlobalConfigSchema = z.object({
  defaultProfile: z.string().default("default"),
  /** 渠道并发数 */
  concurrency: z.number().int().min(1).max(8).default(4),
  /** 上传超时（毫秒） */
  uploadTimeoutMs: z.number().default(900_000),
  /** CI 无人值守豁免确认（等价把 L3 闸门前置到 CI 审批） */
  assumeYes: z.boolean().default(false),
});
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
