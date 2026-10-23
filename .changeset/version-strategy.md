---
"@applift/core": minor
"@applift/cli": minor
---

版本隔离策略（version-strategy）：把「测试包版本名」从硬编码 major+1000 收敛成可配置策略。

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
