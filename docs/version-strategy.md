# 变更提案：版本隔离策略（version-strategy）

> 状态：**已实现（仓库内），待发布 `0.9.0`**。变更集：`.changeset/version-strategy.md`；单测 982/982 通过（2026-10-23，含评审补测）。
> 背景：唯一真实用户 qy-driver（RN 三端）需要「单个 pushy appId 同时承载测试热更与正式热更」，同时要兼容 TestFlight、且三端 versionName 保持一致。

## 1. 需求

### 1.1 问题

现状把「测试/正式隔离」硬编码成 `betaPackageVersion() = major + 1000`，且 qy-driver 侧用同一条公式**反推 versionCode**（`major*1e6+minor*1e3+patch`）。两个设计叠在一起产生三个后果：

1. **versionCode 被顶到十亿级**：`4.0.0` → 测试包 `1004.0.0` → code `1004000000`。AGC 官方规则要求「测试版 code 必须高于已发布正式版、且不低于已发布测试版」，一旦测试包进过 AGC，正式版本按公式算出的 `4100000` 就是回退，公式线永久作废。
2. **策略不可选**：`suffix`（`4.0.0-beta.1`）和双 appId 两种同样合法的隔离方式无从配置。
3. **iOS 无解**：`major+1000` 恰好还是三段数字，能用；但换成字母后缀时没有任何平台能力校验，配上就会在 TestFlight 上传阶段炸。

### 1.2 目标

1. `version.beta` 成为可配置项，支持三种隔离策略：`offset` / `suffix` / `app-id`。
2. 策略按**平台能力**校验：官方不支持的组合（如 `suffix` + iOS）在 `bump` / `beta` 阶段直接报错，不静默降级。
3. `offset` 支持选择偏移段（`patch` / `major`），默认 `patch` + `1000`。`patch+1000` 是三端唯一全通的形态（iOS 只允许 1–3 段整数、鸿蒙仅数字和点、Android 商店要数字点分）。
4. **`beta` 只影响 versionName**：不给 `versionCode` 增加任何派生、步长或预留语义。
5. 热更的 `packageVersion`、版本名、promote 候选全部由策略派生，不再硬编码常量。
6. 基线自动上传（`stage:after`）透传 `platform`，为三端接入热更做准备（当前只有 `agc → harmony` 的渠道映射，Android/iOS 走蒲公英时基线不会上传）。

### 1.3 非目标

- **不接管构建**（架构不变量 1 不变）：ppk / 原生包仍由项目先行产出。
- **不做分发轨道抽象**：TestFlight / Play internal track / AGC 邀请测试是平台侧概念，applift 不建模。
- **不引入状态文件**：所有编号可由工程文件 + 配置派生。
- **不接管 versionCode 分配**：分配发生在构建时，属项目脚本职责，见 §2.3。
- 不改 `framework` / `channel` 两个扩展维度。

### 1.4 验收标准

| #   | 验收项                                                                           |
| --- | -------------------------------------------------------------------------------- |
| 1   | `version.beta` 三种 mode 均可用，缺省为 `offset/patch/1000`                      |
| 2   | `suffix + ios` 在命令执行时抛错；`suffix + harmony` 只告警、不阻断（无静音旗标） |
| 3   | `bump` 行为不变（versionName + code 各 +1），**不新增 step 配置**                |
| 4   | `applift beta <platform>` 把热更绑到「派生测试版本名」，code 不参与              |
| 5   | `applift release <platform>` promote 时按「测试基线」找候选并重绑到正式版本名    |
| 6   | `stage:after` 载荷含 `platform`，Android/iOS 走蒲公英时基线能正确上传            |
| 7   | 现有 qy-driver 配置（`formula` + `rnUpdate({harmony: 34166})`）仍能解析          |

## 2. 设计

### 2.1 三个概念

- **base（正式版本）**：工程文件里的 `versionName`，即本次要发布的正式号（`4.0.0`）。
- **测试孪生体（beta）**：与 base 同源码、仅版本号不同的包，给测试设备装一次、长期接收测试热更。
- **版本名派生**：测试版本名由 base + 配置算出，不落盘。

