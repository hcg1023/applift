---
"@applift/cli": minor
---

status --json wrapped report with platform field: stdout 由 `{ status: results }` 改为 `{ fetchedAt, results }` 包装，每项新增 `platform`（按渠道 id 映射：agc→harmony、asc→ios、其余→android）与 `fetchedAt` 单渠道时间戳；status 命令同时接入插件 channel:register 自定义渠道。
