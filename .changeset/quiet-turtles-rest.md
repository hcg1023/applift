---
"@applift/core": minor
---

内测多渠道支持：config 新增 test 段（pgyer.platforms / agc-harmony.submit+group+testType / testflight）；AGC 邀请测试可选自动提审（提交测试版本 API + 测试群组按名匹配绑定）。apkgo 源码仲裁修复：vivo 审核状态改读 data.status（1草稿/2待审核/3通过/4不通过/5撤销，旧 auditStatus 0/1/2 系误记）+ sign_method 改 HMAC-SHA256；小米 push 必带 icon（android.stores.xiaomi.icon 配置，SIG 一并签名）；应用宝 arm64-only 包改传 apk32_flag=2+apk64_flag=1（新增零依赖 APK ABI 探测）；OPPO 911216 补任务结果轮询
