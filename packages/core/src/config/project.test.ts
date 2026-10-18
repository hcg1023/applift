import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadProjectConfig } from "./project.js";

function tmpProject(setup?: (dir: string) => void): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-proj-"));
  setup?.(dir);
  return dir;
}

describe("loadProjectConfig", () => {
  it("加载 applift.config.ts（c12 执行 TS）并返回配置所在目录", async () => {
    const dir = tmpProject((d) => {
      fs.writeFileSync(
        path.join(d, "applift.config.ts"),
        [
          "export default {",
          "  name: 'demo-app',",
          "  profile: 'prod',",
          "  android: {",
          "    pkgName: 'com.example.app',",
          "    stores: {",
          '      huawei: { appId: "1000123" },',
          "    },",
          "  },",
          "};",
        ].join("\n"),
      );
    });
    const { config, cwd } = await loadProjectConfig(dir);
    expect(config.name).toBe("demo-app");
    expect(config.profile).toBe("prod");
    expect(config.android?.pkgName).toBe("com.example.app");
    expect(config.android?.stores.huawei?.appId).toBe("1000123");
    expect(cwd).toBe(dir);
  });

  it("配置未写 profile/stores → 合并 schema 默认（profile=default，stores 空对象）", async () => {
    const dir = tmpProject((d) => {
      fs.writeFileSync(
        path.join(d, "applift.config.ts"),
        "export default { name: 'bare', android: { pkgName: 'com.example.bare' } };",
      );
    });
    const { config } = await loadProjectConfig(dir);
    expect(config.profile).toBe("default");
    expect(config.android?.stores).toEqual({});
  });

  it("裸工程导入 @applift/cli 的 defineConfig 可用（jiti 别名指到自带 core）", async () => {
    const dir = tmpProject((d) => {
      fs.writeFileSync(
        path.join(d, "applift.config.ts"),
        [
          'import { defineConfig } from "@applift/cli";',
          "export default defineConfig({",
          "  beta: { pgyer: { platforms: ['android'] } },",
          "});",
        ].join("\n"),
      );
    });
    const { config, cwd } = await loadProjectConfig(dir);
    expect(config.beta?.pgyer?.platforms).toEqual(["android"]);
    expect(cwd).toBe(dir);
  });

  it("裸工程导入 @applift/core 的 defineConfig 同样可用", async () => {
    const dir = tmpProject((d) => {
      fs.writeFileSync(
        path.join(d, "applift.config.ts"),
        [
          'import { defineConfig } from "@applift/core";',
          "export default defineConfig({ name: 'alias-core' });",
        ].join("\n"),
      );
    });
    const { config } = await loadProjectConfig(dir);
    expect(config.name).toBe("alias-core");
  });

  it("无配置文件 → 回退内置默认值，cwd 回退入参", async () => {
    const dir = tmpProject();
    const { config, cwd } = await loadProjectConfig(dir);
    expect(config).toEqual({ profile: "default" });
    expect(cwd).toBe(dir);
  });

  it("raw 保留 plugins 等 schema 外键（插件发现用），config 以 zod 解析结果为准", async () => {
    const dir = tmpProject((d) => {
      fs.writeFileSync(
        path.join(d, "applift.config.ts"),
        "export default { name: 'with-plugins', plugins: [{ name: 'p1' }] };",
      );
    });
    const { config, raw } = await loadProjectConfig(dir);
    expect("plugins" in config).toBe(false);
    expect(raw.plugins).toEqual([{ name: "p1" }]);
    expect(raw.name).toBe("with-plugins");
  });

  it("c12 违约返回 config/cwd 为空 → 回退空对象与入参 cwd（防御分支）", async () => {
    vi.resetModules();
    // 动态 import 是必须的：vi.doMock 只影响其后新加载的模块实例，静态导入无法拿到 mock 后的 c12
    vi.doMock("c12", () => ({
      loadConfig: vi.fn(async () => ({ config: undefined, cwd: undefined })),
    }));
    try {
      const { loadProjectConfig: load } = await import("./project.js");
      const { config, cwd } = await load("/fallback-cwd");
      expect(config).toEqual({ profile: "default" });
      expect(cwd).toBe("/fallback-cwd");
    } finally {
      vi.doUnmock("c12");
      vi.resetModules();
    }
  });

  it("README 最小示例（android 仅 stores，无 pkgName）合法——包名自动推导承诺", async () => {
    const dir = tmpProject((d) => {
      fs.writeFileSync(
        path.join(d, "applift.config.ts"),
        "export default { android: { stores: ['huawei'] } };",
      );
    });
    const { config } = await loadProjectConfig(dir);
    expect(config.android?.pkgName).toBeUndefined();
    expect(Object.keys(config.android?.stores ?? {})).toEqual(["huawei"]);
  });

  it("字段类型错误 → 人话化校验失败信息（含字段路径，非原始 zod JSON）", async () => {
    const dir = tmpProject((d) => {
      fs.writeFileSync(
        path.join(d, "applift.config.ts"),
        "export default { android: { pkgName: 123, stores: [] } };",
      );
    });
    await expect(loadProjectConfig(dir)).rejects.toThrow(/字段校验失败.*android\.pkgName/);
  });
});
