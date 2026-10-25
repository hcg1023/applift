# @applift/cli

## 0.12.0

### Minor Changes

- 951ffbc: 修复 AGC 鸿蒙测试提审与 pushy 基线上传的三个发版阻塞问题（qy-driver 2026-10-25 实测）：

  - **AGC 提审三字段互异**：`languages[].appDesc` 与 `newFeatures` 同值被 AGC 拒绝（204144692 "description and briefInfo and new Features cant be the same"）。`appDesc` 改为取新配置 `beta.agc.appDesc`（缺省用通用基线文案），`newFeatures` 用 `--note`，两者来源互异。
  - **pushy 基线 409 自动替换**：测试孪生体同版本名重建（原生依赖修复不改 versionName）时，`uploadApp` 撞 409「原生包已存在」。现在自动检查该基线名下有无热更版本绑定：无绑定 → 删旧基线重传（全程日志可溯）；有绑定或服务端未回显绑定关系 → 保守拒绝并给出人工处理指引，绝不自动删被热更依赖的基线。
  - **在审版本清理提示**：AGC 停版遇 `state is 9998`（版本在审中，平台不允许停/删）时，告警附带可行动指引（控制台撤回审核或等审毕后下次发版自动清理）。

  另：0.11.0 发布时未包含 PR #41（AGC 提审三前置自动携带），本版本一并带出。

### Patch Changes

- Updated dependencies [951ffbc]
  - @applift/core@0.12.0

## 0.11.0

### Minor Changes

- 85a0a91: AGC 邀请测试提审链路修复（qy-driver 2026-10-25 实测逐字段对因）：

  - **提审三前置自动携带**：`uploadBeta` 绑定 PUT 现带 `extInfo.privacyPolicy`（新增配置 `beta.agc.privacyPolicy`，对应控制台版本创建的「自定义协议」，缺失提审报 204144692 privacyPolicy is necessary）、`languages` 中文版本描述（appDesc/newFeatures 取 `--note`，缺失报 Description is necessary）、`openTestInfo.testTaskInfo.displayArea: "1"`（邀请测试必填测试专区，缺失报 displayArea is necessary）。
  - **beta harmony 双产物探测防串包**：`--via agc`（默认）探测按 `.app` 扩展名过滤（与 release 同口径），mtime 更新的 internaltesting `.hap` 不再抢位（原会报「Testing API 不再接受 .hap」）。
  - errorHints 204144692 指引同步更新。

## 0.10.0

### Minor Changes

- aed5448: 版本声明与交付封板分离（bump-semantics，设计文档 docs/bump-semantics.md）：

  - **`applift version bump` 默认不打 tag**：bump = 版本声明（写工程文件 + CHANGELOG + `chore(release):` commit）；tag = 交付标记，由 `release` 全渠道提审成功后补打。**破坏性变更**：`--no-tag` 旗标已移除（默认即不打）；依赖「bump 即打 tag」的脚本需改带 `--tag`（显式逃生口，保留旧行为）
  - **判定锚点升级**：最新 semver tag 与最新 `chore(release):` commit 按 committer time 取新者（`latestVersionAnchor`）——修复「多次 beta 不重复 bump」此前依赖 bump 顺手打 tag 推走锚点的巧合设计；去 tag 化后若锚点仍只认 tag，bump 写入的版本文件（原生目录内）会被判为原生改动、连环烧版本号
  - **beta 原生三态判定**：① 原生·需 bump → 引导三步（含推荐版本与推断理由）；② 原生·已声明（工程版本领先最近发布 tag）→ 只引导重建 + `--delivery native`，不再建议 bump；③ OTA 不变。锚点推进后纯 JS 改动正确判热更
  - **新增 `applift beta <platform> --bump [level]`**：判定需 bump 时自动声明（缺省 level 用 conventional commits 推断，`--yes` 跳过确认），完成即打印重建与重跑指引；新增配置 `beta.autoBump`（默认 false）= 永远带 `--bump`，CI 配合 `--yes`
  - **release 补 tag 冲突告警**：tag 已存在但指向不同 commit（历史提前 tag / 驳回重提后未移动）→ 显式告警而非静默跳过（`TagResult.conflict`）
  - 已知边界（AGENTS.md 已记录）：`--no-commit` 不产生锚点；驳回重提的 tag 移动为人工操作；squash-merge 丢 `chore(release):` 标记；多端异步发布存在全局锚点盲区（既有行为）

