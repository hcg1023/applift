---
"@applift/core": patch
---

补发遗漏：`betaPackageVersion`/`readDepVersions`/`readCommitInfo`/`nodeHttpUpload`/`HttpUploadImpl` 从 `@applift/core/plugins` 导出（`@applift/cli@0.8.0` 的产物探测版本感知依赖这些导出，core 未同步发版导致运行时缺导出崩溃）。