派生规则（`offset/patch`）：

```
测试 versionName = major.minor.(patch + delta)    4.0.0 → 4.0.1000
```

### 2.2 三种策略与平台能力

| mode                    | 测试 versionName   | 隔离键         | Android | iOS 侧载 | iOS TestFlight | Harmony                  |
| ----------------------- | ------------------ | -------------- | ------- | -------- | -------------- | ------------------------ |
| `offset`（patch，默认） | `4.0.1000`         | packageVersion | ✅      | ✅       | ✅             | ✅                       |
| `offset`（major）       | `1004.0.0`         | packageVersion | ✅      | ✅       | ✅             | ✅（兼容旧行为）         |
| `suffix`                | `4.0.0-beta`       | packageVersion | ✅      | ✅       | ❌             | ⚠ 构建放行、文档口径不符 |
| `app-id`                | 与正式相同 `4.0.0` | pushy appId    | ✅      | ✅       | ✅             | ✅                       |

平台能力表（core 内置常量）：

| platform  | maxSegments | 允许 prerelease                  |
| --------- | ----------- | -------------------------------- |
| `ios`     | 3           | 否                               |
| `android` | 4           | 是                               |
| `harmony` | 4           | 否（构建期放行，官方文档不支持） |

校验语义：

- 段数超限 → `error`（`4.0.0.1` 在 iOS 上）。
- `prerelease` 且平台 `allowPrerelease=false`：
  - `ios` → `error`（TestFlight / App Store 硬校验，配置就是错的）。
  - `harmony` → `warning`（实测构建期放行，但与官方文档口径不符）。
- `app-id` 模式要求 `rnUpdate` 提供 `{ prod, beta }` 两个 appId，否则 `error`。

### 2.3 versionCode：不在本次变更范围

versionCode 只承担两件事：**同应用记录下唯一**、**单调递增**（决定能否覆盖安装）。它不参与热更匹配，也没有任何规则要求它跨端相等。

因此本提案**不给 versionCode 增加任何新语义**：

- `bump` 保持现状：versionName 与 code 各 +1。
- 出包时的 code 分配由**项目构建脚本**负责：每次出包（beta 或 release）把 code +1 并写回三端工程文件。这属于构建域，applift 不接管（不变量 1），但 core 已提供 `readProjectVersions` / `writeProjectVersions` 可直接复用。
- 测试包不再有「code = 正式 − 1」这类派生：它就是「下一个被分配的号」。

由此得到的性质：

- 正常顺序（先内测、后正式）下，正式包 code 恒大于测试包 → QA 可平滑升到正式包。
- 重打包同一版本天然换号，绕开 AGC「版本已存在」。
- 分多次构建不同端时，各端产物 code 可能差几个号 —— 不影响任何规则，versionName 才是跨端对账键。

### 2.4 配置契约

```ts
// packages/core/src/config/schema.ts
export const BetaVersionConfigSchema = z.union([
  z.object({
    mode: z.literal("offset"),
    segment: z.enum(["patch", "major"]).default("patch"),
    delta: z.number().int().positive().default(1000),
  }),
  z.object({
    mode: z.literal("suffix"),
    /** 模板：只支持 {base} 占位（不支持 {n}：序号类模板需要持久化状态） */
    template: z.string().default("{base}-beta"),
  }),
  z.object({ mode: z.literal("app-id") }),
]);

export const VersionConfigSchema = z.object({
  versionCode: VersionCodeConfigSchema.default("increment"), // 不新增形态
  beta: BetaVersionConfigSchema.default({ mode: "offset", segment: "patch", delta: 1000 }),
});
```

`rnUpdate` 的 appId 支持两种形态（向后兼容）：

```ts
type AppIdConfig = number | { prod: number; beta: number };

interface RnUpdateOptions {
  harmony?: AppIdConfig;
  android?: AppIdConfig;
  ios?: AppIdConfig;
  // 其余不变
}
```

