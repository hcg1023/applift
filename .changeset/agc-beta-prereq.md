---
"@applift/cli": minor
---

AGC 邀请测试提审链路修复（qy-driver 2026-10-25 实测逐字段对因）：

- **提审三前置自动携带**：`uploadBeta` 绑定 PUT 现带 `extInfo.privacyPolicy`（新增配置 `beta.agc.privacyPolicy`，对应控制台版本创建的「自定义协议」，缺失提审报 204144692 privacyPolicy is necessary）、`languages` 中文版本描述（appDesc/newFeatures 取 `--note`，缺失报 Description is necessary）、`openTestInfo.testTaskInfo.displayArea: "1"`（邀请测试必填测试专区，缺失报 displayArea is necessary）。
- **beta harmony 双产物探测防串包**：`--via agc`（默认）探测按 `.app` 扩展名过滤（与 release 同口径），mtime 更新的 internaltesting `.hap` 不再抢位（原会报「Testing API 不再接受 .hap」）。
- errorHints 204144692 指引同步更新。
