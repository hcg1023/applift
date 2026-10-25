# @applift/core

## 0.12.0

### Minor Changes

- 951ffbc: 修复 AGC 鸿蒙测试提审与 pushy 基线上传的三个发版阻塞问题（qy-driver 2026-10-25 实测）：

  - **AGC 提审三字段互异**：`languages[].appDesc` 与 `newFeatures` 同值被 AGC 拒绝（204144692 "description and briefInfo and new Features cant be the same"）。`appDesc` 改为取新配置 `beta.agc.appDesc`（缺省用通用基线文案），`newFeatures` 用 `--note`，两者来源互异。
  - **pushy 基线 409 自动替换**：测试孪生体同版本名重建（原生依赖修复不改 versionName）时，`uploadApp` 撞 409「原生包已存在」。现在自动检查该基线名下有无热更版本绑定：无绑定 → 删旧基线重传（全程日志可溯）；有绑定或服务端未回显绑定关系 → 保守拒绝并给出人工处理指引，绝不自动删被热更依赖的基线。
  - **在审版本清理提示**：AGC 停版遇 `state is 9998`（版本在审中，平台不允许停/删）时，告警附带可行动指引（控制台撤回审核或等审毕后下次发版自动清理）。

  另：0.11.0 发布时未包含 PR #41（AGC 提审三前置自动携带），本版本一并带出。

## 0.11.0

### Minor Changes

- 88b309d: AGC 鸿蒙测试发布自动清理旧测试版本（`beta.agc.cleanup`，默认开，消费方零配置升级即生效）：

  - 根因：AGC 测试版本数量约束——在审上限（提交报 204144692 "count of harmony test in audit"）、在架上限（邀请测试 3 / 公开测试 1 / 总数 100）；AGC 不自动下架旧测试版本，旧版本堆积后必须到控制台人工停止/删除才能提审新版本。versionCode 递增只解决「包不可选」维度，不解决数量维度
  - 时机：`uploadBeta` 上传完成后、新建测试版本之前——缩短测试设备的「不可安装」窗口，且新版本绝无被误删可能
  - 发现：复用 `POST /api/publish/v3/version/brief-info/list` 反向过滤 `testType` 3/4（与 status() 的商用过滤互补），拿到旧测试版本 versionId；**故意不解读 state**（测试版本 state 枚举与商用 releaseState 表不一致且未实机验证，清理全部旧版本无需依赖）
  - 清理：`POST /api/publish/v2/test/version/stop`（完全下架）→ `DELETE /api/publish/v2/test/app/version`（官方指南顺序）；best-effort——查询/单版本 stop/delete 失败仅告警不阻断发布，名额仍被占时提审 204144692 errorHint 兜底提示人工
  - 影响面：已装设备 App 本体与 pushy 热更均不受影响（只移除 AGC 在架记录）；受影响的仅审核空窗期内想经 AGC 邀请链接新装的人（蒲公英 .hap 通道不受影响）
  - 逃生口：`beta.agc.cleanup: false` 完全恢复旧行为（不查旧版本、不发清理请求）
  - 已知未验证：stop 对「审核中」版本是否有效（官方 stop 文档针对在架版本）——真实链路首用核对

- aed5448: 版本声明与交付封板分离（bump-semantics，设计文档 docs/bump-semantics.md）：

  - **`applift version bump` 默认不打 tag**：bump = 版本声明（写工程文件 + CHANGELOG + `chore(release):` commit）；tag = 交付标记，由 `release` 全渠道提审成功后补打。**破坏性变更**：`--no-tag` 旗标已移除（默认即不打）；依赖「bump 即打 tag」的脚本需改带 `--tag`（显式逃生口，保留旧行为）
  - **判定锚点升级**：最新 semver tag 与最新 `chore(release):` commit 按 committer time 取新者（`latestVersionAnchor`）——修复「多次 beta 不重复 bump」此前依赖 bump 顺手打 tag 推走锚点的巧合设计；去 tag 化后若锚点仍只认 tag，bump 写入的版本文件（原生目录内）会被判为原生改动、连环烧版本号
  - **beta 原生三态判定**：① 原生·需 bump → 引导三步（含推荐版本与推断理由）；② 原生·已声明（工程版本领先最近发布 tag）→ 只引导重建 + `--delivery native`，不再建议 bump；③ OTA 不变。锚点推进后纯 JS 改动正确判热更
  - **新增 `applift beta <platform> --bump [level]`**：判定需 bump 时自动声明（缺省 level 用 conventional commits 推断，`--yes` 跳过确认），完成即打印重建与重跑指引；新增配置 `beta.autoBump`（默认 false）= 永远带 `--bump`，CI 配合 `--yes`
  - **release 补 tag 冲突告警**：tag 已存在但指向不同 commit（历史提前 tag / 驳回重提后未移动）→ 显式告警而非静默跳过（`TagResult.conflict`）
  - 已知边界（AGENTS.md 已记录）：`--no-commit` 不产生锚点；驳回重提的 tag 移动为人工操作；squash-merge 丢 `chore(release):` 标记；多端异步发布存在全局锚点盲区（既有行为）

