---
"@applift/cli": minor
"@applift/ui-server": patch
---

`applift ui`：图形控制台（webui 一期）。后台常驻服务（默认 127.0.0.1:47600）+ 浏览器界面：多项目渠道状态总览与动态时间线、beta 发版向导（判定预览 → 平台确认 → 执行 → 结果）、通用设置。再跑幂等只开浏览器；`--stop` 优雅停止；`--no-open` 无头场景；`--port` 自定义。任务参数白名单（仅 `--delivery`）+ 写路由 Host 校验的安全边界。

阶段一机读面补全（applift-ui / Agent 消费，stdout 纯净）：`applift validate <path> --json`（工程即时校验）、`applift doctor --cwd <dir> --json`（体检报告）、`applift beta <platform> --dry-run --json`（热更判定预览，无需凭据）、`applift beta <platform> --interactive-events`（NDJSON 事件流 + stdin 确认回写，见 README 协议节）。

@applift/ui-server：applift 检索链落地（工程内 > 全局 PATH > npm 引导安装 API）+ 添加项目校验的 CLI 定位同样走检索链（Tauri 打包壳场景仓库相对路径不存在，工程/全局命中才能通过）。

添加项目的目录浏览器（随 `applift ui` 一同发布的 webui 能力）：起始根（home + 常见父目录）→ 逐层点选子目录，含 `applift.config.ts` 的目录高亮「applift 工程」并可直接选择；Tauri 桌面壳内自动切换为系统原生目录选择器。