**为什么没有 `version.release`**：`version.beta` 的前提是「同一份代码需要第二个版本名」；正式包没有第二形态——它的 versionName 就是工程文件里那个值，无可派生，所以不设 release 策略。唯一沾边的规则是「工程里是 prerelease 时写正式号」（`bump --pre beta` 后 `storeVersionName()` 剥后缀），这是固定的语义收敛而非可选策略，留在 bump 里。将来若真出现 release 变体需求（渠道别名、带渠道后缀的商店包），再加 `version.release`，直接复用 `BetaVersionConfigSchema` 的类型与平台能力校验即可——扩展点是现成的。

### 2.5 热更发布路径的变化

| 环节                                | 现状                                     | 变更后                                                                            |
| ----------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------- |
| `publishToBeta` 的 `packageVersion` | `betaPackageVersion(base)`（major+1000） | `betaVersionName(base, config, platform)`                                         |
| 测试热更版本名                      | `{base}-patch.N`                         | `{测试版本名}-patch.N`（`4.0.1000-patch.1`）                                      |
| 正式直发热更版本名                  | `{base}-patch.N`                         | 不变（`4.0.0-patch.1`）                                                           |
| `promoteToProd` 候选                | `^{base}-patch.N$`                       | `^{测试版本名}-patch.N$`，取 N 最大；重绑到 `{base}`                              |
| `app-id` 模式的 promote             | —                                        | 不能 rebind（跨 appId 的 versionId 不通用），退化为「同一 ppk 重发到 prod appId」 |
| 取号                                | `nextPatchNumber(versions, base)`        | 同一函数，key 换成对应基线的版本名                                                |

命名带基线的好处：正式线同时存在 `4.0.1000-patch.1`（promote 来的）与 `4.0.0-patch.1`（直发）时，按名字即可溯源，不会把「测试期验证过的那条」和「上线后补发的」混在一起。

实现补充（2026-10-23 回填）：

- 取号 / promote 候选匹配的正则改为全量转义（`escapeRegExp`）——suffix 模板含 `+`、`.` 等元字符时不再恒返 patch.1。
- `promoteToProd` 的 `rebind` 失败时重抛带修复提示：先 `applift release <platform> --delivery native`（只 stage）生成正式基线，再重试 promote。
- `app-id` 模式（或双 appId 配置）下 `promoteToProd` 返回 null 并向 stderr 提示「跨 appId 的 versionId 不通用——转为 publishToProd，同一 ppk 直接发正式应用记录」，退化路径对发版者可见。

### 2.6 基线自动上传：stage:after 载荷增强与 beta 路径补广播

现状：`rn-update.ts` 的 `CHANNEL_PLATFORM` 只有 `{ agc: 'harmony' }`，且 `stage:after` 载荷是 `{ channel, ok, ref, error, artifactPath }`——没有 platform。Android/iOS 改走蒲公英后，基线不会自动上传；且 `applift beta` 不走 pipeline，5 条 `channel.stage()` 直调分支全都不触发钩子——测试包永远没有 pushy 基线，首次热更 bind 必然失败。

变更（含实现中发现的补充设计，2026-10-23 回填）：

1. `pipeline.ts` 在广播前先算 `plan = await safePlan(channel, effectiveCtx)`，载荷补 `platform: plan.platform`（`runStage` 与 `--submit` 两条路径都要补）。
2. `rn-update.ts` 的 `stage:after` 优先读 `payload.platform`，`CHANNEL_PLATFORM` 降级为兜底（无 platform 时的旧行为）。
3. 平台以 `plan.platform` 为准；只有在 plan 解析失败时才用扩展名兜底，且 `.app` 归鸿蒙（iOS 分发口径统一用 `.ipa`；历史实现误归 android，会把鸿蒙基线传到 android 应用记录）。
4. 载荷新增 `target: "beta" | "prod"`：beta 路径（CLI 直调）恒 `beta`、release pipeline 恒 `prod`——双 appId 模式下基线归属不再靠版本名启发式。
5. beta 路径补广播：5 条 `channel.stage()` 直调分支全部补 `notifyStageAfter`（`target:"beta"`），修复测试包无基线的缺陷。
6. 去重：同一 `(platform, versionName)` 一次运行只传一份基线（`uploadedBaselines` 集合；`test:all` 的 .hap/.app 并发场景）。已知边界：去重键不含 target，app-id 模式下 beta/prod 版本名相同——当前命令面单次运行只触一个 target，不受影响。

