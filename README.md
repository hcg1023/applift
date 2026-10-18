# applift

> 框架无关的多端 App 发版 CLI——React Native / Flutter / 原生（Android/iOS/鸿蒙）/ Electron / Tauri × 10 发布渠道，一套凭据、一套命令。

## 安装

```bash
# 方式一：项目内（推荐，团队锁版本）
pnpm add -D @applift/cli

# 方式二：二进制（免 Node，CI/脚本机）
# bun build --compile 后的单一可执行文件，或 npm 全局
```

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
  agc: { submit: true, group: "内测组" },                              // AGC 邀请测试；submit=true 自动提审
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
applift beta --bump                      # 自动 version(git 推断)→ 重新构建 → 多渠道内测一条命令
````

- 版本决定链:显式指定 > git conventional commits 推断(BREAKING/feat/fix)> patch 兜底;结果展示确认,不静默
- versionCode 单调策略 max(公式值, 现值+1):config `version: { versionCode: { formula: "major*1000000+minor*1000+patch", platforms: ["harmony"] } }`,默认递增 +1;beta.1→beta.2→正式全程单调,AGC 同版本不能覆盖升级的墙由此规避
- 自动 version 常开:config `beta: { bump: true }`(或 `release: { bump: true }`),`--no-bump` 临时关
- push 永不代做,收尾提示 `git push --follow-tags`

## 配置

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

**项目**（`applift.config.ts`，可全空——包名/框架自动推导）：

```ts
import { defineConfig } from "@applift/core";
export default defineConfig({
  android: { stores: ["huawei", { yyb: "appId值" }] }, // 简写：数组/字符串/对象三种
  // artifacts: { ios: ['非标准/产物/路径/*.ipa'] },      // 仅非标工程需要
  // plugins: [...],                                      // 见下
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
plugins: [
  dingtalkNotify({ webhook: "..." }), // 官方：钉钉通知
  {
    name: "no-friday",
    "submit:before"() {
      return !isFridayNight();
    },
  }, // 拦截提审
];
```

8 个生命周期钩子（plan/stage/submit 前后可拦截可修改）。两个扩展点对称：

| 扩展     | 接口                                               | 注册钩子               | 样板                           |
| -------- | -------------------------------------------------- | ---------------------- | ------------------------------ |
| 发布渠道 | `Channel`（5 方法+能力声明+错误码表）              | `'channel:register'`   | `examples/plugin-oss`          |
| 项目框架 | `FrameworkAdapter`（detect/产物 pattern/构建命令） | `'framework:register'` | `examples/plugin-framework-qt` |

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
