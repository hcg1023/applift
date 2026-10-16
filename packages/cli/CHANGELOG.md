# @applift/cli

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