### Patch Changes

- 88b309d: AGC 鸿蒙测试发布自动清理旧测试版本（`beta.agc.cleanup`，默认开，消费方零配置升级即生效）：

  - 根因：AGC 测试版本数量约束——在审上限（提交报 204144692 "count of harmony test in audit"）、在架上限（邀请测试 3 / 公开测试 1 / 总数 100）；AGC 不自动下架旧测试版本，旧版本堆积后必须到控制台人工停止/删除才能提审新版本。versionCode 递增只解决「包不可选」维度，不解决数量维度
  - 时机：`uploadBeta` 上传完成后、新建测试版本之前——缩短测试设备的「不可安装」窗口，且新版本绝无被误删可能
  - 发现：复用 `POST /api/publish/v3/version/brief-info/list` 反向过滤 `testType` 3/4（与 status() 的商用过滤互补），拿到旧测试版本 versionId；**故意不解读 state**（测试版本 state 枚举与商用 releaseState 表不一致且未实机验证，清理全部旧版本无需依赖）
  - 清理：`POST /api/publish/v2/test/version/stop`（完全下架）→ `DELETE /api/publish/v2/test/app/version`（官方指南顺序）；best-effort——查询/单版本 stop/delete 失败仅告警不阻断发布，名额仍被占时提审 204144692 errorHint 兜底提示人工
  - 影响面：已装设备 App 本体与 pushy 热更均不受影响（只移除 AGC 在架记录）；受影响的仅审核空窗期内想经 AGC 邀请链接新装的人（蒲公英 .hap 通道不受影响）
  - 逃生口：`beta.agc.cleanup: false` 完全恢复旧行为（不查旧版本、不发清理请求）
  - 已知未验证：stop 对「审核中」版本是否有效（官方 stop 文档针对在架版本）——真实链路首用核对

- Updated dependencies [88b309d]
- Updated dependencies [aed5448]
  - @applift/core@0.11.0

## 0.9.0

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

### Patch Changes

- Updated dependencies [96b3554]
  - @applift/core@0.10.0

## 0.8.3

### Patch Changes

- Updated dependencies [b48ab7b]
- Updated dependencies [a6b8346]
  - @applift/core@0.9.0

## 0.8.2

### Patch Changes

- 1a1c96a: 修复探测版本感知在发布产物中的运行时崩溃：偏移算法（major+1000）内联进 CLI，不再从 `@applift/core/plugins` 静态 import `betaPackageVersion`——其 chunk 链上的具名 re-export 会被 ESM 链接期校验拒绝（动态 import 可见、静态 import 报 does not provide，实测 cli 0.8.0/0.8.1 在消费项目崩溃）。算法与 rn-update 的 `betaPackageVersion` 同构。

## 0.8.1

### Patch Changes

- Updated dependencies [7da28ed]
  - @applift/core@0.8.2

## 0.8.0

### Minor Changes

- 72b8e8f: **产物探测版本感知**：beta/release 的自动探测按「期望版本号」过滤产物（`readArtifactVersion` 读包内嵌版本）——版本语义落到探测层：

  - **beta**：已接入热更的平台期望偏移测试包（`betaPackageVersion(工程版)`，如 1004.0.0）——测试设备装偏移包才能收到测试线热更；探测不到时明确引导「用 npm run build:test:<platform> -- --offset 构建或 --artifact 显式指定」。未接热更的平台不校验（维持现状）。
  - **release**：期望工程 versionName——偏移测试包（1004.x）/旧版本产物不能用于正式分发，拦截并引导先构建正式产物（qy-driver dry-run 实测：遗留 1004.0.0 .app 被正确拦截，原行为会以 1004.0.0 提审上架）。
  - 读不出版本的产物（.ipa 等不支持格式）放行不校验（ASC/渠道侧有各自的校验）。
  - `betaPackageVersion` 从 core/plugins 导出供 CLI 复用；`readProjectVersions` 为既有导出。

## 0.7.2

### Patch Changes

