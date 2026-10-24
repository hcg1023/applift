# 变更提案：版本声明与封板语义（bump-semantics）

> 状态：**已实施（2026-10-24）**。影响 `@applift/core` + `@applift/cli`。
> 背景：唯一真实用户 qy-driver（RN 三端）。讨论结论：bump 不应是"发布动作"，而是**版本声明**；tag 才是封板标记。

## 1. 需求

### 1.1 问题

当前实现把"版本声明"与"交付标记"揉在一起，产生三个问题：

1. **bump 携带了 tag 这个交付信号**：`applyBump` 默认 `tag: true`（`packages/cli/src/index.ts` → `runBumpOrchestration` → `applyBump`），一条 bump 同时写文件、commit、打 tag。而 AGENTS.md 版本语义明确"tag 由 release 全渠道提审成功后补"——`release` 路径的 `tagReleaseVersion`（`packages/core/src/version/git.ts` L85-101）也是幂等补打。两条路径都会打 tag，先到先得，**语义漂移**。
2. **判定锚点依赖 tag**：`collectReleaseDiff`（`packages/core/src/update.ts` L102-114）以 `latestSemverTag` 为锚点收集 diff。现在"多次 beta 不重复 bump"只是因为 bump 顺手打了 tag、把锚点推走了——**这是巧合而不是设计**。一旦按本提案去掉 bump 的 tag，同一迭代内每次 beta 都会重新看到原生改动 → 反复判定原生 → 反复建议 bump → 烧版本号。
3. **bump 被迫成为开发动作**：因为（a）移动端版本号烤进二进制、（b）applift 不接管构建、（c）测试包要用下一版的孪生体，版本声明必然早于测试包构建。接受这一物理约束后，正确做法不是把 bump 挪到发布时，而是**把 tag 从 bump 拿走**，恢复"version 声明 / publish 交付"的分工（changesets 同款）。

### 1.2 目标

1. `applift version bump` = **版本声明**：写工程文件 + CHANGELOG + commit，**默认不打 tag**（`--tag` 保留显式开口）。
2. `applift release` = **交付**：确认产物版本 == 工程版本 → 提审 → 全渠道成功后补 `v{产物版本}`（封板）。
3. 新增**版本声明锚点**：tag 与最新 `chore(release):` commit 取新者，替换 `collectReleaseDiff` 的 tag 单一锚点。
4. beta 判定升级为**三态**：OTA / 原生·需 bump / 原生·已声明（只需重建）。
5. beta 支持**自动 bump**：按 conventional commits 推断级别，交互确认后直接 bump（`--yes` / CI 跳过确认）。

### 1.3 非目标

- **不接管构建**（不变量 1 不变），bump 后仍需人工构建再重跑 beta。
- 不改测试孪生体派生规则（`version.beta` 的 `offset`/`suffix`/`app-id`）。
- 不改 versionCode 分配模型（bump 与出包各自 +1，工程文件即计数器）。
- 不引入 pending 版本层或状态文件（锚点从 git 派生，零本地状态）。
- 不改热更路径（OTA 不参与 bump）。

### 1.4 验收标准

| #   | 验收项                                                                                      |
| --- | ------------------------------------------------------------------------------------------- |
| 1   | `version bump` 默认不产生 tag；`--tag` 显式打开时才打                                       |
| 2   | `release` 全渠道提审成功后补 `v{产物版本}`；tag 已存在且指向不同 commit 时告警而非静默跳过  |
| 3   | 锚点取"最新 semver tag 提交"与"最新 `chore(release):` 提交"中较新者                         |
| 4   | 原生改动 + 工程版本 == 最近 release tag 版本 → 引导 bump（并给出推荐版本 + 推断理由）       |
| 5   | 原生改动 + 工程版本 > 最近 release tag 版本 → **只引导重建，不再 bump**                     |
| 6   | 锚点后纯 JS 改动 → 判 OTA，不发原生、不 bump、不烧 versionCode                              |
| 7   | `beta --bump` 在原生·需 bump 分支完成 bump + commit，并打印后续构建指引；`--yes` 全程无交互 |
| 8   | 全部既有测试绿 + 新增锚点/三态/自动 bump 用例                                               |

## 2. 设计

### 2.1 三个概念

