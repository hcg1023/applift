---
"@applift/core": minor
"@applift/cli": minor
---

对抗审查第二轮修复（0.6.0/0.5.0 之后合入）。

#### @applift/core

- pipeline 错误消息解包一层 cause：fetch 网络层的真实原因（如 NotReadableError）不再藏在外壳错误里。
- humanizeError 新增 NotReadableError 提示：产物/图标在上传期间被修改会被正确诊断为文件变更，而非误导性的网络故障提示。
- fileBlob 打开文件失败时报错补全路径（openAsBlob 原生报错不含路径）。
- stores 混排数组的单键违规改以 zod issue 呈现（进入人话化校验信息），不再裸抛绕过 safeParse。

#### @applift/cli

- release 凭据加载改走分层链（项目级 .applift/credentials.json）：修复"doctor 绿灯但 release 报凭据 profile 不存在"（私有仓项目级凭据场景）。
- 提审确认处 Ctrl-C 正确退出 130（此前该路径退 1，与取消契约不符）。
- `--dry-run --submit` 零副作用预览不再被非交互提审门控误拦。
- bump 非交互门控认 config.toml 的 assumeYes（与提审门控自荐的补救方式一致）。
- `version bump --no-commit --tag` 的确认文案如实显示将创建 tag。
- bin 兜底 unhandledRejection 转人话退出（规避 undici ≥7.20 上传流错误的进程级崩溃）。
