---
"@applift/core": minor
"@applift/cli": minor
---

版本声明与交付封板分离（bump-semantics，设计文档 docs/bump-semantics.md）：

- **`applift version bump` 默认不打 tag**：bump = 版本声明（写工程文件 + CHANGELOG + `chore(release):` commit）；tag = 交付标记，由 `release` 全渠道提审成功后补打。**破坏性变更**：`--no-tag` 旗标已移除（默认即不打）；依赖「bump 即打 tag」的脚本需改带 `--tag`（显式逃生口，保留旧行为）
- **判定锚点升级**：最新 semver tag 与最新 `chore(release):` commit 按 committer time 取新者（`latestVersionAnchor`）——修复「多次 beta 不重复 bump」此前依赖 bump 顺手打 tag 推走锚点的巧合设计；去 tag 化后若锚点仍只认 tag，bump 写入的版本文件（原生目录内）会被判为原生改动、连环烧版本号
- **beta 原生三态判定**：① 原生·需 bump → 引导三步（含推荐版本与推断理由）；② 原生·已声明（工程版本领先最近发布 tag）→ 只引导重建 + `--delivery native`，不再建议 bump；③ OTA 不变。锚点推进后纯 JS 改动正确判热更
- **新增 `applift beta <platform> --bump [level]`**：判定需 bump 时自动声明（缺省 level 用 conventional commits 推断，`--yes` 跳过确认），完成即打印重建与重跑指引；新增配置 `beta.autoBump`（默认 false）= 永远带 `--bump`，CI 配合 `--yes`
- **release 补 tag 冲突告警**：tag 已存在但指向不同 commit（历史提前 tag / 驳回重提后未移动）→ 显式告警而非静默跳过（`TagResult.conflict`）
- 已知边界（AGENTS.md 已记录）：`--no-commit` 不产生锚点；驳回重提的 tag 移动为人工操作；squash-merge 丢 `chore(release):` 标记；多端异步发布存在全局锚点盲区（既有行为）
