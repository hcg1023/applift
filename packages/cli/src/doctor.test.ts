/**
 * doctor 冒烟（配置来源可解释性）：
 * - 优先级公理行可见：flag > APPLIFT_* env > applift use（个人）> 项目 > 全局
 * - 生效 profile 带来源标注；env 覆盖键名列表（只列名不列值）
 * - 热更 provider 概览（update:register 与 framework:register 对称）
 * APPLIFT_HOME 必须在 core 模块加载前重定向（APPLIFT_HOME/派生常量在 import 时求值），
 * 因此本文件不静态 import ./index.js。
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "applift-doctor-home-"));
process.env.APPLIFT_HOME = home;
process.env.APPLIFT_DOCTOR_PROBE = "unused-value"; // 只应出现在键名列表，值不展示

const { program } = await import("./index.js");

function writeCredentials(): void {
  fs.writeFileSync(
    path.join(home, "credentials.json"),
    JSON.stringify({ profiles: { default: { PGYER_API_KEY: "k" } } }),
  );
}

/** 医生检查的 profile 行只在配置了渠道时输出——统一用 pgyer（凭据只需 PGYER_API_KEY） */
function writeProject(dir: string): void {
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "p", dependencies: { "react-native": "0.72.0" } }),
  );
  fs.writeFileSync(
    path.join(dir, "applift.config.ts"),
    [
      "import { rnFramework } from '@applift/core';",
      "export default {",
      "  plugins: [rnFramework(), {",
      "    name: 'stub-update',",
      "    'update:register': (providers) => providers.push({",
      "      id: 'stub-update', frameworks: ['rn'], platforms: ['harmony'],",
      "      judge: () => ({ recommendation: 'ota', confidence: 'high', evidence: [] }),",
      "      publishToBeta: async () => ({ versionName: 'x', versionId: 1 }),",
      "      promoteToProd: async () => ({ versionName: 'x' }),",
      "    }),",
      "  }],",
      "  android: { stores: ['pgyer'] },",
      "};",
    ].join("\n"),
  );
}

function capture(): { out: () => string; restore: () => void } {
  const buf: string[] = [];
  const so = vi.spyOn(process.stdout, "write").mockImplementation((b) => {
    buf.push(String(b));
    return true;
  });
  const se = vi.spyOn(process.stderr, "write").mockImplementation((b) => {
    buf.push(String(b));
    return true;
  });
  return {
    out: () => buf.join(""),
    restore: () => {
      so.mockRestore();
      se.mockRestore();
    },
  };
}

describe("doctor（配置来源可解释性）", () => {
  it("输出优先级公理、profile 来源、env 覆盖键名与热更 provider，全绿退出", async () => {
    writeCredentials();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-doctor-proj-"));
    writeProject(dir);
    const cap = capture();
    try {
      await program.parseAsync(["doctor", "--cwd", dir], { from: "user" });
      const all = cap.out();
      expect(all).toContain("优先级: flag > APPLIFT_* env");
      // schema 对 profile 有默认值 default，config 路径下来源恒为团队默认；「默认 default」分支仅在调用方直传 undefined 时出现
      expect(all).toContain("profile=default，来源: 项目配置 profile（团队默认）");
      expect(all).toContain("env 覆盖生效");
      expect(all).toContain("DOCTOR_PROBE");
      expect(all).not.toContain("unused-value"); // 只列键名，值永不展示
      expect(all).toContain("热更: stub-update（harmony）");
      expect(all).toContain("体检完成：一切就绪");
      expect(process.exitCode).not.toBe(1);
    } finally {
      cap.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("个人选择（projects.json）优先于默认，来源标注随之变化", async () => {
    writeCredentials();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-doctor-personal-"));
    writeProject(dir);
    fs.writeFileSync(
      path.join(home, "projects.json"),
      JSON.stringify({ [path.resolve(dir)]: "personal" }),
    );
    // personal profile 需要 pgyer 凭据齐全，否则凭据核对拉低健康度（不影响本断言，但保持全绿）
    fs.writeFileSync(
      path.join(home, "credentials.json"),
      JSON.stringify({
        profiles: {
          default: { PGYER_API_KEY: "k" },
          personal: { PGYER_API_KEY: "k" },
        },
      }),
    );
    const cap = capture();
    try {
      await program.parseAsync(["doctor", "--cwd", dir], { from: "user" });
      expect(cap.out()).toContain("profile=personal，来源: applift use（个人）");
    } finally {
      cap.restore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
