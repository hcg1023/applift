/**
 * CHANGELOG 生成：conventional commits 归类渲染（conventional-changelog 风格），
 * 倒序插入项目根 CHANGELOG.md（同版本 section 幂等替换）。
 * 渲染自研（conventional-changelog-core 依赖链对 CLI 太重），解析复用 parser。
 */
import fs from "node:fs";
import { CommitParser, type Commit } from "conventional-commits-parser";

export interface ChangelogEntry {
  type: string;
  scope?: string;
  subject: string;
  breaking: boolean;
  hash?: string;
}

/** raw commit messages → 结构化条目（feat/fix/BREAKING 之外的 type 也保留，渲染时归类） */
export function toChangelogEntries(messages: string[]): ChangelogEntry[] {
  const parser = new CommitParser();
  const out: ChangelogEntry[] = [];
  for (const raw of messages) {
    let c: Commit | null = null;
    try {
      c = parser.parse(raw);
    } catch {
      continue;
    }
    if (!c || !c.header) continue; // 完全无法解析的提交不进 changelog
    // v7 对 `type!:` 语法的 type 字段缺省——从 header 抽取（BREAKING notes 仍以 parser 为准）
    const headerType = /^(\w+)(\([^)]*\))?!?:\s/.exec(c.header)?.[1]?.toLowerCase();
    const type = (c.type ?? headerType)?.toLowerCase();
    if (!type) continue; // 非 conventional 形态不进 changelog
    const breaking = (c.notes ?? []).some((n) => /breaking/i.test(n.title ?? ""));
    out.push({
      type,
      scope: c.scope || undefined,
      subject: (c.subject || c.header || "").trim(),
      breaking,
      hash: c.hash || undefined,
    });
  }
  return out;
}

function line(e: ChangelogEntry): string {
  const scope = e.scope ? `(${e.scope})` : "";
  const hash = e.hash ? ` (${e.hash.slice(0, 7)})` : "";
  return `- ${e.type}${scope}: ${e.subject}${hash}`;
}

/** 渲染单个版本段落（## [4.1.0] - 2026-10-17） */
export function renderChangelogSection(
  version: string,
  date: string,
  entries: ChangelogEntry[],
): string {
  const groups: Array<[string, ChangelogEntry[]]> = [
    ["⚠ BREAKING CHANGES", entries.filter((e) => e.breaking)],
    ["Features", entries.filter((e) => !e.breaking && e.type === "feat")],
    ["Bug Fixes", entries.filter((e) => !e.breaking && e.type === "fix")],
    ["Others", entries.filter((e) => !e.breaking && e.type !== "feat" && e.type !== "fix")],
  ];
  const body = groups
    .filter(([, list]) => list.length > 0)
    .map(([title, list]) => `### ${title}\n\n${list.map(line).join("\n")}`)
    .join("\n\n");
  const heading = `## [${version}] - ${date}`;
  return body ? `${heading}\n\n${body}` : heading;
}

const HEADER_RE = /^#\s*changelog\b/i;

/**
 * 插入/替换 CHANGELOG.md 的版本段落（幂等）：
 * - 已有 `## [version]` → 整段替换为最新渲染
 * - 否则插到首个 # Changelog 标题之后；无标题/无文件 → 新建带标题
 * 返回写入路径；entries 为空也写入 heading（bump 闭环保持 tag ↔ changelog 对齐）。
 */
export function upsertChangelog(cwd: string, version: string, section: string): string {
  const filePath = `${cwd}/CHANGELOG.md`;
  let content = "";
  if (fs.existsSync(filePath)) content = fs.readFileSync(filePath, "utf8");

  // 段落定位（切片替换，不用正则替换——懒惰量词对含特殊字符的旧内容会提前截断泄漏）：
  // 段落 = 一行 `## [version] ...` 起，到下一行 `## ` 或文件尾止
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i]!.startsWith("## ")) {
        end = i;
        break;
      }
    }
    // 保留段落后的空行分隔（段落尾的空行属段落，end 指向下一个 ## 行）
    const replaced = [...lines.slice(0, start), ...section.split("\n"), "", ...lines.slice(end)];
    content = replaced.join("\n");
  } else if (HEADER_RE.test(content)) {
    // 插到标题行（含其后续紧邻空行）之后
    content = content.replace(/(^#\s*changelog\b[^\n]*\n+)/im, `$1\n${section}\n`);
  } else {
    content = `# Changelog\n\n${section}\n${content ? `\n${content}` : ""}`;
  }
  fs.writeFileSync(filePath, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  return filePath;
}
