---
"@applift/core": minor
"@applift/cli": minor
---

修复 AGC 鸿蒙测试提审与 pushy 基线上传的三个发版阻塞问题（qy-driver 2026-10-25 实测）：

- **AGC 提审三字段互异**：`languages[].appDesc` 与 `newFeatures` 同值被 AGC 拒绝（204144692 "description and briefInfo and new Features cant be the same"）。`appDesc` 改为取新配置 `beta.agc.appDesc`（缺省用通用基线文案），`newFeatures` 用 `--note`，两者来源互异。
- **pushy 基线 409 自动替换**：测试孪生体同版本名重建（原生依赖修复不改 versionName）时，`uploadApp` 撞 409「原生包已存在」。现在自动检查该基线名下有无热更版本绑定：无绑定 → 删旧基线重传（全程日志可溯）；有绑定或服务端未回显绑定关系 → 保守拒绝并给出人工处理指引，绝不自动删被热更依赖的基线。
- **在审版本清理提示**：AGC 停版遇 `state is 9998`（版本在审中，平台不允许停/删）时，告警附带可行动指引（控制台撤回审核或等审毕后下次发版自动清理）。

另：0.11.0 发布时未包含 PR #41（AGC 提审三前置自动携带），本版本一并带出。
