---
"@applift/core": patch
---

适配华为 AGC appid-list 接口变更：packageName 改为必传查询参数，并支持新版响应形态 appids=[{key,value}]（旧形态 appIds/appIdList 保留兜底）——2026-10 真实链路实测发现
