# 构建编排（build orchestration）设计

> 状态：定稿（2026-11-18 头脑风暴产出）。前置：`docs/build-hook.md`（2026-10-24 暂缓提案，重启条件已满足：原生迭代高频 + 第二项目接入）、`docs/superpowers/specs/2026-11-14-applift-ui-tauri-design.md`（向导形态）。

## 0. 决策记录（头脑风暴定稿）

| 决策点      | 结论                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 触发形态    | **发版必构建**：向导/`--build` 每次发版都重新构建，永不用旧产物（CLI `--artifact` 显式逃生口保留）                                                                       |
| 声明形态    | **规则表**（按序首命中 + 可选 env 占位）——三代方案迭代的终版（枚举 recipes ✗ 矩阵爆炸；单命令纯 env ✗ 要求项目脚本适配）                                                 |
| 项目脚本    | **零适配**：命令 = 项目现有命令原样写进 config；`$APPLIFT_*` 是给 config 作者的 shell 占位便利，不是对脚本的要求                                                         |
| 多平台      | **逐平台执行**规则（`$APPLIFT_PLATFORM` 恒单值；单端失败不连坐；产物逐端探测）                                                                                           |
| 版本注入    | **一期不接管**（工程脚本自管 versionCode/孪生 versionName，双写现状保留）；env 接口一期定死（`APPLIFT_VERSION_NAME/CODE` 一期=当前值），二期接管时只改 config 命令字符串 |
| CLI 范围    | UI 与 CLI 同步：`applift build` 独立命令 + `beta --build` 内联 + UI 向导构建步                                                                                           |
| bump GUI 化 | 二期实现向导「版本确认」步；一期 dry-run 报告带版本三态字段作数据源预留                                                                                                  |

## 1. 配置契约（core `ProjectConfigSchema.build`）

```ts
build: z.object({
  /** 构建规则：按序首命中；匹配字段全可选（缺省 = 全匹配兜底） */
  rules: z
    .array(
      z.object({
        /** 匹配上下文（applift 已知的发版上下文；全字段可选） */
        delivery: z.enum(["ota", "native"]).optional(),
        stage: z.enum(["beta", "release"]).optional(),
        channel: z.string().optional(), // 渠道 id（pgyer/agc/asc/...）
        platform: z.string().optional(), // 单平台（android/harmony/ios）
        /** 不透明命令：经 shell 执行（sh -c / win cmd /c），cwd=工程目录 */
        command: z.string().min(1),
        /** 超时分钟（缺省 60；上限 720） */
        timeoutMinutes: z.number().int().min(1).max(720).optional(),
      }),
    )
    .min(1),
}).optional();
```

- **整个 `build` 段不声明 → 一切行为与现状完全一致**（零侵入）
- 命令内可用 shell 环境变量占位（见 §3），由 shell 展开——applift 不解析命令内容

## 2. 规则匹配语义

- 上下文来源：判定结果（delivery）+ 发版阶段（beta/release）+ 目标渠道 + 平台（逐平台单值）
- 逐条按序匹配（所有声明字段与上下文相等才命中），**首个命中即执行**
- 一条不中 → 明确报错并列出全部规则与当前上下文（CLI stderr / UI 构建步内）
- 执行透明化：命令跑之前打印/展示「命中规则 #N（匹配字段）→ 命令明文」

### qy-driver 全矩阵验证（4 条封顶）

| 场景                 | 命中                    | 说明                                                            |
| -------------------- | ----------------------- | --------------------------------------------------------------- |
| OTA 热更（任意平台） | 规则 1（delivery=ota）  | `npm run ppk:$APPLIFT_PLATFORM`                                 |
| release 正式包       | 规则 2（stage=release） | `--app --skip-bundle --release`                                 |
| beta + 蒲公英        | 规则 3（channel=pgyer） | `SIGNING_CONFIG=internaltesting` 前缀（签名差异留在命令字符串） |
| beta + AGC / 其余    | 规则 4（缺省）          | `--platform $APPLIFT_PLATFORM --app`                            |

newdriver-ios：单条缺省 `node scripts/export-ipa.js`（不看 env）。

## 3. 环境变量注入（构建执行时）

| 变量                   | 一期值                                              | 二期演进（版本接管后）  |
| ---------------------- | --------------------------------------------------- | ----------------------- |
| `APPLIFT_PLATFORM`     | 当前执行平台（恒单值：android/harmony/ios）         | 不变                    |
| `APPLIFT_STAGE`        | beta / release                                      | 不变                    |
| `APPLIFT_DELIVERY`     | ota / native（判定结果）                            | 不变                    |
| `APPLIFT_CHANNEL`      | 目标渠道 id（pgyer/agc/…；多渠道发版=逐渠道值执行） | 不变                    |
| `APPLIFT_VERSION_NAME` | 当前工程版本（readProjectVersions）                 | **bump 后的目标版本**   |
| `APPLIFT_VERSION_CODE` | 当前工程版本号                                      | **bump 分配后的目标号** |

