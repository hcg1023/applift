---
"@applift/cli": patch
---

修复 `applift --version` 硬编码 0.2.0 的问题，改为从 package.json 动态读取
