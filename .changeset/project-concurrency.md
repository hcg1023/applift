---
"@applift/core": patch
"@applift/cli": patch
---

渠道并发数 `concurrency`（1-8）提升为项目级配置：`applift.config.ts` 可直接声明（渠道数是项目属性，如七安卓渠道全开需 ≥7）。优先级：项目 applift.config.ts > 全局 ~/.applift/config.toml（个人兜底，保留） > 默认 4。此前仅全局可配。
