/**
 * rn-update 判定引擎：diff 能否走热更（JS bundle 安全运行在旧原生二进制上）。
 * 规则依据（五形态完备性）：任何新原生实体必现于 项目原生目录 / 依赖(原生包) /
 * 补丁目录 / 构建配置 / 业务 JS——前四者判原生，纯 JS 判热更，其余灰区。
 */
import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { judgeDelivery, makeRnUpdateProvider, rnUpdate, betaPackageVersion } from "./rn-update.js";
import type { UpdateProvider } from "../update.js";
import type { PushyCli } from "./pushy-api.js";
import { PUSHY_TOKEN_KEY } from "./pushy-api.js";
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

/** PushyCli mock（vi.fn 对象注入）：调用参数类型从接口推导，over 覆盖默认行为 */
function mkCli(over: Partial<PushyCli> = {}) {
  const publish = vi.fn(async (_input: Parameters<PushyCli["publish"]>[0]) => ({
    versionId: 303353,
  }));
  const uploadApp = vi.fn(async (_appId: number, _appFile: string, versionName: string) => ({
    packageId: 100266,
    version: versionName,
  }));
  const rebind = vi.fn(async (_input: Parameters<PushyCli["rebind"]>[0]) => {});
  const versions = vi.fn(
    async (_appId: number): Promise<Array<{ id: number; hash: string; name: string }>> => [],
  );
  const cli: PushyCli = { publish, uploadApp, rebind, versions, ...over };
  return { cli, calls: { publish, uploadApp, rebind, versions } };
}

