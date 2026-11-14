# applift-ui Tauri 壳设计文档

> 2026-11-14 定稿待审。前置：`2026-11-13-applift-ui-design.md`（webui 一期与 HostAdapter 契约）。SEA 内置路线已否决（spike 报告 `.superpowers/sdd/wave-a/sea-spike-report.md`，产物归档可复验）。

## 1. 定位与形态

applift-ui 的桌面宿主（macOS dmg / Windows exe）：**薄壳（目标 ≤15MB）**，不内置任何运行时。职责=窗口 + 系统托盘 + 原生通知 + ui-server 生命周期管理。业务全部复用既有资产：React 前端（apps/ui）+ Node 服务（apps/ui-server）+ spawn applift CLI。

```
┌─ Tauri 壳（Rust，薄）────────────────────┐
│ 主窗口 ──load──→ http://127.0.0.1:<port> │
│ 托盘 popup 窗口 ──load──→ #/popup 路由    │
│ 原生通知 / 文件对话框 / 托盘角标          │
│ sidecar 管理：起停 node ui-server         │
│ 启动自检：node --version + applift 检索链 │
└──────────────────────────────────────────┘
         ↓ spawn（系统 Node）
   node apps/ui-server（data 层不动）
```

关键取舍：**壳的 webview 直接 load localhost**，不自嵌前端资源——webui 与壳跑同一份前端、同一加载路径，前端代码零分叉（TAURI 环境探测只影响 HostAdapter 实现）。

## 2. applift 获取：检索链（用户裁决）

优先级：**工程内 > 全局 > 引导安装**。

| 层 | 检测方式 | UI 呈现 |
|---|---|---|
| 工程内 | 项目卡数据带 `node_modules/.bin/applift` 存在性与 `--version` | 「applift：工程 0.14.x」 |
| 全局 | `applift --version`（PATH 可达）或 `npm ls -g @applift/cli --json` | 「applift：全局 0.14.x」 |
| 都没有 | — | 项目卡顶部「安装 applift」按钮 → 壳代跑 `npm install -g @applift/cli`（进度条 + 失败重试），完成后自动重检 |

- **版本与更新**：启动与手动刷新时对已装来源跑 `--version`；`npm view @applift/cli version` 比对，有新版 → 设置页与项目卡提示「可更新 0.15.0」；全局来源一键更新（`npm i -g @applift/cli@latest`，需确认）；工程内来源仅提示不代改（版本属工程依赖）。
- **实现落点**：ui-server AppliftRunner 的 bin 解析函数扩展为三级链（现已有工程/内置两级语义，去掉内置、加全局与安装引导状态机）；检索与安装走新 REST `GET /api/applift/availability`、`POST /api/applift/install`（Host 校验同现有矩阵），安装用独立任务事件流（复用 WS task 通道，事件类型 `install.log/install.progress/install.result`）。
- **Node 前置**：壳启动 `node --version`，缺失→首屏引导页（下载链接，不做自动安装）。Node ≥20 校验，低于 20 提示升级。

## 3. 壳能力（HostAdapter 的 Tauri 实现）

| 能力 | webui 现状 | Tauri 实现 |
|---|---|---|
| notify | Notification API（授权失败降级未读列表） | tauri-plugin-notification（原生，授权一次） |
| pickDirectory | null（手输路径） | tauri-plugin-dialog 原生目录选择 |
| setBadge | no-op | 托盘角标数字（未读动态数） |

前端探测 `window.__TAURI_INTERNALS__` 选择实现；不可用回落 webuiHost。接口签名沿用一期 HostAdapter（零改动）。

## 4. 托盘与窗口

- **主窗口**：标准窗口（关窗=隐藏到托盘，不退出；菜单退出才真退）。
- **托盘**：图标 + 角标（未读数）+ 左键弹 **popup 窗口**（360×480 无边框，`#/popup` 路由——原型已设计：项目概览行 + 异常高亮 + 快捷发版入口）+ 右键菜单（打开主窗口/立即刷新/退出）。
- **popup 与主窗口共用** ui-server 连接与状态（两个 webview 各自连 WS，服务端补发语义已支持）。
- **常驻语义**：壳常驻=托盘常驻；ui-server 随壳起停（壳退出前 `POST /api/shutdown`）。后台巡航（1h 档）由 ui-server 既有轮询承担，托盘角标由 feed 事件驱动。

## 5. 打包与分发

- `apps/shell`（Tauri 2）：`tauri.conf.json` externalBin 声明 `node`？**否**——不捆绑，运行时找系统 node（`node` in PATH；找不到=引导页）。壳自身打包仅 Rust + webview 壳资源，目标 ≤15MB。
- 产物：dmg（universal）+ nsis exe；CI 复用现有 GitHub Actions 加 matrix job。
- 更新：壳自身不做自动更新（tauri updater 留二期）；applift 的更新走 §2。
- 前端随壳分发但**不由壳加载**（load localhost），构建产物只在 ui-server 静态目录——壳 CI 只需构建 ui-server 侧。

## 6. 结构与测试

```
apps/shell/                # Tauri 2（Rust 薄壳）
  src-tauri/
    src/main.rs            # 窗口/托盘/生命周期
    src/supervisor.rs      # ui-server sidecar 起停 + node 自检
    src/bridge.rs          # 前端 invoke 命令（hostAdapter 落地）
  tauri.conf.json
apps/ui/src/pages/Popup.tsx  # 托盘 popup 页（新路由）
apps/ui/src/host.tauri.ts    # HostAdapter Tauri 实现 + 探测
ui-server: applift 检索链/安装/版本 API（§2）
```

- Rust 侧测试：supervisor（sidecar 起停/崩溃重启≤1 次/退出清理）+ 检索链调用；cargo test。
- 前端：Popup 页组件测 + Playwright（#/popup 路由）；HostAdapter 探测分支测。
- ui-server：检索链/安装任务 API 单测（桩 npm）；全量 gate 不变。
- 验收链：macOS 实机构建 dmg → 安装 → 托盘角标/通知/对话框/popup 全走通 → qy-driver 真实项目卡显示「applift：工程 0.14.x」。

## 7. 边界与不做

- 不捆绑 Node/applift（检索链兜底）；不做壳自动更新；不做多实例（壳单例锁，已有 ui-server 幂等探测双保险）。
- webui 形态继续独立存在（浏览器访问优先适用于远程/无壳场景），Tauri 是增强宿主非替代。
- Windows 组杀降级语义（POSIX 进程组 vs win 单进程）已在 Runner JSDoc 标注，壳期不改善。
