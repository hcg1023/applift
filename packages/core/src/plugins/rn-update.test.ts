/**
 * rn-update 判定引擎：diff 能否走热更（JS bundle 安全运行在旧原生二进制上）。
 * 规则依据（五形态完备性）：任何新原生实体必现于 项目原生目录 / 依赖(原生包) /
 * 补丁目录 / 构建配置 / 业务 JS——前四者判原生，纯 JS 判热更，其余灰区。
 */
import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { judgeDelivery, makeRnUpdateProvider, rnUpdate, testPackageVersion } from "./rn-update.js";
import type { UpdateProvider } from "../update.js";
import { createPushyCli, type CliResult, type CliRunner, type PushyCli } from "./pushy-cli.js";
import type { FrameworkAdapter } from "../framework.js";

const rn: FrameworkAdapter = {
  id: "rn",
  label: "React Native",
  detect: () => true,
  artifactPatterns: () => [],
};

function ctx(cwd: string, anchor?: string) {
  return { cwd, framework: rn, ...(anchor ? { anchor } : {}) };
}

function tmpProject(setup: (dir: string) => void): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-rnupd-"));
  setup(dir);
  return dir;
}

describe("judgeDelivery（路径规则：五形态）", () => {
  it("纯 JS 改动（src/**）→ ota high", () => {
    const r = judgeDelivery(["src/pages/Home.tsx", "src/utils/format.ts"], ctx("/tmp"), {});
    expect(r.recommendation).toBe("ota");
    expect(r.confidence).toBe("high");
    expect(r.evidence.every((e) => e.path && e.rule)).toBe(true);
  });

  it("鸿蒙原生目录命中 → native", () => {
    const r = judgeDelivery(
      ["src/a.ts", "harmony/entry/src/main/ets/pages/Index.ets"],
      ctx("/tmp"),
      {},
    );
    expect(r.recommendation).toBe("native");
    expect(r.evidence.find((e) => e.path.includes("Index.ets"))?.rule).toContain("原生目录");
  });

  it("ios/android 原生目录命中 → native", () => {
    expect(judgeDelivery(["ios/QyDriver/AppDelegate.mm"], ctx("/tmp"), {}).recommendation).toBe(
      "native",
    );
    expect(judgeDelivery(["android/app/build.gradle"], ctx("/tmp"), {}).recommendation).toBe(
      "native",
    );
  });

  it("补丁目录命中 → native（patchDir 可配置）", () => {
    const r = judgeDelivery(["patches/react-native-update+10.53.1.patch"], ctx("/tmp"), {});
    expect(r.recommendation).toBe("native");
    const custom = judgeDelivery(["custom-patches/foo.patch"], ctx("/tmp"), {
      patchDir: "custom-patches",
    });
    expect(custom.recommendation).toBe("native");
    const notPatch = judgeDelivery(["patches/foo.patch"], ctx("/tmp"), {
      patchDir: "custom-patches",
    });
    expect(notPatch.recommendation).not.toBe("native");
  });

  it("构建配置命中 → native（metro/babel/rn.config/app.json）", () => {
    for (const f of ["metro.config.js", "babel.config.js", "react-native.config.js", "app.json"]) {
      expect(judgeDelivery([f], ctx("/tmp"), {}).recommendation, `${f} 应判 native`).toBe("native");
    }
  });

  it("未知路径 → uncertain（灰区，不猜）", () => {
    const r = judgeDelivery(["some-root-file.bin"], ctx("/tmp"), {});
    expect(r.recommendation).toBe("uncertain");
  });

  it("混合（JS + 原生）→ native（原生发版自带 JS 改动）", () => {
    const r = judgeDelivery(["src/a.ts", "harmony/x"], ctx("/tmp"), {});
    expect(r.recommendation).toBe("native");
  });

  it("空 diff（无锚点或无变更）→ uncertain（不猜）", () => {
    const r = judgeDelivery([], ctx("/tmp"), {});
    expect(r.recommendation).toBe("uncertain");
  });
});

