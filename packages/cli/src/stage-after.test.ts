/**
 * beta 路径的 stage:after 广播（rn-update 的基线自动上传挂在这个钩子上）。
 * 回归背景：beta 不走 pipeline，曾经 5 条 stage 分支全部直调 channel.stage，
 * 导致测试包永远没有 pushy 基线，首次热更 bind 必然失败。
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PluginHost } from "@applift/core";
import { notifyStageAfter } from "./index.js";

describe("notifyStageAfter", () => {
  it("成功时广播 stage:after，载荷带 channel/platform/artifactPath", async () => {
    const seen: unknown[] = [];
    const host = new PluginHost([{ name: "spy", "stage:after": (r) => void seen.push(r) }]);
    await notifyStageAfter(
      host,
      "agc",
      "harmony",
      { artifactPath: "/tmp/a.app", credentials: { K: "v" } },
      { ok: true, ref: "42" },
      "/tmp/proj",
    );
    expect(seen).toEqual([
      {
        channel: "agc",
        ok: true,
        ref: "42",
        error: undefined,
        artifactPath: "/tmp/a.app",
        platform: "harmony",
        target: "beta",
      },
    ]);
  });

  it("失败也广播（ok=false），让插件自行决定是否上传", async () => {
    const seen: Array<{ ok: boolean }> = [];
    const host = new PluginHost([
      { name: "spy", "stage:after": (r) => void seen.push({ ok: r.ok }) },
    ]);
    await notifyStageAfter(
      host,
      "pgyer",
      "android",
      { artifactPath: "/tmp/a.apk" },
      { ok: false, error: "上传失败" },
      "/tmp/proj",
    );
    expect(seen).toEqual([{ ok: false }]);
  });

  it("host 缺省（无插件）时安全无副作用", async () => {
    await expect(
      notifyStageAfter(
        undefined,
        "pgyer",
        "ios",
        { artifactPath: "/tmp/a.ipa" },
        { ok: true },
        "/tmp",
      ),
    ).resolves.toBeUndefined();
  });
});

describe("命令级 e2e：beta <platform> 快捷路径触发 stage:after（基线上传吃 target=beta）", () => {
  // 照 release-submit.test 模式：config 插件注册桩 + globalThis 捕获（registry 是模块单例）
  const slot = globalThis as unknown as { __saSeen?: Array<Record<string, unknown>> };

  it("beta harmony --via pgyer：桩 pgyer stage 成功 → notifyStageAfter 广播，载荷带 target=beta", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "applift-sa-home-"));
    const prevHome = process.env.APPLIFT_HOME;
    process.env.APPLIFT_HOME = home;
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(
      path.join(home, "credentials.json"),
      `{"profiles":{"default":{"PGYER_API_KEY":"stub-key"}}}`,
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-sa-proj-"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "sa-demo", dependencies: { "react-native": "0.84.0" } }),
    );
    fs.writeFileSync(
      path.join(dir, "applift.config.ts"),
      [
        "// 桩配置（jiti 加载，不类型检查）：monkey-patch 真实 pgyer 单例的 stage + 捕获 stage:after 载荷",
        "import { rnFramework } from '@applift/core';",
        "export default {",
        "  plugins: [rnFramework(), {",
        "    name: 'sa-e2e-stub',",
        "    'channel:register': (registry) => {",
        "      // 用钩子广播传入的 registry（与 CLI 同一实例；直接 import 会拿到另一份模块图）",
        "      const pgyer = registry.get('pgyer');",
        "      if (!pgyer || pgyer.__saStubbed) return;",
        "      pgyer.__saStubbed = true;",
        "      pgyer.stage = async () => ({ ok: true, ref: 'pgyer-stub-ref' });",
        "    },",
        "    'stage:after': (r) => {",
        "      globalThis.__saSeen = [...(globalThis.__saSeen ?? []), r];",
        "    },",
        "  }],",
        "};",
      ].join("\n"),
    );
    const hap = path.join(dir, "demo-internaltesting.hap");
    fs.writeFileSync(hap, "hap-bytes");
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((b) => {
      writes.push(String(b));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    slot.__saSeen = [];
    try {
      // 动态 import：APPLIFT_HOME 必须在加载 CLI 模块前就位（release-submit.test 同款边界用例）
      const { program } = await import("./index.js");
      await program.parseAsync(
        [
          "beta",
          "harmony",
          "--via",
          "pgyer",
          "--delivery",
          "native",
          "--artifact",
          hap,
          "--cwd",
          dir,
          "--yes",
        ],
        { from: "user" },
      );
      // 贯穿断言：命令路径真的广播了 stage:after，且载荷足以把基线上传到 beta 应用记录
      expect(slot.__saSeen).toHaveLength(1);
      expect(slot.__saSeen![0]).toMatchObject({
        channel: "pgyer",
        ok: true,
        ref: "pgyer-stub-ref",
        artifactPath: hap,
        platform: "harmony",
        target: "beta",
      });
      expect(writes.join("")).toContain("蒲公英发布成功");
    } finally {
      vi.restoreAllMocks();
      if (prevHome === undefined) delete process.env.APPLIFT_HOME;
      else process.env.APPLIFT_HOME = prevHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
