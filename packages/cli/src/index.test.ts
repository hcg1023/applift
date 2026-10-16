/**
 * CLI 层测试（REVIEW 测试盲区 #1 补缺）：
 * - P2-2：--release-time/--remark/--install-password 旗标存在并透传 makeContext
 * - P2-5：config:resolved 钩子返回值成为生效配置（不二次 loadProjectConfig）
 * - P3-7：--stores 未知渠道 id 输出 stderr 警告而非静默过滤
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeContext, program } from "./index.js";
import type { Channel, ChannelContext } from "@applift/core";

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
    captureSlot.__appliftCaptured = captured;
    // 配置文件由 jiti 在本进程执行：channel:register 注册桩渠道，plan 经 globalThis 捕获 ctx
    fs.writeFileSync(
      path.join(dir, "applift.config.ts"),
      [
        "export default {",
        "  plugins: [{",
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
