---
"@applift/core": minor
"@applift/cli": minor
---

对抗审查第二、三轮修复（0.6.0/0.5.0 之后合入）。

#### @applift/core

- pipeline 错误消息解包一层 cause：fetch 网络层的真实原因（如 NotReadableError）不再藏在外壳错误里。
- humanizeError 新增 NotReadableError 提示：产物/图标在上传期间被修改会被正确诊断为文件变更，而非误导性的网络故障提示。
- fileBlob 打开文件失败时报错补全路径（openAsBlob 原生报错不含路径）。
- AGC 鸿蒙正式链路 submit 复用 stage 的 packageId：默认发版流程不再双倍上传整包（数百 MB~GB 级），`--skip-stage` 免重传承诺兑现；OBS PUT 改流式上传。
- 应用宝跨进程 `--submit --skip-stage` 无暂存时现场重传当前包再提审（此前必失败，而 CLI 推荐该用法）；蒲公英 buildInfo 轮询按域名 failover 且单次异常不再整体失败；AGC token / ASC ascGet 对非 JSON 网关页给出可定位报错；华为 releaseTime 本地 RFC3339 校验；altool 子进程 30 分钟超时兜底。
- 输出脱敏统一收口：--json 的 error/ref、渠道 emit 事件、beta 三处错误输出、钉钉通知外发全部过 redactText；OPPO/应用宝 done 消息不再内嵌响应体。

#### @applift/cli

- release 凭据加载改走分层链（项目级 .applift/credentials.json）：修复"doctor 绿灯但 release 报凭据 profile 不存在"（私有仓项目级凭据场景）。
- 提审确认处 Ctrl-C 正确退出 130（此前该路径退 1，与取消契约不符）。
- `--dry-run --submit` 零副作用预览不再被非交互提审门控误拦。
- bump 非交互门控认 config.toml 的 assumeYes（与提审门控自荐的补救方式一致）。
- `version bump --no-commit --tag` 的确认文案如实显示将创建 tag。
- bin 兜底 unhandledRejection 转人话退出（规避 undici ≥7.20 上传流错误的进程级崩溃）。
- stage-only 发版自动排除"上传即提审"型渠道（小米等）并明示，不再误报"传包失败修复后重跑"死循环。
- release 无 --stores 时默认渠道按平台与可提审能力过滤：`release android` 不再把正式包发到蒲公英（公网内测）或 ios/harmony 渠道。
- `config.build` 构建命令覆盖接线生效（此前为死配置键）；status/listing/doctor 与 release 统一 profile 解析链（env 覆盖/缺 profile 报错一致）；小米 MI_APP_NAME 凭据键进入 init 向导与自发现面；version 命令透传全局 assumeYes。