| 概念            | 定义                                                             | 产生时刻               | git 痕迹                       |
| --------------- | ---------------------------------------------------------------- | ---------------------- | ------------------------------ |
| **版本声明**    | 工程版本改为本次要发布的号（`4.0.0`→`4.1.0`），并记录 CHANGELOG  | 发测试前（判定原生后） | `chore(release): 4.1.0` commit |
| **测试孪生体**  | 由工程版本派生的测试包身份（`4.1.1000`），构建期临时使用、不落盘 | 构建测试包时           | 无                             |
| **封板（tag）** | 该版本已交付渠道的事实标记 `v4.1.0`                              | release 提审成功后     | annotated/lightweight tag      |

一条逻辑版本对应**两个 versionName 身份**（测试 `4.1.1000` / 正式 `4.1.0`），versionCode 则每次构建消耗一个（一个周期至少 2 个：测试包一次、正式包一次）。

### 2.2 锚点（版本声明点）

```ts
// packages/core/src/version/git.ts（新增）
export interface VersionAnchor {
  ref: string; // 可直接传给 git diff / git rev-parse 的 ref（tag 名或 commit sha）
  kind: "tag" | "bump"; // tag = 已交付；bump = 已声明未交付
  version?: string; // 从 tag 名或 commit message 解析
  label: string; // 展示用："v4.0.0（已发布）" / "v4.1.0（已声明未发布）"
}

export function latestVersionAnchor(cwd: string): VersionAnchor | null;
```

规则：取 `latestSemverTag` 指向的提交与最新「subject 以 `chore(release): ` 开头」的提交，按 committer time 取较新者（同秒平局用拓扑序决胜：bump 是 tag 的后代则 bump 胜；同一提交优先 tag）。**只认 subject**——`git log --grep` 的 `^` 是行锚定、会命中 body 行，release-note 风格 body 会劫持锚点把更早的原生改动挤出判定窗口（对抗审查实证）。无 tag 且无 bump commit → `null`（判定按 uncertain / patch 兜底语义处理）。

`collectReleaseDiff` 改为以 `VersionAnchor.ref` 为 diff 基准（`git diff --name-only <ref>`；ref 为 tag 名或 sha 均可）。

**为什么不用状态文件**：bump commit 是天然的、随分支合并传播的锚点；状态文件会跨机器/分支失真，且与"工程文件即事实源"的项目原则冲突。

### 2.3 三态判定

```
diff = collectReleaseDiff(cwd)              // 从 anchor 到工作区
judgement = provider.judge(diff, ctx)       // OTA | native | uncertain

if OTA       → 发 ppk（不动版本、不构建）
if native:
    released = latestSemverTag 的版本（无 tag → 0.0.0）
    project  = 工程 versionName
    if project > released  → 原生·已声明：引导"构建后重跑 --delivery native"，不 bump
    else                   → 原生·需 bump：推荐版本（planBump/inferBumpLevel）→ 可选自动 bump
```

推断级别来源（已具备）：`packages/core/src/version/infer.ts` 的 `inferBumpLevel`
——`BREAKING CHANGE → major` / `feat → minor` / `fix → patch`，锚点为最新 tag。

**场景走查**（未 release 期间多次 beta）：

| 轮次    | 改动     | 锚点                  | 判定         | 动作                                  |
| ------- | -------- | --------------------- | ------------ | ------------------------------------- |
| Beta #1 | 纯 JS    | v4.0.0（tag）         | OTA          | 发 `4.0.1000-patch.1`                 |
| Beta #2 | 出现原生 | v4.0.0（tag）         | 原生·需 bump | 推荐 4.1.0 → bump + commit            |
| Beta #3 | 纯 JS    | v4.1.0（bump commit） | OTA          | 发 `4.1.1000-patch.1`（无需重建）     |
| Beta #4 | 又有原生 | v4.1.0（bump commit） | 原生·已声明  | 只提示重建，不 bump                   |
| release | —        | —                     | —            | 校验产物==4.1.0 → 提审 → tag `v4.1.0` |

### 2.4 命令与配置契约

| 入口                                     | 变更                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| `applift version bump [level]`           | 默认 `tag: false`；`--tag` 显式打开；输出改为"版本已声明，tag 将在 release 成功后补" |
| `applift version bump --no-commit`       | 保留，但**不产生锚点**（判定会停留在上一个 tag）——文档标注为调试用途                 |
| `applift beta <platform> --bump [level]` | 新增。仅当判定"原生·需 bump"时执行 bump（level 缺省用推断值）；`--yes` 跳过确认      |
| `beta.autoBump: boolean`                 | 新增配置，等价于永远带 `--bump`；CI 需配合 `--yes`                                   |
| `applift beta --delivery native`         | 语义不变：显式跳过判定走原生发布；bump 后的重跑必须带（锚点已推进，判定会说 OTA）    |
| `applift release`                        | 增加"tag 已存在但指向不同 commit"的告警（可能是历史提前 tag 或驳回重提后未移动）     |

