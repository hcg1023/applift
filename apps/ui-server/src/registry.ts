import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface ProjectEntry {
  id: string;
  name: string;
  path: string;
  addedAt: number;
}

/** ui-server 数据根目录：优先 APPLIFT_HOME（与 CLI HISTORY_PATH/credentials 同源），未设回落原默认 */
export function uiDataHome(): string {
  const env = process.env.APPLIFT_HOME;
  return env && env.trim() !== ""
    ? resolve(env)
    : join(homedir(), "Library", "Application Support", "applift-ui");
}

/** 默认持久化路径（计划 Global Constraints；测试注入临时路径覆盖） */
export function defaultStorePath(): string {
  return join(uiDataHome(), "projects.json");
}

/** 服务端轮询档位持久化（settings.json，与注册表同目录；启动读取、PUT /api/settings 写入） */
export function defaultSettingsPath(): string {
  return join(uiDataHome(), "settings.json");
}

/** 原子写：同目录 .tmp 落盘后 rename（同文件系统内原子，读者不会看到半截文件）；
 * tmp 名带 randomUUID 后缀：并发写同目标时互不覆盖（固定名会 ENOENT——A 写的 tmp 被 B rename 走） */
export async function atomicWriteFile(path: string, data: string): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, data, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
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
    await atomicWriteFile(this.storePath, JSON.stringify(this.entries, null, 2));
  }

  /** 同步原子写（remove 布尔签名要求返回时已落盘）；tmp 随机后缀同 atomicWriteFile（防并发互踩） */
  private persistSync(): void {
    mkdirSync(dirname(this.storePath), { recursive: true });
    const tmp = `${this.storePath}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.entries, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmp, this.storePath);
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
    this.persistSync();
    return true;
  }
}
