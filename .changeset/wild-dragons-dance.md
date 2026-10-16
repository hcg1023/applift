---
"@applift/core": minor
---

全渠道 API 契约对照现行官方文档审计修复（2026-10，共 10 渠道 40+ 接口逐条核对）：华为安卓 app-file-info files 数组化 + 审核意见改 auditInfo.auditOpinion + listing 文案接口 v3→v2；App Store 提审迁移 reviewSubmissions 三步流（旧 appStoreVersionSubmissions 已下线）+ appVersionState 过滤参数 + earliestReleaseDate 字段修正；荣耀文案接口 languageInfoList 嵌套结构（旧扁平结构必败）+ 状态查询改 get-app-current-release；OPPO pkg_name 参数名 + audit_status 现行对照表重映射（原映射整体错位）+ app/upd 异步任务结果轮询；应用宝 query_app_detail 补 pkg_name + 扁平响应解析；vivo errorHints 现行码表 + updateDesc 上限校验；Google Play 轨道部署合并保留旧 versionCode + 状态查询改官方只读端点；AGC 鸿蒙提审前更新说明缺失预警。小米/蒲公英/签名算法均与现行文档一致未动。
