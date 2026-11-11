# fastlane 借鉴项落地设计（2026-11-11）

> 调研背景：对照 fastlane/fastlane（commit `08237b1e`，源码逐行核对）与 Apple 官方文档（帮助页 + ASC API 文档，一手原文核对）做功能审查后的落地设计。方案经 superpowers 流程（brainstorming）逐节确认。
>
> **范围（用户拍板）**：P1（等构建/提审幂等/版本状态机）+ P2（ASC 韧性层/出口合规代答）+ P3（phased release/preflight 规则引擎/build 号预检）全量；**分层（方案 C）**：ASC 六件事渠道内聚，仅 pollUntil 提为 channels/shared 共享工具，preflight 规则接口设计为可移植但不提升 core。

## 背景事实（调研结论，均有源）

- 官方文档确认：首版可选"审核后自动发布"（releaseType=AFTER_APPROVAL），唯一强制手动场景=预购且从未上架（App Store Connect Help "Select an App Store version release option" Note 原文）；**phased release 才有首版限制**（ASC API "App Store Version Phased Releases"："This resource is not available for the first version of an app, only for subsequent releases."）。
- fastlane 关键实证（源码路径见各节）：BuildWatcher 有界轮询（`fastlane_core/build_watcher.rb:36-69`）、X.Y≡X.Y.0 双格式查询坑（`:84-91`，issue #22248）、提审三查（`deliver/submit_for_review.rb:31-63`）、ensure_version! 复用/改名（`spaceship/.../models/app.rb:215-232`，editable 集合 `:260-279`）、releaseType 未配置只警告不猜测（`upload_metadata.rb:187-203`）、出口合规 `usesNonExemptEncryption == null` 才写（`submit_for_review.rb:92-120`）、Spaceship 韧性层（`api_client.rb:166-262`、`token.rb` iat-60）。

## 已落地（本文档范围外，2026-11-11 当日完成，全量 1125 测试绿 + smoke 过）

ASC 上架方式三档：默认 **AFTER_APPROVAL 审核通过自动上架**（行为变更，原默认 MANUAL）；配置 `ios.release: "auto"|"manual"`（默认 auto）；`--release-mode <auto|manual>` 单次覆盖，与 `--release-time` 互斥报错。变更集 `.changeset/asc-auto-release.md`。

## §1 共享轮询 `channels/shared/poll.ts`（新增）

`pollUntil<T>({ attempt, intervalMs, timeoutMs, onWait })`：`attempt()` 返回 `{ done: true, value }` 终态成功、`{ done: false }` 继续等、抛错=终态失败直接抛。迁移三处现有手写轮询：AGC `awaitCompile`（15s × 15min）、oppo `pollTaskState`（10s × 5 次→换算时间上限）、pgyer `buildInfo`（3s × deadline）。华为 120s 固定 sleep 非轮询，不迁移。**迁移纯重构：现有 fake-timers 测试全绿 = 行为不变 gate。**

## §2 ASC 等构建处理完成（P1-1）

- 只发生在 submit（需要绑 build 时）；stage/TestFlight 上传不等。现状问题：`pipeline.ts` 同进程连跑 stage→submit，ASC 构建处理约 10 分钟才 VALID，`asc.ts` 立即查 VALID 必然抛错，等于每次 iOS 发版要人工等 10 分钟重跑。
- 锚定产物：`readArtifactVersion(ipa)` 读 versionName+versionCode → `preReleaseVersions?filter[version]=<versionName>` 拿 id → `builds?filter[preReleaseVersion]=<id>&filter[version]=<versionCode>` 精确锁定本次构建（修掉"盲取最新 VALID"在多 train 并存时绑错包的隐患）；产物读不出时退回现状"最新 VALID"。
- 版本号双格式：X.Y 与 X.Y.0 同版本但只能按先传格式查到 → 双格式查询 `uniq` 去重 + 前导零归一。
- 参数：30s 间隔、30min 上限（对齐上传超时），每轮 emit progress；VALID→继续，INVALID/FAILED→立即报错，PROCESSING→等；超时报错指引 `applift release ios --skip-stage` 重跑（§3 幂等化后重跑安全）。

## §3 提审幂等三查（P1-2）

