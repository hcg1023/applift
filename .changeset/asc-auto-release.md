---
"@applift/core": minor
"@applift/cli": minor
---

iOS App Store 上架方式从固定手动发布改为三档可选（官方文档核查 2026-11-11：首版亦可自动发布，唯一强制手动场景为"预购且从未上架"）：

- **行为变更**：默认改为审核通过自动上架（releaseType=AFTER_APPROVAL），此前默认手动
- 配置 `ios.release: "auto" | "manual"` 固定项目约定（默认 auto）
- `--release-mode <auto|manual>` 单次覆盖配置；与 `--release-time` 互斥（定时上架仍走 `--release-time` → SCHEDULED）
- 提审确认界面对 iOS 自动上架同样给出"无法撤回"警示
