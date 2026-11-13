# applift-ui 阶段一：CLI 机读改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 applift CLI 成为 applift-ui 的稳定 API：补齐 `--json` 机读输出、新增 `projects validate` / `beta --dry-run`、实现 beta 的 NDJSON 交互事件流协议。

**Architecture:** 纯输出层改造，不碰渠道 API 实现。NDJSON 事件流（`--interactive-events`）是唯一有状态的改造：把 `resolveDeliveryMode` 里的 `p.select` 交互替换为「事件下行 + stdin JSON 回写上行」的协议通道，未开 flag 时行为逐字节不变（零侵入不变量）。

**Tech Stack:** TypeScript、commander、vitest（现有基建，禁真实网络——渠道全部用桩）。

**Spec:** `docs/superpowers/specs/2026-11-13-applift-ui-design.md`（§4 CLI 机读改造、§3 数据流）

## Global Constraints

- 运行时只承诺 Node ≥20（bun 基本兼容不承诺）；禁止引入仅单运行时可用的 API。
- 零侵入不变量：无新 flag 时所有命令行为与现在逐字节一致；现有测试全绿是 gate。
- `--json` 输出 stdout 纯净（日志/进度全走 stderr）——现有 status 已遵守（index.ts:261 注释），新改造同守。
- 机读字段演进按 semver；协议带版本号，不匹配明确报错。
- 测试风格沿用现有：桩渠道进程内 / 临时目录 + 真 git / mock CliRunner；断言在导出接口。
- lint 用 oxlint；提交 conventional commits。
- 禁跑真实 pushy 网络命令于开发验证。

---

### Task 1: `doctor --json` 结构化输出

**Files:**
- Modify: `packages/cli/src/index.ts`（doctor 命令，约 1697-1852 行）
- Test: `packages/cli/src/doctor.test.ts`（追加）

**Interfaces:**
- Consumes: doctor 现有内部数据（framework/ids/creds/stores/missing 检查，全部已在 action 里算好）
- Produces: `DoctorJsonReport`（stdout JSON，ui-server Task 5 消费）：
```ts
interface DoctorJsonReport {
  ok: boolean;                       // = 现有 healthy
  cwd: string;
  framework: { id: string; label: string } | null;   // resolveFramework 结果
  suggestedFramework: { id: string; label: string } | null; // suggestFramework 结果
  bundleIds: { android?: string; harmony?: string; ios?: string; iosScheme?: string };
  profiles: string[];                // Object.keys(creds.profiles)
  activeProfile: { name: string; source: string } | null;
  stores: Array<{ id: string; credentialsOk: boolean; missing: string[] }>;
  updateProviders: Array<{ id: string; platforms: string[] | null }>;
  channels: string[];                // config.beta 渠道
}
```

- [ ] **Step 1: 写失败测试**（`doctor.test.ts` 追加；沿用该文件现有的临时目录 + 桩渠道写法）

```ts
it("doctor --json 输出结构化体检报告（stdout 纯净）", async () => {
  const dir = await makeProjectDir(); // 现有 helper：临时目录 + 最小 applift.config.ts
  const { stdout, stderr } = await runCli(["doctor", "--cwd", dir, "--json"]);
  const report = JSON.parse(stdout);
  expect(report.ok).toBe(true);
  expect(report.cwd).toBe(dir);
  expect(typeof report.framework).toBe("object");
  expect(Array.isArray(report.stores)).toBe(true);
  expect(stderr).not.toContain("{"); // 人读日志走 stderr，不污染 stdout
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -r build && npx vitest run packages/cli/src/doctor.test.ts`
Expected: FAIL（`--json` 未定义，commander 报 unknown option）

- [ ] **Step 3: 实现**

doctor 命令加 `.option("--json", "结构化输出（stdout 给机器）")`。action 内：`if (cmdOpts.json)` 时收集上述 `DoctorJsonReport` 字段（数据全部复用现有局部变量：`framework/suggested/ids/profileNames/profile/profileSource/stores/missing 检查循环/updateProviders`），`console.log(JSON.stringify(report, null, 2))` 后 return——跳过所有 `p.log.*` 人读输出。非 json 路径一行不动。

