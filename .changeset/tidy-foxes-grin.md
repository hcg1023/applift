---
"@applift/cli": minor
---

beta 命令支持配置驱动的多渠道并行内测：`applift beta`（无平台参数）读取 applift.config.ts 新增的 test 段（pgyer/agc-harmony/testflight），三端产物各走各的渠道并行发布，逐渠道报告结果；`beta <platform>` 快捷方式不变
