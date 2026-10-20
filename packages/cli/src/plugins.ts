/**
 * 供 applift.config.ts 导入的插件入口（re-export core/plugins）。
 *
 * 消费方只依赖 @applift/cli（devDependency）即可 `import { rnFramework, rnUpdate }
 * from "@applift/cli/plugins"`——无需把传递依赖 @applift/core 提升当直接依赖用
 * （提升布局不是契约）。`@applift/core/plugins` 路径继续可用（裸工程/monorepo 内）。
 */
export * from "@applift/core/plugins";