### 2.7 fail loud

所有策略相关错误必须带「怎么改」：

```
ios 不支持 prerelease 版本名（TestFlight/App Store 要求 1–3 段非负整数）：
  version.beta.mode=suffix 在 ios 上不可用
  → 改用 mode=offset（segment=patch）或 mode=app-id
```

## 3. 实现

### 3.1 文件清单

| 文件                                        | 改动                                                                                                                                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/version/beta-version.ts` | **新增**：策略纯函数 + 平台能力表 + 校验                                                                                                                                                                                         |
| `packages/core/src/version/index.ts`        | 导出新模块                                                                                                                                                                                                                       |
| `packages/core/src/config/schema.ts`        | `BetaVersionConfigSchema`；`VersionConfigSchema` 增 `beta`（`versionCode` 不动）                                                                                                                                                 |
| `packages/core/src/plugins/rn-update.ts`    | `packageVersion` / 命名 / `promoteToProd` / 双 appId / `stage:after` 读 platform 与 target / 去重 / 正则转义 / rebind 失败提示                                                                                                   |
| `packages/core/src/plugins/pushy-api.ts`    | 不改（`publish` 的 `packageVersion` 已是入参）                                                                                                                                                                                   |
| `packages/core/src/pipeline.ts`             | `stage:after` 载荷补 `platform` + `target:"prod"`（两处广播点）；`.app` 兜底归鸿蒙（修历史误归 android）                                                                                                                         |
| `packages/core/src/plugin.ts`               | `AppliftPlugin` 的 `stage:after` 载荷类型补可选 `platform` / `target` 字段                                                                                                                                                       |
| `packages/cli/src/index.ts`                 | `expectedArtifactVersion()` 改用 core 的 `betaVersionName()`（静态导入 core 主入口，不走 `./plugins` chunk——见该函数原注释的 ESM 链接期问题）；beta 路径 5 条 `channel.stage()` 直调分支补 `notifyStageAfter`（`target:"beta"`） |
| `applift/AGENTS.md`                         | §版本语义表：偏移测试包一行改为「派生测试孪生体」；§当前状态补本次变更                                                                                                                                                           |

> `version/bump.ts`、`version/version-code.ts` **不需要改**。

### 3.2 新增模块签名

```ts
// packages/core/src/version/beta-version.ts
export type PrereleasePolicy = "allow" | "warn" | "reject";
export type PlatformVersionCaps = {
  maxSegments: number;
  prerelease: PrereleasePolicy;
  note: string; // 官方口径说明，进报错/告警文案
};
export const PLATFORM_VERSION_CAPS: Record<string, PlatformVersionCaps>;
export const DEFAULT_BETA_VERSION_CONFIG: BetaVersionConfig; // { offset, patch, 1000 }，与 schema default 一致

export interface BetaVersionContext {
  base: string; // 工程 versionName（4.0.0）
  config: BetaVersionConfig;
  platform: string;
}

/** 派生测试版本名；不合法时抛错（含修复建议） */
export function betaVersionName(ctx: BetaVersionContext): string;

/** 校验策略与平台组合；官方硬拒（如 suffix+ios）抛错，口径不符（suffix+harmony）返回 warnings */
export function assertBetaVersionSupported(ctx: BetaVersionContext): string[];

/** 段数与 prerelease 检查（供 suffix/offset 共用） */
export function checkVersionNameShape(name: string, platform: string): string | null;
```

### 3.3 逐函数改动要点

1. **`betaVersionName`**
   - `offset/patch`：`major.minor.(patch + delta)`；`offset/major`：`(major + delta).minor.patch`。
   - `suffix`：模板替换，`{base}` → base；含 `{n}` 直接报错（不支持递增序号）。
   - `app-id`：直接返回 base。
   - 出参统一过 `checkVersionNameShape()`，失败抛错。
2. **`publishToBeta`**
   - `const betaName = betaVersionName({ base: versionName, config, platform })`
   - `name = \`${betaName}-patch.${nextPatchNumber(existing, betaName)}\``
   - `packageVersion = betaName`
