# applift-ui 阶段二：ui-server 与前端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `applift ui`：localhost 服务托管前端 + 项目注册表 + 状态聚合轮询 + 跃迁通知 + beta 发版任务桥接（NDJSON ↔ WebSocket）。

**Architecture:** monorepo 新增 `apps/ui`（纯静态前端，原型 HTML 的组件化实现）与 `apps/ui-server`（Node HTTP/WS 服务，spawn CLI 消费阶段一机读接口）。前置：阶段一计划（`2026-11-13-applift-ui-phase1-cli.md`）全部完成。

**Tech Stack:** TypeScript、Node ≥20 内置 `node:http` + `ws`（唯一新增依赖）、前端零框架 vanilla TS（原型已验证的 CSS/交互直接迁移，避免框架层抽象）、vitest + Playwright（少量 e2e）。

**Spec:** `docs/superpowers/specs/2026-11-13-applift-ui-design.md`（§2 架构、§3 轮询、§5 错误降级、§6 IA）

## Global Constraints

- 绑 127.0.0.1，无鉴权（远程部署是二期后置项）；禁止在此阶段引入鉴权中间件实现。
- GUI 运行时一律 spawn CLI（阶段一机读接口），**禁止 import `@applift/core` 运行时**（类型 import 允许）。
- 轮询下限护栏：前台 ≥1min、后台 ≥15min（设置可调，服务端 clamp）。
- HostAdapter：一期全部方法返回"webui 不支持"降级（接口先立，Tauri 二期实现）。
- 零侵入：不声明 UI 时 CLI 行为不变；ui-server 不写目标工程任何文件。
- 项目注册表持久化：`~/Library/Application Support/applift-ui/projects.json`（按平台惯例目录，`os.homedir()` 拼接——不引 environtment 依赖）。
- 测试禁真实网络：CLI 子进程用真 dist 只读命令（`--version`/`channels --json`）+ 桩工程；渠道 status 用桩 HTTP 服务或注入式 fake Runner。
- pnpm workspace：`pnpm-workspace.yaml` 的 `packages: [packages/*]` 需扩为 `[packages/*, apps/*]`。

---

### Task 1: workspace 扩容 + apps/ui-server 骨架（HTTP 静态托管 + 健康检查）

**Files:**
- Modify: `pnpm-workspace.yaml`
- Create: `apps/ui-server/package.json`、`apps/ui-server/tsconfig.json`、`apps/ui-server/src/index.ts`（入口：startUiServer）、`apps/ui-server/src/http.ts`
- Test: `apps/ui-server/src/http.test.ts`

**Interfaces:**
- Produces: `startUiServer(opts: { port?: number; staticDir: string }): Promise<{ port: number; close: () => Promise<void> }>`（后续任务都经它挂路由）
- HTTP 面（一期全量）：`GET /api/health` → `{ok:true, version}`；静态文件托管 `staticDir`（`/` → index.html，MIME 按扩展名）。

- [ ] **Step 1: workspace 扩容 + 包骨架**

`pnpm-workspace.yaml`: `packages: [packages/*, apps/*]`。`apps/ui-server/package.json`：

```json
{
  "name": "@applift/ui-server",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.mjs",
  "scripts": { "build": "tsdown src/index.ts --format esm --dts", "test": "vitest run" },
  "dependencies": { "ws": "^8.0.0" }
}
```

（build 工具沿用 packages/cli 的 tsdown——看它的 package.json build 脚本照抄参数。）

- [ ] **Step 2: 写失败测试**

