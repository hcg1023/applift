---
"@applift/core": minor
"@applift/cli": minor
---

version 管理:applift version show/bump + beta/release 自动 version 编排

- `applift version` 各端版本实况(versionName/versionCode + 文件路径 + 发版锚点 tag)
- `applift version bump [major|minor|patch|prerelease|<semver>] [--pre beta]`:写各端工程文件(行级幂等改写保注释)→ 生成 CHANGELOG.md → 代 commit(chore(release))→ 代打 tag;push 永不代做
- 版本决定链:显式指定 > git conventional commits 推断(BREAKING/feat/fix)> patch 兜底;semver 全程托管,prerelease 只进 tag、商店 versionName 恒三段数字
- versionCode = max(公式值, 现值+1):默认递增;config `version.versionCode.formula` 支持 `major*1000000+minor*1000+patch` 白名单公式,吞任意历史值(3052/4000000 等)首次 bump 即归一
- beta/release 自动 version:config `beta: { bump: true }` / `release: { bump: true }` 或 CLI `--bump [level]` / `--no-bump`;bump 后强制重新构建,不复用旧产物
- 护栏:同渠道同 versionName 重复提交警告(beta 多渠道现在也落 history.jsonl);产物版本读取沿用 pack.info/aapt
- 支持标准模板形态:AGP gradle 字面量、Xcode pbxproj、DevEco app.json5、pubspec.yaml、package.json、tauri.conf、Expo app.json;version catalog 引用形态识别并提示改造,不代写
