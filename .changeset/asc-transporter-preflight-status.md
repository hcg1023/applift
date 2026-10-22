---
"@applift/core": minor
---

ASC（App Store Connect iOS）渠道三项升级：

- **stage 上传双引擎**：装了 Transporter.app（Mac App Store）时首选 `iTMSTransporter -m upload -jwt` 上传——JWT 与 ASC REST API 同源（Apple 官方建议 API 用户用同一 JWT 上传二进制），免 altool 的 private_keys 目录查找；未装时回退 `xcrun altool`（零额外安装，官方仍支持）。可选凭据 `ASC_TRANSPORTER_PATH` 显式指定 iTMSTransporter 路径。防御：ipa 复制到临时随机 ASCII 名再传（-assetFile 成功后 Apple 侧会删源文件、多字节文件名上传失败，fastlane 实证）；成败按 fastlane 语义（exit 0 且 `DBG-X: Returning 0`）。
- **submit 提审前预检**：目标版本的全部 appStoreVersionLocalizations 必须有商店描述（description），缺失提前报错并列出 locale，不再等 reviewSubmissions 最后一步被拒；并 emit 出口合规提示（Info.plist `ITSAppUsesNonExemptEncryption`）。
- **status 接入**（capabilities.status=true）：查最新 appStoreVersion 的 appVersionState（AppVersionState 15 枚举）映射 ReviewStatus——审核中/被拒（含 METADATA_REJECTED、INVALID_BINARY）/已批准未发布（PENDING_DEVELOPER_RELEASE 等）/已上架（READY_FOR_DISTRIBUTION），跳过 PREPARE_FOR_SUBMISSION 与 REPLACED_WITH_NEW_VERSION 非活跃记录。
