---
"@applift/cli": patch
"@applift/core": patch
---

pushy 服务端真实契约修复（qy-driver 首次真实发布实测暴露，2026-10-21）：

- **UA 必须官方形态**：`/upload` 按 `react-native-update-cli/<版本>` 做客户端版本门禁，自有 UA 被 400 拒绝；且 UA 必须单 token（附加标识破坏服务端版本解析）。已钉 `react-native-update-cli/2.29.3`（载荷反推基准版本）。
- **deps 强制上报**：`version/create`/`package/create` 要求 `deps["react-native-update"] >= 10.53.1`（2026-09-17 后创建的应用），缺省 400。新增 `readDepVersions(cwd)`（官方 dep-versions 同构：直接依赖 → node_modules 实装版本，逐级向上，键排序）。
- **不上报 commit**：官方 getCommitInfo 同构形态的 commit 字段被 version/create 以「上传凭据无效」拒绝（实测去除即过）；溯源走本地 history.jsonl。
- **直传走 node:http(s) 原生**：undici fetch 直传 OSS（同字节同头）后服务端不认账（version/create 报凭据无效，实测 node:https 即过）；multipart/预签名 PUT 统一 `nodeHttpUpload`，`httpUpload` 注入保持可测。
- `/upload` 恒带 `chunked: true`（与官方一致；chunked 指令本身是 GCS 后端特性，SaaS 响应仍为整文件表单）。
- query 对 200 空 body 兜底 `{}`（原实现解构 undefined 崩溃）。
- 修复：`beta <platform>` 快捷路径 AGC 分支不读 `beta.agc.submit/group/testType` 配置（与多渠道并行路径不一致，单平台从不提审）。
- pushy-api 测试切换 httpUpload 注入通道，补 readDepVersions/nodeHttpUpload/边界分支覆盖（branches 92.2% 过 92% 阈值）。
