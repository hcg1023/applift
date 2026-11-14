# applift-ui Tauri 壳 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 applift-ui 桌面壳：Tauri 2 薄壳（窗口+托盘+原生能力）+ ui-server 检索链/引导安装 API + Popup 页。

**Architecture:** 壳 webview load localhost（前端零分叉）；Rust 侧只做 supervisor（node 自检 + ui-server sidecar 起停）与桥接命令；applift 获取=工程内>全局>npm 引导安装（用户本地 Node 必须）。

**Tech Stack:** Tauri 2（tauri-plugin-notification/dialog）、Rust（cargo test）、既有 apps/ui（React）/apps/ui-server。

**Spec:** `docs/superpowers/specs/2026-11-14-applift-ui-tauri-design.md`

## Global Constraints

- 壳体积目标 ≤15MB，禁捆绑 Node/applift 任何运行时。
- Node ≥20 前置：缺失走首屏引导页（下载链接），不自动安装。
- 所有新 REST 路由套用既有 Host 校验（isLocalHostHeader）与 body 上限；安装走任务事件流（WS task 通道）。
- 前端零分叉：webui 与壳同一前端；HostAdapter 按 `window.__TAURI_INTERNALS__` 探测选择实现，签名不变。
- 既有 gate 全绿不动：`pnpm -r build && npx vitest run && pnpm run smoke` + Playwright。
- pnpm workspace 已含 apps/*；Rust 侧不进 pnpm 构建（独立 cargo/tauri CLI，CI 单独 job）。
- 壳单例锁；关窗=隐藏托盘，菜单退出真退（退出前 POST /api/shutdown）。

---

### Task 1: ui-server 检索链与安装 API

**Files:**
- Modify: `apps/ui-server/src/runner.ts`（bin 解析函数抽 public `resolveAppliftBin(cwd)`：工程 node_modules/.bin > PATH `applift` > null）、`apps/ui-server/src/routes.ts`、`apps/ui-server/src/index.ts`
- Create: `apps/ui-server/src/applift-install.ts`（安装任务管理：npm install -g @applift/cli 走 spawnStream，事件经 WS task 通道转发，taskId 前缀 `install:`；去重=进行中拒绝二次）
- Test: `apps/ui-server/src/applift-install.test.ts` + routes 追加

**Interfaces:**
- `GET /api/applift/availability` → `{nodeVersion: string|null, nodeOk: boolean, sources: [{kind:"project"|"global", path, version}], latest: string|null}`（latest 来自 `npm view @applift/cli version`，10s 超时失败置 null）
- `POST /api/applift/install` → `{taskId}`（Host 校验+去重；npm install -g 失败重试由前端再次发起）
- `POST /api/applift/update-global` → `{taskId}`（= install latest 的别名实现）
- 事件：复用 WS `task` 通道（taskId `install:<uuid>`），spawnStream stderr 行→`log(level:error)`，成功后 availability 重检由前端拉取。

- [ ] 失败测试：availability 三源桩（fake PATH/工程目录）、install 任务事件流到 result、去重 409、Host 403、npm 超时降级
- [ ] 实现 → 通过 → 全量 gate
- [ ] Commit `feat(ui-server): applift discovery chain and guided install api`

### Task 2: apps/shell 脚手架 + supervisor

**Files:**
- Create: `apps/shell/package.json`（tauri CLI devDep，不含运行时依赖）、`apps/shell/src-tauri/`（main.rs/lib.rs/supervisor.rs/bridge.rs/tauri.conf.json/Cargo.toml）
- Test: `apps/shell/src-tauri/src/supervisor.rs` 内联 `#[cfg(test)]`

**Interfaces:**
- supervisor：`detect_node() -> Option<String>`（node --version，≥20 判定）；`spawn_server(port_hint) -> ServerHandle`（spawn `node <ui-server main>` detached=false，读 stdout 端口行或 health 轮询≤10s；崩溃重启≤1 次；`shutdown()`=POST /api/shutdown 再 kill 兜底）
- 壳单例：tauri single-instance 插件（二次启动唤起既有主窗口）
- 主窗口：load `http://127.0.0.1:<dynamic port>`；server 未就绪时 load 内嵌 `startup.html`（空白+连接中+失败重试按钮，asset 协议）；node 缺失时 load `node-required.html`（下载链接）
- bridge（invoke 命令）：`get_server_port()`、`server_status()`
- cargo test：detect_node 判定矩阵、shutdown 调用序（桩 http）

- [ ] 脚手架 + `cargo test` 过 + `pnpm -r build && npx vitest run` 不回归（shell 不进 pnpm）
- [ ] 手工冒烟：`cargo tauri dev` 起壳→窗口见总览（连真 ui-server）
- [ ] Commit `feat(shell): tauri scaffold with server supervisor`

### Task 3: HostAdapter Tauri 实现 + 前端接线

**Files:**
- Create: `apps/ui/src/host.tauri.ts`（notify/pickDirectory/setBadge 三实现，经 `window.__TAURI_INTERNALS__` 探测包装在 host.ts 的 `pickHost()`）
- Modify: `apps/ui/src/host.ts`（导出 `pickHost(): HostAdapter`：TAURI 探测→tauri 实现，否则 webuiHost；main.tsx/app.tsx 消费点替换）
- Test: `apps/ui/src/host.tauri.test.ts`（探测分支/mock invoke）

- [ ] 失败测试（探测两分支、invoke mock）→ 实现 → Playwright 仍 4/4（webui 路径不受影响）→ gate
- [ ] Commit `feat(ui): host adapter tauri implementation`

### Task 4: 托盘 + Popup 页 + 原生通知

**Files:**
- Modify: `apps/shell/src-tauri/`（托盘：角标数字、左键 popup 窗口 360×480 无边框 load `#/popup`、右键菜单 打开主窗/立即刷新/退出；关窗隐藏）
- Create: `apps/ui/src/pages/Popup.tsx`（#/popup 路由：项目概览行=状态计数+异常高亮+最新动态；点行开主窗对应详情——`window.__TAURI_INTERNALS__` invoke `open_main`；快捷发版入口导航主窗 #/release）
- Modify: `apps/ui/src/app.tsx`（popup 路由分支：无侧栏布局）、`host.tauri.ts`（setBadge 接托盘角标——feed 未读数）
- Test: Popup 组件测 + Rust 侧托盘状态测（可测部分）+ Playwright #/popup 冒烟

- [ ] 失败测试 → 实现 → gate + Playwright
- [ ] Commit `feat(shell): tray, popup page, native notifications`

### Task 5: 打包、CI 与验收

**Files:**
- Modify: `apps/shell/src-tauri/tauri.conf.json`（bundle targets dmg/exe、签名占位）、`.github/workflows/`（新增 shell job：cargo test + tauri build，macos-latest + windows-latest）
- README：桌面壳章节（安装/托盘/检索链/引导安装）

- [ ] `cargo tauri build` 产出 dmg（本地）+ 体积记录（目标 ≤15MB，超出记录原因）
- [ ] CI job 绿（或标明 requires 手动机器跑）
- [ ] 实机验收清单：安装→托盘角标→通知→对话框→popup→qy-driver 项目卡显示「applift：工程 0.14.x」→ 引导安装路径（临时卸全局验证）
- [ ] Commit `feat(shell): bundling and ci` + changeset

## 验收总则
gate 全绿；dmg 实机走 spec §6 验收链；未实机验证项在报告中显式标注（Windows 侧允许 CI-only，用户无 Windows 环境）。
