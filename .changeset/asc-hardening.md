---
"@applift/core": minor
"@applift/cli": minor
---

ASC 提审链路加固（fastlane 审查落地，docs/fastlane-adoption.md）：

- 提审前有界等待构建处理完成（30s 轮询 / 30min 上限，产物 versionName+versionCode 精确锚定防多 train 绑错包；X.Y≡X.Y.0 双格式兼容）
- stage 前 build 号占用预检（ios build 号全 app 唯一，提前拦截省一次无效上传）
- 提审幂等三查：已在审拒绝 / 未提交草稿复用 / 他人条目拒绝
- 可编辑版本状态机扩展：被拒四态可续用；PREPARE 异号改名；被拒异号报错人工处置
- AscClient：JWT 惰性续签 + iat-60 时钟偏移防御、GET 429/5xx 自动重试、401 重签、写操作不重试、协议未签专属提示
- 出口合规可配置代答（ios.exportCompliance，build 未声明才写）；提审预检规则化（warn/error 分级）
- iOS 分阶段发布开关（ios.phasedRelease，官方首版限制自动跳过）
- 渠道共享 pollUntil，AGC/oppo/pgyer 轮询统一（行为不变）
