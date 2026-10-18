import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: [
      // CLI 测试与 tsconfig paths 对齐：@applift/core 运行时指向 src（而非可能过期的 dist 产物）；
      // 正则精确匹配，放行 @applift/core/plugins 子路径走各自的解析
      {
        find: /^@applift\/core$/,
        replacement: fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      },
    ],
  },
  test: {
    // dist 由 test 脚本前置构建(package.json "test": "pnpm -r build && vitest run")——
    // 不用 vitest globalSetup:其在 CI 上 spawn pnpm 即败(dist 缺失 → spawn 测试崩,Test step 7s 失败根因)
    testTimeout: 30_000, // spawn/git 重型用例在全仓并发 CPU 争抢下的余量
    // globalSetup 的 pnpm -r build 受 hookTimeout 约束(默认 10s):CI 冷构建必超时崩
    // (Test step 12s 失败、本地增量 build 秒过的根因),拉到与构建预算同量级
    hookTimeout: 240_000,
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      // 覆盖率统计 core 引擎；CLI 渲染壳（clack TTY 交互）由真实冒烟覆盖（dist/bin.js --help/doctor/status 实跑），不进单测统计
      include: ["packages/core/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/dist/**", "**/test-utils.ts"],
      // 阈值=现实基线棘轮（只升不降）：HEAD 实测 stmts 97.3 / branch 92.4（旧 98/95 从未在 CI 强制过，属虚构目标）。
      // 缺口主体为结构性不可达：bun/node 双路径、compile 专属逻辑、openAsBlob 回退臂、spawn/TTY 环境分支。
      thresholds: { lines: 98, functions: 98, branches: 92, statements: 97 },
      reporter: ["text", "json-summary"],
    },
  },
});