自动 bump 的交互形态：

```
本次改动判定为原生发版。
推荐版本：4.1.0（minor：锚点 v4.0.0 之后有 3 个 feat）
是否现在 bump？(Y/n)  → Y
✓ 三端版本已写入，CHANGELOG + commit 完成（未打 tag）
下一步：npm run build:test -- --platform harmony
然后重跑：applift beta harmony --delivery native
```

### 2.5 驳回重提的语义（写入文档，不改代码）

- 审核驳回后修改：`versionName` 不变、`versionCode` +1、重建重提
- tag 名不变（`v4.1.0`），但应改指向修复后的提交：`git tag -d v4.1.0 && git tag v4.1.0`
- **前提：tag 未 push**（applift 从不 push）。已 push 时移动需 force push，应改为"保留旧 tag + 人工记录"，或等审核通过后再补 tag
- 纯资料驳回（不发新包）→ versionCode 不变，无需移动 tag

## 3. 实现

### 3.1 文件清单

| 文件                                 | 改动                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| `packages/core/src/version/git.ts`   | 新增 `latestVersionAnchor`；`tagReleaseVersion` 增加"已存在但指向不同 commit"的返回值 |
| `packages/core/src/update.ts`        | `collectReleaseDiff` 改为基于 `latestVersionAnchor`                                   |
| `packages/cli/src/index.ts`          | bump 默认 `tag:false` + 文案；beta 三态分支 + `--bump`/`--yes`；release tag 告警      |
| `packages/core/src/config/schema.ts` | `BetaConfigSchema.autoBump: boolean`（默认 false）                                    |
| `packages/core/src/version/bump.ts`  | 导出 `planBump` 供 beta 复用（若未导出）；无行为变更                                  |
| `AGENTS.md`                          | 版本语义表更新（bump 不打 tag）；已知边界补"`--no-commit` 失锚""驳回重提 tag 移动"    |

### 3.2 测试计划

- `version-anchor.test.ts`：只有 tag / 只有 bump commit / 两者并存取新者 / 都没有 → null
- `bump.test.ts`：默认不打 tag；`--tag` 打；`--no-commit` 不产生锚点
- `update.test.ts`：锚点切换后 diff 收集正确（bump 后纯 JS 不判原生）
- `commands.test.ts`：三态引导文案（需 bump / 已声明 / OTA）；`beta --bump --yes` 全流程（mock 渠道）
- 回归：现有 994 用例全绿

### 3.3 分阶段

1. **语义层**：bump 去 tag + 锚点 + 三态（正确性，必须先落）
2. **自动化层**：`beta --bump` + `beta.autoBump`（体验）
3. 文档与 changeset 同步

## 4. 兼容性

| 场景                                  | 影响                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 已用旧 `version bump` 打过 tag 的项目 | 无破坏：锚点取新者；tag 已存在时 release 走"已存在"幂等分支                                                         |
| 依赖"bump 即打 tag"的外部脚本         | **行为变化**：需改带 `--tag`。changeset 标注 minor + 迁移说明                                                       |
| CI 非交互                             | `--bump` 在非 TTY 下必须配 `--yes`，否则沿用现有 fail-fast（`runBumpOrchestration` 已有该护栏）                     |
| 疑似失败重跑                          | 沿用 `planBump.suspectRerun` 保护：锚点后无业务提交且 HEAD 是 release commit → 拒绝自动 bump，提示 `--no-bump` 复用 |

## 5. 风险与未决

- **`--no-commit` 破坏锚点**：bump 不 commit 就无法被识别为声明点，后续 beta 会重复判原生。文档标注为调试用途；或后续改为"`--no-commit` 时写临时锚点文件"（暂不做）。
- **tag 已 push 后的驳回重提**：移动 tag 需要 force push。当前选择"文档约定 + 人工决策"，不自动化。
- **`project > released` 的版本比较**：依赖 semver；对非 semver 版本（历史上出现过非规范值）退化为"无法比较 → 走需 bump 分支并告警"。
- **多端版本不一致**：release 已有"版本不一致跳过 tag"的护栏（`index.ts` L1415/L1492），保持不变。
- **是否把 bump 也纳入 `release` 自动执行**：明确不做——版本声明必须在构建前，release 阶段已经没有构建机会。