```ts
import { startUiServer } from "./http.js";
it("健康检查 + 静态托管", async () => {
  const dir = await mkdtempStatic("<html>hi</html>");  // helper：临时目录写 index.html
  const srv = await startUiServer({ staticDir: dir, port: 0 });
  const health = await fetch(`http://127.0.0.1:${srv.port}/api/health`).then(r => r.json());
  expect(health.ok).toBe(true);
  const html = await fetch(`http://127.0.0.1:${srv.port}/`).then(r => r.text());
  expect(html).toContain("hi");
  await srv.close();
});
it("绑定 127.0.0.1（非 0.0.0.0）", async () => { /* fetch http://localhost 反解 / 或断言 server.address().address === "127.0.0.1" */ });
```

- [ ] **Step 3: 跑测试失败 → 实现 http.ts**（node:http + fs.readFile 静态 + `/api/health`；listen host 强制 "127.0.0.1"，port 0 自动分配）
- [ ] **Step 4: 测试通过**
- [ ] **Step 5: Commit** `feat(ui-server): http skeleton with static hosting`

---

### Task 2: ProjectRegistry（增删改查 + 持久化）

**Files:**
- Create: `apps/ui-server/src/registry.ts`
- Test: `apps/ui-server/src/registry.test.ts`

**Interfaces:**
- Produces:
```ts
export interface ProjectEntry { id: string; name: string; path: string; addedAt: number; }
export class ProjectRegistry {
  constructor(storePath: string);                       // 测试注入临时路径
  list(): ProjectEntry[];
  add(path: string): Promise<ProjectEntry>;            // name 取 path.basename；重复路径幂等返回已有条目
  remove(id: string): boolean;
  get(id: string): ProjectEntry | undefined;
}
```
- REST 路由（挂到 Task 1 的 http）：`GET /api/projects` / `POST /api/projects {path}`（先 spawn `applift validate <path> --json` 校验，ok=false 时 400 带 report）/ `DELETE /api/projects/:id`。

- [ ] **Step 1: 写失败测试**（Registry 单测：临时 storePath；add 幂等/remove/重启恢复=新实例同 path 读回）
- [ ] **Step 2: 失败 → 实现**（fs 读写 JSON，写时 0600；validate 经 Task 3 的 Runner——本任务先直接 spawn，Task 3 重构收敛）
- [ ] **Step 3: REST 路由测试**（http.test.ts 追加：POST 合法临时工程目录 200、POST 空目录 400 带 error 字段）
- [ ] **Step 4: 全部通过 → Commit** `feat(ui-server): project registry with persistence and REST`

---

### Task 3: AppliftRunner（子进程封装：定位/spawn/kill/退出码兜底）

**Files:**
- Create: `apps/ui-server/src/runner.ts`
- Test: `apps/ui-server/src/runner.test.ts`

**Interfaces:**
- Produces:
```ts
export class AppliftRunner {
  constructor(opts: { cwd?: string; bin?: string });   // bin 缺省 "npx applift"（cwd 工程解析）；测试注入 node 脚本
  run(args: string[], opts?: { timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
  spawnStream(args: string[], handlers: { onLine: (e: object) => void; onError: (s: string) => void }): RunningTask;  // NDJSON 消费
}
export interface RunningTask { pid: number; kill(): void; done: Promise<{ code: number }>; stdinWrite(line: string): void; }
```
- kill 语义：进程组（`spawn detached:true` + `process.kill(-pid, "SIGTERM")`）——UI 取消发版用。

- [ ] **Step 1: 失败测试**（用真 node 脚本做桩 bin：echo JSON、读 stdin 回显、sleep 测 kill/timeout）
- [ ] **Step 2: 实现 → 通过**
- [ ] **Step 3: 真 CLI 冒烟测试**（`run(["--version"])` 返回 code 0 且 stdout 非空；标记 `describe.skipIf(!existsCliDist())` 防裸仓失败）
- [ ] **Step 4: Commit** `feat(ui-server): applift subprocess runner`

---

### Task 4: StatusAggregator（聚焦/前台/后台三级轮询 + 跃迁检测）

**Files:**
- Create: `apps/ui-server/src/aggregator.ts`
- Test: `apps/ui-server/src/aggregator.test.ts`

**Interfaces:**
- Consumes: Runner + `applift status --json`（阶段一 Task 6 的 StatusReport）
- Produces:
```ts
export interface ChannelSnapshot { channel: string; platform: string; state: string; live?: boolean; reason?: string; error?: string; fetchedAt: string; }
export interface ProjectSnapshot { projectId: string; channels: ChannelSnapshot[]; fetchedAt: string; ok: boolean; }  // ok=false = CLI 不可用
export type FeedEvent = { id: string; ts: number; projectId: string; channel: string; kind: "state_change"; from: string; to: string; };
export class StatusAggregator {
  constructor(deps: { registry: ProjectRegistry; runnerFactory: (cwd: string) => AppliftRunner; onSnapshot: (s: ProjectSnapshot) => void; onFeed: (e: FeedEvent) => void; timers?: { setInterval: typeof setInterval; clearInterval: typeof clearInterval } });
  refreshNow(): Promise<void>;                    // 聚焦刷新：全部项目立即一轮（项目间串行）
  setVisible(v: boolean): void;                  // true → 前台档定时器（默认 5min，clamp ≥1min）；false → 后台档（默认 60min，clamp ≥15min）
  setIntervals(foregroundMs: number, backgroundMs: number): void;
  baselinePath: string;                           // state-history.jsonl：跃迁基线持久化，重启恢复
}
```
- 跃迁检测：每轮对比上一快照（内存 + baseline 文件），state 变化 → FeedEvent（含 `rejected→*` / `*→approved+live`）。
- 限频安全：项目间串行 + 档位间隔，单轮内每项目一个子进程。

- [ ] **Step 1: 失败测试**（注入 fake runnerFactory 返回固定 StatusReport；假时钟 timers 推进验证档位切换与 clamp；改 state 验证 FeedEvent 生成与 baseline 落盘、重启恢复）
- [ ] **Step 2: 实现 → 通过**
- [ ] **Step 3: 真 CLI 桩工程冒烟**（临时目录 applift.config.ts + pgyer 渠道，无凭据 → ok=false 快照不 throw）`describe.skipIf` 同上
- [ ] **Step 4: Commit** `feat(ui-server): tiered status aggregation with transition feed`

---

### Task 5: WebSocket 通道（快照推送 + 发版任务桥）

**Files:**
- Create: `apps/ui-server/src/ws.ts`
- Test: `apps/ui-server/src/ws.test.ts`

**Interfaces:**
- Consumes: `ws` 包、Aggregator 的 onSnapshot/onFeed、Runner 的 spawnStream
- Produces（前端消费的 WS 协议，与服务端事件一一映射）：
  - 服务端 → 客户端：`{t:"snapshot", data:ProjectSnapshot}` / `{t:"feed", data:FeedEvent}` / `{t:"task", data:<OutEvent 阶段一协议原样转发>}`
  - 客户端 → 服务端：`{t:"confirm", taskId, id, value}`（转写 stdin）/ `{t:"task.cancel", taskId}`
- 发版任务管理：`startBetaTask(projectId, platform, opts)` → taskId；NDJSON 行经 ws 转发全部连接；result 后任务归档（内存 ring buffer 保留最近 20 条供重连回看）。

- [ ] **Step 1: 失败测试**（真 ws 客户端连本地服务：订阅收 snapshot；发 confirm 桩 bin 收到 stdin 回写；cancel 后进程退出）
- [ ] **Step 2: 实现 → 通过**
- [ ] **Step 3: Commit** `feat(ui-server): websocket channel with task bridge`

---

### Task 6: `applift ui` 命令（CLI 侧入口）

**Files:**
- Modify: `packages/cli/src/lifecycle.ts`
- Create: `packages/cli/src/ui-command.ts`
- Test: `packages/cli/src/ui-command.test.ts`

**Interfaces:**
- Produces: `applift ui [--port <n>] [--stop] [--no-open]`
  - 默认 detach 常驻（`child_process.spawn(node, [serverEntry], { detached: true, stdio: "ignore" })` + `unref()`；端口写 `~/.applift/ui.port`）
  - 幂等：已有实例（探测 `/api/health`）→ 只 `open` 浏览器
  - `--stop`：读端口文件 → `POST /api/shutdown`（ui-server 补该路由，仅监听 127.0.0.1 可达）
  - `--no-open`：CI/无头场景
- 依赖方向：CLI devDependency `@applift/ui-server`（workspace）；server 静态目录 = ui-server 包内 `dist/public`（前端构建产物随包分发）。

- [ ] **Step 1: 失败测试**（ui-command.test.ts：spawn 桩 server 脚本验证 detach/幂等/--stop 路由调用；不真开浏览器——`open` 模块注入 fake）
- [ ] **Step 2: 实现 → 通过 → smoke 追加**（`pnpm run smoke` 加 `node packages/cli/dist/bin.mjs ui --no-open --port 0 & sleep 1; curl health; ui --stop`）
- [ ] **Step 3: Commit** `feat(cli): applift ui command with detached server lifecycle`

---

### Task 7: 前端骨架（原型迁移：总览/详情/设置三页 + 主题）

**Files:**
- Create: `apps/ui/package.json`、`apps/ui/tsconfig.json`、`apps/ui/src/main.ts`、`apps/ui/src/api.ts`（REST+WS 客户端）、`apps/ui/src/pages/overview.ts`、`apps/ui/src/pages/project.ts`、`apps/ui/src/pages/settings.ts`、`apps/ui/src/styles.css`
- Test: `apps/ui/src/api.test.ts`（协议解析单测）+ Playwright `apps/ui/e2e/smoke.spec.ts`

**Interfaces:**
- Consumes: 阶段二 Task 1-5 全部 HTTP/WS 协议；视觉基准 = `docs/superpowers/specs/2026-11-13-applift-ui-prototype.html`（CSS 变量 token、分组列表、状态点体系原样迁移）
- 构建：`tsdown`/esbuild 打包为静态 `dist/public`（零框架 vanilla TS，DOM 操作直写）；`apps/ui` package.json `build` 产出到自身 `dist/public`。

- [ ] **Step 1: api.ts 失败测试**（WS 消息解析、快照合并、confirm 发送格式）
- [ ] **Step 2: 实现 api.ts → 通过**
- [ ] **Step 3: 三页骨架实现**（总览=项目卡网格+动态时间线+过滤；详情=摘要卡筛选+渠道列表+被拒展开；设置=轮询 stepper/开关/主题；空/加载/错误三态全覆盖——对照原型交互）
- [ ] **Step 4: Playwright 冒烟**（起真 server + 桩工程：打开 → 见项目卡 → 点进详情 → 设置改前台间隔断言 clamp 提示）
- [ ] **Step 5: Commit** `feat(ui): vanilla TS frontend migrated from prototype`

---

### Task 8: 发版向导前端（beta 全链路）

**Files:**
- Create: `apps/ui/src/pages/release.ts`
- Test: Playwright `apps/ui/e2e/release.spec.ts`

**Interfaces:**
- Consumes: `applift beta <platform> --dry-run --json`（预览）、WS task 桥（confirm/progress/result）
- 行为：项目+阶段+平台多选表单（记住上次选择 localStorage）→ dry-run 判定展示（分平台推荐徽章/证据列表）→ 确认（改选投递方式 → confirm 回写）→ 执行（进度条映射 progress 事件、折叠日志映射 log 事件）→ 结果/取消/超时态。取消 = `task.cancel`。分平台判定卡（开热更/未开热更跳过）按 dry-run 输出渲染。

- [ ] **Step 1: Playwright 失败测试**（桩 CLI bin：脚本化输出 hello/judgement/confirm_required/progress/result 序列；断言 UI 状态机走完四步）
- [ ] **Step 2: 实现 → 通过**
- [ ] **Step 3: 真 CLI 桩工程端到端**（真 beta --interactive-events + 测试内 stdin 模拟——复用阶段一 Task 5 的 fixture 思路）
- [ ] **Step 4: Commit** `feat(ui): beta release wizard full flow`

---

### Task 9: HostAdapter 接口占位 + 二期窗口收尾

**Files:**
- Create: `apps/ui/src/host.ts`
- Modify: `apps/ui-server/src/index.ts`（导出 HostAdapter 类型给未来 Tauri 壳复用）

**Interfaces:**
- Produces:
```ts
export interface HostAdapter {
  notify(title: string, body: string): Promise<boolean>;   // webui: Notification API（授权失败 false 降级未读列表）
  pickDirectory(): Promise<string | null>;                 // webui: null（UI 提示手输路径）
  setBadge(n: number): Promise<void>;                      // webui: no-op
}
export const webuiHost: HostAdapter;  // 一期实现，全部降级语义
```

- [ ] **Step 1: host.ts 单测**（notify 授权拒绝返回 false；pickDirectory 返回 null）
- [ ] **Step 2: 接入总览/发版页对应交互点（添加项目降级手输、通知走未读列表——原型已设计该形态）→ 通过**
- [ ] **Step 3: 全量 gate**：`pnpm -r build && npx vitest run && pnpm run smoke` + Playwright
- [ ] **Step 4: changeset（minor：@applift/cli 新增 ui 命令；@applift/ui-server 0.1.0 首发）+ README「applift ui」章节 + Commit** `feat: applift-ui phase 2 complete`

---

## 验收总则（两阶段共用）

- 全量 gate：`pnpm -r build && npx vitest run && pnpm run smoke` 全绿。
- 真实链路验证义务（spec §5 记录的未验证点）不因 UI 增加而扩大：渠道 API 行为沿用现有结论。
- qy-driver 升级实测：阶段二完成后在 qy-driver 跑一轮 `applift ui` → 总览见到真实渠道状态 → 桩工程向导走通（真实 beta 发布仍按现有发布流程人工触发，不因 UI 存在而跳过验证纪律）。
