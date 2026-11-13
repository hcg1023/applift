/**
 * validate 冒烟（applift-ui 添加项目即时校验的机读契约）：
 * - 合法工程：ok=true、configFound、framework 声明命中、platforms 由 bundleIds 推导、applift 依赖可探测
 * - 非 applift 目录：ok=false、configFound=false、error 指明原因、exit 1（与 doctor 失败语义同）
 * stdout 纯 JSON 契约与 doctor --json 同源（JSON.parse 直接可解析 = 人读日志不进 stdout）。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../dist/bin.mjs", import.meta.url));

let home: string; // 假 HOME（隔离 ~/.applift）
let proj: string; // 假项目
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "applift-validate-home-"));
  proj = fs.mkdtempSync(path.join(os.tmpdir(), "applift-validate-proj-"));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

function cli(args: string[], cwd = proj) {
  const r = spawnSync("node", [BIN, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: home,
      APPLIFT_HOME: path.join(home, ".applift"),
    },
  });
  // stdout/stderr 分离：--json 纯净性断言需要（stdout 只能有 JSON）
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** 合法 RN 工程：config 声明 rnFramework + app.json 三端标识（bundleIds 全命中）+ applift 依赖 */
function makeRnProjectDir(): void {
  fs.writeFileSync(
    path.join(proj, "package.json"),
    JSON.stringify({
      name: "demo-app",
      dependencies: { "react-native": "0.84.0" },
      devDependencies: { "@applift/cli": "^0.13.0" },
    }),
  );
  fs.writeFileSync(
    path.join(proj, "app.json"),
    JSON.stringify({
      android: { applicationId: "com.demo.app" },
      harmony: { bundleName: "com.demo.app.hm" },
      ios: { bundleIdentifier: "com.demo.app.ios" },
    }),
  );
  fs.writeFileSync(
    path.join(proj, "applift.config.ts"),
    `import { defineConfig, rnFramework } from "@applift/core";\nexport default defineConfig({ name: "demo", plugins: [rnFramework()] });\n`,
  );
}

describe("validate", () => {
  it("合法工程：ok=true 且带框架与三端标识", () => {
    makeRnProjectDir();
    const r = cli(["validate", proj, "--json"]);
    expect(r.code).toBe(0);
    const v = JSON.parse(r.stdout);
    expect(v.ok).toBe(true);
    expect(v.configFound).toBe(true);
    expect(v.path).toBe(proj);
    expect(v.name).toBe("demo");
    expect(v.framework).toEqual({ id: "rn", label: "React Native" });
    expect(v.suggestedFramework).toBeNull(); // 已声明 → 建议字段置空（与 doctor 同形）
    expect(v.bundleIds).toEqual({
      android: "com.demo.app",
      harmony: "com.demo.app.hm",
      ios: "com.demo.app.ios",
    });
    expect(v.platforms).toEqual(["android", "harmony", "ios"]);
    expect(v.appliftAvailable).toBe(true);
    expect(v.error).toBeUndefined();
  });

  it("非 applift 目录：ok=false configFound=false error 指明原因", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-empty-"));
    try {
      const r = cli(["validate", dir, "--json"]);
      const v = JSON.parse(r.stdout); // stdout 仍是完整可解析 JSON（不因失败中断）
      expect(v.ok).toBe(false);
      expect(v.configFound).toBe(false);
      expect(v.error).toContain("applift.config.ts");
      expect(v.framework).toBeNull();
      expect(v.suggestedFramework).toBeNull(); // 空目录无可建议框架
      expect(v.appliftAvailable).toBe(false);
      expect(r.code).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
