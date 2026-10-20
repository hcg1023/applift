/**
 * pushy CLI 封装：spawn 全局 pushy 命令（契约 = CLI 参数与输出，跨版本稳定）。
 * runner 可注入（测试与将来自建服务端换调用方式）。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPushyCli, spawnPushy, type CliRunner, type CliResult } from "./pushy-cli.js";

function mkRunner(reply: (args: string[]) => CliResult): { runner: CliRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: CliRunner = async (args) => {
    calls.push(args);
    return reply(args);
  };
  return { runner, calls };
}

const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });

describe("pushy CLI 封装（参数拼装 + 输出解析）", () => {
  it("bundle：拼 --platform 与 --no-interactive，从输出解析 ppk 路径", async () => {
    const { runner, calls } = mkRunner(() =>
      ok("已生成 .pushy/output/harmony.1792376468222.ppk\n是否现在上传此热更包?(Y/N)"),
    );
    const cli = createPushyCli(runner);
    const ppk = await cli.bundle("harmony");
    expect(ppk).toBe(".pushy/output/harmony.1792376468222.ppk");
    expect(calls[0]).toContain("--platform");
    expect(calls[0]).toContain("harmony");
  });

  it("publish：appId/name/description/packageVersion/rollout 拼装，解析热更版本 id", async () => {
    const { runner, calls } = mkRunner(() =>
      ok("已成功上传新热更包（id: 303339）\n已将热更包 303339 绑定到原生版本 4.0.0 (id: 100263)"),
    );
    const cli = createPushyCli(runner);
    const r = await cli.publish({
      appId: 34166,
      ppk: ".pushy/output/x.ppk",
      platform: "harmony",
      name: "4.0.0-patch.5",
      description: "修复",
      packageVersion: "4.0.0",
      rollout: 10,
    });
    expect(r.versionId).toBe(303339);
    const args = calls[0]!.join(" ");
    expect(args).toContain("--appId 34166");
    expect(args).toContain("--packageVersion 4.0.0");
    expect(args).toContain("--rollout 10");
    expect(args).toContain("--no-interactive");
  });

  it("publish：非零退出码时抛含 stderr 的错误", async () => {
    const { runner } = mkRunner(() => ({ code: 1, stdout: "", stderr: "原生包 4.0.0 已注册" }));
    const cli = createPushyCli(runner);
    await expect(
      cli.publish({
        appId: 1,
        ppk: "x.ppk",
        platform: "harmony",
        name: "n",
        packageVersion: "1.0.0",
      }),
    ).rejects.toThrow(/原生包 4.0.0/);
  });

  it("publish/rebind：可选参数缺省不拼进命令行（最小参数面）", async () => {
    const { runner, calls } = mkRunner(() => ok("已成功上传新热更包（id: 9）"));
    const cli = createPushyCli(runner);
    await cli.publish({
      appId: 1,
      ppk: "a.ppk",
      platform: "harmony",
      name: "n",
      packageVersion: "4.0.0",
    });
    const pub = calls[0]!.join(" ");
    expect(pub).not.toContain("--description");
    expect(pub).not.toContain("--rollout");
    await cli.rebind({ appId: 1, versionId: 9, packageVersion: "4.0.0" });
    expect(calls[1]!.join(" ")).not.toContain("--rollout");
  });

  it("bundle：输出不含 ppk 路径 → 显式抛错（CLI 升级改文案时防线）", async () => {
    const { runner } = mkRunner(() => ok("Bundle complete."));
    const cli = createPushyCli(runner);
    await expect(cli.bundle("harmony")).rejects.toThrow(/未含 ppk 路径/);
  });

  it("publish：exit 0 但输出不含版本 id → 抛错（文案漂移防线）", async () => {
    const { runner } = mkRunner(() => ok("上传成功"));
    const cli = createPushyCli(runner);
    await expect(
      cli.publish({
        appId: 1,
        ppk: "a.ppk",
        platform: "harmony",
        name: "n",
        packageVersion: "1.0.0",
      }),
    ).rejects.toThrow(/未含版本 id/);
  });

  it("rebind：非零退出码 → 抛含命令名的错误", async () => {
    const { runner } = mkRunner(() => ({ code: 1, stdout: "", stderr: "版本不存在" }));
    const cli = createPushyCli(runner);
    await expect(cli.rebind({ appId: 1, versionId: 9, packageVersion: "4.0.0" })).rejects.toThrow(
      /pushy update 失败[\s\S]*版本不存在/,
    );
  });

  it("versions：非零退出码 → 抛错", async () => {
    const { runner } = mkRunner(() => ({ code: 1, stdout: "", stderr: "尚未登录" }));
    const cli = createPushyCli(runner);
    await expect(cli.versions(1)).rejects.toThrow(/尚未登录/);
  });

  it("uploadApp：解析原生包 id 与版本；输出不含预期串时抛错", async () => {
    const fresh = mkRunner(() =>
      ok("已成功上传app原生包（id: 100263, version: 4.0.0, buildTime: 1792376104143）"),
    );
    const cli1 = createPushyCli(fresh.runner);
    const r1 = await cli1.uploadApp(34166, "harmony/build/outputs/default/x.app");
    expect(r1).toEqual({ packageId: 100263, version: "4.0.0" });

    const bad = mkRunner(() => ok("上传成功"));
    const cli2 = createPushyCli(bad.runner);
    await expect(cli2.uploadApp(34166, "x.app")).rejects.toThrow(/未含原生包信息/);
  });

  it("rebind：update --versionId --packageVersion 拼装（promote 语义：重绑正式版本+灰度）", async () => {
    const { runner, calls } = mkRunner(() => ok("操作完成，共已绑定 1 个原生版本"));
    const cli = createPushyCli(runner);
    await cli.rebind({ appId: 34166, versionId: 303339, packageVersion: "4.0.0", rollout: 10 });
    const args = calls[0]!.join(" ");
    expect(args).toContain("update");
    expect(args).toContain("--versionId 303339");
    expect(args).toContain("--packageVersion 4.0.0");
    expect(args).toContain("--rollout 10");
  });

  it("versions：解析版本表（id、hash、name），取号用", async () => {
    const { runner } = mkRunner(() =>
      ok("303339) qm5Xb8bG 4.0.0-patch.4 no package\n303353) Qn19JhbA 4.0.0-patch.5 no package"),
    );
    const cli = createPushyCli(runner);
    const vs = await cli.versions(34166);
    expect(vs).toEqual([
      { id: 303339, hash: "qm5Xb8bG", name: "4.0.0-patch.4" },
      { id: 303353, hash: "Qn19JhbA", name: "4.0.0-patch.5" },
    ]);
  });
});

describe("spawnPushy 默认 runner（PATH 注入桩 pushy：CliResult 组装契约，CI 无真 pushy 也可移植）", () => {
  function fakePushyDir(script: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "applift-fakepushy-"));
    const bin = path.join(dir, "pushy");
    fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`);
    fs.chmodSync(bin, 0o755);
    return dir;
  }
  const withPath = <T>(dir: string, fn: () => Promise<T>): Promise<T> => {
    const old = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${old ?? ""}`;
    return fn().finally(() => {
      process.env.PATH = old;
    });
  };

  it("成功：stdout/stderr 分别汇聚，exit 0 透传", async () => {
    const dir = fakePushyDir('echo "out-line1"; echo "err-line1" >&2; exit 0');
    try {
      const r = await withPath(dir, () => spawnPushy(["--no-interactive"], { cwd: "/tmp" }));
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("out-line1");
      expect(r.stderr).toContain("err-line1");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("非零退出码透传（close 而非 error）", async () => {
    const dir = fakePushyDir("exit 3");
    try {
      const r = await withPath(dir, () => spawnPushy([]));
      expect(r.code).toBe(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("命令不存在 → reject 并给出安装提示（ENOENT 走 error 而非 close）", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "applift-nopath-"));
    const old = process.env.PATH;
    process.env.PATH = empty; // 完全替换：前置拼接仍会从原 PATH 找到真 pushy
    try {
      await expect(spawnPushy([])).rejects.toThrow(/pushy 命令不可用/);
    } finally {
      process.env.PATH = old;
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it("cwd 透传（脚本按 cwd 输出 pwd）", async () => {
    const dir = fakePushyDir("pwd");
    try {
      const r = await withPath(dir, () => spawnPushy([], { cwd: dir }));
      // macOS /tmp ↔ /private/tmp 符号链接：双向 realpath 同一化后比对
      expect(fs.realpathSync(r.stdout.trim())).toBe(fs.realpathSync(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