## 0.10.0

### Minor Changes

- 96b3554: 版本隔离策略（version-strategy）：把「测试包版本名」从硬编码 major+1000 收敛成可配置策略。

  - 新增 `version.beta`：`offset`（默认 patch+1000，`4.0.0` → `4.0.1000`）/ `suffix`（semver prerelease）/ `app-id`（版本名不变，靠双 appId 隔离）。按平台能力校验：`suffix` + iOS 直接报错（TestFlight/App Store 只收 1–3 段整数），`suffix` + 鸿蒙告警。
  - `rnUpdate` 的 appId 支持 `{ prod, beta }` 双应用记录；`app-id` 模式（或双 appId 配置）下 `promoteToProd` 返回 null 并向 stderr 提示原因（跨 appId 无法 rebind，退化为同一 ppk 重发到正式应用记录），退化路径对发版者可见。
  - 热更版本名带基线（`4.0.1000-patch.1`），`promoteToProd` 只认测试基线的候选，不会把正式线自发的 `4.0.0-patch.N` 当候选。
  - `stage:after` 载荷透传 `platform`，Android/iOS 走蒲公英时基线上传不再遗漏（`.app` 归鸿蒙整包，不按扩展名猜 android）。
  - **beta 路径补广播 `stage:after`**：`applift beta` 不走 pipeline，原先 5 条 `channel.stage()` 直调分支全都不触发钩子，导致测试包永远没有 pushy 基线（首次热更 bind 必然失败）。
  - `stage:after` 载荷新增 `target: "beta" | "prod"`：beta 路径（CLI）恒 beta、release pipeline 恒 prod，双 appId 的基线归属不再靠版本名启发式；同一 (平台, 版本名) 一次运行只传一份基线（`test:all` 的 .hap/.app 并发）。
  - `promoteToProd` 在 `bind` 失败时提示「先 `applift release <platform> --delivery native` 生成正式基线」。
  - `app-id` 模式未配置 `{ prod, beta }` 时直接报错，不再静默绑到正式线。
  - 热更取号/promote 的正则改为全量转义（suffix 模板含 `+` 等元字符时不再恒返 patch.1）。
  - CLI 的产物版本期望与 provider 共用同一个纯函数，删除内联的 major+1000 副本。

  **BREAKING**：`betaPackageVersion` 从 `@applift/core/plugins` 移除；未显式配置 `beta` 的项目，测试热更的 packageVersion 由 `1004.0.0` 变为 `4.0.1000`，旧偏移测试包不再匹配，需按新版本名重建一次测试包（原生包的 versionCode 不受影响）。想保留旧行为：显式配置 `version.beta = { mode: "offset", segment: "major", delta: 1000 }`。

## 0.9.0

### Minor Changes

- b48ab7b: AGC 鸿蒙渠道 status 接入（capabilities.status=true，"v1 亦无"的结论已过时——华为已上线版本列表接口）：

  - `POST /api/publish/v3/version/brief-info/list` 查商用版本列表，`state` 字段取值同 AppInfo.releaseState 全表（与华为安卓渠道同表）：0=已上架、3=待上架、4/5=审核中、1/8=审核不通过、2=已下架、7=草稿、11=撤销上架 → ReviewStatus
  - 只取商用版本（`testType` 缺省或 1）；测试版本（3=邀请/4=公开，走 Testing API 链路）不混入 status 语义，过滤后为空返回 unknown（fail-safe 不误报）
  - 多个商用版本取 `updateTime` 最新；认证与现有 AGC 链路同源（client_id + access_token），appId 缺省时按 bundleName 查（复用 `getHarmonyAppId`）
  - 已知边界：商用版本的 testType=1 是基于本仓 Testing API 同枚举的推断（官方数据模型文档动态加载拿不到枚举表），真实链路首次使用时核对；若过滤漏掉商用版本表现为 unknown 而非误报

