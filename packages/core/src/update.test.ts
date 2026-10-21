import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { FrameworkAdapter } from "./framework.js";
import { collectReleaseDiff, routeDelivery, type UpdateProvider } from "./update.js";

const rnFrameworkAdapter: FrameworkAdapter = {
  id: "rn",
  label: "React Native",
  detect: () => true,
  artifactPatterns: () => [],
};

const flutterLikeAdapter: FrameworkAdapter = {
  id: "flutter",
  label: "Flutter",
  detect: () => true,
  artifactPatterns: () => [],
};

function mkProvider(
  id: string,
  frameworks: string[],
  judge: UpdateProvider["judge"] = () => ({
    recommendation: "ota",
    confidence: "high",
    evidence: [],
  }),
): UpdateProvider {
  return {
    id,
    frameworks,
    judge,
    publishToProd: async () => ({ versionName: "", versionId: 0 }),
    publishToBeta: async () => ({ versionName: "", versionId: 0 }),
    promoteToProd: async () => ({ versionName: "" }),
  };
}

describe("routeDelivery（投递路由：core 编排，provider 判定）", () => {
  it("无 provider 注册 → 返回 null（原生路径，原始行为不受影响）", async () => {
    expect(
      await routeDelivery([], { cwd: "/tmp", framework: rnFrameworkAdapter }, ["src/a.ts"]),
    ).toBeNull();
  });

  it("provider.frameworks 不含当前 framework → 该 provider 被忽略，返回 null", async () => {
    const provider = mkProvider("rn-update", ["rn"]);
    expect(
      await routeDelivery([provider], { cwd: "/tmp", framework: flutterLikeAdapter }, [
        "lib/a.dart",
      ]),
    ).toBeNull();
  });

  it("匹配的 provider → 调用 judge（注入 diff 与 frameworkCtx）并返回判定", async () => {
    const calls: unknown[] = [];
    const provider = mkProvider("rn-update", ["rn"], (diff, ctx) => {
      calls.push({ diff, ctx });
      return {
        recommendation: "native",
        confidence: "high",
        evidence: [{ path: "harmony/x", rule: "native", note: "" }],
      };
    });
    const r = await routeDelivery([provider], { cwd: "/w", framework: rnFrameworkAdapter }, [
      "src/a.ts",
      "harmony/x",
    ]);
    expect(r?.provider.id).toBe("rn-update");
    expect(r?.judgement.recommendation).toBe("native");
    expect(calls[0]).toEqual({
      diff: ["src/a.ts", "harmony/x"],
      ctx: { cwd: "/w", framework: rnFrameworkAdapter },
    });
  });

  it("多个 provider 匹配同一 framework → 配置错误，报错", async () => {
    const a = mkProvider("rn-update", ["rn"]);
    const b = mkProvider("another-rn", ["rn", "expo"]);
    await expect(
      routeDelivery([a, b], { cwd: "/tmp", framework: rnFrameworkAdapter }, ["src/a.ts"]),
    ).rejects.toThrow(/多个/);
  });
});

describe("routeDelivery 平台过滤（未接入热更的平台走原生）", () => {
  it("provider.platforms 不含目标平台 → 过滤该 provider 返回 null；未声明 platforms 不过滤", async () => {
    const scoped = { ...mkProvider("rn-update", ["rn"]), platforms: ["harmony"] };
    expect(
      await routeDelivery(
        [scoped],
        { cwd: "/tmp", framework: rnFrameworkAdapter },
        ["src/a.ts"],
        "android",
      ),
    ).toBeNull();
    expect(
      await routeDelivery(
        [scoped],
        { cwd: "/tmp", framework: rnFrameworkAdapter },
        ["src/a.ts"],
        "harmony",
      ),
    ).not.toBeNull();
    const open = mkProvider("open", ["rn"]);
    expect(
      await routeDelivery(
        [open],
        { cwd: "/tmp", framework: rnFrameworkAdapter },
        ["src/a.ts"],
        "android",
      ),
    ).not.toBeNull();
  });
});

describe("collectReleaseDiff（上个发版锚点到工作区的文件列表，含未提交与未跟踪）", () => {
  it("无 tag / 非 git 目录 → null（无法判定，调用方按 uncertain 处理）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-diff-"));
    try {
      expect(await collectReleaseDiff(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("锚点 tag 之后的提交文件出现在 diff 中", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-diff-"));
    try {
      const g = (args: string[]) =>
        spawnSync("git", args, { cwd: dir, encoding: "utf8" }) as { status: number | null };
      g(["init", "-q"]);
      g(["config", "user.email", "t@t"]);
      g(["config", "user.name", "t"]);
      fs.writeFileSync(path.join(dir, "base.txt"), "x");
      g(["add", "-A"]);
      g(["commit", "-qm", "init"]);
      g(["tag", "v4.0.0"]);
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "new.ts"), "y");
      g(["add", "-A"]);
      g(["commit", "-qm", "feat: new"]);
      const diff = await collectReleaseDiff(dir);
      expect(diff).toContain("src/new.ts");
      expect(diff).not.toContain("base.txt");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("未提交修改与未跟踪文件也计入（pushy bundle 打包的是工作区，口径必须一致）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-diff-"));
    try {
      const g = (args: string[]) =>
        spawnSync("git", args, { cwd: dir, encoding: "utf8" }) as { status: number | null };
      g(["init", "-q"]);
      g(["config", "user.email", "t@t"]);
      g(["config", "user.name", "t"]);
      fs.writeFileSync(path.join(dir, "committed.ts"), "x");
      g(["add", "-A"]);
      g(["commit", "-qm", "init"]);
      g(["tag", "v1.0.0"]);
      fs.writeFileSync(path.join(dir, "committed.ts"), "changed"); // 锚点后未提交修改
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "dirty.ts"), "dirty"); // 未跟踪（含新目录）
      const diff = await collectReleaseDiff(dir);
      expect(diff).toContain("src/dirty.ts");
      expect(diff).toContain("committed.ts"); // 已提交文件被修改（锚点后工作区改动）
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
