import { mkdtemp, chmod, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareSemver, MIN_CAPABLE_VERSION, resolveCapableBin } from "./runner.js";

describe("compareSemver（三段受控格式）", () => {
  it("常规比较", () => {
    expect(compareSemver("0.14.0", "0.14.0")).toBe(0);
    expect(compareSemver("0.15.0", MIN_CAPABLE_VERSION)).toBe(1);
    expect(compareSemver("0.13.0", MIN_CAPABLE_VERSION)).toBe(-1);
    expect(compareSemver("1.0.0", "0.14.0")).toBe(1);
    expect(compareSemver("0.14.1", "0.14.0")).toBe(1);
  });
  it("非版本串按最小处理（门禁安全侧：不放行）", () => {
    expect(compareSemver("garbage", "0.14.0")).toBe(-1);
    expect(compareSemver("", "0.0.1")).toBe(-1);
  });
});

describe("resolveCapableBin（能力门禁降级链）", () => {
  it("env 候选短路：显式意图不做版本门禁", async () => {
    const res = await resolveCapableBin(undefined, { cliBinEnv: "/nonexistent/bin.mjs" });
    expect(res.source).toBe("env");
    expect(res.capable).toBe(true);
    expect(res.bin).toEqual([process.execPath, "/nonexistent/bin.mjs"]);
  });

  it("真实环境：全局 PATH 命中 applift 时返回 capable 结果（本机开发环境回归锚）", async () => {
    const res = await resolveCapableBin("/tmp");
    // 本机 applift（sh shim → 仓库 dist 0.14.0）必须过门禁；无候选环境跳过断言
    if (res.source !== "fallback") {
      expect(res.capable).toBe(true);
      expect(res.version !== null && compareSemver(res.version, MIN_CAPABLE_VERSION) >= 0).toBe(
        true,
      );
    }
  });
});

describe("resolveCapableBin 端到端（真 spawn 桩 shim）", () => {
  it("工程内 0.12.1 无能力 → 自动降级 PATH 全局 0.14.0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cap-e2e-"));
    try {
      const projBin = join(dir, "proj", "node_modules", ".bin");
      const globBin = join(dir, "glob");
      await mkdir(projBin, { recursive: true });
      await mkdir(globBin, { recursive: true });
      await writeFile(join(projBin, "applift"), "#!/bin/sh\necho 0.12.1\n");
      await writeFile(join(globBin, "applift"), "#!/bin/sh\necho 0.14.0\n");
      await chmod(join(projBin, "applift"), 0o755);
      await chmod(join(globBin, "applift"), 0o755);
      const res = await resolveCapableBin(join(dir, "proj"), { pathEnv: globBin });
      expect(res.source).toBe("global"); // 降级命中全局
      expect(res.capable).toBe(true);
      expect(res.version).toBe("0.14.0");
      expect(res.skipped).toEqual([{ source: "project", version: "0.12.1" }]); // 工程内被跳过留痕
      expect(res.bin).toEqual([join(globBin, "applift")]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
