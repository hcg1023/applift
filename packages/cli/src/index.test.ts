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
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

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
      releaseMode: "manual",
      remark: "提审备注",
      installPassword: "pw123",
    });
    expect(ctx.releaseTime).toBe("2027-01-01T00:00:00Z");
    expect(ctx.releaseMode).toBe("manual");
    expect(ctx.remark).toBe("提审备注");
    expect(ctx.installPassword).toBe("pw123");
    expect(ctx.updateDescription).toBe("更新说明");
    expect(ctx.credentials).toEqual({ k: "v" });
    expect(ctx.target).toEqual({ appId: "1" });
    expect(ctx.artifactPath).toBe("/tmp/a.apk");

    const bare = makeContext(stubChannel, {}, {}, "/tmp/a.apk", undefined);
    expect(bare.releaseTime).toBeUndefined();
    expect(bare.releaseMode).toBeUndefined();
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

describe("makeContext emit progress 渲染（长任务进度可见性）", () => {
  it("progress 事件写 stderr（脱敏）——ASC 等构建/AGC 编译轮询不再静默", () => {
    const ctx = makeContext(stubChannel, {}, {}, "/tmp/a.apk", undefined);
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((b) => {
      writes.push(String(b));
      return true;
    });
    try {
      ctx.emit?.({ type: "progress", detail: "构建处理中（已等 5 分钟，第 10 次探测）" });
      ctx.emit?.({ type: "progress", detail: "COS 上传完成 url?token=abc123secret 已入库" });
    } finally {
      spy.mockRestore();
    }
    const text = writes.join("");
    expect(text).toContain("构建处理中（已等 5 分钟，第 10 次探测）");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("abc123secret");
  });
});

