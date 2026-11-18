import { afterAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { AppliftRunner } from "./runner.js";

const tmpDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function newTmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `ui-runner-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}
/** 轮询让出事件循环的间隔——真实子进程的收尸/上报无法用假时钟驱动，只能真轮询等真信号 */
function pause(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** 真 CLI dist 是否已构建（裸仓/未 build 时跳过冒烟） */
function existsCliDist(): boolean {
  return existsSync(fileURLToPath(new URL("../../../packages/cli/dist/bin.mjs", import.meta.url)));
}

/** 桩 bin 命令串：node + 脚本路径（bin 按空白切分，tmpdir 路径无空格） */
function nodeBin(script: string): string {
  return `${process.execPath} ${script}`;
}

/** 轮询等进程真正消亡（kill 后的收尸余量）；超时抛错让用例失败 */
async function waitProcessGone(pid: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
      throw err; // EPERM 等异常状态如实暴露
    }
    if (Date.now() > deadline) throw new Error(`process ${pid} still alive after ${timeoutMs}ms`);
    await pause(50);
  }
}

// 桩：回显 argv 与 cwd（单行 NDJSON）
const ARGV_CWD =
  "console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));";

// 桩：stderr 输出 + 非零退出码
const FAIL = 'process.stderr.write("boom\\n");\nprocess.exit(3);';

// 桩：起一个孙进程一起长眠；先上报孙进程 pid，用于验证进程组 kill 能带走整棵子树
const SLEEP_TREE = `import { spawn } from "node:child_process";
const grand = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
console.log(JSON.stringify({ grandchild: grand.pid }));
setTimeout(() => {}, 60000);
`;

// 桩：逐行读 stdin，每行回显 JSON；收满 2 行后收尾（destroy stdin 让事件循环自然排空，保证 stdout 冲刷）
const NDJSON_STDIN = `let seen = 0;
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx = buf.indexOf("\\n");
  while (idx >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    idx = buf.indexOf("\\n");
    if (!line) continue;
    seen += 1;
    console.log(JSON.stringify({ echo: line }));
    if (seen >= 2) {
      console.log(JSON.stringify({ done: true }));
      process.stdin.destroy();
    }
  }
});
`;

// 桩：输出一行非法 JSON（走 onError 解析失败路径）
const BAD_NDJSON = 'console.log("not-json{");';

describe("AppliftRunner.run", () => {
  it("透传参数与 cwd；stdout/退出码回传", async () => {
    const dir = await newTmpDir("argv");
    const script = join(dir, "argv-cwd.mjs");
    await writeFile(script, ARGV_CWD, "utf8");
    const runner = new AppliftRunner({ bin: nodeBin(script), cwd: dir });
    const r = await runner.run(["--version"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { argv: string[]; cwd: string };
    expect(parsed.argv).toEqual(["--version"]);
    expect(parsed.cwd).toBe(await realpath(dir)); // macOS 下 /var 解析为 /private/var，子进程 cwd 为真身
  });

  it("bin 数组形态：含空格路径原样传递不被切分", async () => {
    const base = await newTmpDir("spaced");
    const dir = join(base, "applift ui test dir");
    await mkdir(dir);
    const script = join(dir, "argv-cwd.mjs");
    await writeFile(script, ARGV_CWD, "utf8");
    const r = await new AppliftRunner({ bin: [process.execPath, script] }).run(["--version"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { argv: string[] };
    expect(parsed.argv).toEqual(["--version"]);
  });

  it("非零退出码与 stderr 原样回传", async () => {
    const dir = await newTmpDir("fail");
    const script = join(dir, "fail.mjs");
    await writeFile(script, FAIL, "utf8");
    const r = await new AppliftRunner({ bin: nodeBin(script) }).run([]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("boom");
  });

  it("超时：杀进程组返回非零 + 超时说明，孙进程一并消亡", async () => {
    const dir = await newTmpDir("sleep-run");
    const script = join(dir, "sleep-tree.mjs");
    await writeFile(script, SLEEP_TREE, "utf8");
    const runner = new AppliftRunner({ bin: nodeBin(script) });
    const started = Date.now();
    // 全仓并发跑时桩进程冷启动可能远慢于单测环境：预算 2s 让“孙进程 pid 上报”稳定先于超时
    const r = await runner.run([], { timeoutMs: 2000 });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("超时");
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(r.stdout.trim(), "桩在超时前未完成启动上报（冷启动被负载拖垮）").toBeTruthy();
    const { grandchild } = JSON.parse(r.stdout.trim()) as { grandchild: number };
    await waitProcessGone(grandchild);
  });

  it("命令不存在：不 reject，返回非零 + 启动失败信息", async () => {
    const r = await new AppliftRunner({ bin: "applift-missing-bin-xyz" }).run([]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("无法启动");
  });

  it("输出累积上限：stdout/stderr 各 10MiB 截断并带标记", async () => {
    const dir = await newTmpDir("huge");
    const script = join(dir, "huge.mjs");
    await writeFile(
      script,
      "process.stdout.write(Buffer.alloc(11 * 1024 * 1024, 0x61));" +
        "process.stderr.write(Buffer.alloc(11 * 1024 * 1024, 0x62));\n",
      "utf8",
    );
    const r = await new AppliftRunner({ bin: nodeBin(script) }).run([]);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeLessThanOrEqual(10 * 1024 * 1024 + 200);
    expect(r.stdout).toContain("[applift-runner] 输出超过");
    expect(r.stderr.length).toBeLessThanOrEqual(10 * 1024 * 1024 + 200);
    expect(r.stderr).toContain("[applift-runner] 输出超过");
  }, 30_000);

  it("kill 升级：SIGTERM 被吞时 5s 后 SIGKILL 组杀带走孙进程", async () => {
    const dir = await newTmpDir("sigkill");
    const script = join(dir, "sigterm-tree.mjs");
    await writeFile(
      script,
      [
        'import { spawn } from "node:child_process";',
        'process.on("SIGTERM", () => {});',
        'const gc = spawn(process.execPath, ["-e", "process.on(\'SIGTERM\', () => {}); setInterval(() => {}, 1000);"], { stdio: "inherit" });',
        "console.log(JSON.stringify({ grandchild: gc.pid }));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );
    const runner = new AppliftRunner({ bin: nodeBin(script) });
    const r = await runner.run([], { timeoutMs: 2000 });
    expect(r.code).not.toBe(0);
    expect(r.stdout.trim(), "桩在超时前未完成启动上报（冷启动被负载拖垮）").toBeTruthy();
    const { grandchild } = JSON.parse(r.stdout.trim()) as { grandchild: number };
    // SIGTERM 被吞 → 等 SIGKILL 升级（预算 10s > 5s 升级窗口）
    await waitProcessGone(grandchild, 10_000);
  }, 30_000);

  it("T5-壳场景：宿主 PATH 无 node 时 shim（shebang env node）仍可执行——node 目录前置子进程 PATH", async () => {
    const dir = await newTmpDir("shim-path");
    const shim = join(dir, "applift"); // 模拟工程/全局命中的 npm bin shim（js + shebang）
    await writeFile(
      shim,
      "#!/usr/bin/env node\nconsole.log('shim-ok:' + process.version);\n",
      "utf8",
    );
    await chmod(shim, 0o755);
    const savedPath = process.env.PATH;
    // GUI 宿主（launchd/Tauri 壳）形态：PATH 只有系统目录——shebang 的 env node 原本会 127
    process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
    try {
      const r = await new AppliftRunner({ bin: [shim] }).run(["--version"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("shim-ok:");
    } finally {
      process.env.PATH = savedPath;
    }
  }, 20_000);
});

describe("AppliftRunner.spawnStream", () => {
  it("NDJSON 逐行 onLine + stdinWrite 回显；done 退出码", async () => {
    const dir = await newTmpDir("stdin");
    const script = join(dir, "ndjson-stdin.mjs");
    await writeFile(script, NDJSON_STDIN, "utf8");
    const lines: object[] = [];
    const errors: string[] = [];
    const task = new AppliftRunner({ bin: nodeBin(script) }).spawnStream([], {
      onLine: (e) => lines.push(e),
      onError: (s) => errors.push(s),
    });
    expect(task.pid).toBeGreaterThan(0);
    task.stdinWrite("hello-1");
    task.stdinWrite("hello-2");
    const { code } = await task.done;
    expect(code).toBe(0);
    expect(lines).toEqual([{ echo: "hello-1" }, { echo: "hello-2" }, { done: true }]);
    expect(errors).toEqual([]);
  });

  it("非 JSON 行走 onError", async () => {
    const dir = await newTmpDir("bad");
    const script = join(dir, "bad-ndjson.mjs");
    await writeFile(script, BAD_NDJSON, "utf8");
    const lines: object[] = [];
    const errors: string[] = [];
    const task = new AppliftRunner({ bin: nodeBin(script) }).spawnStream([], {
      onLine: (e) => lines.push(e),
      onError: (s) => errors.push(s),
    });
    const { code } = await task.done;
    expect(code).toBe(0);
    expect(lines).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("无法解析");
  });

  it("kill()：进程组终止主进程与孙进程，done 返回非零", async () => {
    const dir = await newTmpDir("sleep-stream");
    const script = join(dir, "sleep-tree.mjs");
    await writeFile(script, SLEEP_TREE, "utf8");
    const lines: object[] = [];
    const task = new AppliftRunner({ bin: nodeBin(script) }).spawnStream([], {
      onLine: (e) => lines.push(e),
      onError: () => {},
    });
    // 等桩上报孙进程 pid
    const deadline = Date.now() + 5000;
    while (lines.length === 0) {
      if (Date.now() > deadline) throw new Error("stub 未上报 grandchild pid");
      await pause(50);
    }
    const { grandchild } = lines[0] as { grandchild: number };
    task.kill();
    const { code } = await task.done;
    expect(code).not.toBe(0);
    await waitProcessGone(task.pid);
    await waitProcessGone(grandchild);
  });

  it("命令不存在：onError + done 非零", async () => {
    const errors: string[] = [];
    const task = new AppliftRunner({ bin: "applift-missing-bin-xyz" }).spawnStream([], {
      onLine: () => {},
      onError: (s) => errors.push(s),
    });
    const { code } = await task.done;
    expect(code).not.toBe(0);
    expect(errors.some((e) => e.includes("无法启动"))).toBe(true);
  });
});

describe.skipIf(!existsCliDist())("真 CLI 冒烟（dist 未构建则跳过）", () => {
  it("run --version 返回 code 0 且 stdout 非空", async () => {
    const binMjs = fileURLToPath(new URL("../../../packages/cli/dist/bin.mjs", import.meta.url));
    const r = await new AppliftRunner({ bin: nodeBin(binMjs) }).run(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  });
});
