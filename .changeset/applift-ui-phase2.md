---
"@applift/cli": minor
"@applift/ui-server": patch
---

`applift ui`：图形控制台（webui 一期）。后台常驻服务（默认 127.0.0.1:47600）+ 浏览器界面：多项目渠道状态总览与动态时间线、beta 发版向导（判定预览 → 平台确认 → 执行 → 结果）、通用设置。再跑幂等只开浏览器；`--stop` 优雅停止；`--no-open` 无头场景；`--port` 自定义。任务参数白名单（仅 `--delivery`）+ 写路由 Host 校验的安全边界。

阶段一机读面补全（applift-ui / Agent 消费，stdout 纯净）：`applift validate <path> --json`（工程即时校验）、`applift doctor --cwd <dir> --json`（体检报告）、`applift beta <platform> --dry-run --json`（热更判定预览，无需凭据）、`applift beta <platform> --interactive-events`（NDJSON 事件流 + stdin 确认回写，见 README 协议节）。

@applift/ui-server 首发（0.1.0）：applift-ui 的本地服务包——项目注册 REST、CLI 子进程 runner、分级状态轮询聚合器（状态跃迁动态流）、WebSocket 双向通道（快照/动态/发版任务桥 + 确认看门狗 + 归档回放）、静态托管；HostAdapter 宿主能力接口（Tauri 壳二期复用）。随 `@applift/cli` 运行时依赖分发。
