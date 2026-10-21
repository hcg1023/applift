/**
 * CLI 层测试（REVIEW 测试盲区 #1 补缺）：
 * - P2-2：--release-time/--remark/--install-password 旗标存在并透传 makeContext
 * - P2-5：config:resolved 钩子返回值成为生效配置（不二次 loadProjectConfig）
 * - P3-7：--stores 未知渠道 id 输出 stderr 警告而非静默过滤
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// 热更路径会写 history.jsonl：APPLIFT_HOME 必须在 core 加载前重定向（该常量 import 时求值），
// 否则测试污染真实 ~/.applift（此前 release 路径一直隐性依赖真实机器凭据，重定向后显形）。
// 故 ./index.js 与 @applift/core 都动态 import（与 doctor.test.ts 同模式）。
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "applift-idx-home-"));
process.env.APPLIFT_HOME = testHome;
fs.writeFileSync(
  path.join(testHome, "credentials.json"),
  JSON.stringify({ profiles: { default: { PGYER_API_KEY: "test-key" } } }),
);
const { makeContext, program } = await import("./index.js");
const core = await import("@applift/core");
import type { Channel, ChannelContext } from "@applift/core";

afterAll(() => fs.rmSync(testHome, { recursive: true, force: true }));

const stubChannel: Channel = {
  id: "stub",
  label: "桩渠道",
  capabilities: { stage: true, submit: true, scheduled: true, status: false },
  plan: () => {
    throw new Error("unused");
  },
  stage: () => {
    throw new Error("unused");
  },
  submit: () => {
    throw new Error("unused");
  },
  status: () => {
    throw new Error("unused");
  },
};

describe("makeContext（P2-2 透传）", () => {
  it("extra 扩展字段透传到 ChannelContext，缺省不产生 undefined 以外的值", () => {
    const ctx = makeContext(stubChannel, { k: "v" }, { appId: "1" }, "/tmp/a.apk", "更新说明", {
      releaseTime: "2027-01-01T00:00:00Z",
      remark: "提审备注",
      installPassword: "pw123",
    });
    expect(ctx.releaseTime).toBe("2027-01-01T00:00:00Z");
    expect(ctx.remark).toBe("提审备注");
    expect(ctx.installPassword).toBe("pw123");
    expect(ctx.updateDescription).toBe("更新说明");
    expect(ctx.credentials).toEqual({ k: "v" });
    expect(ctx.target).toEqual({ appId: "1" });
    expect(ctx.artifactPath).toBe("/tmp/a.apk");

    const bare = makeContext(stubChannel, {}, {}, "/tmp/a.apk", undefined);
    expect(bare.releaseTime).toBeUndefined();
    expect(bare.remark).toBeUndefined();
    expect(bare.installPassword).toBeUndefined();
    expect(bare.updateDescription).toBeUndefined();
  });
});

describe("makeContext emit 脱敏（SEC-002）", () => {
  it("warn/phase message 内嵌凭据 → stderr 输出 [REDACTED] 且不含原文", () => {
    const ctx = makeContext(stubChannel, {}, {}, "/tmp/a.apk", undefined);
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((b) => {
      writes.push(String(b));
      return true;
    });
    try {
      ctx.emit?.({ type: "warn", message: "渠道警告：token=leak-me-123" });
      ctx.emit?.({ type: "phase", phase: "upload", message: "上传响应 token=phase-leak-9" });
      ctx.emit?.({ type: "phase", phase: "done", message: "已提交（versionCode=301）" });
    } finally {
      spy.mockRestore();
    }
    const text = writes.join("");
    expect(text).toContain("token=[REDACTED]");
    expect(text).not.toContain("leak-me-123");
    expect(text).not.toContain("phase-leak-9");
    expect(text).toContain("已提交（versionCode=301）"); // 非敏感 message 原样保留
  });
});

describe("CLI 旗标面（P2-2 入口）", () => {
  it("release 暴露 --release-time/--remark；beta 暴露 --install-password", () => {
    const release = program.commands.find((c) => c.name() === "release");
    const beta = program.commands.find((c) => c.name() === "beta");
    expect(release?.options.map((o) => o.flags)).toContain("--release-time <rfc3339>");
    expect(release?.options.map((o) => o.flags)).toContain("--remark <text>");
    expect(beta?.options.map((o) => o.flags)).toContain("--install-password <pwd>");
  });
});

describe("release --dry-run 集成（P2-2 透传 / P2-5 钩子配置 / P3-7 警告）", () => {
  it("flag 到达 ChannelContext、config:resolved 返回值生效、未知渠道 stderr 警告", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-cli-"));
    const captured: ChannelContext[] = [];
    // 捕获槽走 globalThis（jiti 执行的配置文件无法 import 测试符号，只能共享进程全局）；命名常量持有类型化句柄
    const captureSlot = globalThis as { __appliftCaptured?: ChannelContext[] };
    // RN 工程痕迹：声明式 framework 的 detect 校验需要（package.json 含 react-native）
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "guard-demo", dependencies: { "react-native": "0.84.0" } }),
    );
    captureSlot.__appliftCaptured = captured;
    // 配置文件由 jiti 在本进程执行：channel:register 注册桩渠道，plan 经 globalThis 捕获 ctx
    fs.writeFileSync(
      path.join(dir, "applift.config.ts"),
      [
        "import { rnFramework } from '@applift/core';",
        "export default {",
        "  plugins: [rnFramework(), {",
        "    name: 'capture',",
        "    'config:resolved': (config) => ({ ...config, android: { pkgName: 'com.demo', stores: { stub: { appId: 'from-hook' } } } }),",
        "    'channel:register': (registry) => registry.register({",
        "      id: 'stub', label: '桩渠道',",
        "      capabilities: { stage: true, submit: true, scheduled: true, status: false },",
        "      plan: async (ctx) => {",
        "        globalThis.__appliftCaptured.push(ctx);",
        "        return { channel: 'stub', platform: 'android', artifactVersion: '1.0.0', action: 'stage-only', afterApproval: ctx.releaseTime ? 'scheduled' : 'auto-publish' };",
        "      },",
        "      stage: async () => ({ ok: true }),",
        "      submit: async () => ({ ok: true }),",
        "      status: async () => { throw new Error('not supported'); },",
        "    }),",
        "  }],",
        "};",
      ].join("\n"),
    );
    const stderrWrites: string[] = [];
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((b) => {
      stderrWrites.push(String(b));
      return true;
    });
    vi.spyOn(process.stdout, "write").mockImplementation((b) => {
      stdoutWrites.push(String(b));
      return true;
    });
    try {
      await program.parseAsync(
        [
          "release",
          "android",
          "--cwd",
          dir,
          "--stores",
          "stub, bogus",
          "--dry-run",
          "--json",
          "--release-time",
          "2027-01-01T00:00:00Z",
          "--remark",
          "审核备注",
        ],
        // from:'user' —— 数组即用户输入（缺省 'node' 会剥掉前两项）
        { from: "user" },
      );
    } finally {
      vi.restoreAllMocks();
      delete captureSlot.__appliftCaptured;
      fs.rmSync(dir, { recursive: true, force: true });
    }

    // P3-7：未知渠道 stderr 警告（不再静默过滤），可用列表含内置与插件渠道
    const warn = stderrWrites.join("");
    expect(warn).toContain("未知渠道 bogus（可用:");
    expect(warn).toContain("stub");
    expect(warn).toContain("huawei");

    // P2-2：--release-time/--remark 透传到 ChannelContext
    expect(captured.length).toBe(1);
    expect(captured[0]?.releaseTime).toBe("2027-01-01T00:00:00Z");
    expect(captured[0]?.remark).toBe("审核备注");

    // P2-5：config:resolved 钩子返回值生效（target 来自钩子注入的 android.stores；pkgName 由 android 段兜底合入）
    expect(captured[0]?.target).toEqual({ pkgName: "com.demo", appId: "from-hook" });

    // dry-run 计划由 ctx.releaseTime 驱动 → scheduled；stdout 为纯 JSON
    const json = JSON.parse(stdoutWrites.join("")) as {
      plans: Array<{ afterApproval: string }>;
      errors: Record<string, string>;
    };
    expect(json.errors).toEqual({});
    expect(json.plans[0]?.afterApproval).toBe("scheduled");
  });
});

describe("声明式 framework 守卫（发布命令无插件声明必须报错）", () => {
  it("release 无 framework 插件声明 → 报错并提示声明方式", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-guard-"));
    fs.writeFileSync(path.join(dir, "applift.config.ts"), "export default {};\n");
    try {
      await expect(
        program.parseAsync(["release", "android", "--cwd", dir, "--dry-run"], {
          from: "user",
        }),
      ).rejects.toThrow(/framework 插件/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("beta 无 framework 插件声明 → 同样报错", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-guard-"));
    fs.writeFileSync(path.join(dir, "applift.config.ts"), "export default {};\n");
    try {
      await expect(
        program.parseAsync(["beta", "android", "--cwd", dir, "--yes"], {
          from: "user",
        }),
      ).rejects.toThrow(/framework 插件/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
describe("beta/release 热更路由集成（判定 → 推荐 → 热更执行）", () => {
  function otaProviderProject(recommendation: "ota" | "native" | "uncertain"): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-ota-"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "ota-demo", dependencies: { "react-native": "0.84.0" } }),
    );
    fs.writeFileSync(
      path.join(dir, "applift.config.ts"),
      [
        "import { rnFramework } from '@applift/core';",
        "export default {",
        "  plugins: [rnFramework(), {",
        "    name: 'stub-update',",
        "    'update:register': (providers) => providers.push({",
        "      id: 'stub-update', frameworks: ['rn'],",
        `      judge: () => ({ recommendation: '${recommendation}', confidence: 'high', evidence: [{ path: 'src/a.ts', rule: 'JS 层', note: '' }] }),`,
        "      publishToBeta: async (ctx) => { (globalThis.__otaCaptured ??= []).push({ kind: 'publishToBeta', platform: ctx.platform }); return { versionName: '4.0.0-ota.1', versionId: 1 }; },",
        "      promoteToProd: async (ctx) => { (globalThis.__otaCaptured ??= []).push({ kind: 'promoteToProd', platform: ctx.platform }); return { versionName: '4.0.0-ota.1' }; },",
        "    }),",
        "  }],",
        "};",
      ].join("\n"),
    );
    return dir;
  }

  it("beta 判定 ota + --yes → 走热更（publishToBeta），不进原生管线", async () => {
    const dir = otaProviderProject("ota");
    const slot = globalThis as { __otaCaptured?: Array<{ kind: string; platform: string }> };
    slot.__otaCaptured = [];
    try {
      await program.parseAsync(["beta", "harmony", "--cwd", dir, "--yes"], {
        from: "user",
      });
      expect(slot.__otaCaptured).toEqual([{ kind: "publishToBeta", platform: "harmony" }]);
    } finally {
      delete slot.__otaCaptured;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("release 判定 ota + --yes → 走热更（promoteToProd）", async () => {
    const dir = otaProviderProject("ota");
    const slot = globalThis as { __otaCaptured?: Array<{ kind: string; platform: string }> };
    slot.__otaCaptured = [];
    try {
      await program.parseAsync(["release", "harmony", "--cwd", dir, "--yes"], { from: "user" });
      expect(slot.__otaCaptured).toEqual([{ kind: "promoteToProd", platform: "harmony" }]);
    } finally {
      delete slot.__otaCaptured;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--yes 且判定 uncertain → 中止并要求 --delivery 显式指定", async () => {
    const dir = otaProviderProject("uncertain");
    try {
      await expect(
        program.parseAsync(["beta", "harmony", "--cwd", dir, "--yes"], {
          from: "user",
        }),
      ).rejects.toThrow(/--delivery/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--delivery native 强制原生路径（跳过热更，走原有管线）", async () => {
    const dir = otaProviderProject("ota");
    const slot = globalThis as { __otaCaptured?: unknown[] };
    slot.__otaCaptured = [];
    try {
      await expect(
        program.parseAsync(["beta", "harmony", "--cwd", dir, "--yes", "--delivery", "native"], {
          from: "user",
        }),
      ).rejects.toThrow();
      expect(slot.__otaCaptured).toEqual([]);
    } finally {
      delete slot.__otaCaptured;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--delivery ota 显式覆盖（判定 native 也强制走热更：用户拍板优先于推荐）", async () => {
    const dir = otaProviderProject("native");
    const slot = globalThis as { __otaCaptured?: Array<{ kind: string; platform: string }> };
    slot.__otaCaptured = [];
    try {
      await program.parseAsync(["beta", "harmony", "--cwd", dir, "--delivery", "ota"], {
        from: "user",
      });
      expect(slot.__otaCaptured).toEqual([{ kind: "publishToBeta", platform: "harmony" }]);
    } finally {
      delete slot.__otaCaptured;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("release 判定 ota + --dry-run → 零副作用（不调 promoteToProd，只打印计划）", async () => {
    const dir = otaProviderProject("ota");
    const slot = globalThis as { __otaCaptured?: unknown[] };
    slot.__otaCaptured = [];
    try {
      await program.parseAsync(["release", "harmony", "--cwd", dir, "--dry-run"], {
        from: "user",
      });
      expect(slot.__otaCaptured).toEqual([]);
    } finally {
      delete slot.__otaCaptured;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("非交互（无 TTY）且判定 uncertain、未给 --delivery/--yes → 直接报错要求显式指定，不挂交互", async () => {
    const dir = otaProviderProject("uncertain");
    try {
      await expect(
        program.parseAsync(["release", "harmony", "--cwd", dir, "--dry-run"], {
          from: "user",
        }),
      ).rejects.toThrow(/--delivery/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("beta 热更落 history（channel=provider id，action=stage）——审计不断链", async () => {
    const dir = otaProviderProject("ota");
    try {
      await program.parseAsync(["beta", "harmony", "--cwd", dir, "--yes"], {
        from: "user",
      });
      const entries = core.readEntries(
        { channel: "stub-update" },
        path.join(testHome, "history.jsonl"),
      );
      // 同 describe 前序 ota 测试也各落一条：断言存在性而非计数
      expect(
        entries.some(
          (e) =>
            e.action === "stage" && e.ok && e.artifactVersion === "4.0.0-ota.1" && e.cwd === dir,
        ),
      ).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("release 热更落 history（action=submit）——审计不断链", async () => {
    const dir = otaProviderProject("ota");
    try {
      await program.parseAsync(["release", "harmony", "--cwd", dir, "--yes"], {
        from: "user",
      });
      const entries = core.readEntries(
        { channel: "stub-update" },
        path.join(testHome, "history.jsonl"),
      );
      expect(entries.some((e) => e.action === "submit" && e.ok)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("判定 native + 非交互（--yes）→ 三步发版引导（含跳过出路），文案与判定一致", async () => {
    const dir = otaProviderProject("native");
    try {
      await expect(
        program.parseAsync(["beta", "harmony", "--cwd", dir, "--yes"], {
          from: "user",
        }),
      ).rejects.toThrow(/判定为原生发版[\s\S]*--delivery native/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("未接入热更的平台走原生（provider.platforms 过滤）", () => {
  it("provider 只支持 harmony 时，beta android 不被判定劫持（不调 publishToBeta，进原生管线）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-plat-"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "plat-demo", dependencies: { "react-native": "0.84.0" } }),
    );
    fs.writeFileSync(
      path.join(dir, "applift.config.ts"),
      [
        "import { rnFramework } from '@applift/core';",
        "export default {",
        "  plugins: [rnFramework(), {",
        "    name: 'scoped-update',",
        "    'update:register': (providers) => providers.push({",
        "      id: 'scoped-update', frameworks: ['rn'], platforms: ['harmony'],",
        "      judge: () => ({ recommendation: 'ota', confidence: 'high', evidence: [] }),",
        "      publishToBeta: async () => { (globalThis.__platCaptured ??= []).push('publishToBeta'); return { versionName: 'x', versionId: 1 }; },",
        "      promoteToProd: async () => ({ versionName: 'x' }),",
        "    }),",
        "  }],",
        "};",
      ].join("\n"),
    );
    const slot = globalThis as { __platCaptured?: string[] };
    slot.__platCaptured = [];
    try {
      // android 未接入热更 → 路由返回 null → 原生管线（缺产物/凭据报错），但绝不调热更 provider
      await expect(
        program.parseAsync(["beta", "android", "--cwd", dir, "--yes"], {
          from: "user",
        }),
      ).rejects.toThrow();
      expect(slot.__platCaptured).toEqual([]);
    } finally {
      delete slot.__platCaptured;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("release 未接入热更的平台 + --rollout → 参数静默失效必须可见（warn 提示）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-rollout-warn-"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "rw", dependencies: { "react-native": "0.84.0" } }),
    );
    fs.writeFileSync(
      path.join(dir, "applift.config.ts"),
      "import { rnFramework } from '@applift/core';\nexport default { plugins: [rnFramework()] };",
    );
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      // android 平台无热更 provider → 路由 null → 原生路径，--rollout 无人消费
      await expect(
        program.parseAsync(["release", "android", "--cwd", dir, "--yes", "--rollout", "20"], {
          from: "user",
        }),
      ).rejects.toThrow();
      expect(out.mock.calls.flat().join(" ")).toContain("--rollout 仅热更发布");
    } finally {
      out.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("beta 判定 native → 引导手动 bump+构建+重跑（不自动 bump，不进渠道管线）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-natbump-"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "nat-demo",
        version: "4.0.0",
        dependencies: { "react-native": "0.84.0" },
      }),
    );
    fs.writeFileSync(
      path.join(dir, "applift.config.ts"),
      [
        "import { rnFramework } from '@applift/core';",
        "export default {",
        "  plugins: [rnFramework(), {",
        "    name: 'stub-update',",
        "    'update:register': (providers) => providers.push({",
        "      id: 'stub-update', frameworks: ['rn'],",
        "      judge: () => ({ recommendation: 'native', confidence: 'high', evidence: [{ path: 'harmony/x', rule: '原生目录', note: '' }] }),",
        "      publishToBeta: async () => { throw new Error('不应走热更'); },",
        "      promoteToProd: async () => ({ versionName: 'x' }),",
        "    }),",
        "  }],",
        "};",
      ].join("\n"),
    );
    spawnSync("git", ["init", "-q"], { cwd: dir });
    spawnSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    spawnSync("git", ["config", "user.name", "t"]);
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["commit", "-qm", "init"], { cwd: dir });

    await expect(
      program.parseAsync(["beta", "harmony", "--cwd", dir, "--yes"], { from: "user" }),
    ).rejects.toThrow(/version bump/);

    // 不自动 bump：工程文件版本保持原样（升版本由用户跑 applift version bump）
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    expect(pkg.version).toBe("4.0.0");
  });
});
