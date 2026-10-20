# @applift/cli

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
