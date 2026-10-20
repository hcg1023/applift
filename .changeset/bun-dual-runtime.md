---
"@applift/core": patch
"@applift/cli": patch
---

运行时健壮性：CLI 版本读取改 JSON import 内联（消除运行时对包文件的 readFileSync 依赖）；CI 新增 `runtime-bun` job 做 bun 直跑 dist 基本命令冒烟（`--version` / `channels`）。运行时承诺定为 Node ≥20 唯一（runtime-node20 门禁）；bun 基本兼容不承诺——配置装载（c12/jiti）在 ubuntu + bun 下读不到配置（CI 实证未根因），读配置命令请用 Node；`bun build --compile` 单文件二进制分发经评估不做（配置与插件深耦合工程 node_modules，裸机场景不存在）。
