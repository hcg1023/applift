---
"@applift/core": minor
"@applift/cli": minor
---

生产就绪加固。

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
