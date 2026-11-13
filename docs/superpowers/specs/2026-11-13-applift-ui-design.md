# applift-ui 设计文档

> 2026-11-13 定稿（IA 重构版）。配套高保真可交互原型：`2026-11-13-applift-ui-prototype.html`（同目录，浏览器打开，Apple 风格明暗双主题、总览/详情/发版/设置全流程可点；顶部可切换 macOS/浏览器/Windows 三种外壳形态演示）。早期低保真线框稿 `2026-11-13-applift-ui-design.html` 已被原型取代，仅存档。
## 1. 定位与范围

applift-ui：applift 的图形界面。解决三个痛点——多渠道审核状态要跑十几个官网才能看全、状态跃迁（审核通过/被拒）不能及时发现、多项目多应用状态散落。

- MVP 主线 = **总览（多项目状态 + 动态）+ 应用内 beta 发版**；release、凭据管理、Tauri 壳为二期；构建接管为远期占位（applift 本身尚不支持构建，遵循架构不变量 1：不接管构建）。
- GUI 不做 CLI 做不到的事；当前用户 2 个工程（qy-driver、iOS 项目），设计按多项目通用。

## 2. 架构决策（已定案）

| 决策 | 结论 | 理由 |
|---|---|---|
| GUI ↔ applift 交互 | **spawn CLI，不嵌 core** | core 配置装载（c12/jiti 别名指向目标工程）天然是「在项目目录跑 CLI」形态；applift 升级 GUI 零改动；类型定义（枚举等）可静态 import，运行时不 import core |
| 应用形态 | **webui 先行（`applift ui` 起 localhost 服务）**，HostAdapter 抽象宿主能力 | spawn 在 Node 侧最顺手；零打包签名成本；Tauri 壳二期按需包同一前端 |
| 命名 | **applift-ui**，monorepo 新增 `apps/ui`（前端）+ `apps/ui-server`（Node 服务，随 CLI 分发） | |
| 项目注册 | 手动添加（目录含 `applift.config.ts` 即合法），预留「扫描建议」口子（只扫用户指定父目录） | |
| 凭据 | 一期只读引导（doctor 缺失项横幅 → 引导跑 `applift doctor`）；编辑界面二期，但在设计范围内 | |

## 3. 数据流与轮询

- 三通道：项目/设置 CRUD 走 HTTP REST；状态推送走 WebSocket；发版任务走 WebSocket 双向（事件下行/确认上行）。
- **StatusAggregator**（server 侧）：逐项目跑 `applift status --json`（项目间串行错峰，项目内渠道由 CLI 并行），内存缓存 + fetchedAt 时间戳，UI 标注数据新鲜度。
- **分级轮询**（间隔可在设置中调整，有下限护栏：前台 ≥1min、后台 ≥15min）：

| 场景 | 触发 | 频率 |
|---|---|---|
| 聚焦刷新 | WebSocket 首连 / 页面重新可见 / 手动刷新 | 即时单次 |
| 前台保持 | 页面可见定时器 | 默认 5 分钟 |
| 后台巡航 | ui-server 存活期间 | 默认 1 小时 |
| 变更通知 | 巡航发现状态跃迁 | 事件即推 |

- `applift ui` 默认 detach 常驻（再跑幂等只开浏览器；`applift ui --stop` 停止）；巡航基线落盘 `state-history.jsonl`，重启不断档。
- 通知走 HostAdapter：webui 宿主 = 页面开着用 Web Notification，页面关着等下次打开以「未读变更」列表呈现；Tauri 壳 = native notification + 状态栏 popup，协议不变。

## 4. CLI 机读改造（前置工作）

原则：CLI 先成为自己最好的 API；零侵入不变量（无新 flag 时行为逐字节不变，现有测试全绿是 gate）。

1. 只读命令加 `--json`（stdout 纯 JSON、日志走 stderr）：`status`（全渠道矩阵含失败渠道）、`doctor`、`channels`、`history`。
2. `applift beta <platform> --interactive-events`：stdout 变 NDJSON 事件流，协议含版本握手：
   - `→ {"type":"hello","protocol":1}`
   - `→ stage / judgement / confirm_required / progress / log / result`
   - `← {"type":"confirm","id":...,"value":...}`（stdin 一行 JSON 回写）
   - 确认等待上限 10 分钟，超时 CLI 主动取消；SIGTERM 在 stage 边界停下。
   - 互斥守卫：与 `--json` 互斥；仅支持单平台路径；不支持 `--bump`（`beta.autoBump` 在事件流下跳过 bump 引导）。`result.summary.mode` 取值集合：`ota` / `native` / `preview`（`--dry-run` 预览；需 bump 的原生路径以 `result(ok:false)` + 引导文案收口）。
