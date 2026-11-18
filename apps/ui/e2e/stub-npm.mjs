#!/usr/bin/env node
/**
 * e2e 桩 npm（server.mjs 经 createServer npmBin 注入，不走 PATH——
 * 规避 childEnv 把 node 目录前置导致真 npm 抢跑）：
 * - view → 空输出退出 0（availability latest=null，离线降级路径）
 * - install -g @applift/cli → stderr 一行安装日志 + 写时间戳 marker，退出 0
 *   （validate 桩以「marker 且 15s 内」判 ok：全新/复用的旧 server 上首验必失败）
 */
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
if (argv[0] === "view") process.exit(0);
process.stderr.write("added 1 package in 2s\n");
// 稍作停留：让前端 running 态（spinner + 日志滚动）可被 e2e 断言到再收口
await new Promise((r) => setTimeout(r, 800));
writeFileSync(process.env.APPLIFT_E2E_INSTALL_MARKER, String(Date.now()));
process.exit(0);
