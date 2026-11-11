---
"@applift/core": minor
"@applift/cli": minor
---

产品审查第二批（清零批次）：

**命名对齐**
- `ios.release` → `ios.releaseMode`（配置键/旗标 --release-mode/ctx 字段三处同名，消除一词三名；0.x 无存量迁移）

**配置清理**
- 删除 `ios.scheme`/`ios.workspace` 死键（声明"缺省自动推导"但 detectBundleIds 不读配置、无渠道消费——写了被无视）
- `beta.agc.testType` 支持 `"invite" | "open"` 语义枚举（兼容原 3/4 数字，内部归一）

**doctor 兑现 README 承诺**
- 展示项目 name、渠道并发生效值（含来源：项目/全局/默认）、iOS 提审三键状态（releaseMode/出口合规代答/分阶段发布）

**beta 路径错误人话化**
- beta 多渠道并行与 AGC 单平台路径的失败输出接入 errorHints（AGC 204144692 等高频码此前在 beta 是裸码）

**交互补齐**
- ASC 写操作 retryHint 指引补全为 `applift status --stores asc`（iOS-only 项目原指引执行即报错）
- OTA dry-run 分支 `--json` 输出结构化结果（stdout 纯净契约）
- `--submit` + `--dry-run` 同传提示"--submit 不生效"
- ASC 等构建文案对称化（"约 10 分钟，慢时 30 分钟；超时自动中止且重跑安全"）

**异步化**
- Transporter/altool 上传从 spawnSync 改异步 spawn（Promise.withResolvers + 流式捕获）：5-15 分钟上传期间事件循环不再冻结——spinner 动画、其他渠道进度、Ctrl-C 全部恢复正常
