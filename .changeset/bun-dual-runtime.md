---
"@applift/core": patch
"@applift/cli": patch
---

运行时健壮性：CLI 版本读取改 JSON import 内联（消除运行时对包文件的 readFileSync 依赖）；CI 新增 `runtime-bun` 门禁 job（bun 直跑 dist 冒烟 + 裸工程 `applift.config.ts` 配置装载验证）。bun 与 node（≥20）双运行时为长期支持形态；`bun build --compile` 单文件二进制分发经评估不做（配置与插件深耦合工程 node_modules，裸机场景不存在）。