- a6b8346: ASC（App Store Connect iOS）渠道三项升级：

  - **stage 上传双引擎**：装了 Transporter.app（Mac App Store）时首选 `iTMSTransporter -m upload -jwt` 上传——JWT 与 ASC REST API 同源（Apple 官方建议 API 用户用同一 JWT 上传二进制），免 altool 的 private_keys 目录查找；未装时回退 `xcrun altool`（零额外安装，官方仍支持）。可选凭据 `ASC_TRANSPORTER_PATH` 显式指定 iTMSTransporter 路径。防御：ipa 复制到临时随机 ASCII 名再传（-assetFile 成功后 Apple 侧会删源文件、多字节文件名上传失败，fastlane 实证）；成败按 fastlane 语义（exit 0 且 `DBG-X: Returning 0`）。
  - **submit 提审前预检**：目标版本的全部 appStoreVersionLocalizations 必须有商店描述（description），缺失提前报错并列出 locale，不再等 reviewSubmissions 最后一步被拒；并 emit 出口合规提示（Info.plist `ITSAppUsesNonExemptEncryption`）。
  - **status 接入**（capabilities.status=true）：查最新 appStoreVersion 的 appVersionState（AppVersionState 15 枚举）映射 ReviewStatus——审核中/被拒（含 METADATA_REJECTED、INVALID_BINARY）/已批准未发布（PENDING_DEVELOPER_RELEASE 等）/已上架（READY_FOR_DISTRIBUTION），跳过 PREPARE_FOR_SUBMISSION 与 REPLACED_WITH_NEW_VERSION 非活跃记录。

## 0.8.2

### Patch Changes

- 7da28ed: 补发遗漏：`betaPackageVersion`/`readDepVersions`/`readCommitInfo`/`nodeHttpUpload`/`HttpUploadImpl` 从 `@applift/core/plugins` 导出（`@applift/cli@0.8.0` 的产物探测版本感知依赖这些导出，core 未同步发版导致运行时缺导出崩溃）。

## 0.8.1

### Patch Changes

- e81a7e4: pushy 服务端真实契约修复（qy-driver 首次真实发布实测暴露，2026-10-21）：

  - **UA 必须官方形态**：`/upload` 按 `react-native-update-cli/<版本>` 做客户端版本门禁，自有 UA 被 400 拒绝；且 UA 必须单 token（附加标识破坏服务端版本解析）。已钉 `react-native-update-cli/2.29.3`（载荷反推基准版本）。
  - **deps 强制上报**：`version/create`/`package/create` 要求 `deps["react-native-update"] >= 10.53.1`（2026-09-17 后创建的应用），缺省 400。新增 `readDepVersions(cwd)`（官方 dep-versions 同构：直接依赖 → node_modules 实装版本，逐级向上，键排序）。
  - **不上报 commit**：官方 getCommitInfo 同构形态的 commit 字段被 version/create 以「上传凭据无效」拒绝（实测去除即过）；溯源走本地 history.jsonl。
  - **直传走 node:http(s) 原生**：undici fetch 直传 OSS（同字节同头）后服务端不认账（version/create 报凭据无效，实测 node:https 即过）；multipart/预签名 PUT 统一 `nodeHttpUpload`，`httpUpload` 注入保持可测。
  - `/upload` 恒带 `chunked: true`（与官方一致；chunked 指令本身是 GCS 后端特性，SaaS 响应仍为整文件表单）。
  - query 对 200 空 body 兜底 `{}`（原实现解构 undefined 崩溃）。
  - 修复：`beta <platform>` 快捷路径 AGC 分支不读 `beta.agc.submit/group/testType` 配置（与多渠道并行路径不一致，单平台从不提审）。
  - pushy-api 测试切换 httpUpload 注入通道，补 readDepVersions/nodeHttpUpload/边界分支覆盖（branches 92.2% 过 92% 阈值）。

## 0.8.0

### Minor Changes