env 是给 config 命令字符串的 shell 占位便利；项目脚本收到的仍是普通 argv（`--platform $APPLIFT_PLATFORM` 展开后即脚本已有参数），**无任何适配要求**。

## 4. 三个入口

### 4.1 CLI：`applift build`

```
applift build                          # 列出规则（编号/匹配字段/命令）只读
applift build --platform harmony --stage beta [--channel pgyer] [--delivery native]
                                       # 注入 env → 首命中规则 → sh -c 执行
                                       # 流式转发输出、超时 kill、退出码透传；打印命中规则
```

纯编排命令，不碰发版。

### 4.2 CLI：`applift beta <platform> [--bump] --build`

```
判定 →（需 bump 且 --bump：声明）→ 规则匹配 → 逐平台执行构建
     → 产物探测 + 版本校验（readArtifactVersion）→ 原有 beta 发布流程
```

- 判定 OTA：走 delivery=ota 规则（未声明 build 段 → 报错引导 config 声明；不静默跳过构建——发版必构建）
- 构建失败/超时：终止发版，退出码透传
- 与 `--bump` 组合顺序：声明 → 构建 → 发布（构建在声明后，产物携带新版本）

### 4.3 UI 向导（4 步 → 5 步）

```
① 预览改动（判定，dry-run 报告含版本三态字段——一期数据源预留）
② 构建（必经）：按判定自动匹配规则 → 展示命令明文 → 一键执行（spawnStream 日志滚动）
   失败：日志尾段 + 重试按钮；无匹配规则：明确阻止 + 引导声明
③ 确认方式（现有步骤：OTA/原生改选）
④ 执行 ⑤ 完成
```

二期在 ①② 之间插入「版本确认」步（判定=需 bump 时出现：按建议 bump / 自定义版本 / 跳过；OTA 跳过；已声明只展示）——步骤位置一期预留。

## 5. 错误处理

| 场景         | 行为                                                                              |
| ------------ | --------------------------------------------------------------------------------- |
| 规则零命中   | CLI：stderr 列全部规则+当前上下文，exit 1；UI：构建步阻止 + 引导                  |
| 构建非零退出 | 终止发版；输出原样转发（不试图人话化——proposal 硬契约）；UI 停构建步可重试        |
| 超时         | kill 进程组（复用 AppliftRunner 语义）+ 同失败路径                                |
| 产物校验失败 | 拒绝发布（沿用现有产物版本校验链路）                                              |
| shell 注入面 | 命令字符串经 `sh -c`：与 npm scripts 同信任级（用户自己的 config/机器），文档明示 |

## 6. 不变量 1 改写（AGENTS.md 同步）

> **不接管构建（收紧版）**：构建是项目域知识。applift 仅允许 spawn **项目配置 `build.rules` 声明的不透明命令**（经 shell 黑盒执行），且 (a) 不生成、拼接、推断构建参数（env 占位是 config 作者书写，applift 只注入上下文变量）；(b) 不感知框架/渠道构建差异（匹配字段是配置作者声明的标签）；(c) 产物仍是唯一发布入口，构建后必须通过探测与版本校验。`FrameworkAdapter` 无 buildCommand 字段（v1 禁令维持）。不声明 `build` 段时所有行为与现状一致。

## 7. 测试面

- **core**：`build` 段 schema 校验（空 rules 拒绝、字段枚举、timeout 边界）；规则匹配纯函数（按序命中/零命中/字段相等语义）
- **CLI**：`applift build` 列表/执行（桩脚本：成功/失败/超时）；`beta --build` 四态（OTA 走 ota 规则、native 走缺省、零命中报错、构建失败终止）
- **ui-server**：构建任务桥（spawnStream 复用、cwd=工程、env 注入断言——桩脚本回显 env）
- **UI**：向导 5 步状态机（构建步必经、失败重试、命令明文展示）；e2e 桩构建链路
- **gate**：`pnpm -r build && npx vitest run` + smoke + Playwright + cargo 全绿

## 8. 二期路线（记录不实施）

1. **版本接管**：bump 注入 `APPLIFT_VERSION_*` 目标值 + 构建前写/构建后还原（中断安全）；qy-driver build-test.js 删版本逻辑
2. **向导版本确认步**：dry-run 三态字段（一期就绪）→ GUI bump 交互 + version bump 任务桥
3. 多渠道发版的逐渠道构建编排（一期单渠道值执行已覆盖主路径）
