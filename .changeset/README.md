# Changesets

本仓库用 [changesets](https://github.com/changesets/changesets) 管理版本与发布。

## 日常使用

写完一个改动后运行：

```bash
pnpm changeset
```

按提示选择影响范围（`@applift/core` / `@applift/cli`）、bump 类型（patch / minor / major）并填写变更说明，会在 `.changeset/` 下生成一个 markdown 文件，随代码一起提交。

## 发版流程

1. 合并到 `main` 后 CI 通过，Release workflow 自动开启一个 "Release From Changesets" 版本 PR，包含 CHANGELOG 与版本号变更。
2. 合并该版本 PR 后，workflow 自动执行 `pnpm run release` 构建并发布到 npm。