- 497d053: pushy 热更链路四项改造（2026-10-20 定稿，详见 AGENTS.md）：

  1. **服务端操作迁 OpenAPI**：publish/uploadApp/rebind/versions 全部改 HTTP 客户端（pushy-api.ts，`x-api-token` 鉴权，token = `~/.applift/credentials.json` 的 `PUSHY_API_TOKEN`，CI 可用同名环境变量覆盖），不再 spawn pushy CLI、不解析中文人读输出、不依赖 `pushy login`。载荷对照 react-native-update-cli 2.29.3 参考实现反推并由契约测试钉死。
  2. **ppk 产物化**：ppk 是构建产物（pushy bundle = metro + hermesc），applift 不 spawn 构建命令——项目先行产出（如 `npm run ppk:<platform>`），applift 按 `--artifact` 或 `ppkPatterns`（默认 `.pushy/output/{platform}.*.ppk`，三端同构）探测 mtime 最新；探测路径强制新鲜度护栏（ppk 须新于未发布改动，`--artifact` 显式跳过）。pushy-cli.ts 删除，applift 运行时对 pushy CLI 依赖清零。
  3. **热更不依赖 beta**（UpdateProvider 契约）：`publishToProd()` 必选（探测 ppk → 取号 → 绑正式版本 + rollout 直接发正式）；`publishToBeta?`/`promoteToProd?` 可选（promote 返回 null = 测试通道无货，调用方转 publishToProd）。release ota 两条腿：有已验证测试热更 → promote（零构建）；无 → 直接发正式。
  4. **术语统一 beta**：applift 自有命名全链路 beta（`publishToBeta`、`betaPackageVersion`、config `beta:` 段、`applift beta` 命令）；pushy 物理域描述保留「测试」措辞，semver prerelease `-beta.N` 不受影响。

  配套：`PublishContext` 增 `credentials`/`artifact`、`HookContext` 增 `credentials`（stage:after 基线上传走 token）；beta creds 解析上提并容错（纯热更项目可无渠道凭据）；`stage:after` 基线版本号由 `readArtifactVersion` 从产物读取；`KNOWN_CREDENTIAL_KEYS` 增 `PUSHY_API_TOKEN`。

### Patch Changes

- 4775143: 修复蒲公英上传永远轮询超时：getCOSToken 响应按官方契约取 `data.key` 作为 buildKey（原实现解构不存在的 `data.buildKey` 得 undefined，buildInfo 轮询永远返回 1247「处理中」直至 15 分钟超时——上传本身是成功的，控制台可见）。测试桩同步改为官方契约（此前桩与实现一起错，全绿掩盖 bug）。2026-10-20 线上实证：修复后 41 秒轮询成功出短链。

## 0.7.2

### Patch Changes

- 81f0f24: 消费方类型链路与热更灰度默认：① `@applift/cli` build 加 `--dts` 且 `exports` 补 `types` 条件——此前 dist 无类型文件，消费方 applift.config.ts 只能 `@ts-expect-error` 压制；② 新增 `./plugins` 子导出（re-export core/plugins），配置文件只依赖 `@applift/cli` 即可导入 `rnFramework` / `rnUpdate` 且类型完整（不必把传递依赖 `@applift/core` 的提升布局当契约）；③ `promoteToProd` 灰度比例内置默认 100（全量）——promote 语义是"测试通道已验证、发正式"，全量是常态、灰度是显式选择（`--rollout` > `rnUpdate({ defaultRollout })` > 默认）。

## 0.7.1

### Patch Changes

- 816a932: 运行时健壮性：CLI 版本读取改 JSON import 内联（消除运行时对包文件的 readFileSync 依赖）；CI 新增 `runtime-bun` job 做 bun 直跑 dist 基本命令冒烟（`--version` / `channels`）。运行时承诺定为 Node ≥20 唯一（runtime-node20 门禁）；bun 基本兼容不承诺——配置装载（c12/jiti）在 ubuntu + bun 下读不到配置（CI 实证未根因），读配置命令请用 Node；`bun build --compile` 单文件二进制分发经评估不做（配置与插件深耦合工程 node_modules，裸机场景不存在）。

## 0.7.0

### Minor Changes

