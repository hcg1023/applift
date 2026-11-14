export interface Settings {
  checkOnOpen: boolean;
  fgMinutes: number;
  bgMinutes: number;
  notifyState: boolean;
  notifyRelease: boolean;
  theme: "light" | "auto" | "dark";
}

/** 与 aggregator 护栏同源：前台最短 1min，后台最短 15min（防误配打爆渠道 API） */
export const FG_MIN = 1;
export const FG_MAX = 30;
export const BG_MIN = 15;
export const BG_MAX = 180;

const SETTINGS_KEY = "applift-ui:settings";

export const defaultSettings: Settings = {
  checkOnOpen: true,
  fgMinutes: 5,
  bgMinutes: 60,
  notifyState: true,
  notifyRelease: true,
  theme: "auto",
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw === null) return { ...defaultSettings };
    return { ...defaultSettings, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...defaultSettings };
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export function applyTheme(theme: Settings["theme"]): void {
  const dark =
    theme === "dark" ||
    (theme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** 模板字符串插值统一转义 */
export function esc(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** 时间线相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 HH:MM / M月D日 */
export function relTime(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = new Date(ts);
  const today = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getFullYear() === today.getFullYear() && d.getDate() === today.getDate() - 1) {
    return `昨天 ${hm}`;
  }
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 状态新鲜度标注：ProjectSnapshot.fetchedAt → 「x 分钟前更新」；>30min 标 stale（橙色 warn） */
export function freshness(iso: string, now = Date.now()): { text: string; warn: boolean } {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return { text: "— 更新", warn: true };
  return { text: `${relTime(ts, now)}更新`, warn: now - ts > 30 * 60_000 };
}

let toastTimer: number | undefined;

export function toast(msg: string): void {
  const el = document.getElementById("toast");
  if (el === null) return;
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("show"), 2200);
}
