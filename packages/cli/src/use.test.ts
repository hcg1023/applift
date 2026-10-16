/**
 * applift use 冒烟（profile 本地化）：APPLIFT_HOME 重定向到临时目录，全程不碰真实 ~/.applift。
 * 验收链：use 无参展示列表 → use 写 projects.json → release 解析到个人 profile → --profile 旗标优先级最高。
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChannelContext } from "@applift/core";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "applift-home-"));
// APPLIFT_HOME（连同 PROJECTS_MAP_PATH/CREDENTIALS_PATH 等派生常量）在 core 模块加载时求值
// → 必须先设 env 再动态 import CLI 及其依赖的 core src
process.env.APPLIFT_HOME = home;
const { program } = await import("./index.js");
const core = await import("@applift/core");

afterAll(() => {
  delete process.env.APPLIFT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("applift use → release profile 解析链", () => {
  it("use 无参展示列表；use 写 projects.json；release 走个人选择；--profile 旗标最高优先级", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-use-proj-"));
    const captured: ChannelContext[] = [];
    // 捕获槽走 globalThis（jiti 执行的配置文件无法 import 测试符号，只能共享进程全局）
    const slot = globalThis as { __appliftUseCaptured?: ChannelContext[] };
    slot.__appliftUseCaptured = captured;
    // 凭据（临时 home）：两个 profile 用同一键名区分来源
    core.saveCredentials({
      profiles: { "team-default": { CAPTURE_KEY: "team" }, personal: { CAPTURE_KEY: "me" } },
    });
    fs.writeFileSync(
      path.join(dir, "applift.config.ts"),
      [
        "export default {",
        "  profile: 'team-default',",
        "  android: { pkgName: 'com.use.demo', stores: { 'use-stub': {} } },",
        "  plugins: [{",
        "    name: 'capture',",
        "    'channel:register': (registry) => {",
        // 幂等：release 连跑两次会触发两次 channel:register，registry 重复注册抛错
        "      if (registry.get('use-stub')) return;",
        "      registry.register({",
        "        id: 'use-stub', label: '桩渠道',",
        "        capabilities: { stage: true, submit: true, scheduled: false, status: false },",
        "        plan: async () => ({ channel: 'use-stub', platform: 'android', artifactVersion: '1.0.0', action: 'stage-only', afterApproval: 'auto-publish' }),",
        "        stage: async (ctx) => { globalThis.__appliftUseCaptured.push(ctx); return { ok: true }; },",
        "        submit: async () => ({ ok: true }),",
        "        status: async () => ({ state: 'unknown' }),",
        "      });",
        "    },",
        "  }],",
        "};",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(dir, "demo.apk"), "apk-bytes");
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((b) => {
      writes.push(String(b));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((b) => {
      writes.push(String(b));
      return true;
    });
    const releaseArgs = [
      "release",
      "android",
      "--cwd",
      dir,
      "--stores",
      "use-stub",
      "--artifact",
      path.join(dir, "demo.apk"),
    ];
    try {
      // ① use 无参：展示当前生效（项目默认 team-default）与可用 profiles，不写文件
      await program.parseAsync(["use", "--cwd", dir], { from: "user" });
      expect(fs.existsSync(path.join(home, "projects.json"))).toBe(false);
      expect(writes.join("")).toContain("team-default");
      expect(writes.join("")).toContain("personal");

      // ② use personal：写 projects.json（个人选择，不进项目目录）
      await program.parseAsync(["use", "personal", "--cwd", dir], { from: "user" });
      expect(JSON.parse(fs.readFileSync(path.join(home, "projects.json"), "utf8"))).toEqual({
        [dir]: "personal",
      });

      // ③ release（无旗标）→ 解析到个人 profile 的凭据
      await program.parseAsync(releaseArgs, { from: "user" });
      expect(captured.at(-1)?.credentials?.CAPTURE_KEY).toBe("me");

      // ④ --profile 旗标 > projects.json 个人选择
      await program.parseAsync([...releaseArgs, "--profile", "team-default"], { from: "user" });
      expect(captured.at(-1)?.credentials?.CAPTURE_KEY).toBe("team");
      expect(process.exitCode ?? 0).toBe(0);
    } finally {
      vi.restoreAllMocks();
      delete slot.__appliftUseCaptured;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
