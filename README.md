# applift

> 框架无关的多端 App 发版 CLI——React Native / Flutter / 原生（Android/iOS/鸿蒙）/ Electron / Tauri × 10 发布渠道，一套凭据、一套命令。

## 安装

```bash
# 方式一：项目内（推荐，团队锁版本）
pnpm add -D @applift/cli

# 方式二：npm 全局
npm i -g @applift/cli
```

要求 Node ≥20（CI 强制 runtime-node20 门禁）。bun 直跑 dist 仅基本兼容（`--version`/`channels`
等基本命令验证通过；配置装载在 linux bun 下未通过，读配置命令请用 Node）；不做 bun --compile
单文件二进制分发——配置与插件深耦合工程 node_modules，裸机场景不存在。

## 5 分钟上手

```bash
applift init            # 向导：识别框架 → 生成 applift.config.ts → 引导配凭据
applift doctor          # 体检：框架/包名推导/凭据核对/产物版本
applift beta android --note "修复xx"    # 内测：三端均走蒲公英扫码即装（ios 的 ipa / harmony 的 hap --via pgyer）
applift beta                             # 多渠道内测：读 applift.config.ts 的 beta 段并行发（pgyer/agc/testflight）
```

多渠道内测配置示例（applift.config.ts，全可选）：

```ts
beta: {
  pgyer: { platforms: ["android", "ios"], installPassword: "1234" }, // 蒲公英多平台，缺省只发 android
  agc: { submit: true, group: "内测组" },                              // AGC 邀请测试；submit=true 自动提审；发布前自动停删旧测试版本（cleanup 默认 true）
  testflight: { note: "TestFlight 备注" },                            // asc 上传 ipa 进 TestFlight
},
```

正式发版（两段式，交互向导引导）：

````bash
applift release android           # ① 确认渠道清单 → 传包到各家草稿（安全）
                                  # ② 草稿就绪后交互询问"现在提审？"
applift release android --submit  # 一条龙：传包+计划确认+提审（审核通过即上架）
applift release android --dry-run # 只看计划，无需凭据
applift status --stores huawei    # 审核状态跟踪
applift history                   # 谁在何时发了什么

版本管理(可接管:工程文件永远是版本事实源,applift 只代读代写):

```bash
applift version                          # 各端版本实况(versionName/versionCode + 锚点 tag)
applift version bump patch               # 写工程文件 + CHANGELOG + 代 commit + 代 tag v4.0.1
applift version bump minor --pre beta    # 进入 prerelease:tag v4.1.0-beta.0,商店 versionName 仍 4.1.0
applift beta --yes                      # 多渠道内测一条命令（构建由项目完成，读最新产物 → 校验 → 分发）
````

- 版本决定链:显式指定 > git conventional commits 推断(BREAKING/feat/fix)> patch 兜底;结果展示确认,不静默
- versionCode 单调策略 max(公式值, 现值+1):config `version: { versionCode: { formula: "major*1000000+minor*1000+patch", platforms: ["harmony"] } }`,默认递增 +1;beta.1→beta.2→正式全程单调,AGC 同版本不能覆盖升级的墙由此规避
- 升版本显式化(构建/bump 解耦):beta/release 不再代 bump;`applift version bump` 单独升版本后重新构建,再跑发布命令
- 热更正式默认全量:promote 灰度比例内置默认 100,`--rollout N` 或 `rnUpdate({ defaultRollout: N })` 显式灰度

## 配置

**优先级公理（所有配置键同一条链，高 → 低）**：CLI flag > `APPLIFT_*` env > 个人（`applift use`）> 项目（`.applift/` + `applift.config.ts`）> 全局（`~/.applift/`）。`applift doctor` 会打印每个生效值来自哪一层。

**凭据**（`~/.applift/credentials.json`，0600；项目 `.applift/` 同名文件逐键优先，私有仓可提交进仓库）：

```json
{
  "profiles": {
    "default": {
      "PGYER_API_KEY": "...", // 蒲公英（免费，内测）
      "AGC_CLIENT_ID": "..." // 华为 AGC；完整键清单：applift channels --json（含每项获取指引）
    }
  }
}
```

**项目**（`applift.config.ts`，凭据/渠道可全空；**发布命令（beta/release）必须声明 framework 插件**，未声明会直接报错——版本读写等只读命令仍可自动探测）：

```ts
import { defineConfig } from "@applift/cli";
import { rnFramework } from "@applift/cli/plugins";

