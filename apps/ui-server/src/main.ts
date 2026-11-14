/**
 * ui-server 独立进程入口（`applift ui` detach 启动）：
 *   node dist/main.mjs [--port <n>]
 * 就绪后打印一行 `applift-ui listening on 127.0.0.1:<port>`（诊断用；CLI 侧靠 /api/health 探测）。
 */
import { createServer } from "./index.js";

function parsePort(argv: string[]): number {
  const i = argv.indexOf("--port");
  const raw = i >= 0 ? argv[i + 1] : undefined;
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : 0;
}

const server = await createServer({ port: parsePort(process.argv.slice(2)) });
process.stdout.write(`applift-ui listening on 127.0.0.1:${server.port}\n`);

// detach 进程无父进程信号转发，自接 SIGTERM/SIGINT 保证优雅排空
process.on("SIGTERM", () => {
  void server.close().finally(() => process.exit(0));
});
process.on("SIGINT", () => {
  void server.close().finally(() => process.exit(0));
});
