---
"@applift/cli": patch
---

修复 release 原生路径产物探测不按上架扩展名过滤：双产物工程（internaltesting .hap + release .app）按 mtime 最新可能选中测试签名包用于正式上架（渠道层有终验会报错拦下，但探测就该选对）。上架扩展名约束与 beta 分流同源：harmony=.app（AGC 不收单 .hap）、android=.apk/.aab、ios=.ipa；探测到产物但无可接受扩展名时给出「测试签名包不能上架」的明确引导。qy-driver dry-run 实测：修复前误选 internaltesting.hap，修复后正确选 release .app。
