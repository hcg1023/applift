import { createContext, useContext, useEffect, useReducer, type ReactNode } from "react";
import type { UiClient } from "./api.js";
import type { HostAdapter } from "./host.js";

/** 页面上下文：UiClient 单例 + 宿主能力 + 路由跳转（app.tsx 注入） */
export interface PageCtx {
  client: UiClient;
  navigate: (hash: string) => void;
  /** 宿主能力（webui 降级实现；Tauri 壳注入 native） */
  host: HostAdapter;
}

const PageCtxContext = createContext<PageCtx | null>(null);

export function PageCtxProvider({ value, children }: { value: PageCtx; children: ReactNode }) {
  return <PageCtxContext.Provider value={value}>{children}</PageCtxContext.Provider>;
}

export function usePageCtx(): PageCtx {
  const ctx = useContext(PageCtxContext);
  if (ctx === null) throw new Error("PageCtxProvider 缺失");
  return ctx;
}

/**
 * UiClient 订阅驱动重渲：emit（快照/feed/任务/连接态）即 tick。
 * UiState 是可变单例，渲染期直接读 client.state 最新值。
 */
export function useUiTick(): void {
  const { client } = usePageCtx();
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const off = client.subscribe(tick);
    return () => {
      off();
    };
  }, [client, tick]);
}