describe("judgeDelivery（依赖变更：锚点对比 + node_modules 原生信号）", () => {
  /** 造 git 工程：anchor 版 package.json（oldDeps）打 tag v1，HEAD 换成 newDeps；node_modules 按 pkgs 布置信号 */
  function withDeps(
    oldDeps: Record<string, string>,
    newDeps: Record<string, string>,
    pkgs: Record<string, object>,
    files: Record<string, string> = {},
  ): string {
    return tmpProject((d) => {
      const g = (args: string[]) => spawnSync("git", args, { cwd: d, encoding: "utf8" });
      g(["init", "-q"]);
      g(["config", "user.email", "t@t"]);
      g(["config", "user.name", "t"]);
      fs.writeFileSync(
        path.join(d, "package.json"),
        JSON.stringify({ name: "p", dependencies: oldDeps }),
      );
      g(["add", "-A"]);
      g(["commit", "-qm", "init"]);
      g(["tag", "v1"]);
      fs.writeFileSync(
        path.join(d, "package.json"),
        JSON.stringify({ name: "p", dependencies: newDeps }),
      );
      g(["add", "-A"]);
      g(["commit", "-qm", "deps"]);
      for (const [name, pkg] of Object.entries(pkgs)) {
        fs.mkdirSync(path.join(d, "node_modules", name), { recursive: true });
        fs.writeFileSync(path.join(d, "node_modules", name, "package.json"), JSON.stringify(pkg));
      }
      for (const [f, c] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
        fs.writeFileSync(path.join(d, f), c);
      }
    });
  }

  it("新增纯 JS 依赖（无原生信号）→ ota，evidence 注明包名", () => {
    const dir = withDeps({}, { dayjs: "^1.0.0" }, { dayjs: { name: "dayjs", version: "1.0.0" } });
    const r = judgeDelivery(["package.json", "src/a.ts"], ctx(dir, "v1"), {});
    expect(r.recommendation).toBe("ota");
    expect(r.evidence.find((e) => e.path === "package.json")?.note).toContain("dayjs");
  });

  it("新增原生依赖（podspec 信号）→ native", () => {
    const dir = withDeps(
      {},
      { "react-native-foo": "^1.0.0" },
      { "react-native-foo": { name: "react-native-foo", version: "1.0.0" } },
      { "node_modules/react-native-foo/RNFoo.podspec": "Pod::Spec" },
    );
    const r = judgeDelivery(["package.json"], ctx(dir, "v1"), {});
    expect(r.recommendation).toBe("native");
    expect(r.evidence.find((e) => e.path === "package.json")?.note).toContain("react-native-foo");
  });

  it("新增 RN 库（package.json 含 react-native 字段）→ native", () => {
    const dir = withDeps(
      {},
      { "react-native-bar": "^1.0.0" },
      {
        "react-native-bar": {
          name: "react-native-bar",
          version: "1.0.0",
          "react-native": { codegenConfig: {} },
        },
      },
    );
    expect(judgeDelivery(["package.json"], ctx(dir, "v1"), {}).recommendation).toBe("native");
  });

  it("新增依赖带 android/build.gradle 信号 → native", () => {
    const dir = withDeps(
      {},
      { "rn-baz": "^1.0.0" },
      { "rn-baz": { name: "rn-baz", version: "1.0.0" } },
      { "node_modules/rn-baz/android/build.gradle": "// gradle" },
    );
    expect(judgeDelivery(["package.json"], ctx(dir, "v1"), {}).recommendation).toBe("native");
  });

  it("依赖未变（仅 scripts 等元数据变化）→ 无变更包，package.json 按构建配置保守判 native", () => {
    const dir = withDeps({}, {}, {});
    const r = judgeDelivery(["package.json"], ctx(dir, "v1"), {});
    expect(r.recommendation).toBe("native");
  });

  it("package.json 变更但无锚点 → uncertain（不猜哪些包是新的）", () => {
    const r = judgeDelivery(["package.json"], ctx("/tmp"), {});
    expect(r.recommendation).toBe("uncertain");
  });

  it("新增依赖但 node_modules 缺失（无法检测）→ uncertain，evidence 提示先安装", () => {
    const dir = withDeps({}, { "some-native-lib": "^1.0.0" }, {});
    const r = judgeDelivery(["package.json"], ctx(dir, "v1"), {});
    expect(r.recommendation).toBe("uncertain");
    expect(r.confidence).toBe("medium");
    expect(r.evidence.find((e) => e.path === "package.json")?.note).toContain("some-native-lib");
  });
  it("依赖删除（锚点有、当前无）也进 changedPackages → 判定走依赖分析", () => {
    const dir = withDeps(
      { lodash: "^4.0.0", dayjs: "^1.0.0" },
      { dayjs: "^1.0.0" },
      {
        dayjs: { name: "dayjs", version: "1.0.0" },
      },
    );
    const r = judgeDelivery(["package.json"], ctx(dir, "v1"), {});
    expect(r.evidence.find((e) => e.path === "package.json")?.note).toContain("lodash");
  });

  it("当前 package.json 坏 JSON → readDeps 容错为 {}，锚点依赖全部视为变更（含删除语义）", () => {
    const dir = withDeps({ lodash: "^4.0.0" }, {}, {});
    fs.writeFileSync(path.join(dir, "package.json"), "{broken json"); // 当前工作区坏 JSON
    const r = judgeDelivery(["package.json"], ctx(dir, "v1"), {});
    // cur={} → lodash 判"删除"进 changed → node_modules 无信号 → uncertain 且 evidence 含包名
    expect(r.recommendation).toBe("uncertain");
    expect(r.evidence.find((e) => e.path === "package.json")?.note).toContain("lodash");
  });
});

