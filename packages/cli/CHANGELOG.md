# @applift/cli

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