/** ppk 产物 fixture：.pushy/output/harmony.<time>.ppk（pushy 官方输出约定），返回绝对路径 */
function ppkArtifact(dir: string, ageMs = 0): string {
  fs.mkdirSync(path.join(dir, ".pushy", "output"), { recursive: true });
  const p = path.join(dir, `.pushy`, "output", `harmony.${Date.now()}.ppk`);
  fs.writeFileSync(p, "ppk");
  if (ageMs > 0) {
    const past = new Date(Date.now() - ageMs);
    fs.utimesSync(p, past, past);
  }
  return p;
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

  it("lockfile 变更 → uncertain（依赖树内部变化，不猜）", () => {
    const r = judgeDelivery(["package-lock.json"], ctx("/tmp"), {});
    expect(r.recommendation).toBe("uncertain");
    expect(r.evidence.find((e) => e.path === "package-lock.json")?.rule).toContain("lockfile");
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

  it("锚点 package.json 坏 JSON → readDepsFromGit 返回 null → uncertain（锚点侧不猜）", () => {
    const dir = tmpProject((d) => {
      const g = (args: string[]) => spawnSync("git", args, { cwd: d, encoding: "utf8" });
      g(["init", "-q"]);
      g(["config", "user.email", "t@t"]);
      g(["config", "user.name", "t"]);
      fs.writeFileSync(path.join(d, "package.json"), "{broken anchor"); // 锚点侧坏 JSON
      g(["add", "-A"]);
      g(["commit", "-qm", "init"]);
      g(["tag", "v1"]);
      fs.writeFileSync(
        path.join(d, "package.json"),
        JSON.stringify({ name: "p", dependencies: { dayjs: "^1.0.0" } }),
      );
      fs.mkdirSync(path.join(d, "node_modules", "dayjs"), { recursive: true });
      fs.writeFileSync(
        path.join(d, "node_modules", "dayjs", "package.json"),
        JSON.stringify({ name: "dayjs", version: "1.0.0" }),
      );
    });
    const r = judgeDelivery(["package.json", "src/a.ts"], ctx(dir, "v1"), {});
    expect(r.recommendation).toBe("uncertain");
  });
});

describe("publishToBeta / promoteToProd（OpenAPI 客户端组装：取号 + 测试版本偏移 + promote 重绑）", () => {
  function rnProject(): string {
    return tmpProject((d) => {
      fs.mkdirSync(path.join(d, "harmony", "AppScope"), { recursive: true });
      fs.writeFileSync(
        path.join(d, "harmony", "AppScope", "app.json5"),
        '{ "versionName": "4.0.0", "versionCode": 4000000 }',
      );
    });
  }

  it("publishToBeta：读 versionName → 探测 ppk 产物（mtime 最新）→ 服务端取号 → publish 绑 major+1000 偏移测试版本", async () => {
    const dir = rnProject();
    ppkArtifact(dir, 60_000); // 旧 ppk：mtime 排序应被新者胜出
    const fresh = ppkArtifact(dir);
    const { cli, calls } = mkCli({
      versions: async () => [{ id: 303339, hash: "qm5Xb8bG", name: "4.0.0-patch.4" }],
    });
    const provider = makeRnUpdateProvider({ harmony: 34166 }, cli);
    const r = await provider.publishToBeta!({
      cwd: dir,
      framework: rn,
      platform: "harmony",
      note: "修复登录",
    });
    expect(r).toEqual({ versionName: "4.0.0-patch.5", versionId: 303353 });
    expect(calls.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 34166,
        ppk: fresh,
        name: "4.0.0-patch.5",
        packageVersion: "1004.0.0",
        description: "修复登录",
      }),
    );
  });

  it("publishToBeta：无 ppk → 报错引导先产出（产物入口语义）", async () => {
    const dir = rnProject(); // 无 .pushy/output
    const { cli } = mkCli();
    const provider = makeRnUpdateProvider({ harmony: 34166 }, cli);
    await expect(
      provider.publishToBeta!({ cwd: dir, framework: rn, platform: "harmony" }),
    ).rejects.toThrow(/未探测到 harmony 的 ppk[\s\S]*pushy bundle/);
  });

  it("publishToBeta：--artifact 显式指定 ppk → 跳过探测与新鲜度护栏（显式意图语义）", async () => {
    const dir = rnProject();
    const stale = ppkArtifact(dir, 3_600_000); // 一小时前的旧包
    const { cli, calls } = mkCli();
    const provider = makeRnUpdateProvider({ harmony: 34166 }, cli);
    await provider.publishToBeta!({
      cwd: dir,
      framework: rn,
      platform: "harmony",
      artifact: stale,
    });
    expect(calls.publish).toHaveBeenCalledWith(expect.objectContaining({ ppk: stale }));
  });

  it("publishToBeta：ppk 早于最新代码改动 → 新鲜度护栏报错（旧包防呆）", async () => {
    const dir = tmpProject((d) => {
      const g = (args: string[]) => spawnSync("git", args, { cwd: d, encoding: "utf8" });
      g(["init", "-q"]);
      g(["config", "user.email", "t@t"]);
      g(["config", "user.name", "t"]);
      fs.mkdirSync(path.join(d, "harmony", "AppScope"), { recursive: true });
      fs.writeFileSync(
        path.join(d, "harmony", "AppScope", "app.json5"),
        '{ "versionName": "4.0.0", "versionCode": 4000000 }',
      );
      fs.mkdirSync(path.join(d, "src"), { recursive: true });
      fs.writeFileSync(path.join(d, "src", "a.ts"), "1");
      g(["add", "-A"]);
      g(["commit", "-qm", "init"]);
      g(["tag", "v1.0.0"]); // 锚点须三段 semver（latestSemverTag 契约），v1 不识别
      // 锚点之后的新改动（mtime = 现在）：ppk 必须新于它
      fs.writeFileSync(path.join(d, "src", "b.ts"), "2");
    });
    ppkArtifact(dir, 60_000); // ppk 比 b.ts 旧
    const { cli } = mkCli();
    const provider = makeRnUpdateProvider({ harmony: 34166 }, cli);
    await expect(
      provider.publishToBeta!({ cwd: dir, framework: rn, platform: "harmony" }),
    ).rejects.toThrow(/早于最新代码改动/);
  });

  it("publishToBeta：ppkPatterns 覆盖默认探测目录（自定义 bundle 输出位置）", async () => {
    const dir = rnProject();
    fs.mkdirSync(path.join(dir, "dist", "hot"), { recursive: true });
    const custom = path.join(dir, "dist", "hot", "custom.ppk");
    fs.writeFileSync(custom, "ppk");
    const { cli, calls } = mkCli();
    const provider = makeRnUpdateProvider(
      { harmony: 34166, ppkPatterns: { harmony: ["dist/hot/*.ppk"] } },
      cli,
    );
    await provider.publishToBeta!({ cwd: dir, framework: rn, platform: "harmony" });
    expect(calls.publish).toHaveBeenCalledWith(expect.objectContaining({ ppk: custom }));
  });

  it("promoteToProd：取测试通道最新热更 → rebind 正式版本 + 灰度比例", async () => {
    const dir = rnProject();
    const { cli, calls } = mkCli({
      versions: async () => [
        { id: 303339, hash: "qm5Xb8bG", name: "4.0.0-patch.4" },
        { id: 303353, hash: "Qn19JhbA", name: "4.0.0-patch.5" },
      ],
    });
    const provider = makeRnUpdateProvider({ harmony: 34166, defaultRollout: 10 }, cli);
    const r = await provider.promoteToProd!({
      cwd: dir,
      framework: rn,
      platform: "harmony",
    });
    expect(r).toEqual({ versionName: "4.0.0-patch.5", rollout: 10 });
    expect(calls.rebind).toHaveBeenCalledWith({
      appId: 34166,
      versionId: 303353,
      packageVersion: "4.0.0",
      rollout: 10,
    });
  });

  it("promoteToProd：未配置 defaultRollout → 内置默认 100（全量）", async () => {
    const dir = rnProject();
    const { cli, calls } = mkCli({
      versions: async () => [{ id: 303353, hash: "Qn19JhbA", name: "4.0.0-patch.5" }],
    });
    const provider = makeRnUpdateProvider({ harmony: 34166 }, cli);
    const r = await provider.promoteToProd!({ cwd: dir, framework: rn, platform: "harmony" });
    expect(r).toEqual({ versionName: "4.0.0-patch.5", rollout: 100 });
    expect(calls.rebind).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: 303353, rollout: 100 }),
    );
  });

  it("promoteToProd：只认当前 versionName 的 patch（跨版本不串台），全局更大 N 不越权", async () => {
    const dir = rnProject();
    const { cli, calls } = mkCli({
      versions: async () => [
        { id: 303340, hash: "aaa", name: "3.9.9-patch.9" },
        { id: 303353, hash: "Qn19JhbA", name: "4.0.0-patch.2" },
      ],
    });
    const provider = makeRnUpdateProvider({ harmony: 34166 }, cli);
    const r = await provider.promoteToProd!({ cwd: dir, framework: rn, platform: "harmony" });
    expect(r!.versionName).toBe("4.0.0-patch.2");
    expect(calls.rebind).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: 303353, packageVersion: "4.0.0" }),
    );
  });

  it("promoteToProd：当前 versionName 无 patch（其他版本的不串台）→ 返回 null 不误 promote", async () => {
    const dir = rnProject();
    const { cli, calls } = mkCli({
      versions: async () => [{ id: 1, hash: "aaa", name: "3.9.9-patch.9" }],
    });
    const provider = makeRnUpdateProvider({ harmony: 34166 }, cli);
    await expect(
      provider.promoteToProd!({ cwd: dir, framework: rn, platform: "harmony" }),
    ).resolves.toBeNull();
    expect(calls.rebind).not.toHaveBeenCalled();
  });

  it("平台未配置 app 记录 → 明确报错引导配置", async () => {
    const { cli } = mkCli();
    const provider = makeRnUpdateProvider({}, cli);
    await expect(
      provider.publishToBeta!({ cwd: "/tmp", framework: rn, platform: "android" }),
    ).rejects.toThrow(/android[\s\S]*rnUpdate/);
  });

  it("promoteToProd 无已验证热更 → 返回 null（契约：调用方转 publishToProd 直接发正式）", async () => {
    const dir = rnProject();
    const { cli, calls } = mkCli(); // versions 缺省返回 []
    const provider = makeRnUpdateProvider({ harmony: 34166 }, cli);
    await expect(
      provider.promoteToProd!({ cwd: dir, framework: rn, platform: "harmony" }),
    ).resolves.toBeNull();
    expect(calls.rebind).not.toHaveBeenCalled();
  });

  it("publishToProd：探测 ppk → 取号 → 绑正式版本（非偏移线）+ rollout", async () => {
    const dir = rnProject();
    const fresh = ppkArtifact(dir);
    const { cli, calls } = mkCli({
      versions: async () => [{ id: 303339, hash: "qm5Xb8bG", name: "4.0.0-patch.4" }],
    });
    const provider = makeRnUpdateProvider({ harmony: 34166 }, cli);
    const r = await provider.publishToProd({
      cwd: dir,
      framework: rn,
      platform: "harmony",
      note: "正式修复",
    });
    expect(r).toEqual({ versionName: "4.0.0-patch.5", versionId: 303353, rollout: 100 });
    expect(calls.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 34166,
        ppk: fresh,
        name: "4.0.0-patch.5",
        packageVersion: "4.0.0", // 正式线（publishToBeta 是 1004.0.0 偏移线）
        description: "正式修复",
        rollout: 100,
      }),
    );
  });

  it("未注入 cli 且 ctx 无凭据 → fail-fast 报 PUSHY_API_TOKEN（本地 bundle 之前）", async () => {
    const dir = rnProject();
    const provider = makeRnUpdateProvider({ harmony: 34166 }); // 默认 API 客户端路径
    await expect(
      provider.publishToBeta!({ cwd: dir, framework: rn, platform: "harmony" }),
    ).rejects.toThrow(/PUSHY_API_TOKEN/);
    await expect(
      provider.promoteToProd!({ cwd: dir, framework: rn, platform: "harmony" }),
    ).rejects.toThrow(/PUSHY_API_TOKEN/);
  });
});

