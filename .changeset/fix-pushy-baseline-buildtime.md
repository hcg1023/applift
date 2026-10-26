---
"@applift/core": patch
"@applift/cli": patch
---

修复 pushy 基线上传 buildTime 写入上传时刻导致热更永远到不了设备的问题（qy-driver 2026-10-26 实证）。

`uploadApp` 此前用 `Date.now()` 作为基线 buildTime，而 pushy 服务端要求它与设备上报的编译时间戳（鸿蒙包内 `resources/rawfile/meta.json` 的 `pushy_build_time`）精确匹配——不匹配的 checkUpdate 直接返回「编译时间戳不匹配」并封锁该设备 6 小时，表现为热更已发布、已绑定、灰度 100%，但真机永远收不到且无任何报错。

- `PushyCli.uploadApp` 增加必传 `buildTime` 参数，由调用方从产物内提取后显式传入
- 新增 `readArtifactBuildTime`：.hap/.app 读包内 meta.json（含 .app 嵌套 hap 提取）、.apk 读 AndroidManifest meta-data、.ipa 读 `pushy_build_time.txt`
- stage:after 自动基线在产物读不出 buildTime 时拒绝上传并提示人工补传（时间戳不可猜测）
