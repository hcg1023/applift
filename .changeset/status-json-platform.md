---
"@applift/cli": minor
---

status --json wrapped report with platform field: stdout 由裸 `{ status: results }` 改为 `{ fetchedAt, results }` 包装，每项新增 `platform`（一期全部 "android"）与 `fetchedAt` 单渠道时间戳。
