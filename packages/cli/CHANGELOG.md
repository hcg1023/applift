# @applift/cli

## 0.2.0

### Minor Changes

- a8bebb6: 小米 icon 自动发现扩展：新增 Tauri 2 移动端支持（src-tauri/icons 探测序），配合此前的 Android res 双根（RN/Flutter/Expo/原生安卓全覆盖）
- 504bc27: beta 命令支持配置驱动的多渠道并行内测：`applift beta`（无平台参数）读取 applift.config.ts 新增的 test 段（pgyer/agc-harmony/testflight），三端产物各走各的渠道并行发布，逐渠道报告结果；`beta <platform>` 快捷方式不变

### Patch Changes

- Updated dependencies [a8bebb6]
- Updated dependencies [504bc27]
  - @applift/core@0.3.0

## 0.1.6

### Patch Changes

- Updated dependencies [a1629df]
  - @applift/core@0.2.0

## 0.1.5

### Patch Changes

- 630a65b: beta 命令透传渠道 warn 事件（此前绑定失败等警告被静默导致假成功）；AGC 测试发布成功文案对齐 Testing API 新语义
- Updated dependencies [8f63ef5]
- Updated dependencies [b03bbaf]
- Updated dependencies [bee7885]
  - @applift/core@0.1.3

## 0.1.4

### Patch Changes

- e804d4f: 修复 `applift --version` 硬编码 0.2.0 的问题，改为从 package.json 动态读取

## 0.1.3

### Patch Changes

- d79c447: cli 直发链路验证（0.1.2 因 trusted publisher 配置切换期间暂存条目丢失，由本版补位）

## 0.1.2

### Patch Changes

- 59a758f: 验证 trusted publisher 直发（npm publish）链路
- Updated dependencies [59a758f]
  - @applift/core@0.1.2

## 0.1.1

### Patch Changes

- e2a3348: init
- Updated dependencies [e2a3348]
  - @applift/core@0.1.1
