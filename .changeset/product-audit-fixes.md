---
"@applift/core": minor
"@applift/cli": minor
---

产品/交互审查落地：配置面"每个键都算数" + 交互面"每个等待可见"（PM/UE 两席审查产出，14 项修复）：

**配置接线（承诺但未接线的死配置）**

- `beta.agc.cleanup: false` 逃生口接线：此前 CLI 从未把配置写入 target，渠道侧清理恒开——配置关不掉旧测试版本 stop+delete（删数据类操作）；现两条 beta 路径（多渠道并行 / beta harmony）均透传，补 CLI 接线 e2e
- `defaultProfile`（~/.applift/config.toml）接入 profile 解析链：此前定义但零消费，README 优先级公理的全局层名存实亡；现为第四层（旗标 > applift use > 项目 profile > 全局 defaultProfile > default），use/status/doctor/release/beta/listing 六入口全接，doctor 与 use 展示新来源
- 删除 `uploadTimeoutMs` 死旋钮：零消费方（各渠道超时各自实现），配置调它毫无作用

**交互修复**

- `progress` 事件渲染接线：渠道轮询进度（ASC 等构建 30 分钟级、AGC 云端编译、OPPO 任务轮询）此前被 CLI 静默丢弃，终端零输出最长 30 分钟；现统一写 stderr（脱敏，保 --json stdout 纯净），beta 快捷路径接 spinner message
- 两段式提审确认文案按实际上架方式聚合展示（manual 用户此前被错误的"审核通过即自动上架"误导）
- `--release-mode scheduled` 报错补指路 `--release-time`；`--release-mode` 非 iOS 平台警告（对齐 --rollout 的"参数给了无人消费必须可见"原则）
- `--release-time` 对不支持定时的渠道（oppo/vivo/小米/googleplay）逐渠道警告——防"以为全渠道定时"的危险静默
- `version bump --no-commit` 输出锚点丢失警告（后续 beta 判定将停留上一锚点，可能重复建议 bump）