3. 补充命令面：`applift validate <path> --json`（单级命令，添加项目即时校验）；`applift beta <platform> --dry-run --json`（判定预览，发版向导第一步）。
4. `--json` 输出进契约测试（快照级）；协议不匹配明确报错并提示升级。

## 5. 错误处理与降级

- UI 不因局部失败白屏；错误是一等数据。工程 applift 不可用 → 项目卡片标灰引导；单渠道查询失败 → 该格子错误态 + 旧数据标注；凭据缺失 → 顶部横幅引导 doctor。
- 发版取消（用户/确认超时/关页面）→ kill 进程组，任务标「已取消」，事件流 server 侧留档可回看。
- 明确不做：断点续跑、多用户鉴权（绑 127.0.0.1，远程部署是二期后置项）、自动重试轰炸。

## 6. 信息架构与界面（与原型同步定稿）

**IA 原则：一切以项目为维度；无全局"当前项目"状态。** 项目身份只在两处产生：从总览点进哪个项目（下钻），发版表单里选了哪个项目（记住上次选择）。任何两处都不维护同一个"当前项目"。

```
侧栏                            页面
──────────                      ──────────────────────────────
总览 (未读角标)       ←→  项目卡片网格（状态计数 + 最新动态 + ⋯ 菜单 + 不可用态）
                                动态时间线（全部 / 按项目过滤）
发版                  ←→  向导：项目+阶段(beta/release)+平台多选 → 分平台判定
                                → 执行（分渠道进度 + 日志）→ 结果
── 设置 ──
通用设置              ←→  轮询间隔（有下限）/ 通知 / 外观
账号与凭据 (二期)     ←→  凭据状态与编辑（一期仅 doctor 引导横幅）
构建与产物 (预留)     ←→  占位
宿主形态 (演示)       ←→  三种外壳（macOS/浏览器/Windows）+ 托盘/状态栏辅助形态
```

- **总览**：项目卡（图标、名称、状态计数、最新一条动态、⋯ 菜单[重新检查/移除]、不可用灰化态）+ 虚线"添加项目"卡（目录输入 + 实时校验 + 扫描父文件夹）；下方动态时间线带项目过滤。**项目管理已收敛进总览，无独立页面。**
- **项目详情**（总览点卡下钻，非侧栏持久项）：摘要卡筛选 + 渠道明细（被拒行内展开原因）+ "← 总览"返回 + "发版"直达。
- **发版**：三端多选同发；每端独立判定（开热更→热更/整包带推荐徽章可改选；未开热更→自动跳过选择）；阶段 beta/release 页内切换（release 二期）。
- 设计系统：原型即视觉基准（分组内嵌列表、系统语义色、SF 字体栈、150–200ms 功能性动效、明暗双主题、窗口外壳三形态切换演示）。

## 7. 测试策略

- CLI 契约：vitest + mock CliRunner（沿用现有风格，禁真实网络）。
- ui-server：Registry 持久化、Runner 生命周期、EventStream 协议解析/握手报错、Aggregator 调度与跃迁检测（假时钟）；子进程用真 CLI 只读命令 + 桩脚本。
- 前端：四态渲染、向导状态机、设置护栏；Playwright 少量关键路径 e2e。
- gate：`pnpm -r build && npx vitest run` 全绿 + `pnpm run smoke`；不测视觉像素。

## 8. 二期窗口（一期只留接口不实现）

| 项 | 预留口子 |
|---|---|
| release 完整链路 | NDJSON 协议按通用任务设计（无 beta 私有字段），向导骨架复用 |
| 凭据管理 | doctor JSON 结构化缺失项；server 预留文件写接口位 |
| Tauri 壳 | HostAdapter 全量接口 + 常驻服务/跃迁事件队列 |
| 远程/多用户 | API 与宿主解耦，鉴权留中间件位 |
| 构建接管 | 仅设计占位，无接口 |

## 9. 界面术语与命名（用户语言，与原型同步定稿）

界面一律用用户能懂的词，不用实现层黑话：主导航为 **总览 / 发版 / 通用设置**（另有账号与凭据、构建与产物、宿主形态标注二期/预留/演示）；渠道状态只出现 **审核中 / 已上架 / 已发布 / 被拒 / 待你处理 / 未接入**；数据新鲜度显示「3 分钟前更新」而非 fetchedAt。「待你处理」= 需要用户在商店后台操作后才能继续的状态。二期/预留页在导航中直接标注，不隐藏。
