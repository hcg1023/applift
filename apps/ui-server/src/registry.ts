import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface ProjectEntry {
  id: string;
  name: string;
  path: string;
  addedAt: number;
}

/** 默认持久化路径（计划 Global Constraints；测试注入临时路径覆盖） */
export function defaultStorePath(): string {
  return join(homedir(), "Library", "Application Support", "applift-ui", "projects.json");
}

export class ProjectRegistry {
  private readonly storePath: string;
  private entries: ProjectEntry[] = [];

  constructor(storePath: string) {
    this.storePath = resolve(storePath);
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.storePath, "utf8"));
      if (Array.isArray(parsed)) this.entries = parsed as ProjectEntry[];
    } catch {
      this.entries = []; // 文件不存在或损坏 → 空表重建
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true });
    await writeFile(this.storePath, JSON.stringify(this.entries, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  list(): ProjectEntry[] {
    return [...this.entries];
  }

  get(id: string): ProjectEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /** name 取 basename；重复路径幂等返回已有条目 */
  async add(path: string): Promise<ProjectEntry> {
    const abs = resolve(path);
    const existing = this.entries.find((e) => e.path === abs);
    if (existing) return existing;
    const entry: ProjectEntry = {
      id: randomUUID(),
      name: basename(abs),
      path: abs,
      addedAt: Date.now(),
    };
    this.entries.push(entry);
    await this.persist();
    return entry;
  }

  remove(id: string): boolean {
    const next = this.entries.filter((e) => e.id !== id);
    if (next.length === this.entries.length) return false;
    this.entries = next;
    void this.persist();
    return true;
  }
}
