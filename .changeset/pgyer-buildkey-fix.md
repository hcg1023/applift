---
"@applift/core": patch
---

修复蒲公英上传永远轮询超时：getCOSToken 响应按官方契约取 `data.key` 作为 buildKey（原实现解构不存在的 `data.buildKey` 得 undefined，buildInfo 轮询永远返回 1247「处理中」直至 15 分钟超时——上传本身是成功的，控制台可见）。测试桩同步改为官方契约（此前桩与实现一起错，全绿掩盖 bug）。2026-10-20 线上实证：修复后 41 秒轮询成功出短链。
