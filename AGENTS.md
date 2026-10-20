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
| 偏移测试包 | major+1000（`4.0.0`→`1004.0.0`，pushy 官方测试约定） | —                                                     | publishToTest 自动                           |

- 测试/正式隔离靠版本号精确绑定：偏移测试包设备收测试热更，正式设备收正式热更，互不污染
- 热更**不参与 version bump**（不动 versionName/versionCode/bump 机制）——这是防复杂化的关键取舍，勿回退
- tag 后移：release 全渠道提审成功才打（部分成功不打）；beta 不打 tag（追溯走 history.jsonl）；tag 失败不阻断发布

## UpdateProvider 契约（core/src/update.ts）

- 声明 `frameworks`（框架匹配）+ `platforms`（已接入热更的平台，未接入平台路由直接走原生）
- `judge(diff, ctx)` → `{ recommendation, confidence, evidence[] }`——推荐 + 证据，不是决定
- `publishToTest(ctx)`（beta 热更）/ `promoteToProd(ctx)`（release promote）
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
- 提交用 conventional commits；**禁跑真实 pushy 网络命令**（bundle/publish/uploadApp）于开发验证——用 mock CliRunner

## 当前状态（2026-10-19）

- framework 插件化：7 适配器迁 `plugins/frameworks.ts`（工厂函数），`resolveFramework` 声明式（多注册报错、detect 降级校验、内置表已删）
- rn-update 插件：判定引擎（五形态+依赖信号+缺失 uncertain）、pushy CLI 封装（spawnPushy + runner 注入）、publishToTest（服务端取号 patch.N + 偏移绑定）、promoteToProd（重绑+rollout）、`stage:after` 自动基线
- tag 后移：release 全成功补 `v{产物版本}`（幂等：内容一致「无需重复上传」）
- qy-driver 侧：config 已声明双插件、hook `usePatchVersionSuffix` 已接关于页
- 运行时定稿（2026-10-20）：Node ≥20 唯一承诺；bun 基本兼容（CLI 基本命令 mac/ubuntu CI 通过，配置装载 ubuntu+bun 失败未根因，读配置命令不承诺 bun）；CLI 版本读取改 JSON import 内联（消运行时文件读取）；`bun build --compile` 二进制评估后**否决**（行为分裂实证）；CI runtime-bun job 收缩为基本命令冒烟
- 未做：热更发布本地 git tag（`v4.0.0-patch.N`，服务端已有 commit 记录）；偏移测试包自动构建
