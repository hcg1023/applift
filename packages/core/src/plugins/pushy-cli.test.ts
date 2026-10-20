/**
 * pushy CLI 封装：spawn 全局 pushy 命令（契约 = CLI 参数与输出，跨版本稳定）。
 * runner 可注入（测试与将来自建服务端换调用方式）。
 */
import { describe, expect, it } from "vitest";
import { createPushyCli, type CliRunner, type CliResult } from "./pushy-cli.js";

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
