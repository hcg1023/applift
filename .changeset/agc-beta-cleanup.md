---
"@applift/core": minor
"@applift/cli": patch
---

AGC 鸿蒙测试发布自动清理旧测试版本（`beta.agc.cleanup`，默认开，消费方零配置升级即生效）：

- 根因：AGC 测试版本数量约束——在审上限（提交报 204144692 "count of harmony test in audit"）、在架上限（邀请测试 3 / 公开测试 1 / 总数 100）；AGC 不自动下架旧测试版本，旧版本堆积后必须到控制台人工停止/删除才能提审新版本。versionCode 递增只解决「包不可选」维度，不解决数量维度
- 时机：`uploadBeta` 上传完成后、新建测试版本之前——缩短测试设备的「不可安装」窗口，且新版本绝无被误删可能
- 发现：复用 `POST /api/publish/v3/version/brief-info/list` 反向过滤 `testType` 3/4（与 status() 的商用过滤互补），拿到旧测试版本 versionId；**故意不解读 state**（测试版本 state 枚举与商用 releaseState 表不一致且未实机验证，清理全部旧版本无需依赖）
- 清理：`POST /api/publish/v2/test/version/stop`（完全下架）→ `DELETE /api/publish/v2/test/app/version`（官方指南顺序）；best-effort——查询/单版本 stop/delete 失败仅告警不阻断发布，名额仍被占时提审 204144692 errorHint 兜底提示人工
- 影响面：已装设备 App 本体与 pushy 热更均不受影响（只移除 AGC 在架记录）；受影响的仅审核空窗期内想经 AGC 邀请链接新装的人（蒲公英 .hap 通道不受影响）
- 逃生口：`beta.agc.cleanup: false` 完全恢复旧行为（不查旧版本、不发清理请求）
- 已知未验证：stop 对「审核中」版本是否有效（官方 stop 文档针对在架版本）——真实链路首用核对