提交流程前三查（fastlane `submit_for_review.rb:31-63` 同款）：
1. **已在审**：`GET /v1/reviewSubmissions`（进行中）含本平台条目 → 报错"已在审核中，勿重复提交；改文案先在控制台撤回"，不碰。
2. **未提交草稿 submission**：复用追加条目；items 非空（网页人工加的）→ 报错引导网页处理，不覆盖人工操作。
3. 都没有 → 现行三步流（创建 reviewSubmission → 添加条目 → action=SUBMIT）。

## §4 版本状态机扩展（P1-3）

- "可编辑版本"集合从只认 `PREPARE_FOR_SUBMISSION` 扩为 fastlane 全集：+ `DEVELOPER_REJECTED` / `REJECTED` / `METADATA_REJECTED` / `INVALID_BINARY`（被拒后重跑不再撞同号建重复版本），取 versionString 最大者。
- 分支：同号 → 复用 PATCH releaseType（现状）；`PREPARE`/`INVALID_BINARY` 且异号 → PATCH versionString 改名续用（fastlane `ensure_version!` 语义）；**被拒态且异号 → 报错人话**（被拒记录连着审核沟通历史，不自动改名，引导控制台人工处置——比 fastlane 保守，理由：驳回处置在本仓边界内本就是人工操作范畴，见 AGENTS.md 已知边界）。

## §5 ASC 韧性层（P2，`shared/asc-jwt.ts`）

- `iat = now - 60`（时钟偏移防御，fastlane `token.rb` 实证）。
- **GET**：429 指数退避（1s 起倍增封顶 60s，总上限 10min）；500/502/503/504 重试 ≤3 次（2s/4s/8s）；401 重签 JWT 重试 1 次。
- **POST/PATCH 不自动重试**（防重复创建版本/重复提审），错误文案补"可能已成功，先跑 status 确认再重试"。
- 403 + `REQUIRED_AGREEMENTS_MISSING_OR_EXPIRED` → 专属人话"付费协议未签/过期，到 ASC 网页签署后重试"（fastlane `ProgramLicenseAgreementUpdated` 专属异常同款价值）。
- 现有 30s AbortSignal 超时保留。

## §6 出口合规代答（P2）

配置 `ios.exportCompliance?: { usesNonExemptEncryption: boolean }`，缺省=不代答（保持现提示行为）。submit 时查绑定 build 的 `usesNonExemptEncryption`：**null 才 PATCH**（幂等判据，fastlane 同款；Info.plist 已声明 `ITSAppUsesNonExemptEncryption` 的自动跳过）。beta 流程不扩展（记边界）。

## §7 phased release——iOS 灰度（P3）

配置 `ios.phasedRelease: boolean` 默认 false（持续约定走配置，不加旗标——YAGNI）。submit 绑版本后：**非首版**（appStoreVersions 记录数 >1 粗判，fastlane deliver 同款判据）→ `POST /v1/appStoreVersionPhasedReleases`（7 天 1%→2%→5%→10%→20%→50%→100%）；**首版 → warn + 跳过**（官方硬限制，属能力客观不可用，非静默降级，warn 文案引用官方原文）。pause/resume/全量放行不做（控制台操作，记边界）。

## §8 preflight 规则引擎（P3）

ASC 渠道内规则数组 `{ key, level: "warn" | "error", check }`：
- 现有 localizations 描述检查迁为 rule（error 级，保持阻断语义）；
- 新增：出口合规未决（build 未声明且未配置代答 → warn）、存在被拒版本（error，人话指引）、phased 首版冲突（warn）。
- **error 才阻断提审，warn 仅提示**；接口形态可移植，不提升 core。fastlane 文本审查类规则（脏话/占位词）明确不做——applift 无元数据域。

## §9 build 号预检（P3）

stage 上传前：`builds?filter[app]=<id>&filter[version]=<产物 versionCode>` 已存在 → 报错"build 号已被占用（版本 X 构建号 Y），升 versionCode 重新出包"。只读不写，**"versionCode 工程文件即计数器"不变量保持**（不做 fastlane `increment_build_number` 式写回）。

## §10 ConfigItem 自文档 → 收敛为文档同步

