# AGENTS.md（applift）

> 本文件固化 applift 的架构边界与发版模型设计决策（2026-10-19 定稿）。**后续所有开发必须基于这些前提**，不得回退或绕过；与本文件冲突的设计一律先改本文件再动代码。

## 项目定位

applift：多框架 App 发版工具。**只管发版（产物 → 校验 → 分发），不接管构建**。

- pnpm monorepo：`packages/core`（编排 + 契约）、`packages/cli`（commander 命令面）
- 消费方式：项目根 `applift.config.ts`（c12 + jiti 加载，`@applift/core`/`@applift/cli` 别名指到 CLI 自带模块）
- 当前唯一真实用户：qy-driver（RN 三端，含鸿蒙热更）

## 架构不变量（任何改动不得违反）

1. **不接管构建**：构建是项目域知识（签名/证书/渠道变体/自定义脚本链），applift 禁止 spawn 构建命令；`FrameworkAdapter` 无 buildCommand 字段。产物是唯一入口（`--artifact` 或 `artifactPatterns` 探测最新）。曾因接管构建导致蒲公英链路被迫绕开（实证），不得回退。
2. **core 零框架知识**：判定知识在 UpdateProvider（framework 相关），core 只编排（diff 收集 → provider.judge → 推荐 → 确认 → 路由）。`FrameworkAdapter` 只有 detect/artifactPatterns/expoAwareLabel。
3. **三维插件对称**：`channel:register`（渠道）/ `framework:register`（框架适配）/ `update:register`（热更 provider）——三个扩展点接口对称，注册即声明。
4. **零侵入**：不声明插件时所有命令行为与无插件完全一致；新增钩子必须保持此性质（现有测试全绿是 gate）。
5. **判定是推荐不是决定**：judge 输出推荐 + 逐文件证据，确认界面可改选；CI（`--yes`）用推荐值，uncertain 必须显式 `--delivery ota|native`。
6. **热更是第三维能力**（framework × channel × update），与渠道/框架扩展接口对称，不做特殊通路。
7. **运行时：Node ≥20 唯一承诺；bun 仅基本兼容，不承诺**：npm dist 分发按 Node ≥20 门禁（CI runtime-node20 强制）。bun 直跑 dist 的基本命令（`--version` / `channels` 等）验证通过（macOS 本地 + ubuntu CI），但**配置装载（c12/jiti 执行 applift.config.ts）在 ubuntu + bun 下读不到配置**（2026-10-20 CI 实证未根因：前三步命令全过、doctor 输出无渠道）——CI runtime-bun job 只做基本命令冒烟，不做配置装载断言；发版操作（doctor/beta/release 等读配置命令）一律用 Node。**明确不做 `bun build --compile` 单文件二进制分发**（2026-10-20 否决）：配置与插件深耦合工程 node_modules，"免 Node"卖点不成立；且编译形态与 dist 行为全面分裂（`import.meta.resolve` 失效 / `$bunfs` 对 node:fs 不可见 / jiti babel.cjs 不可达——均实证），勿回退此决策。约束：禁止引入仅单运行时可用的 API；运行时读自身包文件走 import 内联（版本号即此写法）。

## 发版模型（终态）

| 你要做什么 | 敲什么                       | 内部发生什么（不用管）                                                                       |
| ---------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| **发内测** | `applift beta <platform>`    | 自动判定：JS 改动→热更发测试设备（偏移测试包线）；原生改动→自动升版本+引导重建→重跑→AGC 群组 |
| **发正式** | `applift release <platform>` | 上次 beta 是热更→promote 给正式用户（灰度）；是原生→上架；成功后补 tag                       |

投递方式由 diff 判定唯一决定；`--delivery ota|native` 仅为覆盖推荐的低频逃生口（显式 `--delivery ota` 但平台未接入/无 provider 时必须报错，不得静默降级为原生）。

## 版本语义（终态）

| 变更       | versionName                                          | tag                                                   | 取号                                         |
| ---------- | ---------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------- |
| 原生发版   | 三段升（`4.0.0`→`4.1.0`，versionCode 公式递增）      | `v4.1.0`（release 全渠道提审成功后补；beta 不打 tag） | `applift version bump`                       |
| 热更发版   | **versionName 不动**                                 | `v4.0.0-patch.N`（beta 热更发布时打，进 CHANGELOG）   | pushy 服务端查询取号（多机安全，本地无状态） |
| 偏移测试包 | major+1000（`4.0.0`→`1004.0.0`，pushy 官方测试约定） | —                                                     | publishToBeta 自动                           |

- 测试/正式隔离靠版本号精确绑定：偏移测试包设备收测试热更，正式设备收正式热更，互不污染
- 热更**不参与 version bump**（不动 versionName/versionCode/bump 机制）——这是防复杂化的关键取舍，勿回退
- tag 后移：release 全渠道提审成功才打（部分成功不打）；beta 不打 tag（追溯走 history.jsonl）；tag 失败不阻断发布

## UpdateProvider 契约（core/src/update.ts）

- 声明 `frameworks`（框架匹配）+ `platforms`（已接入热更的平台，未接入平台路由直接走原生）
- `judge(diff, ctx)` → `{ recommendation, confidence, evidence[] }`——推荐 + 证据，不是决定
- `publishToBeta(ctx)`（beta 热更）/ `publishToProd(ctx)`（直接发正式，必选）/ `promoteToProd(ctx)`（release promote，返回 null=无货）
- 判定引擎五形态完备性：新原生实体必现于 原生目录/依赖(原生包)/补丁/构建配置/JS 之一——前四判原生，纯 JS 判热更，包未安装→uncertain（不猜）

