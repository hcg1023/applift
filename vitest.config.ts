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
    globalSetup: ["./packages/cli/src/vitest.global-setup.ts"],
    testTimeout: 30_000, // spawn/git 重型用例在全仓并发 CPU 争抢下的余量
    include: ["packages/*/src/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      // 覆盖率统计 core 引擎；CLI 渲染壳（clack TTY 交互）由真实冒烟覆盖（dist/bin.js --help/doctor/status 实跑），不进单测统计
      include: ["packages/core/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/dist/**", "**/test-utils.ts"],
      // branches 95：跨运行时分支（B″ 的 bun/node 双路径、compile 专属逻辑）在 node vitest 下结构性不可达
      thresholds: { lines: 98, functions: 98, branches: 95, statements: 98 },
      reporter: ["text", "json-summary"],
    },
  },
});
