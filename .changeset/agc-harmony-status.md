---
"@applift/core": minor
---

AGC 鸿蒙渠道 status 接入（capabilities.status=true，"v1 亦无"的结论已过时——华为已上线版本列表接口）：

- `POST /api/publish/v3/version/brief-info/list` 查商用版本列表，`state` 字段取值同 AppInfo.releaseState 全表（与华为安卓渠道同表）：0=已上架、3=待上架、4/5=审核中、1/8=审核不通过、2=已下架、7=草稿、11=撤销上架 → ReviewStatus
- 只取商用版本（`testType` 缺省或 1）；测试版本（3=邀请/4=公开，走 Testing API 链路）不混入 status 语义，过滤后为空返回 unknown（fail-safe 不误报）
- 多个商用版本取 `updateTime` 最新；认证与现有 AGC 链路同源（client_id + access_token），appId 缺省时按 bundleName 查（复用 `getHarmonyAppId`）
- 已知边界：商用版本的 testType=1 是基于本仓 Testing API 同枚举的推断（官方数据模型文档动态加载拿不到枚举表），真实链路首次使用时核对；若过滤漏掉商用版本表现为 unknown 而非误报
