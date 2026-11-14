import {
  BG_MAX,
  BG_MIN,
  FG_MAX,
  FG_MIN,
  applyTheme,
  clamp,
  loadSettings,
  saveSettings,
  toast,
  type Settings,
} from "../util.js";
import type { PageCtx } from "./overview.js";

interface StepperSpec {
  key: "fg" | "bg";
  title: string;
  sub: string;
  min: number;
  max: number;
}

const STEPPERS: StepperSpec[] = [
  {
    key: "fg",
    title: "使用期间",
    sub: "页面在前台时定时刷新",
    min: FG_MIN,
    max: FG_MAX,
  },
  {
    key: "bg",
    title: "后台检查",
    sub: "应用未打开时仍定时核对一次，applift ui 需保持运行",
    min: BG_MIN,
    max: BG_MAX,
  },
];

type SwitchKey = "checkOnOpen" | "notifyState" | "notifyRelease";

const SWITCHES: Array<{ key: SwitchKey; title: string; sub: string; label: string }> = [
  {
    key: "checkOnOpen",
    title: "页面打开时",
    sub: "立即查询一次所有渠道",
    label: "页面打开时立即查询",
  },
  {
    key: "notifyState",
    title: "审核状态变化",
    sub: "通过、上架、被拒时提醒",
    label: "审核状态变化通知",
  },
  {
    key: "notifyRelease",
    title: "发版完成提醒",
    sub: "无论成败，发版流程结束时提醒一次",
    label: "发版完成提醒",
  },
];

/** 通用设置：轮询 stepper（护栏 clamp）/ 通知开关 / 外观；localStorage 持久化 */
export function renderSettings(_ctx: PageCtx): HTMLElement {
  const settings = loadSettings();
  const el = document.createElement("section");
  el.className = "page";
  el.id = "page-settings";

  const stepperHtml = STEPPERS.map(
    (s) => `
      <div class="set-row">
        <div class="set-main">
          <div class="set-title">${s.title}</div>
          <div class="set-sub">${s.sub}（最短 ${s.min} 分钟，最长 ${s.max} 分钟）</div>
        </div>
        <div class="stepper" data-key="${s.key}" data-min="${s.min}" data-max="${s.max}" data-unit="分钟">
          <button aria-label="减少" data-dir="-1">−</button><span class="val">${s.key === "fg" ? settings.fgMinutes : settings.bgMinutes} 分钟</span><button aria-label="增加" data-dir="1">＋</button>
        </div>
      </div>`,
  ).join("");

  const switchHtml = SWITCHES.map(
    (sw) => `
      <div class="set-row">
        <div class="set-main">
          <div class="set-title">${sw.title}</div>
          <div class="set-sub">${sw.sub}</div>
        </div>
        <button class="switch" data-key="${sw.key}" aria-checked="${settings[sw.key]}" role="switch" aria-label="${sw.label}"></button>
      </div>`,
  ).join("");

  const themeSeg = (t: Settings["theme"], label: string): string =>
    `<button class="seg${settings.theme === t ? " active" : ""}" data-th="${t}">${label}</button>`;

  el.innerHTML = `
    <h1>通用设置</h1>
    <p class="page-sub">调整后立即保存，对所有项目生效（当前会话本地生效，服务端热接入为后续任务）。</p>
    <div class="group-title">自动检查</div>
    <div class="group" id="checkGroup">${stepperHtml}</div>
    <div class="group-title">通知</div>
    <div class="group" id="notifyGroup">${switchHtml}</div>
    <div class="group-title">外观</div>
    <div class="group">
      <div class="set-row">
        <div class="set-main"><div class="set-title">外观</div></div>
        <div class="seg-wrap" id="themeSeg">${themeSeg("light", "浅色")}${themeSeg("auto", "自动")}${themeSeg("dark", "深色")}</div>
      </div>
    </div>`;

  el.querySelector("#checkGroup")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button[data-dir]");
    if (btn === null) return;
    const wrap = btn.closest(".stepper") as HTMLElement;
    const key = wrap.dataset.key as "fg" | "bg";
    const min = Number(wrap.dataset.min);
    const max = Number(wrap.dataset.max);
    const dir = Number((btn as HTMLElement).dataset.dir);
    const current = key === "fg" ? settings.fgMinutes : settings.bgMinutes;
    // 原型语义：后台档（min≥15）步长 15，前台档步长 1
    const step = min >= 15 ? 15 : 1;
    const clamped = clamp(current + dir * step, min, max);
    if (clamped === current) {
      // 护栏提示：到界后再点同方向按钮
      toast(dir < 0 ? `已是最短间隔：${min} 分钟` : `已是最长间隔：${max} 分钟`);
      return;
    }
    if (key === "fg") settings.fgMinutes = clamped;
    else settings.bgMinutes = clamped;
    saveSettings(settings);
    wrap.querySelector(".val")!.textContent = `${clamped} 分钟`;
  });

  el.querySelector("#notifyGroup")?.addEventListener("click", (e) => {
    const sw = (e.target as HTMLElement).closest(".switch") as HTMLElement | null;
    if (sw === null) return;
    const key = sw.dataset.key as SwitchKey;
    const next = sw.getAttribute("aria-checked") !== "true";
    settings[key] = next;
    saveSettings(settings);
    sw.setAttribute("aria-checked", String(next));
  });

  el.querySelector("#themeSeg")?.addEventListener("click", (e) => {
    const seg = (e.target as HTMLElement).closest(".seg[data-th]") as HTMLElement | null;
    if (seg === null) return;
    settings.theme = seg.dataset.th as Settings["theme"];
    saveSettings(settings);
    applyTheme(settings.theme);
    el.querySelectorAll(".seg[data-th]").forEach((s) => {
      s.classList.toggle("active", (s as HTMLElement).dataset.th === settings.theme);
    });
  });

  return el;
}
