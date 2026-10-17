/**
 * CHANGELOG 契约测试：解析归类、段落渲染、幂等插入（新建/头部插入/同版本替换）。
 */
import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderChangelogSection, toChangelogEntries, upsertChangelog } from "./changelog.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-changelog-"));
});

describe("toChangelogEntries", () => {
  it("conventional 形态解析；非 conventional 跳过", () => {
    const entries = toChangelogEntries([
      "feat(login): 新登录页",
      "fix: 修复闪退",
      "chore!: 重构\n\nBREAKING CHANGE: 接口变更",
      "随便一句话",
    ]);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ type: "feat", scope: "login", breaking: false });
    expect(entries[2]).toMatchObject({ type: "chore", breaking: true });
  });
});

describe("renderChangelogSection", () => {
  it("分组：BREAKING / Features / Bug Fixes / Others", () => {
    const s = renderChangelogSection(
      "4.1.0",
      "2026-10-17",
      toChangelogEntries(["feat: a", "fix: b", "chore!: c\n\nBREAKING CHANGE: x", "docs: d"]),
    );
    expect(s).toContain("## [4.1.0] - 2026-10-17");
    expect(s.indexOf("⚠ BREAKING CHANGES")).toBeLessThan(s.indexOf("### Features"));
    expect(s).toContain("- feat: a");
    expect(s).toContain("- fix: b");
    expect(s).toContain("### Others");
    expect(s).toContain("- docs: d");
  });
});

describe("upsertChangelog", () => {
  it("无文件：新建带 # Changelog 头", () => {
    const p = upsertChangelog(dir, "4.1.0", "## [4.1.0] - 2026-10-17\n\n- feat: a");
    expect(fs.readFileSync(p, "utf8")).toBe(
      "# Changelog\n\n## [4.1.0] - 2026-10-17\n\n- feat: a\n",
    );
  });

  it("已有头：新版本插到头部之后（倒序）；同版本重跑替换不重复（幂等）", () => {
    upsertChangelog(dir, "4.1.0", "## [4.1.0] - 2026-10-17\n\n- feat: a");
    upsertChangelog(dir, "4.2.0", "## [4.2.0] - 2026-10-18\n\n- fix: b");
    let text = fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");
    expect(text.indexOf("4.2.0")).toBeLessThan(text.indexOf("4.1.0"));

    upsertChangelog(dir, "4.2.0", "## [4.2.0] - 2026-10-18\n\n- fix: b2");
    text = fs.readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");
    expect(text.match(/## \[4\.2\.0\]/g)).toHaveLength(1);
    expect(text).toContain("- fix: b2");
    expect(text).not.toContain("- fix: b\n");
  });
});