describe("CLI 旗标面（P2-2 入口）", () => {
  it("release 暴露 --release-time/--remark；beta 暴露 --install-password", () => {
    const release = program.commands.find((c) => c.name() === "release");
    const beta = program.commands.find((c) => c.name() === "beta");
    expect(release?.options.map((o) => o.flags)).toContain("--release-time <rfc3339>");
    expect(release?.options.map((o) => o.flags)).toContain("--release-mode <mode>");
    expect(release?.options.map((o) => o.flags)).toContain("--remark <text>");
    expect(beta?.options.map((o) => o.flags)).toContain("--install-password <pwd>");
  });

  it("--release-mode 非法值 / 与 --release-time 同给 → 入口报错", async () => {
    await expect(
      program.parseAsync(["release", "ios", "--release-mode", "whenever"], { from: "user" }),
    ).rejects.toThrow(/--release-mode 只支持 auto \| manual/);
    await expect(
      program.parseAsync(
        ["release", "ios", "--release-mode", "manual", "--release-time", "2027-01-01T00:00:00Z"],
        { from: "user" },
      ),
    ).rejects.toThrow(/互斥/);
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
        "    'config:resolved': (config) => ({ ...config, android: { pkgName: 'com.demo', stores: { stub: { appId: 'from-hook' } } }, ios: { releaseMode: 'manual' } }),",
        "    'channel:register': (registry) => registry.register({",
        "      id: 'stub', label: '桩渠道',",
        "      capabilities: { stage: true, submit: true, scheduled: true, status: false },",
        "      plan: async (ctx) => {",
        "        globalThis.__appliftCaptured.push(ctx);",
        "        return { channel: 'stub', platform: 'android', artifactVersion: '1.0.0', action: 'stage-only', afterApproval: ctx.releaseTime ? 'scheduled' : (ctx.releaseMode === 'manual' ? 'manual' : 'auto-publish') };",
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

  it("ios.release 配置解析：旗标缺省时 ctx.releaseMode 取配置值", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-cli-ios-"));
    const captured: ChannelContext[] = [];
    const slot = globalThis as { __appliftCaptured2?: ChannelContext[] };
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "guard-demo-ios", dependencies: { "react-native": "0.84.0" } }),
    );
    slot.__appliftCaptured2 = captured;
    fs.writeFileSync(
      path.join(dir, "applift.config.ts"),
      [
        "import { rnFramework } from '@applift/core';",
        "export default {",
        "  ios: { releaseMode: 'manual' },",
        "  plugins: [rnFramework(), {",
        "    name: 'capture-ios',",
        "    'channel:register': (registry) => {",
        "      if (registry.get('stub-ios')) return;",
        "      registry.register({",
        "        id: 'stub-ios', label: '桩渠道(iOS)',",
        "        capabilities: { stage: true, submit: true, scheduled: true, status: false },",
        "        plan: async (ctx) => {",
        "          globalThis.__appliftCaptured2.push(ctx);",
        "          return { channel: 'stub-ios', platform: 'ios', artifactVersion: '1.0.0', action: 'stage-only', afterApproval: ctx.releaseMode === 'manual' ? 'manual' : 'auto-publish' };",
        "        },",
        "        stage: async () => ({ ok: true }),",
        "        submit: async () => ({ ok: true }),",
        "        status: async () => { throw new Error('not supported'); },",
        "      });",
        "    },",
        "  }],",
        "};",
      ].join("\n"),
    );
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((b) => {
      stdoutWrites.push(String(b));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await program.parseAsync(
        ["release", "ios", "--cwd", dir, "--stores", "stub-ios", "--dry-run", "--json"],
        { from: "user" },
      );
    } finally {
      vi.restoreAllMocks();
      delete slot.__appliftCaptured2;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(captured.length).toBe(1);
    expect(captured[0]?.releaseMode).toBe("manual");
    const json = JSON.parse(stdoutWrites.join("")) as { plans: Array<{ afterApproval: string }> };
    expect(json.plans[0]?.afterApproval).toBe("manual");
  });

  it("ios.exportCompliance 配置解析：ctx.exportCompliance 透传给渠道（旗标面缺省取配置）", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-cli-cmp-"));
    const captured: ChannelContext[] = [];
    const slot = globalThis as { __appliftCaptured3?: ChannelContext[] };
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "guard-demo-cmp", dependencies: { "react-native": "0.84.0" } }),
    );
    slot.__appliftCaptured3 = captured;
    fs.writeFileSync(
      path.join(dir, "applift.config.ts"),
      [
        "import { rnFramework } from '@applift/core';",
        "export default {",
        "  ios: { exportCompliance: { usesNonExemptEncryption: false } },",
        "  plugins: [rnFramework(), {",
        "    name: 'capture-cmp',",
        "    'channel:register': (registry) => {",
        "      if (registry.get('stub-cmp')) return;",
        "      registry.register({",
        "        id: 'stub-cmp', label: '桩渠道(CMP)',",
        "        capabilities: { stage: true, submit: true, scheduled: true, status: false },",
        "        plan: async (ctx) => {",
        "          globalThis.__appliftCaptured3.push(ctx);",
        "          return { channel: 'stub-cmp', platform: 'ios', artifactVersion: '1.0.0', action: 'stage-only', afterApproval: 'auto-publish' };",
        "        },",
        "        stage: async () => ({ ok: true }),",
        "        submit: async () => ({ ok: true }),",
        "        status: async () => { throw new Error('not supported'); },",
        "      });",
        "    },",
        "  }],",
        "};",
      ].join("\n"),
    );
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((b) => {
      stdoutWrites.push(String(b));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await program.parseAsync(
        ["release", "ios", "--cwd", dir, "--stores", "stub-cmp", "--dry-run", "--json"],
        { from: "user" },
      );
    } finally {
      vi.restoreAllMocks();
      delete slot.__appliftCaptured3;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(captured.length).toBe(1);
    expect(captured[0]?.exportCompliance).toEqual({ usesNonExemptEncryption: false });
  });

  it("ios.phasedRelease 配置解析：ctx.phasedRelease 透传给渠道", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-cli-phased-"));
    const captured: ChannelContext[] = [];
    const slot = globalThis as { __appliftCaptured4?: ChannelContext[] };
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "guard-demo-phased", dependencies: { "react-native": "0.84.0" } }),
    );
    slot.__appliftCaptured4 = captured;
    fs.writeFileSync(
      path.join(dir, "applift.config.ts"),
      [
        "import { rnFramework } from '@applift/core';",
        "export default {",
        "  ios: { phasedRelease: true },",
        "  plugins: [rnFramework(), {",
        "    name: 'capture-phased',",
        "    'channel:register': (registry) => {",
        "      if (registry.get('stub-phased')) return;",
        "      registry.register({",
        "        id: 'stub-phased', label: '桩渠道(PHASED)',",
        "        capabilities: { stage: true, submit: true, scheduled: true, status: false },",
        "        plan: async (ctx) => {",
        "          globalThis.__appliftCaptured4.push(ctx);",
        "          return { channel: 'stub-phased', platform: 'ios', artifactVersion: '1.0.0', action: 'stage-only', afterApproval: 'auto-publish' };",
        "        },",
        "        stage: async () => ({ ok: true }),",
        "        submit: async () => ({ ok: true }),",
        "        status: async () => { throw new Error('not supported'); },",
        "      });",
        "    },",
        "  }],",
        "};",
      ].join("\n"),
    );
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((b) => {
      stdoutWrites.push(String(b));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await program.parseAsync(
        ["release", "ios", "--cwd", dir, "--stores", "stub-phased", "--dry-run", "--json"],
        { from: "user" },
      );
    } finally {
      vi.restoreAllMocks();
      delete slot.__appliftCaptured4;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(captured.length).toBe(1);
    expect(captured[0]?.phasedRelease).toBe(true);
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
/** 桩热更工程：RN framework + stub update provider（judge 可配置推荐值；platforms 缺省全平台命中） */
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

describe("beta/release 热更路由集成（判定 → 推荐 → 热更执行）", () => {
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
  it("release --dry-run 伪 TTY 下不弹 select（零侵入不变量：dry-run 自动用推荐值出计划）", async () => {
    // 回归：resolveDeliveryMode 移除 dryRun 非交互触发后，TTY 下 release --dry-run
    // 会落入 p.select 挂死伪 TTY 自动化；调用点须以 yes 代答复刻旧语义
    const realTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    const dir = otaProviderProject("ota");
    const slot = globalThis as { __otaCaptured?: unknown[] };
    slot.__otaCaptured = [];
    try {
      await program.parseAsync(["release", "harmony", "--cwd", dir, "--dry-run"], {
        from: "user",
      });
      expect(slot.__otaCaptured).toEqual([]); // 判定走非交互分支出计划，未挂交互等待
    } finally {
      Object.defineProperty(process.stdout, "isTTY", {
        value: realTTY,
        configurable: true,
      });

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

describe("beta --dry-run --json 判定预览（发版向导第一步，不发布）", () => {
  it("beta <platform> --dry-run --json 输出判定预览，不进任何发布分支", async () => {
    const dir = otaProviderProject("ota");
    const slot = globalThis as { __otaCaptured?: unknown[] };
    slot.__otaCaptured = [];
    const out = vi.spyOn(process.stdout, "write").mockImplementation((b) => {
      return true;
    });
    try {
      await program.parseAsync(["beta", "android", "--cwd", dir, "--dry-run", "--json"], {
        from: "user",
      });
      // stdout 纯 JSON 契约：整体可解析 = 判定日志（clack log 走 stderr）未混入
      const r = JSON.parse(out.mock.calls.flat().join("")) as {
        platform: string;
        provider: string | null;
        recommendation: string | null;
        confidence: string | null;
        evidence: Array<{ path: string; rule: string }>;
        note: string;
      };
      expect(r.platform).toBe("android");
      expect(r.provider).toBe("stub-update");
      expect(r.recommendation).toBe("ota");
      expect(r.confidence).toBe("high");
      expect(r.evidence.length).toBeGreaterThan(0);
      expect(r.evidence[0]).toMatchObject({ path: "src/a.ts", rule: "JS 层" });
      expect(r.note).toContain("ota");
      // 不发布：不调热更 provider，history 无该工程新条目
      expect(slot.__otaCaptured).toEqual([]);
      const entries = core.readEntries(
        { channel: "stub-update" },
        path.join(testHome, "history.jsonl"),
      );
      expect(entries.filter((e) => e.cwd === dir)).toHaveLength(0);
    } finally {
      out.mockRestore();
      delete slot.__otaCaptured;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("beta --dry-run 无 provider 平台：provider/recommendation=null，原生语义", async () => {
    // 桩 provider platforms 只含 android → beta harmony 路由 null（未接入热更）
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-dry-native-"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "dry-native", dependencies: { "react-native": "0.84.0" } }),
    );
    fs.writeFileSync(
      path.join(dir, "applift.config.ts"),
      [
        "import { rnFramework } from '@applift/core';",
        "export default {",
        "  plugins: [rnFramework(), {",
        "    name: 'scoped-update',",
        "    'update:register': (providers) => providers.push({",
        "      id: 'scoped-update', frameworks: ['rn'], platforms: ['android'],",
        "      judge: () => ({ recommendation: 'ota', confidence: 'high', evidence: [] }),",
        "      publishToBeta: async () => { throw new Error('不应走热更'); },",
        "      promoteToProd: async () => ({ versionName: 'x' }),",
        "    }),",
        "  }],",
        "};",
      ].join("\n"),
    );
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await program.parseAsync(["beta", "harmony", "--cwd", dir, "--dry-run", "--json"], {
        from: "user",
      });
      const r = JSON.parse(out.mock.calls.flat().join("")) as {
        provider: string | null;
        recommendation: string | null;
        confidence: string | null;
        evidence: unknown[];
        note: string;
      };
      expect(r.provider).toBeNull();
      expect(r.recommendation).toBeNull();
      expect(r.confidence).toBeNull();
      expect(r.evidence).toEqual([]);
      expect(r.note).toContain("原生");
    } finally {
      out.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("beta --dry-run 无 platform：入口守卫拒绝（多渠道并行无判定语义，不静默真实发布）", async () => {
    // 多渠道 fixture：若无守卫，此调用会进入 pgyer 真实发布流程（探测产物 → 渠道上传 → 写 history）
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-dry-guard-"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: "dry-guard",
        version: "4.0.0",
        dependencies: { "react-native": "0.84.0" },
      }),
    );
    fs.writeFileSync(
      path.join(dir, "applift.config.ts"),
      "import { rnFramework } from '@applift/core';\nexport default { plugins: [rnFramework()], beta: { pgyer: { platforms: ['android'] } } };",
    );
    try {
      await expect(
        program.parseAsync(["beta", "--cwd", dir, "--dry-run", "--yes"], { from: "user" }),
      ).rejects.toThrow(/--dry-run 仅支持 beta <platform>/);
      // 守卫在任何发布路径前中止：history 无该工程条目
      const entries = core.readEntries({}, path.join(testHome, "history.jsonl"));
      expect(entries.filter((e) => e.cwd === dir)).toHaveLength(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("beta --json 无 --dry-run：明确报错（不静默接受无人消费的机读旗标）", async () => {
    const dir = otaProviderProject("ota");
    try {
      await expect(
        program.parseAsync(["beta", "android", "--cwd", dir, "--json"], { from: "user" }),
      ).rejects.toThrow(/--json 当前仅支持 --dry-run 判定预览/);
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
describe("beta --interactive-events（NDJSON 事件流，子进程级）", () => {
  const CLI_BIN = fileURLToPath(new URL("../dist/bin.mjs", import.meta.url));
  // 子进程不继承测试进程的环境改写：APPLIFT_HOME 必须显式传（否则 history 写真实 ~/.applift）
  const childEnv = { ...process.env, APPLIFT_HOME: testHome };

  /** 逐行解析子进程 stdout 的 NDJSON；waitFor 按谓词等事件，result 即结果事件 */
  function collectEvents(proc: ChildProcess) {
    const lines: Array<Record<string, unknown>> = [];
    const waiters: Array<{
      test: (l: Record<string, unknown>) => boolean;
      resolve: (l: Record<string, unknown>) => void;
    }> = [];
    let resultResolve: (l: Record<string, unknown>) => void;
    const result = new Promise<Record<string, unknown>>((res) => (resultResolve = res));
    let buf = "";
    proc.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!raw) continue;
        let e: Record<string, unknown>;
        try {
          e = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          continue;
        }
        lines.push(e);
        if (e.type === "result") resultResolve(e);
        for (let k = waiters.length - 1; k >= 0; k--) {
          if (waiters[k]!.test(e)) {
            waiters[k]!.resolve(e);
            waiters.splice(k, 1);
          }
        }
      }
    });
    proc.stderr!.on("data", () => {}); // 排空防背压（判定日志走 stderr）
    const waitFor = (test: (l: Record<string, unknown>) => boolean) =>
      new Promise<Record<string, unknown>>((res) => {
        const found = lines.find(test);
        if (found) res(found);
        else waiters.push({ test, resolve: res });
      });
    return { lines, waitFor, result };
  }

  const closed = (proc: ChildProcess) =>
    new Promise<{ code: number | null }>((res) => proc.on("close", (code) => res({ code })));

  it(
    "判定确认经 stdin 回写后完成发布（hello → stage/judgement → confirm → result）",
    { timeout: 60_000 },
    async () => {
      const dir = otaProviderProject("ota");
      try {
        const proc = spawn(
          process.execPath,
          [CLI_BIN, "beta", "android", "--interactive-events", "--cwd", dir],
          { stdio: ["pipe", "pipe", "pipe"], env: childEnv },
        );
        const ev = collectEvents(proc);
        const hello = await ev.waitFor((l) => l.type === "hello");
        expect(ev.lines[0]).toBe(hello);
        expect(hello).toMatchObject({ type: "hello", protocol: 1 });
        const judge = await ev.waitFor((l) => l.type === "stage" && l.stage === "judge");
        expect(judge).toBeDefined();
        const judgement = (await ev.waitFor((l) => l.type === "judgement")) as {
          recommendation: string;
          provider: string;
        };
        expect(judgement.recommendation).toBe("ota");
        expect(judgement.provider).toBe("stub-update");
        const confirmEvt = (await ev.waitFor((l) => l.type === "confirm_required")) as {
          id: string;
          choices: Array<{ value: string; recommended?: boolean }>;
        };
        expect(confirmEvt.id).toBe("delivery");
        expect(confirmEvt.choices.find((c) => c.value === "ota")?.recommended).toBe(true);
        proc.stdin!.write(JSON.stringify({ type: "confirm", id: "delivery", value: "ota" }) + "\n");
        await ev.waitFor((l) => l.type === "stage" && l.stage === "publish");
        const result = (await ev.result) as { ok: boolean; summary: Record<string, unknown> };
        expect(result.ok).toBe(true);
        expect(result.summary).toMatchObject({
          versionName: "4.0.0-ota.1",
          channel: "stub-update",
          mode: "ota",
        });
        expect(await closed(proc)).toMatchObject({ code: 0 });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it(
    "beta 无 --interactive-events：stdout 不是 NDJSON（零侵入）",
    { timeout: 60_000 },
    async () => {
      const dir = otaProviderProject("ota");
      try {
        const { stdout } = spawnSync(
          process.execPath,
          [CLI_BIN, "beta", "android", "--yes", "--cwd", dir],
          { encoding: "utf8", env: childEnv },
        );
        expect(stdout.split("\n")[0]!.startsWith("{")).toBe(false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("多渠道并行（beta 无 platform）+ --interactive-events → 入口报错", async () => {
    await expect(
      program.parseAsync(["beta", "--interactive-events", "--cwd", process.cwd()], {
        from: "user",
      }),
    ).rejects.toThrow(/--interactive-events 仅支持单平台路径/);
  });

  it("--interactive-events 与 --json 互斥（含 --dry-run 三 flag 同传）→ 入口报错", async () => {
    await expect(
      program.parseAsync(
        ["beta", "android", "--interactive-events", "--json", "--dry-run", "--cwd", process.cwd()],
        { from: "user" },
      ),
    ).rejects.toThrow(/--interactive-events 与 --json 互斥/);
  });

  it("--interactive-events + --bump（显式）→ 入口报错（bump 编排未事件化）", async () => {
    await expect(
      program.parseAsync(
        ["beta", "android", "--interactive-events", "--bump", "--cwd", process.cwd()],
        { from: "user" },
      ),
    ).rejects.toThrow(/--interactive-events 暂不支持 --bump/);
  });

  it(
    "beta.autoBump=true + flag：不触发 bump 编排（confirm 回写即 explicit，绕过三态引导），stdout 流完整",
    { timeout: 60_000 },
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-autobump-"));
      fs.writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({
          name: "ota-demo",
          version: "4.0.0",
          dependencies: { "react-native": "0.84.0" },
        }),
      );
      fs.writeFileSync(
        path.join(dir, "applift.config.ts"),
        [
          "import { rnFramework } from '@applift/core';",
          "export default {",
          "  beta: { autoBump: true },",
          "  plugins: [rnFramework(), {",
          "    name: 'stub-update',",
          "    'update:register': (providers) => providers.push({",
          "      id: 'stub-update', frameworks: ['rn'],",
          "      judge: () => ({ recommendation: 'native', confidence: 'high', evidence: [{ path: 'src/native.kt', rule: '原生代码', note: '' }] }),",
          "      publishToBeta: async () => { throw new Error('不应走热更'); },",
          "      promoteToProd: async () => ({ versionName: 'x' }),",
          "    }),",
          "  }],",
          "};",
        ].join("\n"),
      );
      spawnSync("git", ["init", "-q"], { cwd: dir });
      spawnSync("git", ["config", "user.email", "t@t"], { cwd: dir });
      spawnSync("git", ["config", "user.name", "t"], { cwd: dir });
      spawnSync("git", ["add", "-A"], { cwd: dir });
      spawnSync("git", ["commit", "-qm", "init"], { cwd: dir });
      try {
        const proc = spawn(
          process.execPath,
          [CLI_BIN, "beta", "android", "--interactive-events", "--cwd", dir],
          { stdio: ["pipe", "pipe", "pipe"], env: childEnv },
        );
        const ev = collectEvents(proc);
        const confirmEvt = await ev.waitFor((l) => l.type === "confirm_required");
        expect(confirmEvt.id).toBe("delivery");
        proc.stdin!.write(
          JSON.stringify({ type: "confirm", id: "delivery", value: "native" }) + "\n",
        );
        const result = (await ev.result) as { ok: boolean; error?: string };
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/未找到构建产物/);
        // stdout 流完整性：所有行都是合法 NDJSON 事件（无 clack 文本混入）
        expect(ev.lines.length).toBeGreaterThan(0);
        expect(ev.lines.every((l) => typeof l.type === "string")).toBe(true);
        expect(ev.lines[0]).toMatchObject({ type: "hello", protocol: 1 });
        expect(ev.lines.at(-1)).toMatchObject({ type: "result", ok: false });
        expect(await closed(proc)).toMatchObject({ code: 1 });
        // autoBump 未生效：工程版本未被改动（bump 编排未被调用）
        expect(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version).toBe(
          "4.0.0",
        );
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