3. **`promoteToProd`**
   - 候选用 `betaName` 前缀匹配；无可 promote 返回 `null`（契约不变）。
   - `app-id` 模式：`return null`，由 `release` 走 `publishToProd`（同一 ppk 重发），返回说明标注「跨 appId 无法 rebind」。
4. **`platformAppId(opts, platform, channel)`**
   - `channel='beta'` 且配置为 `{prod,beta}` → 用 `beta`；否则用 `prod`；number 形态两处同值。
5. **`pipeline.ts`**
   - 广播前算 `plan`（合并两次 `safePlan` 调用），载荷补 `platform`。

### 3.4 测试计划

| 测试文件                       | 新增/调整                                                                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version/beta-version.test.ts` | **新增**：三策略 × 三端矩阵；段数/prerelease 校验；`suffix+ios` 抛错、`suffix+harmony` 告警；`{n}` 模板报错；`BetaVersionConfigSchema` 三形态解析/非法值/默认与 `DEFAULT_BETA_VERSION_CONFIG` 一致性锁定（替换原常量=字面量的同义反复用例） |
| `plugins/rn-update.test.ts`    | beta packageVersion 派生；命名带基线；promote 只选测试基线；双 appId 分支；`app-id` 模式 promote 返回 null + stderr 提示；offset+双 appId 同样返 null；rebind 失败含 `--delivery native` 修复提示                                           |
| `cli/commands.test.ts`         | `expectedArtifactVersion` 对 beta 期望派生值（suffix 策略 `4.0.0-beta`）；`suffix+ios` 策略不兼容报错文案                                                                                                                                   |
| `cli/stage-after.test.ts`      | **新增**：`notifyStageAfter` 单元 + **命令级 e2e**（`beta harmony --via pgyer` 全链路触发 stage:after，载荷带 `target:"beta"`）                                                                                                             |
| `pipeline.test.ts`             | `stage:after` 载荷含正确 `platform`；`.app` 兜底归 harmony 回归锁（.app 曾误归 android）；`runSubmit(--submit)` 路径载荷                                                                                                                    |

`version/bump.test.ts`、`version/version-code.test.ts` 无需改（未触及）。`pnpm -r build && npx vitest run` 全绿是 gate。

### 3.5 版本与发布

- 版本号 `0.8.2 → 0.9.0`（breaking：`rnUpdate` 的 beta packageVersion 默认来源变化）。
- CHANGELOG 写明：**升级后若未显式配置 `beta`，测试热更将从 `1004.0.0` 变为 `4.0.1000`**，旧偏移测试包不再匹配，需重建一次测试包；保留旧行为的出路：`version.beta = { mode: "offset", segment: "major", delta: 1000 }`。

## 4. 兼容性

| 现有配置                                      | 升级后                                                                                                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version.versionCode: { formula, platforms }` | 不变                                                                                                                                                             |
| `rnUpdate({ harmony: 34166 })`                | 仍合法（number 形态 = prod，beta 同值）                                                                                                                          |
| 不声明 `rnUpdate`                             | 行为完全不变（零侵入不变量）                                                                                                                                     |
| 声明了 `rnUpdate` 但未配 `beta`               | 走新默认 `offset/patch/1000` → 测试 packageVersion 变化，**需重建测试包**（breaking 点）；保留旧行为：显式配 `{ mode: "offset", segment: "major", delta: 1000 }` |

## 5. 风险与未决

| 风险                                       | 处理                                                     |
| ------------------------------------------ | -------------------------------------------------------- |
| AGC 邀请测试是否接受 `4.0.1000`            | 实测；退路 `4.0.0.1`（四段数字，仅鸿蒙与其他两端不同）   |
| TestFlight 是否接受 `4.0.1000`             | 实测；退路 `app-id`（双 appId，版本号不动）              |
| 分端构建导致产物 code 不同                 | 不影响商店/AGC（各自单调）；跨端对账以 versionName 为准  |
| 正式线 patch 序号与 promote 来的版本名并存 | 文档明示按名字溯源，不做自动改名（pushy 无 rename 能力） |
