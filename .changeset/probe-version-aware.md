---
"@applift/cli": minor
---

**产物探测版本感知**：beta/release 的自动探测按「期望版本号」过滤产物（`readArtifactVersion` 读包内嵌版本）——版本语义落到探测层：

- **beta**：已接入热更的平台期望偏移测试包（`betaPackageVersion(工程版)`，如 1004.0.0）——测试设备装偏移包才能收到测试线热更；探测不到时明确引导「用 npm run build:test:<platform> -- --offset 构建或 --artifact 显式指定」。未接热更的平台不校验（维持现状）。
- **release**：期望工程 versionName——偏移测试包（1004.x）/旧版本产物不能用于正式分发，拦截并引导先构建正式产物（qy-driver dry-run 实测：遗留 1004.0.0 .app 被正确拦截，原行为会以 1004.0.0 提审上架）。
- 读不出版本的产物（.ipa 等不支持格式）放行不校验（ASC/渠道侧有各自的校验）。
- `betaPackageVersion` 从 core/plugins 导出供 CLI 复用；`readProjectVersions` 为既有导出。