describe("publishToTest / promoteToProd（pushy CLI 组装：取号 + 测试版本偏移 + promote 重绑）", () => {
  function rnProject(): string {
    return tmpProject((d) => {
      fs.mkdirSync(path.join(d, "harmony", "AppScope"), { recursive: true });
      fs.writeFileSync(
        path.join(d, "harmony", "AppScope", "app.json5"),
        '{ "versionName": "4.0.0", "versionCode": 4000000 }',
      );
    });
  }

  function mkCli(reply: (args: string[]) => CliResult): { cli: PushyCli; calls: string[][] } {
    const calls: string[][] = [];
    const runner: CliRunner = async (args) => {
      calls.push(args);
      return reply(args);
    };
    return { cli: createPushyCli(runner), calls };
  }

  it("publishToTest：读 versionName → 服务端取号（已有 patch.4 → patch.5）→ bundle → publish 绑 major+1000 偏移测试版本", async () => {
    const dir = rnProject();
    const { cli, calls } = mkCli((args) => {
      if (args[0] === "versions")
        return { code: 0, stdout: "303339) qm5Xb8bG 4.0.0-patch.4 no package\n", stderr: "" };
      if (args[0] === "bundle")
        return { code: 0, stdout: "已生成 .pushy/output/harmony.123.ppk\n", stderr: "" };
      if (args[0] === "publish")
        return { code: 0, stdout: "已成功上传新热更包（id: 303353）\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const provider = makeRnUpdateProvider({ harmony: 34166 }, cli);
    const r = await provider.publishToTest({
      cwd: dir,
      framework: rn,
      platform: "harmony",
      note: "修复登录",
    });
    expect(r).toEqual({ versionName: "4.0.0-patch.5", versionId: 303353 });
    const publishArgs = calls.find((c) => c[0] === "publish")!.join(" ");
    expect(publishArgs).toContain("--name 4.0.0-patch.5");
    expect(publishArgs).toContain("--packageVersion 1004.0.0");
    expect(publishArgs).toContain("--description 修复登录");
  });

  it("promoteToProd：取测试通道最新热更 → rebind 正式版本 + 灰度比例", async () => {
    const dir = rnProject();
    const { cli, calls } = mkCli((args) => {
      if (args[0] === "versions")
        return {
          code: 0,
          stdout:
            "303339) qm5Xb8bG 4.0.0-patch.4 no package\n303353) Qn19JhbA 4.0.0-patch.5 no package\n",
          stderr: "",
        };
      return { code: 0, stdout: "操作完成，共已绑定 1 个原生版本\n", stderr: "" };
    });
    const provider = makeRnUpdateProvider({ harmony: 34166, defaultRollout: 10 }, cli);
    const r = await provider.promoteToProd({
      cwd: dir,
      framework: rn,
      platform: "harmony",
    });
    expect(r).toEqual({ versionName: "4.0.0-patch.5", rollout: 10 });
    const rebindArgs = calls.find((c) => c[0] === "update")!.join(" ");
    expect(rebindArgs).toContain("--versionId 303353");
    expect(rebindArgs).toContain("--packageVersion 4.0.0");
    expect(rebindArgs).toContain("--rollout 10");
  });

  it("promoteToProd：只认当前 versionName 的 patch（跨版本不串台），全局更大 N 不越权", async () => {
    const dir = rnProject();
    const { cli, calls } = mkCli((args) => {
      if (args[0] === "versions")
        return {
          code: 0,
          stdout:
            "303340) aaa 3.9.9-patch.9 no package\n303353) Qn19JhbA 4.0.0-patch.2 no package\n",
          stderr: "",
        };
      return { code: 0, stdout: "操作完成\n", stderr: "" };
    });
    const provider = makeRnUpdateProvider({ harmony: 34166 }, cli);
    const r = await provider.promoteToProd({ cwd: dir, framework: rn, platform: "harmony" });
    expect(r.versionName).toBe("4.0.0-patch.2");
    expect(calls.find((c) => c[0] === "update")!.join(" ")).toContain("--versionId 303353");
  });

  it("promoteToProd：当前 versionName 无 patch 但有其他版本的 → 报错列出现存", async () => {
    const dir = rnProject();
    const { cli } = mkCli((args) => {
      if (args[0] === "versions")
        return { code: 0, stdout: "1) aaa 3.9.9-patch.9 no package\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const provider = makeRnUpdateProvider({ harmony: 34166 }, cli);
    await expect(
      provider.promoteToProd({ cwd: dir, framework: rn, platform: "harmony" }),
    ).rejects.toThrow(/4\.0\.0-patch\.N[\s\S]*3\.9\.9-patch\.9/);
  });

  it("平台未配置 app 记录 → 明确报错引导配置", async () => {
    const { cli } = mkCli(() => ({ code: 0, stdout: "", stderr: "" }));
    const provider = makeRnUpdateProvider({}, cli);
    await expect(
      provider.publishToTest({ cwd: "/tmp", framework: rn, platform: "android" }),
    ).rejects.toThrow(/android[\s\S]*rnUpdate/);
  });

  it("promoteToProd 无已验证热更 → 报错引导先 beta", async () => {
    const dir = rnProject();
    const { cli } = mkCli((args) => {
      if (args[0] === "versions") return { code: 0, stdout: "偏移量 0\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const provider = makeRnUpdateProvider({ harmony: 34166 }, cli);
    await expect(
      provider.promoteToProd({ cwd: dir, framework: rn, platform: "harmony" }),
    ).rejects.toThrow(/beta/);
  });
});

describe("stage:after 自动基线（原生路径发版成功后 pushy uploadApp）", () => {
  it("agc 渠道 stage 成功 → 上传 .app 基线", async () => {
    const calls: string[][] = [];
    const runner: CliRunner = async (args) => {
      calls.push(args);
      if (args[0] === "uploadApp")
        return {
          code: 0,
          stdout: "已成功上传app原生包（id: 100266, version: 4.0.0, buildTime: 1）",
          stderr: "",
        };
      return { code: 0, stdout: "", stderr: "" };
    };
    const plugin = rnUpdate({ harmony: 34166 }, createPushyCli(runner));
    const ctx = { cwd: "/tmp", channel: "agc" };
    // stage:after 的 result 自带 artifactPath（core 接口字段），无 before 依赖、无插件状态
    await plugin["stage:after"]!({ channel: "agc", ok: true, artifactPath: "/tmp/x.app" }, ctx);
    expect(calls.filter((c) => c[0] === "uploadApp")).toHaveLength(1);
    expect(calls.find((c) => c[0] === "uploadApp")!.join(" ")).toContain("--appId 34166");
  });

  it("stage 失败或未配置平台的渠道 → 不上传", async () => {
    const calls: string[][] = [];
    const runner: CliRunner = async (args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };
    const plugin = rnUpdate({ harmony: 34166 }, createPushyCli(runner));
    const ctx = { cwd: "/tmp" };
    await plugin["stage:after"]!(
      { channel: "agc", ok: false, error: "x", artifactPath: "/tmp/x.app" },
      ctx,
    );
    await plugin["stage:after"]!({ channel: "pgyer", ok: true, artifactPath: "/tmp/pg.apk" }, ctx);
    // result 不带 artifactPath（旧管线/异常路径）→ 不上传防误传
    await plugin["stage:after"]!({ channel: "agc", ok: true }, ctx);
    expect(calls.filter((c) => c[0] === "uploadApp")).toHaveLength(0);
  });

  it("uploadApp 失败 → 不阻断发布（stage:after 不抛），stderr 提醒人工补传", async () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runner: CliRunner = async () => ({ code: 1, stdout: "", stderr: "pushy down" });
    const plugin = rnUpdate({ harmony: 34166 }, createPushyCli(runner));
    const ctx = { cwd: "/tmp", channel: "agc" };
    await expect(
      plugin["stage:after"]!({ channel: "agc", ok: true, artifactPath: "/tmp/x.app" }, ctx),
    ).resolves.toBeUndefined();
    expect(errSpy.mock.calls.flat().join(" ")).toContain("基线上传失败");
    errSpy.mockRestore();
  });

  it("并发交错无状态：两渠道 after 各自带 artifactPath，各传各的（接口数据自带 = 构造性并发安全）", async () => {
    const calls: string[][] = [];
    const runner: CliRunner = async (args) => {
      calls.push(args);
      if (args[0] === "uploadApp")
        return {
          code: 0,
          stdout: "已成功上传app原生包（id: 100266, version: 4.0.0, buildTime: 1）",
          stderr: "",
        };
      return { code: 0, stdout: "", stderr: "" };
    };
    const plugin = rnUpdate({ harmony: 34166 }, createPushyCli(runner));
    // 无 before、无暂存：每个 after 只依赖自己的 result（旧闭包/Map 实现在交错下会丢或串）
    await Promise.all([
      plugin["stage:after"]!(
        { channel: "agc", ok: true, artifactPath: "/tmp/agc.app" },
        { cwd: "/tmp", channel: "agc" },
      ),
      plugin["stage:after"]!({ channel: "pgyer", ok: true }, { cwd: "/tmp", channel: "pgyer" }),
    ]);
    const uploads = calls.filter((c) => c[0] === "uploadApp");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.join(" ")).toContain("/tmp/agc.app");
  });
});

describe("错误分支与工厂注册", () => {
  it("testPackageVersion：非数字开头版本 → 显式报错；纯数字与带段版本可偏移", () => {
    expect(() => testPackageVersion("v4.0.0")).toThrow(/非 X\.Y\.Z 形态/);
    expect(testPackageVersion("4.a.0")).toBe("1004.a.0"); // 契约：只要求 major 数字可偏移，余段原样保留
    expect(testPackageVersion("4")).toBe("1004");
    expect(testPackageVersion("4.0.0")).toBe("1004.0.0");
  });

  it("publishToTest：工程无该平台版本文件 → 明确报错（不是静默空版本）", async () => {
    const dir = tmpProject(() => {}); // 空工程：readProjectVersions 读不到 harmony 版本
    const provider = makeRnUpdateProvider(
      { harmony: 1 },
      createPushyCli(async () => ({ code: 0, stdout: "", stderr: "" })),
    );
    await expect(
      provider.publishToTest({ cwd: dir, framework: rn, platform: "harmony" }),
    ).rejects.toThrow(/未读到平台 harmony 的 versionName/);
  });

  it("rnUpdate 工厂：update:register 注册完整 provider（platforms = 已配置 appId 的平台）", async () => {
    const plugin = rnUpdate(
      { harmony: 34166 },
      createPushyCli(async () => ({ code: 0, stdout: "", stderr: "" })),
    );
    const providers: UpdateProvider[] = [];
    plugin["update:register"]!(providers, { cwd: "/tmp" });
    expect(providers).toHaveLength(1);
    expect(providers[0]!.id).toBe("rn-update");
    expect(providers[0]!.platforms).toEqual(["harmony"]); // android/ios 未配 appId 不在列
  });
});