- [ ] **Step 4: 跑测试通过 + 全量回归**

Run: `pnpm -r build && npx vitest run packages/cli/src/doctor.test.ts && npx vitest run`
Expected: 全绿（零侵入：无 flag 的 doctor 输出未变）

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/src/doctor.test.ts
git commit -m "feat(cli): doctor --json structured report"
```

---

### Task 2: `applift projects validate <path> --json`

**Files:**
- Create: `packages/cli/src/validate.ts`
- Modify: `packages/cli/src/lifecycle.ts`（注册新命令）
- Test: `packages/cli/src/validate.test.ts`

**Interfaces:**
- Consumes: `@applift/core` 的 `loadProjectConfig(cwd)`（config/project.ts:63）、`resolveFramework`、`suggestFramework`、`detectBundleIds`
- Produces: stdout `ProjectValidation`（ui-server 添加项目即时校验消费）：
```ts
interface ProjectValidation {
  ok: boolean;
  path: string;
  configFound: boolean;      // findUp 命中 applift.config.ts
  name?: string;             // config.name
  framework: { id: string; label: string } | null;      // 插件注册声明
  suggestedFramework: { id: string; label: string } | null;
  bundleIds: { android?: string; harmony?: string; ios?: string; iosScheme?: string };
  platforms: string[];       // 由 bundleIds 命中端推导
  appliftAvailable: boolean; // node_modules 里有 applift 可执行依赖（探测 package.json deps）
  error?: string;            // configFound=false 时的原因（"未找到 applift.config.ts"）
}
```
- 注册形态：`registerValidateCommand(program, { setup: setupChannels, registry })`，与 lifecycle/listing 同构（registry 传入但 validate 只用 core 探测，不需要渠道——保持签名一致便于未来扩展）。

- [ ] **Step 1: 写失败测试**

```ts
describe("projects validate", () => {
  it("合法工程：ok=true 且带框架与三端标识", async () => {
    const dir = await makeRnProjectDir(); // 现有临时工程 helper（commands.test.ts 里已有类似）
    const { stdout } = await runCli(["projects", "validate", dir, "--json"]);
    const v = JSON.parse(stdout);
    expect(v.ok).toBe(true);
    expect(v.configFound).toBe(true);
    expect(v.platforms.length).toBeGreaterThan(0);
  });
  it("非 applift 目录：ok=false configFound=false error 指明原因", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "applift-empty-"));
    const { stdout, code } = await runCli(["projects", "validate", dir, "--json"]);
    const v = JSON.parse(stdout);
    expect(v.ok).toBe(false);
    expect(v.configFound).toBe(false);
    expect(v.error).toContain("applift.config.ts");
    expect(code).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -r build && npx vitest run packages/cli/src/validate.test.ts`
Expected: FAIL（unknown command `projects`）

- [ ] **Step 3: 实现 validate.ts**

命令注册（commander）：`.command("projects")` + `.command("validate <path>")` 子命令组合，或直接 `.command("validate <path>")`（简单起见选后者，spec 文案 `applift projects validate` 保留 alias 描述——**采用 `applift validate <path>`，spec 措辞以实现为准更新**，避免 commander 两级空壳）。核心：

```ts
export function registerValidateCommand(program: Command, _deps: { setup: () => void; registry: ChannelRegistry }) {
  program
    .command("validate <path>")
    .description("校验目录是否为 applift 工程（--json 供 UI 消费）")
    .option("--json", "JSON 输出")
    .action(async (target: string, cmdOpts: { json?: boolean }) => {
      const cwd = path.resolve(target);
      const report = await validateProject(cwd); // 导出供测试直接调用（断言在导出接口）
      if (cmdOpts.json) { console.log(JSON.stringify(report, null, 2)); }
      else { /* 人读：p.log.success/error 摘要 */ }
      if (!report.ok) process.exitCode = 1;
    });
}
```

`validateProject(cwd)` 逻辑：try `loadProjectConfig(cwd)`（catch → `configFound:false, error`）；`resolveFramework`（声明）与 `suggestFramework`（建议）；`detectBundleIds`；`appliftAvailable` = 目标工程 `package.json` 的 deps/devDeps 里含 `applift`（读写 `path.join(cwd, "package.json")`，缺失 = false）。

- [ ] **Step 4: 跑测试通过**

Run: `pnpm -r build && npx vitest run packages/cli/src/validate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/validate.ts packages/cli/src/validate.test.ts packages/cli/src/lifecycle.ts
git commit -m "feat(cli): validate <path> command for project discovery"
```

---

### Task 3: `beta --dry-run --json` 判定预览

**Files:**
- Modify: `packages/cli/src/index.ts`（beta 命令，约 560-1080 行；`resolveDeliveryMode` 约 91-156 行）
- Test: `packages/cli/src/index.test.ts`（追加）

**Interfaces:**
- Consumes: `resolveDeliveryMode` 现有判定链（collectReleaseDiff → routeDelivery → judgement）
- Produces: stdout `BetaDryRunReport`（发版向导第一步预览消费）：
```ts
interface BetaDryRunReport {
  platform: string;
  provider: string | null;        // 判定 provider id；null = 无热更 provider（原生路径）
  recommendation: "ota" | "native" | "uncertain" | null;   // null = 未路由（无 provider）
  confidence: "high" | "medium" | "low" | null;
  evidence: Array<{ path: string; rule: string; note?: string }>;
  note: string;                   // 人读摘要（UI 直接展示）
}
```

- [ ] **Step 1: 写失败测试**（用现有 rn-update 测试的桩工程写法：临时目录 + git init + JS 改动 + 桩 provider 注册）

```ts
it("beta <platform> --dry-run --json 输出判定预览不发布", async () => {
  const dir = await makeOtaFixture(); // 现有 helper：RN 工程 + git + 纯 JS 改动
  const { stdout } = await runCli(["beta", "android", "--dry-run", "--json", "--cwd", dir]);
  const r = JSON.parse(stdout);
  expect(r.platform).toBe("android");
  expect(r.recommendation).toBe("ota");
  expect(r.confidence).toBe("high");
  expect(r.evidence.length).toBeGreaterThan(0);
  // 不发布：history.jsonl 无新条目
  expect(readHistory(dir)).toHaveLength(0);
});
it("beta --dry-run 无 provider 平台：recommendation=null 走原生语义", async () => {
  const dir = await makeOtaFixture();
  const { stdout } = await runCli(["beta", "harmony", "--dry-run", "--json", "--cwd", dir]); // 桩 provider platforms 不含 harmony
  const r = JSON.parse(stdout);
  expect(r.provider).toBeNull();
  expect(r.recommendation).toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -r build && npx vitest run packages/cli/src/index.test.ts -t "dry-run"`
Expected: FAIL（`--dry-run` option 未定义于 beta）

- [ ] **Step 3: 实现**

beta 命令加 `.option("--dry-run", "只出判定预览，不发布")`。在 `resolveDeliveryMode` 返回后（ota 分支入口前、native 分支入口前）插入：

```ts
if (cmdOpts.dryRun) {
  const report: BetaDryRunReport = decision
    ? { platform, provider: decision.provider?.id ?? null,
        recommendation: judgement.recommendation, confidence: judgement.confidence,
        evidence: judgement.evidence.slice(0, 50).map(e => ({ path: e.path, rule: e.rule, note: e.note })),
        note: `判定：${judgement.recommendation}（${judgement.confidence}）` }
    : { platform, provider: null, recommendation: null, confidence: null, evidence: [], note: "未接入热更（原生路径）" };
  if (cmdOpts.json) console.log(JSON.stringify(report, null, 2));
  else p.log.message(report.note);
  return; // 不进任何发布分支
}
```

注意：`resolveDeliveryMode` 的 opts 已含 `dryRun`（index.ts:95/131 现有签名兼容），非交互路径已用推荐值——dry-run 不该因 uncertain 抛错：把 131 行的 `--dry-run` 从非交互分支的触发条件里**移除**（dry-run 是预览，uncertain 也照实输出 recommendation:"uncertain"），仅 `--yes`/`--json`/无 TTY 保持中止语义。这是对现有行为的**收窄修改**：现有测试里若有 dry-run uncertain 断言需同步更新（先跑全量确认无此断言）。

- [ ] **Step 4: 跑测试通过 + 全量回归**

Run: `pnpm -r build && npx vitest run`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/src/index.test.ts
git commit -m "feat(cli): beta --dry-run --json judgement preview"
```

---

### Task 4: NDJSON 事件流协议核心（`--interactive-events`）

**Files:**
- Create: `packages/cli/src/events.ts`（协议通道：序列化 + 确认问答 + 超时）
- Modify: `packages/cli/src/index.ts`（beta 命令接线：`resolveDeliveryMode` 交互替换）
- Test: `packages/cli/src/events.test.ts`

**Interfaces:**
- Produces（ui-server EventStream 消费，协议版本 1）：
```ts
type OutEvent =
  | { type: "hello"; protocol: 1; cli: string }        // cli = pkg.version
  | { type: "stage"; stage: string }                    // judge/pack/upload/notify/...
  | { type: "judgement"; platform: string; recommendation: "ota"|"native"|"uncertain"|null; confidence: string|null; provider: string|null; evidence: Array<{path:string;rule:string;note?:string}> }
  | { type: "confirm_required"; id: string; question: string; choices: Array<{ value: string; label: string; recommended?: boolean }> }
  | { type: "progress"; stage: string; channel?: string; pct?: number; msg?: string }
  | { type: "log"; level: "info"|"warn"|"error"; msg: string }
  | { type: "result"; ok: boolean; summary: Record<string, unknown>; error?: string };
type InEvent = { type: "confirm"; id: string; value: string };
```
- `EventChannel` 类（events.ts 导出）：
```ts
export class EventChannel {
  constructor(write: (line: string) => void, opts?: { confirmTimeoutMs?: number })  // 默认 10 * 60_000
  emit(e: OutEvent): void                       // JSON.stringify + \n
  async confirm(id: string, question: string, choices): Promise<string>  // emit confirm_required → 等 stdin 一行 → 校验 value ∈ choices → 超时 throw ConfirmTimeout
}
```
- stdin 读取：`readline.createInterface({ input: process.stdin })` 逐行 `JSON.parse`，坏行 emit `{type:"log",level:"error"}` 并继续（协议容错）。

- [ ] **Step 1: 写失败测试**（events.test.ts：进程内测 EventChannel，不跑真 CLI）

```ts
describe("EventChannel", () => {
  it("emit 序列化为 NDJSON 单行", () => {
    const lines: string[] = [];
    const ch = new EventChannel(l => lines.push(l));
    ch.emit({ type: "hello", protocol: 1, cli: "0.13.0" });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ type: "hello", protocol: 1, cli: "0.13.0" });
  });
  it("confirm：回写合法值 → 解析返回", async () => {
    const inputs = new PassThrough();  // node:stream 模拟 stdin
    const ch = new EventChannel(() => {}, { input: inputs });
    const p = ch.confirm("delivery", "投递方式", [
      { value: "ota", label: "热更", recommended: true },
      { value: "native", label: "整包" },
    ]);
    inputs.write(JSON.stringify({ type: "confirm", id: "delivery", value: "ota" }) + "\n");
    await expect(p).resolves.toBe("ota");
  });
  it("confirm：非法 value → error log 并继续等待", async () => { /* 同上，先写坏值再写好值 */ });
  it("confirm 超时 → ConfirmTimeout（假时钟：vi.useFakeTimers）", async () => {
    vi.useFakeTimers();
    const ch = new EventChannel(() => {}, { input: new PassThrough(), confirmTimeoutMs: 1000 });
    const p = ch.confirm("x", "q", [{ value: "a", label: "A" }]);
    vi.advanceTimersByTime(1001);
    await expect(p).rejects.toThrow(/确认超时/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run packages/cli/src/events.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 events.ts**

按上述接口实现。要点：emit 前 `hello` 只发一次（构造时自动发）；confirm 用 Promise + 挂起队列（id → resolver map）；stdin line 事件驱动；超时 `setTimeout` reject 后清理。`input` 默认 `process.stdin`（测试注入 PassThrough）。

- [ ] **Step 4: 跑测试通过**

Run: `npx vitest run packages/cli/src/events.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/events.ts packages/cli/src/events.test.ts
git commit -m "feat(cli): NDJSON event channel with confirm protocol"
```

---

### Task 5: beta 接线 `--interactive-events`（判定确认走协议）

**Files:**
- Modify: `packages/cli/src/index.ts`（beta 命令 + `resolveDeliveryMode` 加可选 channel 参数）
- Test: `packages/cli/src/index.test.ts`（追加 e2e 风格：子进程跑真 CLI dist，stdin 喂确认）

**Interfaces:**
- Consumes: Task 4 的 `EventChannel`
- Produces: `applift beta <platform> --interactive-events` 完整事件序列（ui-server 发版向导消费）：
  `hello → stage(judge) → judgement → confirm_required(delivery) → [confirm 回写] → stage(publish) → progress* → log* → result`

- [ ] **Step 1: 写失败测试**（子进程级：execFile dist/bin.mjs，桩渠道工程，stdin 写确认）

```ts
it("beta --interactive-events：判定确认经 stdin 回写后完成发布", async () => {
  const dir = await makeOtaFixture();
  const proc = spawn("node", [CLI_BIN, "beta", "android", "--interactive-events", "--cwd", dir], { stdio: ["pipe","pipe","pipe"] });
  const lines = await collectNdjson(proc.stdout);    // helper：逐行收集直到 result
  expect(lines[0]).toMatchObject({ type: "hello", protocol: 1 });
  const confirmEvt = lines.find(l => l.type === "confirm_required");
  expect(confirmEvt.id).toBe("delivery");
  proc.stdin.write(JSON.stringify({ type: "confirm", id: "delivery", value: "ota" }) + "\n");
  const result = await waitResult(proc);             // helper：等到 result 事件
  expect(result.ok).toBe(true);
});
it("beta 无 --interactive-events：stdout 不是 NDJSON（零侵入）", async () => {
  const dir = await makeOtaFixture();
  const { stdout } = await runCliStdio(["beta", "android", "--yes", "--cwd", dir]); // --yes 跳交互
  expect(stdout.split("\n")[0].startsWith("{")).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -r build && npx vitest run packages/cli/src/index.test.ts -t "interactive-events"`
Expected: FAIL（unknown option）

- [ ] **Step 3: 实现**

1. beta 加 `.option("--interactive-events", "NDJSON 事件流（stdout 事件/stdin 确认回写；供 UI 消费）")`。
2. `resolveDeliveryMode` 加参数 `channel?: EventChannel`：有 channel 时第 141 行 `p.select` 替换为 `await channel.confirm("delivery", "投递方式", [...])`（choices 映射：value/label + recommended 标记 = recommendation）；判定结果 emit `stage(judge)` + `judgement` 事件；无 channel 时完全走原路径（**逐字节不变**）。
3. beta action：flag 开启时构造 `EventChannel(line => process.stdout.write(line))`，主要阶段边界 emit `stage`（judge/pack/upload/notify）；OTA 发布成功/原生发布汇总处 emit `result`（ok=true, summary={versionName, channel, mode}）；catch 路径 emit `result`（ok=false, error）再 rethrow（exitCode=1 现有语义不变）。`p.log.*` 人读输出在 flag 开启时改为 emit `log` 事件（只改 beta 主路径上的关键 info/success，渠道内部日志仍走 stderr——stderr 不受影响）。
4. 多渠道并行（beta 无 platform）+ flag：报错退出（`--interactive-events 仅支持单平台路径：applift beta <platform>`）——一期 UI 只走单平台向导。

- [ ] **Step 4: 跑测试通过 + 全量回归 + smoke**

Run: `pnpm -r build && npx vitest run && pnpm run smoke`
Expected: 全绿 + smoke-ok（零侵入验证）

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/src/index.test.ts
git commit -m "feat(cli): beta --interactive-events NDJSON protocol wiring"
```

---

### Task 6: status --json 补 platform/version 字段 + 契约快照测试

**Files:**
- Modify: `packages/cli/src/lifecycle.ts`（status 命令，约 262-346 行）
- Test: `packages/cli/src/lifecycle.test.ts`（追加）

**Interfaces:**
- Consumes: status 现有循环（channel/status API 已返回 ReviewStatus）
- Produces: stdout `StatusReport`（ui-server StatusAggregator 消费，Task 8）：
```ts
interface StatusReport {
  fetchedAt: string;             // ISO
  results: Array<{
    channel: string;
    platform: "android" | "ios" | "harmony" | string;   // 从 config 渠道归属推导（android.stores → android；ios/harmony 渠道 id 前缀映射）
    version?: string;            // ReviewStatus 无 version——渠道实现里有线上版本的不多，一期置 undefined
    state: "reviewing" | "approved" | "rejected" | "unknown";
    live?: boolean; reason?: string; raw?: string; error?: string;   // 现有字段保持
    fetchedAt: string;           // 单渠道时间戳
  }>;
}
```
- platform 推导规则（core 零框架知识的边界内）：status 现有 storeIds 来自 `config.android.stores`——全部标 `android`；未来 ios/harmony 渠道接入 status 时由渠道 `id` 映射表扩展（`PGYER→多端`，具体在渠道层补充，此处建立字段占位）。**一期如实输出：全部 android + 版本字段 undefined，不为造数据造字段。**

- [ ] **Step 1: 写失败测试**（快照断言——契约测试）

```ts
it("status --json 契约快照（含 platform/fetchedAt）", async () => {
  const dir = await makeProjectWithStubStores(); // 现有桩渠道工程 helper
  const { stdout } = await runCli(["status", "--cwd", dir, "--json"]);
  const r = JSON.parse(stdout);
  expect(r.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(r.results.every(x => x.platform && x.state && x.fetchedAt)).toBe(true);
  expect(r.results.map(x => x.channel)).toMatchInlineSnapshot();  // 渠道清单快照
});
```

- [ ] **Step 2: 确认失败**（现有输出无 platform/fetchedAt 包装层）

Run: `pnpm -r build && npx vitest run packages/cli/src/lifecycle.test.ts -t "契约快照"`
Expected: FAIL（`r.fetchedAt` undefined——现在 stdout 是裸数组）

- [ ] **Step 3: 实现**

status --json 输出从裸 `results` 数组改为 `{ fetchedAt, results }` 包装（每项补 `platform`/`fetchedAt`）。**破坏性变更评估**：`--json` 是 0.13.0 已发布面，0.14.0 minor 版本内允许（changeset minor：`applift status --json` 输出结构变更）。同步更新引用旧结构的测试。

- [ ] **Step 4: 全量回归**

Run: `pnpm -r build && npx vitest run`
Expected: 全绿

- [ ] **Step 5: Commit（含 changeset）**

```bash
pnpm changeset minor   # 交互选 @applift/cli + @applift/core，summary: status --json wrapped report with platform/fetchedAt
git add .changeset packages/cli/src/lifecycle.ts packages/cli/src/lifecycle.test.ts
git commit -m "feat(cli)!: status --json wrapped report with platform field"
```

---

### Task 7: 文档更新 + 阶段收尾

**Files:**
- Modify: `README.md`（若存在命令文档段落）
- Modify: `docs/superpowers/specs/2026-11-13-applift-ui-design.md` §4（validate 命令名定为 `applift validate`）

- [ ] **Step 1: README 补新命令文档**（`validate`、`doctor --json`、`beta --dry-run`、`--interactive-events` 协议说明各一段，含 NDJSON 事件示例）
- [ ] **Step 2: spec §4 第 3 条命令名同步**（`applift projects validate` → `applift validate`）
- [ ] **Step 3: 全量 gate**

Run: `pnpm -r build && npx vitest run && pnpm run smoke`
Expected: 全绿 + smoke-ok

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/specs/2026-11-13-applift-ui-design.md
git commit -m "docs: CLI machine-readable surface for applift-ui phase 1"
```