describe("stage:after 自动基线（原生路径发版成功后 pushy uploadApp）", () => {
  /** 产物 fixture：空 .app 文件 + 同目录 pack.info（readArtifactVersion 回退路径读取版本） */
  function appArtifact(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-rnupd-art-"));
    fs.writeFileSync(path.join(dir, "x.app"), "");
    fs.writeFileSync(
      path.join(dir, "pack.info"),
      JSON.stringify({ summary: { app: { version: { name: "4.0.0", code: 4000000 } } } }),
    );
    return path.join(dir, "x.app");
  }

  it("agc 渠道 stage 成功 → 从产物读版本号上传基线（appId/file/versionName 齐全）", async () => {
    const artifact = appArtifact();
    const { plugin, calls } = (() => {
      const m = mkCli();
      return { plugin: rnUpdate({ harmony: 34166 }, m.cli), calls: m.calls };
    })();
    await plugin["stage:after"]!(
      { channel: "agc", ok: true, artifactPath: artifact },
      { cwd: "/tmp", channel: "agc" },
    );
    expect(calls.uploadApp).toHaveBeenCalledWith(34166, artifact, "4.0.0", {});
  });

  it("产物读不出版本号（无 pack.info 的 .app）→ 不上传，stderr 提醒人工补传", async () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-rnupd-nover-"));
    fs.writeFileSync(path.join(dir, "x.app"), ""); // 无伴生 pack.info：readArtifactVersion 返回 undefined
    const m = mkCli();
    const plugin = rnUpdate({ harmony: 34166 }, m.cli);
    try {
      await expect(
        plugin["stage:after"]!(
          { channel: "agc", ok: true, artifactPath: path.join(dir, "x.app") },
          { cwd: dir, channel: "agc" },
        ),
      ).resolves.toBeUndefined();
      expect(m.calls.uploadApp).not.toHaveBeenCalled();
      expect(errSpy.mock.calls.flat().join(" ")).toContain("未能从产物读出 versionName");
    } finally {
      errSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("默认路径：hookCtx.credentials 带 token → 构造 API 客户端上传（x-api-token 透传）", async () => {
    const artifact = appArtifact();
    // 直传走 node:http(s) 原生（不经 fetch）：起一次性本地 server 承接（返回 204）
    const srv = http.createServer((req, res) => {
      req.resume();
      res.statusCode = 204;
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      if (String(url).endsWith("/upload"))
        return Response.json({
          url: `http://127.0.0.1:${port}/bucket`,
          formData: { key: "pkgKey" },
        });
      return Response.json({ id: 100266 });
    });
    try {
      const plugin = rnUpdate({ harmony: 34166 }); // 默认 OpenAPI 客户端路径
      await plugin["stage:after"]!(
        { channel: "agc", ok: true, artifactPath: artifact },
        { cwd: "/tmp", channel: "agc", credentials: { PUSHY_API_TOKEN: "tok-1" } },
      );
    } finally {
      fetchSpy.mockRestore();
      srv.close();
    }
    const upload = fetchCalls.find((c) => c.url.endsWith("/upload"));
    expect(upload?.init?.headers).toMatchObject({ "x-api-token": "tok-1" });
    expect(fetchCalls.some((c) => c.url.includes("/app/34166/package/create"))).toBe(true);
  });

  it("stage 失败或未配置平台的渠道 → 不上传", async () => {
    const { plugin, calls } = (() => {
      const m = mkCli();
      return { plugin: rnUpdate({ harmony: 34166 }, m.cli), calls: m.calls };
    })();
    const ctx = { cwd: "/tmp", channel: "agc" };
    await plugin["stage:after"]!(
      { channel: "agc", ok: false, error: "x", artifactPath: "/tmp/x.app" },
      ctx,
    );
    await plugin["stage:after"]!({ channel: "pgyer", ok: true, artifactPath: "/tmp/pg.apk" }, ctx);
    // result 不带 artifactPath（旧管线/异常路径）→ 不上传防误传
    await plugin["stage:after"]!({ channel: "agc", ok: true }, ctx);
    expect(calls.uploadApp).not.toHaveBeenCalled();
  });

  it("uploadApp 失败 → 不阻断发布（stage:after 不抛），stderr 提醒人工补传", async () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const artifact = appArtifact();
    const { plugin } = (() => {
      const m = mkCli({
        uploadApp: async () => {
          throw new Error("pushy down");
        },
      });
      return { plugin: rnUpdate({ harmony: 34166 }, m.cli) };
    })();
    try {
      await expect(
        plugin["stage:after"]!(
          { channel: "agc", ok: true, artifactPath: artifact },
          { cwd: "/tmp", channel: "agc" },
        ),
      ).resolves.toBeUndefined();
      expect(errSpy.mock.calls.flat().join(" ")).toContain("基线上传失败");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("并发交错无状态：两渠道 after 各自带 artifactPath，各传各的（接口数据自带 = 构造性并发安全）", async () => {
    const { plugin, calls } = (() => {
      const m = mkCli();
      return { plugin: rnUpdate({ harmony: 34166 }, m.cli), calls: m.calls };
    })();
    const artifact = appArtifact();
    // 无 before、无暂存：每个 after 只依赖自己的 result（旧闭包/Map 实现在交错下会丢或串）
    await Promise.all([
      plugin["stage:after"]!(
        { channel: "agc", ok: true, artifactPath: artifact },
        { cwd: "/tmp", channel: "agc" },
      ),
      plugin["stage:after"]!({ channel: "pgyer", ok: true }, { cwd: "/tmp", channel: "pgyer" }),
    ]);
    expect(calls.uploadApp).toHaveBeenCalledTimes(1);
    expect(calls.uploadApp.mock.calls[0]![1]).toBe(artifact);
  });
});

describe("错误分支与工厂注册", () => {
  it("betaPackageVersion：非数字开头版本 → 显式报错；纯数字与带段版本可偏移", () => {
    expect(() => betaPackageVersion("v4.0.0")).toThrow(/非 X\.Y\.Z 形态/);
    expect(betaPackageVersion("4.a.0")).toBe("1004.a.0"); // 契约：只要求 major 数字可偏移，余段原样保留
    expect(betaPackageVersion("4")).toBe("1004");
    expect(betaPackageVersion("4.0.0")).toBe("1004.0.0");
  });

  it("publishToBeta：工程无该平台版本文件 → 明确报错（不是静默空版本）", async () => {
    const dir = tmpProject(() => {}); // 空工程：readProjectVersions 读不到 harmony 版本
    const { cli } = mkCli();
    const provider = makeRnUpdateProvider({ harmony: 1 }, cli);
    await expect(
      provider.publishToBeta!({ cwd: dir, framework: rn, platform: "harmony" }),
    ).rejects.toThrow(/未读到平台 harmony 的 versionName/);
  });

  it("rnUpdate 工厂：update:register 注册完整 provider（platforms = 已配置 appId 的平台）", async () => {
    const { cli } = mkCli();
    const plugin = rnUpdate({ harmony: 34166 }, cli);
    const providers: UpdateProvider[] = [];
    plugin["update:register"]!(providers, { cwd: "/tmp" });
    expect(providers).toHaveLength(1);
    expect(providers[0]!.id).toBe("rn-update");
    expect(providers[0]!.platforms).toEqual(["harmony"]); // android/ios 未配 appId 不在列
    expect(providers[0]!.judge(["src/a.ts"], { cwd: "/tmp", framework: rn })).toMatchObject({
      recommendation: "ota",
    });
  });
});