- b1d3567: 对抗审查第二、三轮修复（0.6.0/0.5.0 之后合入）。

  #### @applift/core
  - pipeline 错误消息解包一层 cause：fetch 网络层的真实原因（如 NotReadableError）不再藏在外壳错误里。
  - humanizeError 新增 NotReadableError 提示：产物/图标在上传期间被修改会被正确诊断为文件变更，而非误导性的网络故障提示。
  - fileBlob 打开文件失败时报错补全路径（openAsBlob 原生报错不含路径）。
  - AGC 鸿蒙正式链路 submit 复用 stage 的 packageId：默认发版流程不再双倍上传整包（数百 MB~GB 级），`--skip-stage` 免重传承诺兑现；OBS PUT 改流式上传。
  - 应用宝跨进程 `--submit --skip-stage` 无暂存时现场重传当前包再提审（此前必失败，而 CLI 推荐该用法）；蒲公英 buildInfo 轮询按域名 failover 且单次异常不再整体失败；AGC token / ASC ascGet 对非 JSON 网关页给出可定位报错；华为 releaseTime 本地 RFC3339 校验；altool 子进程 30 分钟超时兜底。
  - 输出脱敏统一收口：--json 的 error/ref、渠道 emit 事件、beta 三处错误输出、钉钉通知外发全部过 redactText；OPPO/应用宝 done 消息不再内嵌响应体。

  #### @applift/cli
  - release 凭据加载改走分层链（项目级 .applift/credentials.json）：修复"doctor 绿灯但 release 报凭据 profile 不存在"（私有仓项目级凭据场景）。
  - 提审确认处 Ctrl-C 正确退出 130（此前该路径退 1，与取消契约不符）。
  - `--dry-run --submit` 零副作用预览不再被非交互提审门控误拦。
  - bump 非交互门控认 config.toml 的 assumeYes（与提审门控自荐的补救方式一致）。
  - `version bump --no-commit --tag` 的确认文案如实显示将创建 tag。
  - bin 兜底 unhandledRejection 转人话退出（规避 undici ≥7.20 上传流错误的进程级崩溃）。
  - stage-only 发版自动排除"上传即提审"型渠道（小米等）并明示，不再误报"传包失败修复后重跑"死循环。
  - release 无 --stores 时默认渠道按平台与可提审能力过滤：`release android` 不再把正式包发到蒲公英（公网内测）或 ios/harmony 渠道。
  - `config.build` 构建命令覆盖接线生效（此前为死配置键）；status/listing/doctor 与 release 统一 profile 解析链（env 覆盖/缺 profile 报错一致）；小米 MI_APP_NAME 凭据键进入 init 向导与自发现面；version 命令透传全局 assumeYes。

## 0.6.0

### Minor Changes

- 725cd53: 生产就绪加固。

  #### @applift/core
  - AGC / 蒲公英请求增加超时兜底，避免慢网络下无限挂起。
  - 五渠道惰性 Blob 流式上传（openAsBlob），大包不再整包读入内存。
  - Google Play submit 复用 stage 已上传的 versionCode，不再重复整包上传。
  - `Channel.submit` 新增可选参数 `stagedRef`，用于接收 stage 阶段产物的渠道引用。
  - errorHints 补齐 pgyer/xiaomi/yyb/googleplay 常见错误码的人话提示（asc 错误无数字码表，未加）；humanizeError 改为边界匹配并对网络错误输出人话描述。
  - 配置层对齐 README 承诺：`android.pkgName`/`harmony.bundleName`/`ios.scheme` 改为可缺省（detectBundleIds 自动推导兜底）；stores 支持 README 首例的混排数组写法 `['huawei', { yyb: 'appId' }]`；配置校验失败输出人话字段路径而非原始 zod JSON。
  - **Breaking（0.x 内变更）**：`QypubPlugin` / `QypubUserConfig` 更名为 `AppliftPlugin` / `AppliftUserConfig`。

  #### @applift/cli
  - 非交互环境下提审 / bump 操作 fail-fast：必须显式 `--yes`，不再卡在交互确认。
  - `init` 华为凭据键与渠道实际所需键对齐。
  - `doctor` 支持项目级凭据检查与"或型"凭据键（任一即可）检查。
  - `listing` 的 profile 解析链与 release 一致化；任一渠道失败时退出码 1。
  - `release --json` 输出显式 `ref` 字段（stage/submit 各渠道产物/提审引用，无则 null）。
  - 用户取消（Ctrl-C）退出码改为 130。
  - 错误输出统一走脱敏（redactText），不再泄漏凭据。

## 0.5.0

### Minor Changes

