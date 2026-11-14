import { createTauriHost, tauriInvoke } from "./host.tauri.js";

/**
 * HostAdapter 宿主能力抽象（一期 webui 全降级实现；接口与 @applift/ui-server host.ts 同构——
 * 前端沿用 api.ts 不跨包 import 的约定，本地定义，Tauri 壳（二期）注入 native 实现替换）。
 */

export interface HostAdapter {
  /** 系统通知；授权不可用/拒绝返回 false（调用方降级为未读列表角标） */
  notify(title: string, body: string): Promise<boolean>;
  /** 原生目录选择器；webui 无此能力恒 null（UI 降级为手输路径输入框） */
  pickDirectory(): Promise<string | null>;
  /** 应用角标；webui no-op（Tauri 壳 = dock badge） */
  setBadge(n: number): Promise<void>;
}

/** Notification API 可注入面（测试/宿主差异） */
export interface NotifyDeps {
  /** Notification 构造器（默认 window.Notification） */
  Notification?: typeof Notification;
}

/**
 * webui 宿主降级实现：
 * - notify：Notification API 授权尝试（granted 直接发；default 发起请求且只在当次授予时发），
 *   denied/未实现/请求失败 → false，由未读列表兜底——「通知走未读列表」的降级语义。
 * - pickDirectory：恒 null（添加项目流已是手输路径形态）。
 * - setBadge：no-op。
 */
export function createWebuiHost(deps: NotifyDeps = {}): HostAdapter {
  const N = deps.Notification ?? globalThis.Notification;
  return {
    async notify(title: string, body: string): Promise<boolean> {
      if (typeof N === "undefined") return false;
      try {
        if (N.permission === "granted") {
          new N(title, { body });
          return true;
        }
        if (N.permission !== "default") return false; // denied
        // 首次：发起授权请求，当次即授予则直接送达（多数浏览器请求期间挂起，仍返回待授权语义）
        const granted = await N.requestPermission();
        if (granted === "granted") {
          new N(title, { body });
          return true;
        }
        return false;
      } catch {
        return false; // 宿主限制（如非安全上下文）按降级处理
      }
    },
    async pickDirectory(): Promise<string | null> {
      return null;
    },
    async setBadge(): Promise<void> {},
  };
}

/**
 * 宿主实现选择（Tauri 壳期）：`window.__TAURI_INTERNALS__` 存在 → Tauri 实现
 * （原生通知/目录对话框/角标），否则 webuiHost（目录选择由前端服务端目录浏览器承担）。
 */
export function pickHost(): HostAdapter {
  const invoke = tauriInvoke();
  return invoke === null ? webuiHost : createTauriHost(invoke);
}

/** 一期默认宿主实例（全降级语义；Tauri 壳注入 native 实现时替换此出口） */
export const webuiHost: HostAdapter = createWebuiHost();
