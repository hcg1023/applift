---
name: applift
description: 多端 App 发版 CLI（RN/Flutter/原生×3/Electron/Tauri × 10 渠道）。内测分发、多商店两段式提审（草稿→确认→提审）、审核状态跟踪、插件扩展。AI 友好（--json/自发现/零交互）。
---

# applift 发版技能

用 applift 把 App 发布到应用商店（华为/小米/OPPO/vivo/荣耀/应用宝/鸿蒙AGC/Google Play/iOS TestFlight/App Store）与内测渠道（蒲公英/AGC 指定设备）。

## 何时使用

用户要求：发版 / 上架 / 内测 / 提审 / 传包到商店 / 查审核状态 / TestFlight / 蒲公英。

## 执行流程

### 1. 摸底（总是先做）

```bash
applift channels --json          # 渠道清单+所需凭据键+获取指引
applift doctor --cwd <项目目录>   # 框架/包名推导/凭据核对/产物版本
```

### 2. 凭据检查

查找链：项目 `.applift/credentials.json`（逐层向上）→ `~/.applift/credentials.json` → `APPLIFT_*` 环境变量。doctor 报缺什么键，把 channels --json 里对应 hint 转告用户。不要编造凭据。

### 3. 内测（beta，安全，免确认）

```bash
applift beta android --note "说明"        # 蒲公英，扫码即装
applift beta harmony                # AGC 邀请测试（Testing API，需 .app 整包；--via pgyer 改蒲公英）
applift beta ios                      # 蒲公英（ipa 扫码即装）；TestFlight 走 release ios 的 asc 渠道
applift beta                             # 无参数：读 applift.config.ts 的 beta 段，多渠道并行内测
```

`beta` 段配置（全可选，写进 applift.config.ts）：

```ts
beta: {
  pgyer: { platforms: ["android", "ios"], installPassword: "1234" },  // 缺省 platforms=["android"]
  "agc-harmony": { submit: true, group: "内测组", testType: 3 },       // submit=true 上传绑定后自动提审（默认 false）
  testflight: { note: "TestFlight 备注" },                              // asc 渠道上传 ipa 进 TestFlight
},
```

逐渠道并行发布，任一失败退出码 1；`agc-harmony.group` 按群组名匹配（匹配不到报错，需先到 AGC 控制台建组）。

### 4. 正式发版（两段式，L3 不可逆）

```bash
applift release android --dry-run         # 先预览计划（无副作用，无需凭据）
applift release android                   # 交互向导：确认渠道→传草稿→询问是否提审
applift release android --submit --yes    # agent/CI：一条龙免交互
```

**安全红线**：`--submit` = 审核通过自动上架（除 iOS 默认手动）——agent 必须先把 dry-run 计划表展示给用户并获得明确同意。

小米渠道提审 icon 默认从工程 mipmap 自动发现（密度高→低），可用 `android.stores.xiaomi.icon` 覆盖。

### 5. 跟踪

```bash
applift status --stores huawei,xiaomi --json
applift history --json
```

## 语义约定

- 退出码：0=全成 1=有败；`--json` stdout 纯净（进度走 stderr）
- 错误信息自带"缺少 <KEY>（去哪拿）"；常见错误码附人话提示
- 项目配置 `applift.config.ts`（逐层向上查找）；stores 支持数组/字符串/对象三种写法；包名框架自动推导，配置可全空
- 定时上架 `--release-time`；提审备注 `--remark`；蒲公英密码安装 `--install-password`

## 扩展（用户要接自建平台/新框架时）

- 自建分发（OSS/NAS/内部市场）：实现 Channel 5 方法 + `'channel:register'` 注册，样板 `examples/plugin-oss/`
- 新框架（Qt/Unity/...）：实现 FrameworkAdapter 3 成员 + `'framework:register'`，样板 `examples/plugin-framework-qt/`

## 排错

| 症状                     | 处置                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| 框架识别失败             | 项目配置 artifacts 覆盖产物 glob，或 --artifact 指定                                       |
| 蒲公英上传慢             | 大包（90MB+）云端处理可达 5-10 分钟；CLI 轮询 15 分钟，超时可到 pgyer.com 控制台确认       |
| 华为 204144719           | 包编译中，CLI 自动重试                                                                     |
| vivo 文案被拒            | 官方要求 ≥5 字，空/短文案 CLI 直接拒绝                                                     |
| AGC 提审被拒（前置缺失） | 首次上架前控制台需完成：发布地区、内容分级、隐私政策、默认语言文案（一次性，API 无法代办） |
| 小米无草稿               | 上传即提审是官方设计，dry-run 显示 submit-only                                             |
