/**
 * HostAdapter：宿主能力抽象（spec §3「通知走 HostAdapter」的接口占位）。
 * - webui 宿主的降级实现在 apps/ui/src/host.ts（前端自包含同构定义，沿用 api.ts 不跨包 import 的约定）
 * - Tauri 壳（二期）按同一接口注入 native notification / 目录选择器 / dock 角标
 */
export interface HostAdapter {
  /** 系统通知；宿主不支持或授权失败返回 false（调用方降级为应用内未读列表） */
  notify(title: string, body: string): Promise<boolean>;
  /** 原生目录选择器；返回 null = 宿主无此能力（UI 降级为手输路径输入框） */
  pickDirectory(): Promise<string | null>;
  /** 应用角标（n=0 清除）；宿主无此能力时 no-op */
  setBadge(n: number): Promise<void>;
}
