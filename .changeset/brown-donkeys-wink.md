---
"@applift/core": patch
---

AGC 测试发布重构为 Testing API 新链路（华为已下线 releaseType=6 直绑 app-package-info，枚举仅剩 1/7）：上传 .hap → 新建测试版本（testType=3 邀请测试）→ 添加测试软件包 → 等云端编译 → 更新测试版本绑定；不再自动写应用文案（测试信息继承全网版本）。2026-10 真实链路实测发现。