## 已知边界（记录在案，不视为缺陷）

- 取号并发 TOCTOU：两机同时 beta 可能同号（pushy 行为未验证；单机单人发版无影响）
- `--delivery ota` 越过判定可绑到尚无设备的原生版本（用户显式意图范畴）
- 灰度调比例用 pushy `update` 原生命令/网页后台（applift 暂无子命令）
- 鸿蒙扫码 DeepLink pushy 官方未支持（仅 Android/iOS）

## 开发规范

- pnpm；测试 vitest（`pnpm -r build && npx vitest run`，全量绿是 gate）；lint 用 oxlint（packages）
- 测试写法沿用现有风格：桩渠道进程内 / 临时目录 + 真 git / mock CliRunner；断言在导出接口（seam），不测内部实现
- 负载型 git 测试（bump 全链路/e2e 周期）限时已放宽（90s/120s），全量并行偶发超时单独重跑确认即可
- 改 core 契约（AppliftPlugin/UpdateProvider/DeliveryJudgement）必须同步 plugin.test/update.test
- 触碰 CLI 入口/配置加载相关代码后跑 `pnpm run smoke`（node）即可；bun 不作为验证义务（基本兼容，见不变量 7），CI 的 runtime-bun 基本冒烟自动覆盖
- **术语规范**（2026-10-20 定稿，防摇摆）：applift 自有命名全链路统一 **beta**（`applift beta` 命令 / config `beta:` 段 / `publishToBeta` 等方法 / `betaPackageVersion`——beta=内测发版阶段，与 release 对仗）。pushy 服务端概念的中文描述保留"测试"措辞（测试通道/测试设备/偏移测试包——锚定 pushy 上游术语），仅作解释文字不用于命名；semver prerelease 的 `-beta.N`（`--pre beta`）是版本号语义，与发版阶段无关
- 提交用 conventional commits；**禁跑真实 pushy 网络命令**（bundle/publish/uploadApp）于开发验证——用 mock CliRunner

## 当前状态（2026-10-19）

- framework 插件化：7 适配器迁 `plugins/frameworks.ts`（工厂函数），`resolveFramework` 声明式（多注册报错、detect 降级校验、内置表已删）
- rn-update 插件：判定引擎（五形态+依赖信号+缺失 uncertain）、pushy OpenAPI 客户端（pushy-api.ts：x-api-token，token=credentials.json 的 PUSHY_API_TOKEN；服务端操作全 API 化）、**ppk 产物化**（2026-10-20 定稿：ppk 是构建产物，项目先行产出 pushy bundle，applift 按 `--artifact` 或 `ppkPatterns`（默认 .pushy/output/{platform}.*.ppk）探测 mtime 最新；探测路径强制新鲜度护栏=ppk 须新于未发布改动最新文件，--artifact 显式跳过；pushy-cli.ts 已删，applift 零 spawn 构建）、**publishToProd 必选契约**（2026-10-20 定稿：热更不依赖 beta——release ota 两条腿：测试通道有已验证热更且 provider 支持 → promoteToProd（返回 null=无货），否则 publishToProd 直接发正式（探 ppk + 取号 + 绑正式版本 + rollout）；publishToBeta/promoteToProd 可选，beta 遇无 publishToBeta 的 provider 报错引导 release）、publishToBeta（服务端取号 patch.N + 偏移绑定）、promoteToProd（重绑+rollout）、`stage:after` 自动基线（版本号由 readArtifactVersion 从产物读取）
- tag 后移：release 全成功补 `v{产物版本}`（幂等：内容一致「无需重复上传」）
- qy-driver 侧：config 已声明双插件、hook `usePatchVersionSuffix` 已接关于页
- 消费方类型链路修复（2026-10-20）：`@applift/cli` build 加 `--dts` 且 exports 补 types 条件；新增 `./plugins` 子导出（re-export core/plugins）——applift.config.ts 只依赖 @applift/cli 即有完整类型，无需 @ts-expect-error；promote 灰度内置默认 100（全量，`--rollout` > `rnUpdate({ defaultRollout })` > 默认）
- ASC 渠道升级（2026-10-22，参考蒲公英 ASC CLI 文章做功能审查的产物）：① stage 上传双引擎——装 Transporter.app 时首选 `iTMSTransporter -jwt`（JWT 与 REST API 同源，Apple 官方建议；ipa 复制临时 ASCII 名防删源/多字节名失败），未装回退 altool（altool --upload-app 未被官方弃用，弃用的是其公证功能；勿再以"altool 已弃用"为由单路押注）；② submit 前预检本地化 description（Apple 硬性要求，提前暴露）+ 出口合规提示；③ status 接入（appVersionState 15 枚举 → ReviewStatus，跳过 PREPARE_FOR_SUBMISSION/REPLACED）。upload/submit 真实链路仍未经实机验证（qy-driver iOS release 首发时按"只读验证→预检→提审"顺序灰度）
- AGC 鸿蒙 status 接入（2026-10-22，安卓/鸿蒙渠道审查的唯一缺口）：`/publish/v3/version/brief-info/list` 查商用版本 state（同 releaseState 全表，与华为安卓同表映射）；只取 testType 缺省/1 的商用版本（测试版本 3/4 不混入），空则 unknown fail-safe。testType=1 为推断值（官方数据模型文档动态加载拿不到枚举），真实链路首用核对。安卓七渠道审查结论：全部进程内 API 无外部工具风险（oppo aapt2 仅解析 versionCode 且三级降级），errorHints 等价预检，status 全接入——无需 iOS 式改造
