---
"@applift/cli": patch
---

修复探测版本感知在发布产物中的运行时崩溃：偏移算法（major+1000）内联进 CLI，不再从 `@applift/core/plugins` 静态 import `betaPackageVersion`——其 chunk 链上的具名 re-export 会被 ESM 链接期校验拒绝（动态 import 可见、静态 import 报 does not provide，实测 cli 0.8.0/0.8.1 在消费项目崩溃）。算法与 rn-update 的 `betaPackageVersion` 同构。
