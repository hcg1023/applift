/**
 * HostAdapter 的 Tauri 壳实现（spec §3）：经 `window.__TAURI_INTERNALS__.invoke` 直调
 * 壳命令 / 插件命令，不引 @tauri-apps/api（壳 webview 加载 ui-server 静态产物，零 npm 依赖分叉）。
 * - notify：tauri-plugin-notification（先查授权，未授请求，拒绝/失败 → false 走未读列表降级）
 * - pickDirectory：tauri-plugin-dialog 原生目录选择（真对话框语义仅 Tauri；webui 走服务端目录浏览器 UI 层）
 * - setBadge：壳命令 set_badge（托盘未读数字——macOS/Linux 标题形态；Windows 占位 no-op）
 */
import type { HostAdapter } from "./host.js";

/** Tauri 注入的 invoke 面（window.__TAURI_INTERNALS__；测试注入同构替身） */
export type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

interface TauriInternals {
  invoke?: TauriInvoke;
}

/** 壳环境探测：`window.__TAURI_INTERNALS__` 存在（带 invoke）即视为 Tauri 壳 */
export function tauriInvoke(win?: { __TAURI_INTERNALS__?: TauriInternals }): TauriInvoke | null {
  const w =
    win ??
    (typeof window === "object" ? (window as { __TAURI_INTERNALS__?: TauriInternals }) : undefined);
  const invoke = w?.__TAURI_INTERNALS__?.invoke;
  return typeof invoke === "function" ? invoke : null;
}

/** 便捷布尔探测（Settings autostart 等非 HostAdapter 接线的壳能力用） */
export function isTauriEnv(): boolean {
  return tauriInvoke() !== null;
}

export function createTauriHost(invoke: TauriInvoke): HostAdapter {
  let visible = false; // 主窗 isVisible 乐观缓存（isWindowVisible 用）
  let visibleAt = 0;
  return {
    async notify(title, body): Promise<boolean> {
      try {
        const granted = await invoke("plugin:notification|is-permission-granted");
        if (granted !== true) {
          const req = await invoke("plugin:notification|request-permission");
          if (req !== "granted" && req !== true) return false;
        }
        await invoke("plugin:notification|notify", { options: { title, body } });
        return true;
      } catch {
        return false; // 插件缺席/授权拒绝 → 与 webui 同款降级（未读列表兜底）
      }
    },
    async pickDirectory(): Promise<string | null> {
      // dialog open（directory 限定）返回路径字符串；取消返回 null（多选形态防御性排除）
      const picked = await invoke("plugin:dialog|open", { options: { directory: true } });
      if (typeof picked === "string" && picked.trim() !== "") return picked;
      return null;
    },
    async setBadge(n): Promise<void> {
      await invoke("set_badge", { n });
    },
    isWindowVisible(): boolean {
      // invoke 异步但接口同步：乐观缓存（最近一次 invoke 结果 + 500ms 有效期）。
      // Tauri 壳 webview 隐藏后 visibilityState 恒 visible（文档值不可信），以宿主 isVisible 为真值；
      // 缓存过期返回 false（保守：宁可多通知，不漏通知——窗口隐藏时通知正是本接口的目的）。
      if (Date.now() - visibleAt >= 500) {
        void invoke("is_main_visible")
          .then((v) => {
            visible = v === true;
            visibleAt = Date.now();
          })
          .catch(() => {});
      }
      return visible;
    },
  };
}
