import { useReducer } from "react";
import {
  BG_MAX,
  BG_MIN,
  FG_MAX,
  FG_MIN,
  clamp,
  loadSettings,
  saveSettings,
  toast,
  type Settings,
} from "../util.js";
import { usePageCtx } from "../state.js";

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

const THEME_SEGS: Array<{ key: Settings["theme"]; label: string }> = [
  { key: "light", label: "浅色" },
  { key: "auto", label: "自动" },
  { key: "dark", label: "深色" },
];

/**
 * 通用设置：轮询 stepper（护栏 clamp + PUT /api/settings 服务端热接入）/ 通知开关 / 外观。
 * fg/bg/开关以 localStorage 为单一事实源（渲染期读、点击即写 + force 重渲），主题由 app.tsx 经 props 同步。
 */
export default function SettingsPage({
  theme,
  onThemeChange,
}: {
  theme: Settings["theme"];
  onThemeChange: (t: Settings["theme"]) => void;
}) {
  const { client } = usePageCtx();
  const [, force] = useReducer((n: number) => n + 1, 0);
  const settings = loadSettings();

  const onStep = (spec: StepperSpec, dir: number) => {
    const current = spec.key === "fg" ? settings.fgMinutes : settings.bgMinutes;
    // 原型语义：后台档（min≥15）步长 15，前台档步长 1
    const step = spec.min >= 15 ? 15 : 1;
    const clamped = clamp(current + dir * step, spec.min, spec.max);
    if (clamped === current) {
      // 护栏提示：到界后再点同方向按钮
      toast(dir < 0 ? `已是最短间隔：${spec.min} 分钟` : `已是最长间隔：${spec.max} 分钟`);
      return;
    }
    if (spec.key === "fg") settings.fgMinutes = clamped;
    else settings.bgMinutes = clamped;
    saveSettings(settings);
    // 服务端热接入：失败仅 toast（本地档位仍生效为前端展示值，下次成功写入时对齐）
    void client
      .applyIntervals(settings.fgMinutes * 60_000, settings.bgMinutes * 60_000)
      .catch((err: unknown) =>
        toast(`服务端轮询间隔保存失败：${err instanceof Error ? err.message : String(err)}`),
      );
    force();
  };

  const onSwitch = (key: SwitchKey) => {
    const s = loadSettings();
    s[key] = !s[key];
    saveSettings(s);
    force();
  };

  return (
    <section className="page" id="page-settings">
      <h1>通用设置</h1>
      <p className="page-sub">调整后立即保存并对服务端轮询热生效（重启后保留）。</p>
      <div className="group-title">自动检查</div>
      <div className="group" id="checkGroup">
        {STEPPERS.map((s) => (
          <div className="set-row" key={s.key}>
            <div className="set-main">
              <div className="set-title">{s.title}</div>
              <div className="set-sub">
                {s.sub}（最短 {s.min} 分钟，最长 {s.max} 分钟）
              </div>
            </div>
            <div
              className="stepper"
              data-key={s.key}
              data-min={s.min}
              data-max={s.max}
              data-unit="分钟"
            >
              <button aria-label="减少" data-dir="-1" onClick={() => onStep(s, -1)}>
                −
              </button>
              <span className="val">
                {s.key === "fg" ? settings.fgMinutes : settings.bgMinutes} 分钟
              </span>
              <button aria-label="增加" data-dir="1" onClick={() => onStep(s, 1)}>
                ＋
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="group-title">通知</div>
      <div className="group" id="notifyGroup">
        {SWITCHES.map((sw) => (
          <div className="set-row" key={sw.key}>
            <div className="set-main">
              <div className="set-title">{sw.title}</div>
              <div className="set-sub">{sw.sub}</div>
            </div>
            <button
              className="switch"
              data-key={sw.key}
              aria-checked={settings[sw.key] ? "true" : "false"}
              role="switch"
              aria-label={sw.label}
              onClick={() => onSwitch(sw.key)}
            />
          </div>
        ))}
      </div>
      <div className="group-title">外观</div>
      <div className="group">
        <div className="set-row">
          <div className="set-main">
            <div className="set-title">外观</div>
          </div>
          <div className="seg-wrap" id="themeSeg">
            {THEME_SEGS.map((t) => (
              <button
                key={t.key}
                className={`seg${theme === t.key ? " active" : ""}`}
                data-th={t.key}
                onClick={() => onThemeChange(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
