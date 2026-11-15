import { describe, expect, it } from "vitest";
import {
  detectGlobalPackageManager,
  installCommand,
  pmFromGlobalPath,
  pmFromUserAgent,
  type PmResolution,
} from "./pm.js";

describe("pmFromGlobalPath（全局目录特征）", () => {
  it("pnpm/bun/yarn/npm 各自特征路径命中", () => {
    expect(pmFromGlobalPath("/Users/x/.pnpm-global/5/.bin/applift")).toBe("pnpm");
    expect(pmFromGlobalPath("/home/x/.local/share/pnpm/global/5/.bin/applift")).toBe("pnpm");
    expect(pmFromGlobalPath("/Users/x/.bun/bin/applift")).toBe("bun");
    expect(pmFromGlobalPath("/usr/local/lib/node_modules/applift")).toBe("npm");
    expect(pmFromGlobalPath("/Users/x/.nvm/versions/node/v22/bin/applift")).toBe("npm");
  });
  it("无特征返回 null（不猜）", () => {
    expect(pmFromGlobalPath("/opt/whatever/applift")).toBeNull();
  });
});

describe("pmFromUserAgent", () => {
  it(`解析首段名称（pnpm/10.1.0 node/v22 …）`, () => {
    expect(pmFromUserAgent("pnpm/10.1.0 node/v22.1.0 darwin arm64")).toBe("pnpm");
    expect(pmFromUserAgent("npm/10.9.0 node/v22.1.0 darwin arm64")).toBe("npm");
    expect(pmFromUserAgent("yarn/4.5.0 npm/? node/v22")).toBe("yarn");
    expect(pmFromUserAgent("bun/1.1.0 npm/? node/v22")).toBe("bun");
  });
  it("缺失/未知返回 null", () => {
    expect(pmFromUserAgent(undefined)).toBeNull();
    expect(pmFromUserAgent("")).toBeNull();
    expect(pmFromUserAgent("weird-agent/1.0")).toBeNull();
  });
});

describe("installCommand（命令映射）", () => {
  const res = (
    name: PmResolution["name"],
    fallbackTo?: PmResolution["fallbackTo"],
  ): PmResolution => ({
    name,
    source: "env",
    fallbackTo,
  });
  it("npm/pnpm/bun/yarn1 各自命令形态", () => {
    expect(installCommand(res("npm"))).toEqual({
      bin: "npm",
      args: ["install", "-g", "@applift/cli"],
    });
    expect(installCommand(res("pnpm"))).toEqual({
      bin: "pnpm",
      args: ["add", "-g", "@applift/cli"],
    });
    expect(installCommand(res("bun"))).toEqual({ bin: "bun", args: ["add", "-g", "@applift/cli"] });
    expect(installCommand(res("yarn"))).toEqual({
      bin: "yarn",
      args: ["global", "add", "@applift/cli"],
    });
  });
  it("update 装最新版（@latest）；yarn berry 降级 npm 命令", () => {
    expect(installCommand(res("pnpm"), { update: true }).args).toEqual([
      "add",
      "-g",
      "@applift/cli@latest",
    ]);
    expect(installCommand(res("yarn", "npm"), { update: true })).toEqual({
      bin: "npm",
      args: ["install", "-g", "@applift/cli@latest"],
    });
  });
});

describe("detectGlobalPackageManager（优先级链）", () => {
  it("env 覆盖最优先", async () => {
    const r = await detectGlobalPackageManager({
      env: { APPLIFT_PM: "pnpm" },
      globalAppliftPath: "/usr/local/lib/node_modules/applift",
    });
    expect(r).toEqual({ name: "pnpm", source: "env" });
  });
  it("全局归属 > user_agent", async () => {
    const r = await detectGlobalPackageManager({
      env: { npm_config_user_agent: "npm/10.9.0 node/v22" },
      globalAppliftPath: "/Users/x/.pnpm-global/5/.bin/applift",
    });
    expect(r).toEqual({ name: "pnpm", source: "global-path" });
  });
  it("user_agent > 锁文件；yarn（agent）降级 npm", async () => {
    const r = await detectGlobalPackageManager({
      env: { npm_config_user_agent: "yarn/4.5.0 node/v22" },
    });
    expect(r.name).toBe("yarn");
    expect(r.fallbackTo).toBe("npm");
  });
  it("锁文件探测兜底前最后一档（pnpm-lock.yaml → pnpm）", async () => {
    const r = await detectGlobalPackageManager({ env: {}, cwd: process.cwd() });
    // applift 仓库根是 pnpm workspace：锁文件档应命中 pnpm（无全局/user_agent 输入时）
    expect(r).toEqual({ name: "pnpm", source: "lockfile" });
  });
  it("全无信号 → npm fallback", async () => {
    const r = await detectGlobalPackageManager({ env: {}, cwd: "/tmp" });
    expect(r).toEqual({ name: "npm", source: "fallback" });
  });
});