- 3bebdf9: 修复 release 原生路径产物探测不按上架扩展名过滤：双产物工程（internaltesting .hap + release .app）按 mtime 最新可能选中测试签名包用于正式上架（渠道层有终验会报错拦下，但探测就该选对）。上架扩展名约束与 beta 分流同源：harmony=.app（AGC 不收单 .hap）、android=.apk/.aab、ios=.ipa；探测到产物但无可接受扩展名时给出「测试签名包不能上架」的明确引导。qy-driver dry-run 实测：修复前误选 internaltesting.hap，修复后正确选 release .app。

## 0.7.1

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

- Updated dependencies [e81a7e4]
  - @applift/core@0.8.1

## 0.7.0

### Minor Changes

- 497d053: pushy 热更链路四项改造（2026-10-20 定稿，详见 AGENTS.md）：

  1. **服务端操作迁 OpenAPI**：publish/uploadApp/rebind/versions 全部改 HTTP 客户端（pushy-api.ts，`x-api-token` 鉴权，token = `~/.applift/credentials.json` 的 `PUSHY_API_TOKEN`，CI 可用同名环境变量覆盖），不再 spawn pushy CLI、不解析中文人读输出、不依赖 `pushy login`。载荷对照 react-native-update-cli 2.29.3 参考实现反推并由契约测试钉死。
  2. **ppk 产物化**：ppk 是构建产物（pushy bundle = metro + hermesc），applift 不 spawn 构建命令——项目先行产出（如 `npm run ppk:<platform>`），applift 按 `--artifact` 或 `ppkPatterns`（默认 `.pushy/output/{platform}.*.ppk`，三端同构）探测 mtime 最新；探测路径强制新鲜度护栏（ppk 须新于未发布改动，`--artifact` 显式跳过）。pushy-cli.ts 删除，applift 运行时对 pushy CLI 依赖清零。
  3. **热更不依赖 beta**（UpdateProvider 契约）：`publishToProd()` 必选（探测 ppk → 取号 → 绑正式版本 + rollout 直接发正式）；`publishToBeta?`/`promoteToProd?` 可选（promote 返回 null = 测试通道无货，调用方转 publishToProd）。release ota 两条腿：有已验证测试热更 → promote（零构建）；无 → 直接发正式。
  4. **术语统一 beta**：applift 自有命名全链路 beta（`publishToBeta`、`betaPackageVersion`、config `beta:` 段、`applift beta` 命令）；pushy 物理域描述保留「测试」措辞，semver prerelease `-beta.N` 不受影响。

  配套：`PublishContext` 增 `credentials`/`artifact`、`HookContext` 增 `credentials`（stage:after 基线上传走 token）；beta creds 解析上提并容错（纯热更项目可无渠道凭据）；`stage:after` 基线版本号由 `readArtifactVersion` 从产物读取；`KNOWN_CREDENTIAL_KEYS` 增 `PUSHY_API_TOKEN`。

### Patch Changes

- Updated dependencies [4775143]
- Updated dependencies [497d053]
  - @applift/core@0.8.0

## 0.6.2

### Patch Changes

- 81f0f24: 消费方类型链路与热更灰度默认：① `@applift/cli` build 加 `--dts` 且 `exports` 补 `types` 条件——此前 dist 无类型文件，消费方 applift.config.ts 只能 `@ts-expect-error` 压制；② 新增 `./plugins` 子导出（re-export core/plugins），配置文件只依赖 `@applift/cli` 即可导入 `rnFramework` / `rnUpdate` 且类型完整（不必把传递依赖 `@applift/core` 的提升布局当契约）；③ `promoteToProd` 灰度比例内置默认 100（全量）——promote 语义是"测试通道已验证、发正式"，全量是常态、灰度是显式选择（`--rollout` > `rnUpdate({ defaultRollout })` > 默认）。
- Updated dependencies [81f0f24]
  - @applift/core@0.7.2

## 0.6.1

### Patch Changes

- 816a932: 运行时健壮性：CLI 版本读取改 JSON import 内联（消除运行时对包文件的 readFileSync 依赖）；CI 新增 `runtime-bun` job 做 bun 直跑 dist 基本命令冒烟（`--version` / `channels`）。运行时承诺定为 Node ≥20 唯一（runtime-node20 门禁）；bun 基本兼容不承诺——配置装载（c12/jiti）在 ubuntu + bun 下读不到配置（CI 实证未根因），读配置命令请用 Node；`bun build --compile` 单文件二进制分发经评估不做（配置与插件深耦合工程 node_modules，裸机场景不存在）。
- Updated dependencies [816a932]
  - @applift/core@0.7.1