export default defineConfig({
  plugins: [rnFramework()], // 框架声明是发布的前提（rn/flutter/native-android/native-ios/native-harmony/electron/tauri）
  android: { stores: ["huawei", { yyb: "appId值" }] }, // 简写：数组/字符串/对象三种
  // artifacts: { ios: ['非标准/产物/路径/*.ipa'] },      // 仅非标工程需要
});
```

profile 切换：`applift use <name>`（本机个人选择）或 `--profile`（最高优先级）。

## 渠道与能力

|      | 渠道                                      | stage 草稿  | 提审          | 审核通过后           |
| ---- | ----------------------------------------- | ----------- | ------------- | -------------------- |
| 内测 | 蒲公英（三端）/ AGC 指定设备              | ✅          | —             | 即装                 |
| 安卓 | 华为 / 小米 / OPPO / vivo / 荣耀 / 应用宝 | ✅*         | ✅            | 自动上架             |
| 鸿蒙 | AGC（.app 整包全链路）                    | ✅          | ✅            | 自动上架             |
| iOS  | App Store Connect / TestFlight            | ✅          | ✅            | **手动发布**（默认） |
| 海外 | Google Play                               | ✅ internal | ✅ production | 自动                 |

*小米上传即提审（无草稿态），提审 icon 默认从工程自动发现（android res mipmap → Tauri src-tauri/icons），可用 `android.stores.xiaomi.icon` 覆盖。`applift channels --json` 查全部渠道+所需凭据。

## 插件（vite 风格）

```ts
import { rnFramework, rnUpdate } from "@applift/cli/plugins";

plugins: [
  rnFramework(), // 框架适配器（发布必声明；detect + 产物 pattern，不含构建命令——构建由项目负责）
  rnUpdate({ harmony: 34166 }), // 热更：配置了 appId 的平台启用 OTA 路由与原生基线上传
  dingtalkNotify({ webhook: "..." }), // 官方：钉钉通知
  {
    name: "no-friday",
    "submit:before"() {
      return !isFridayNight();
    },
  }, // 拦截提审
];
```

10 个生命周期钩子（config:resolved / 三个 register / plan·stage·submit 前后可拦截可修改 / notify）。三个扩展点对称：

| 扩展     | 接口                                                  | 注册钩子               | 样板                                     |
| -------- | ----------------------------------------------------- | ---------------------- | ---------------------------------------- |
| 发布渠道 | `Channel`（5 方法+能力声明+错误码表）                 | `'channel:register'`   | `examples/plugin-oss`                    |
| 项目框架 | `FrameworkAdapter`（detect/产物 pattern）             | `'framework:register'` | `examples/plugin-framework-qt`           |
| 热更     | `UpdateProvider`（judge/publishToTest/promoteToProd） | `'update:register'`    | `packages/core/src/plugins/rn-update.ts` |

### 热更（react-native-update / pushy）

配置 `rnUpdate({ harmony: <appId> })` 后（导入自 `@applift/cli/plugins`——消费方只依赖 @applift/cli 即有完整类型；`@applift/core/plugins` 等价），`beta/release <platform>` 会先判定本次改动能否走热更（原生目录/原生依赖/补丁/构建配置 → 原生包；纯 JS → 热更；灰区 → uncertain），展示逐文件证据后由你拍板：

```bash
applift beta harmony --delivery ota        # 热更发测试通道（版本名 {ver}-patch.N，绑定测试包 major+1000）
applift release harmony --delivery ota --rollout 20   # 测试通道最新热更 promote 到正式（重绑正式原生版本+灰度）
```

- 非交互（`--yes`/`--json`/无 TTY）用推荐值，uncertain 必须显式 `--delivery`
- 原生发版时自动把产物上传为 pushy 基线（失败仅提醒，不阻断发布）

平台枚举开放（含 windows/macos/linux），桌面商店（winget/Homebrew 等）与游戏商店均为纯插件扩展。

## AI / CI

- `--json` 结构化输出（channels/status/history/listing/release 支持；stdout 纯净，进度走 stderr）；退出码 0=全成 1=有败
- `applift channels --json` 自发现；`--yes` 无人值守；错误信息自带"缺什么键去哪拿"
- Agent 技能文档：`SKILL.md`（可装入 Claude Code/Cursor）/ `docs/llms.txt`

## 开发

```bash
pnpm install && pnpm build && pnpm test     # 全量测试；pnpm test:coverage 覆盖率门禁（CI 强制，阈值=现实基线棘轮）
pnpm vitest run --coverage                   # 覆盖率报告
bun build --compile packages/cli/src/bin.ts --target=bun-darwin-arm64   # 出二进制
```

架构：`packages/core`（headless 引擎：Channel/PluginHost/FrameworkAdapter/pipeline）+ `packages/cli`（渲染壳）。TS 配置加载：bun 下 tryNative 原生零转换 + Bun.Transpiler 兜底；node 下 c12/jiti 默认。