- 29cd2a6: version 管理:applift version show/bump + beta/release 自动 version 编排

  - `applift version` 各端版本实况(versionName/versionCode + 文件路径 + 发版锚点 tag)
  - `applift version bump [major|minor|patch|prerelease|<semver>] [--pre beta]`:写各端工程文件(行级幂等改写保注释)→ 生成 CHANGELOG.md → 代 commit(chore(release))→ 代打 tag;push 永不代做
  - 版本决定链:显式指定 > git conventional commits 推断(BREAKING/feat/fix)> patch 兜底;semver 全程托管,prerelease 只进 tag、商店 versionName 恒三段数字
  - versionCode = max(公式值, 现值+1):默认递增;config `version.versionCode.formula` 支持 `major*1000000+minor*1000+patch` 白名单公式,吞任意历史值(3052/4000000 等)首次 bump 即归一
  - beta/release 自动 version:config `beta: { bump: true }` / `release: { bump: true }` 或 CLI `--bump [level]` / `--no-bump`;bump 后强制重新构建,不复用旧产物
  - 护栏:同渠道同 versionName 重复提交警告(beta 多渠道现在也落 history.jsonl);产物版本读取沿用 pack.info/aapt
  - 支持标准模板形态:AGP gradle 字面量、Xcode pbxproj、DevEco app.json5、pubspec.yaml、package.json、tauri.conf、Expo app.json;version catalog 引用形态识别并提示改造,不代写

## 0.4.0

### Minor Changes

- bf29106: 配置加载器 jiti 别名（@applift/core / @applift/cli 指向自带模块）与 dist 未构建时的 src 入口回退——裸工程导入 defineConfig 的 core 侧配套（与 cli@0.3.0 的重导出配对生效）

## 0.3.0

### Minor Changes

- a8bebb6: 渠道 id agc-harmony 改名 agc（配置键同步：beta 段与 harmony.stores，行为不变）；vivo sign_method 按官方文档字面改小写 hmac-sha256
- 504bc27: 内测多渠道支持：config 新增 test 段（pgyer.platforms / agc-harmony.submit+group+testType / testflight）；AGC 邀请测试可选自动提审（提交测试版本 API + 测试群组按名匹配绑定）。apkgo 源码仲裁修复：vivo 审核状态改读 data.status（1草稿/2待审核/3通过/4不通过/5撤销，旧 auditStatus 0/1/2 系误记）+ sign_method 改 HMAC-SHA256；小米 push 必带 icon（android.stores.xiaomi.icon 配置，SIG 一并签名）；应用宝 arm64-only 包改传 apk32_flag=2+apk64_flag=1（新增零依赖 APK ABI 探测）；OPPO 911216 补任务结果轮询

## 0.2.0

### Minor Changes

- a1629df: 全渠道 API 契约对照现行官方文档审计修复（2026-10，共 10 渠道 40+ 接口逐条核对）：华为安卓 app-file-info files 数组化 + 审核意见改 auditInfo.auditOpinion + listing 文案接口 v3→v2；App Store 提审迁移 reviewSubmissions 三步流（旧 appStoreVersionSubmissions 已下线）+ appVersionState 过滤参数 + earliestReleaseDate 字段修正；荣耀文案接口 languageInfoList 嵌套结构（旧扁平结构必败）+ 状态查询改 get-app-current-release；OPPO pkg_name 参数名 + audit_status 现行对照表重映射（原映射整体错位）+ app/upd 异步任务结果轮询；应用宝 query_app_detail 补 pkg_name + 扁平响应解析；vivo errorHints 现行码表 + updateDesc 上限校验；Google Play 轨道部署合并保留旧 versionCode + 状态查询改官方只读端点；AGC 鸿蒙提审前更新说明缺失预警。小米/蒲公英/签名算法均与现行文档一致未动。

## 0.1.3

### Patch Changes

- 8f63ef5: AGC 测试发布重构为 Testing API 新链路（华为已下线 releaseType=6 直绑 app-package-info，枚举仅剩 1/7）：上传 .hap → 新建测试版本（testType=3 邀请测试）→ 添加测试软件包 → 等云端编译 → 更新测试版本绑定；不再自动写应用文案（测试信息继承全网版本）。2026-10 真实链路实测发现。
- b03bbaf: 适配华为 AGC appid-list 接口变更：packageName 改为必传查询参数，并支持新版响应形态 appids=[{key,value}]（旧形态 appIds/appIdList 保留兜底）——2026-10 真实链路实测发现
- bee7885: 蒲公英云端处理轮询上限从 5 分钟提升到 15 分钟（真实 95MB APK 实测处理超 5 分钟），超时错误信息引导到控制台确认

## 0.1.2

### Patch Changes

- 59a758f: 验证 trusted publisher 直发（npm publish）链路

## 0.1.1

### Patch Changes

- e2a3348: init
