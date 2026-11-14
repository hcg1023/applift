import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ProjectRegistry } from "./registry.js";

const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function tempStore(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ui-server-registry-"));
  tmpDirs.push(dir);
  return join(dir, "projects.json");
}

describe("ProjectRegistry", () => {
  it("add 生成 id/name/addedAt 并持久化", async () => {
    const store = await tempStore();
    const reg = new ProjectRegistry(store);
    const entry = await reg.add("/tmp/some-project");
    expect(entry.id).toBeTruthy();
    expect(entry.name).toBe(basename("/tmp/some-project"));
    expect(entry.addedAt).toBeGreaterThan(0);
    expect(reg.list()).toEqual([entry]);
    expect(reg.get(entry.id)).toBe(entry);
  });

  it("add 幂等：同 path 返回已有条目（id 不变，不新增）", async () => {
    const reg = new ProjectRegistry(await tempStore());
    const a = await reg.add("/tmp/dup-project");
    const b = await reg.add("/tmp/dup-project");
    expect(b.id).toBe(a.id);
    expect(reg.list()).toHaveLength(1);
  });

  it("remove 按 id 删除；未知 id 返回 false", async () => {
    const reg = new ProjectRegistry(await tempStore());
    const entry = await reg.add("/tmp/rm-project");
    expect(reg.remove(entry.id)).toBe(true);
    expect(reg.list()).toHaveLength(0);
    expect(reg.remove(entry.id)).toBe(false);
    expect(reg.remove("no-such-id")).toBe(false);
  });

  it("重启恢复：新实例同 storePath 读回条目", async () => {
    const store = await tempStore();
    const first = new ProjectRegistry(store);
    const entry = await first.add("/tmp/persist-project");
    const second = new ProjectRegistry(store);
    expect(second.list()).toEqual([entry]);
    // 幂等跨实例成立
    const again = await second.add("/tmp/persist-project");
    expect(again.id).toBe(entry.id);
  });

  it("空 store 文件（首次）list 为空", () => {
    const reg = new ProjectRegistry("/nonexistent-dir-should-not-crash/projects.json");
    expect(reg.list()).toEqual([]);
  });
});
