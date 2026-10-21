---
"@applift/cli": minor
"@applift/core": minor
---

pushy 热更链路四项改造（2026-10-20 定稿，详见 AGENTS.md）：

1. **服务端操作迁 OpenAPI**：publish/uploadApp/rebind/versions 全部改 HTTP 客户端（pushy-api.ts，`x-api-token` 鉴权，token = `~/.applift/credentials.json` 的 `PUSHY_API_TOKEN`，CI 可用同名环境变量覆盖），不再 spawn pushy CLI、不解析中文人读输出、不依赖 `pushy login`。载荷对照 react-native-update-cli 2.29.3 参考实现反推并由契约测试钉死。
2. **ppk 产物化**：ppk 是构建产物（pushy bundle = metro + hermesc），applift 不 spawn 构建命令——项目先行产出（如 `npm run ppk:<platform>`），applift 按 `--artifact` 或 `ppkPatterns`（默认 `.pushy/output/{platform}.*.ppk`，三端同构）探测 mtime 最新；探测路径强制新鲜度护栏（ppk 须新于未发布改动，`--artifact` 显式跳过）。pushy-cli.ts 删除，applift 运行时对 pushy CLI 依赖清零。
3. **热更不依赖 beta**（UpdateProvider 契约）：`publishToProd()` 必选（探测 ppk → 取号 → 绑正式版本 + rollout 直接发正式）；`publishToBeta?`/`promoteToProd?` 可选（promote 返回 null = 测试通道无货，调用方转 publishToProd）。release ota 两条腿：有已验证测试热更 → promote（零构建）；无 → 直接发正式。
4. **术语统一 beta**：applift 自有命名全链路 beta（`publishToBeta`、`betaPackageVersion`、config `beta:` 段、`applift beta` 命令）；pushy 物理域描述保留「测试」措辞，semver prerelease `-beta.N` 不受影响。

配套：`PublishContext` 增 `credentials`/`artifact`、`HookContext` 增 `credentials`（stage:after 基线上传走 token）；beta creds 解析上提并容错（纯热更项目可无渠道凭据）；`stage:after` 基线版本号由 `readArtifactVersion` 从产物读取；`KNOWN_CREDENTIAL_KEYS` 增 `PUSHY_API_TOKEN`。