不做代码机制（applift 配置是 zod 单源 + doctor 已有来源展示，不存在 fastlane 的 options 散布问题）。收敛为：README 补 `ios.release` / `--release-mode` / `ios.phasedRelease` / `ios.exportCompliance` 文档；docs/llms.txt 同步。

## §11 测试与落地顺序

测试：新增 `poll.test.ts`（间隔/上限/终态/异常传播）；迁移渠道现有测试全绿=行为不变 gate；asc.test/asc.flow 补轮询（fake timers：PROCESSING→VALID 两轮 / INVALID 立败 / 超时）、三查、状态机分支、phased 首版跳过、build 号占用、合规 null 才 PATCH；asc-jwt.test 补重试矩阵。

顺序（每步全量绿再进下一步）：
1. pollUntil + 迁移三渠道（纯重构）
2. asc-jwt 韧性层
3. ASC 等构建 + build 号预检
4. 提审三查 + 版本状态机
5. 出口合规代答 + preflight 规则化
6. phased release
7. 文档（README/llms.txt）+ changeset

## §12 多渠道 / 多平台影响面

原则：**模式全渠道统一（等待=有界轮询、提交=先查后写、错误=人话分类），实现渠道内聚**（各渠道 API 语义不同，不建假抽象的 core 中间层）。

| 设计项 | 影响渠道 | 其他渠道现状对照 |
|---|---|---|
| §1 pollUntil | 跨渠道：asc（新）+ agc-harmony / oppo / pgyer（迁移） | 华为 120s 固定 sleep 非轮询不动 |
| §2 等构建 | 仅 ASC | 安卓渠道上传即可提审无此缺口；AGC"等云端编译"= 它自己的等构建（§1 统一） |
| §3 提审幂等 | 仅 ASC 新增 | oppo 已有等价物（errno 911215 不重复建任务）、honor 已有（errorHints 20022）；ASC 是唯一没防重的渠道 |
| §4 版本状态机 | 仅 ASC | 安卓渠道服务端无"可编辑版本记录"实体 |
| §5 韧性层 | 仅 asc-jwt | AGC token 刷新 / oppo 签名 / pgyer 三域名 failover 各自内聚已有；不统一 HTTP 层 |
| §6 出口合规 | 仅 ASC | Apple 特有提审问询 |
| §7 phased | 仅 ASC（ios） | 热更灰度 pushy promote rollout 已有；安卓国内渠道无对应 API |
| §8 preflight 接口 | 设计可移植，本轮只落 ASC 规则 | 其他渠道已有 errorHints 事后人话体系 |
| §9 build 号预检 | 仅 ASC | ios build 号全 app 唯一才冲突；安卓 versionCode 各渠道自校验（errorHints 已覆盖） |
| §10 文档 | 全局 | — |

多平台：所有 ASC 项只在 `release/beta ios` 路径生效；android/harmony 发布行为零变化（§1 迁移为纯重构+测试兜底）；beta 多渠道并行（pgyer/agc/testflight）不受影响；插件自报平台路径不经过这些渠道。

主动核过不需要做的：小米上传即提审无草稿区（幂等靠渠道 errno）；vivo/应用宝/谷歌市场无等待-处理阶段；AGC beta cleanup 已是独立幂等域，不并入三查。

## 明确不做（边界）

文本审查规则（无元数据域）/ pause-resume 子命令（控制台操作）/ HTML 预览人工确认（CI-first 冲突）/ 元数据管理域（越 applift 边界）/ 写操作自动重试（防重复副作用）/ Fastfile-lane DSL（为接管构建而生，方向相反）/ build 号写回工程（构建域）。

## 风险与未验证点

- 全部 ASC 改动仍**未经真实链路验证**（AGENTS.md 既有状态）；qy-driver iOS 首发按"只读验证→预检→提审"顺序灰度时逐项核对。
- `preReleaseVersions?filter[version]` 精确锚定 build 的查询路径按 ASC API 文档设计，真实首用核对（退回路径"最新 VALID"兜底）。
- phased 首版判据（版本记录数 >1）与 fastlane deliver 同款粗判；被拒旧版本记录长期存在可能误判"非首版"——可接受（POST phased 对首版失败时降级为 warn 不阻断，预检 §8 已前置拦截）。
