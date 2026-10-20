/**
 * 不 require 其内部 lib（无公开契约）；cresc/自建服务的差异在服务端 URL，CLI 参数面一致。
 * 输出解析正则按 react-native-update-cli 2.22.9 实测文案编写（源码 i18n 硬编码：pushy 恒中文、cresc 恒英文，
 * 不随系统 locale）；CLI 升级改文案会显式抛错而非静默，升级后请跑 pushy-cli.test.ts 的真实输出回归。
 * cresc 二进制输出为英文，本封装不适用——换 cresc 应另写 provider 插件而非复用本封装。
 */
import { spawn } from "node:child_process";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CliRunner = (args: string[], opts?: { cwd?: string }) => Promise<CliResult>;

/** 默认 runner：spawn 全局 pushy，超时 10 分钟（bundle/upload 含网络大文件传输） */
export function spawnPushy(args: string[], opts?: { cwd?: string }): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("pushy", args, { cwd: opts?.cwd });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 10 * 60_000);
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e: Error) => {
      clearTimeout(timer);
      reject(new Error(`pushy 命令不可用（react-native-update-cli 未全局安装？）：${e.message}`));
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

export interface PushyCli {
  /** 构建热更包，返回 ppk 路径 */
  bundle(platform: string, cwd?: string): Promise<string>;
  /** 发布热更版本（publish），返回版本 id */
  publish(input: {
    appId: number;
    ppk: string;
    platform: string;
    name: string;
    description?: string;
    packageVersion: string;
    rollout?: number;
  }): Promise<{ versionId: number }>;
  /** 上传原生基线（基线版本号由服务端从包内读取） */
  uploadApp(appId: number, appFile: string): Promise<{ packageId: number; version: string }>;
  /** 版本重绑（promote 语义：测试通道版本重绑正式原生版本 + 灰度） */
  rebind(input: {
    appId: number;
    versionId: number;
    packageVersion: string;
    rollout?: number;
  }): Promise<void>;
  /** 版本列表（取号与状态展示用） */
  versions(appId: number): Promise<Array<{ id: number; hash: string; name: string }>>;
}

function fail(cmd: string, r: CliResult): never {
  throw new Error(`pushy ${cmd} 失败（exit ${r.code}）：${(r.stderr || r.stdout).trim()}`);
}

export function createPushyCli(runner: CliRunner = spawnPushy): PushyCli {
  return {
    async bundle(platform, cwd) {
      const r = await runner(["bundle", "--platform", platform, "--no-interactive"], { cwd });
      if (r.code !== 0) fail("bundle", r);
      const m = r.stdout.match(/已生成\s+(\S+\.ppk)/);
      if (!m) throw new Error(`pushy bundle 输出未含 ppk 路径：${r.stdout.trim()}`);
      return m[1]!;
    },

    async publish(input) {
      const args = [
        "publish",
        input.ppk,
        "--platform",
        input.platform,
        "--appId",
        String(input.appId),
        "--name",
        input.name,
      ];
      if (input.description) args.push("--description", input.description);
      if (input.packageVersion) args.push("--packageVersion", input.packageVersion);
      if (input.rollout !== undefined) args.push("--rollout", String(input.rollout));
      args.push("--no-interactive");
      const r = await runner(args);
      if (r.code !== 0) fail("publish", r);
      const m = (r.stdout + r.stderr).match(/已成功上传新热更包（id:\s*(\d+)）/);
      if (!m) throw new Error(`pushy publish 输出未含版本 id：${r.stdout.trim()}`);
      return { versionId: Number(m[1]) };
    },

    async uploadApp(appId, appFile) {
      const r = await runner(["uploadApp", appFile, "--appId", String(appId)]);
      if (r.code !== 0) fail("uploadApp", r);
      const m = (r.stdout + r.stderr).match(
        /已成功上传app原生包（id:\s*(\d+),\s*version:\s*([\d.]+)[^）]*）/,
      );
      if (!m)
        throw new Error(`pushy uploadApp 输出未含原生包信息：${(r.stdout + r.stderr).trim()}`);
      return { packageId: Number(m[1]), version: m[2]! };
    },
    async rebind(input) {
      const args = [
        "update",
        "--versionId",
        String(input.versionId),
        "--appId",
        String(input.appId),
        "--packageVersion",
        input.packageVersion,
      ];
      if (input.rollout !== undefined) args.push("--rollout", String(input.rollout));
      args.push("--no-interactive");
      const r = await runner(args);
      if (r.code !== 0) fail("update", r);
    },

    async versions(appId) {
      const r = await runner(["versions", "--appId", String(appId), "--no-interactive"]);
      if (r.code !== 0) fail("versions", r);
      const out: Array<{ id: number; hash: string; name: string }> = [];
      for (const m of r.stdout.matchAll(/^(\d+)\)\s+(\S+)\s+(\S+)/gm)) {
        out.push({ id: Number(m[1]), hash: m[2]!, name: m[3]! });
      }
      return out;
    },
  };
}
