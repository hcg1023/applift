# @applift/core

## 0.4.0

### Minor Changes

- bf29106: 配置加载器 jiti 别名（@applift/core / @applift/cli 指向自带模块）与 dist 未构建时的 src 入口回退——裸工程导入 defineConfig 的 core 侧配套（与 cli@0.3.0 的重导出配对生效）

## 0.3.0

### Minor Changes

- a8bebb6: 渠道 id agc-harmony 改名 agc（配置键同步：beta 段与 harmony.stores，行为不变）；vivo sign_method 按官方文档字面改小写 hmac-sha256
- 504bc27: 内测多渠道支持：config 新增 test 段（pgyer.platforms / agc-harmony.submit+group+testType / testflight）；AGC 邀请测试可选自动提审（提交测试版本 API + 测试群组按名匹配绑定）。apkgo 源码仲裁修复：vivo 审核状态改读 data.status（1草稿/2待审核/3通过/4不通过/5撤销，旧 auditStatus 0/1/2 系误记）+ sign_method 改 HMAC-SHA256；小米 push 必带 icon（android.stores.xiaomi.icon 配置，SIG 一并签名）；应用宝 arm64-only 包改传 apk32_flag=2+apk64_flag=1（新增零依赖 APK ABI 探测）；OPPO 911216 补任务结果轮询

## 0.2.0

### Minor Changes

- a1629df: 全渠道 API 契约对照现行官方文档审计修复（2026-10，共 10 渠道 40+ 接口逐条核对）：华为安卓 app-file-info files 数组化 + 审核意见改 auditInfo.auditOpinion + listing 文案接口 v3→v2；App Store 提审迁移 reviewSubmissions 三步流（旧 appStoreVersionSubmissions 已下线）+ appVersionState 过滤参数 + earliestReleaseDate 字段修正；荣耀文案接口 languageInfoList 嵌套结构（旧扁平结构必败）+ 状态查询改 get-app-current-release；OPPO pkg_name 参数名 + audit_status 现行对照表重映射（原映射整体错位）+ app/upd 异步任务结果轮询；应用宝 query_app_detail 补 pkg_name + 扁平响应解析；vivo errorHints 现行码表 + updateDesc 上限校验；Google Play 轨道部署合并保留旧 versionCode + 状态查询改官方只读端点；AGC 鸿蒙提审前更新说明缺失预警。小米/蒲公英/签名算法均与现行文档一致未动。

## 0.1.3

### Patch Changes

- 8f63ef5: AGC 测试发布重构为 Testing API 新链路（华为已下线 releaseType=6 直绑 app-package-info，枚举仅剩 1/7）：上传 .hap → 新建测试版本（testType=3 邀请测试）→ 添加测试软件包 → 等云端编译 → 更新测试版本绑定；不再自动写应用文案（测试信息继承全网版本）。2026-10 真实链路实测发现。
- b03bbaf: 适配华为 AGC appid-list 接口变更：packageName 改为必传查询参数，并支持新版响应形态 appids=[{key,value}]（旧形态 appIds/appIdList 保留兜底）——2026-10 真实链路实测发现
- bee7885: 蒲公英云端处理轮询上限从 5 分钟提升到 15 分钟（真实 95MB APK 实测处理超 5 分钟），超时错误信息引导到控制台确认

## 0.1.2

### Patch Changes

- 59a758f: 验证 trusted publisher 直发（npm publish）链路

## 0.1.1

### Patch Changes

- e2a3348: init
