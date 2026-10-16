---
"@applift/cli": minor
---

applift.config.ts 支持从 @applift/cli 导入 defineConfig（CLI 重导出）；配置加载器注入 jiti 别名，裸工程（未安装 applift 依赖）里 @applift/cli / @applift/core 的导入自动指向 CLI 自带模块，目标工程零依赖即可使用类型化配置