## 0.6.0

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

### Patch Changes

- Updated dependencies [b1d3567]
  - @applift/core@0.7.0

## 0.5.0

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

### Patch Changes

- Updated dependencies [725cd53]
  - @applift/core@0.6.0

## 0.4.0

### Minor Changes

- 29cd2a6: version 管理:applift version show/bump + beta/release 自动 version 编排

  - `applift version` 各端版本实况(versionName/versionCode + 文件路径 + 发版锚点 tag)
  - `applift version bump [major|minor|patch|prerelease|<semver>] [--pre beta]`:写各端工程文件(行级幂等改写保注释)→ 生成 CHANGELOG.md → 代 commit(chore(release))→ 代打 tag;push 永不代做
  - 版本决定链:显式指定 > git conventional commits 推断(BREAKING/feat/fix)> patch 兜底;semver 全程托管,prerelease 只进 tag、商店 versionName 恒三段数字
  - versionCode = max(公式值, 现值+1):默认递增;config `version.versionCode.formula` 支持 `major*1000000+minor*1000+patch` 白名单公式,吞任意历史值(3052/4000000 等)首次 bump 即归一
  - beta/release 自动 version:config `beta: { bump: true }` / `release: { bump: true }` 或 CLI `--bump [level]` / `--no-bump`;bump 后强制重新构建,不复用旧产物
  - 护栏:同渠道同 versionName 重复提交警告(beta 多渠道现在也落 history.jsonl);产物版本读取沿用 pack.info/aapt
  - 支持标准模板形态:AGP gradle 字面量、Xcode pbxproj、DevEco app.json5、pubspec.yaml、package.json、tauri.conf、Expo app.json;version catalog 引用形态识别并提示改造,不代写

### Patch Changes

- Updated dependencies [29cd2a6]
  - @applift/core@0.5.0

## 0.3.1

### Patch Changes

- Updated dependencies [bf29106]
  - @applift/core@0.4.0

## 0.3.0

### Minor Changes

- 549f23e: applift.config.ts 支持从 @applift/cli 导入 defineConfig（CLI 重导出）；配置加载器注入 jiti 别名，裸工程（未安装 applift 依赖）里 @applift/cli / @applift/core 的导入自动指向 CLI 自带模块，目标工程零依赖即可使用类型化配置

## 0.2.0

### Minor Changes

- a8bebb6: 小米 icon 自动发现扩展：新增 Tauri 2 移动端支持（src-tauri/icons 探测序），配合此前的 Android res 双根（RN/Flutter/Expo/原生安卓全覆盖）
- 504bc27: beta 命令支持配置驱动的多渠道并行内测：`applift beta`（无平台参数）读取 applift.config.ts 新增的 test 段（pgyer/agc-harmony/testflight），三端产物各走各的渠道并行发布，逐渠道报告结果；`beta <platform>` 快捷方式不变

### Patch Changes

- Updated dependencies [a8bebb6]
- Updated dependencies [504bc27]
  - @applift/core@0.3.0

## 0.1.6

### Patch Changes

- Updated dependencies [a1629df]
  - @applift/core@0.2.0

## 0.1.5

### Patch Changes

- 630a65b: beta 命令透传渠道 warn 事件（此前绑定失败等警告被静默导致假成功）；AGC 测试发布成功文案对齐 Testing API 新语义
- Updated dependencies [8f63ef5]
- Updated dependencies [b03bbaf]
- Updated dependencies [bee7885]
  - @applift/core@0.1.3

## 0.1.4

### Patch Changes

- e804d4f: 修复 `applift --version` 硬编码 0.2.0 的问题，改为从 package.json 动态读取

## 0.1.3

### Patch Changes

- d79c447: cli 直发链路验证（0.1.2 因 trusted publisher 配置切换期间暂存条目丢失，由本版补位）

## 0.1.2

### Patch Changes

- 59a758f: 验证 trusted publisher 直发（npm publish）链路
- Updated dependencies [59a758f]
  - @applift/core@0.1.2

## 0.1.1

### Patch Changes

- e2a3348: init
- Updated dependencies [e2a3348]
  - @applift/core@0.1.1
