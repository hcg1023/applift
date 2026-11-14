import type { JudgementReport, TaskEvent, UiClient } from "../api.js";
import { esc, loadSettings, toast } from "../util.js";
import type { PageCtx } from "./overview.js";

/** 平台常量（与服务端 BETA_PLATFORMS 同源） */
const PLATFORMS: Array<{ key: string; label: string }> = [
  { key: "android", label: "Android" },
  { key: "ios", label: "iOS" },
  { key: "harmony", label: "鸿蒙" },
];

const platLabel = (key: string): string => PLATFORMS.find((p) => p.key === key)?.label ?? key;

const WIZARD_KEY = "applift-ui:release-wizard";

/** 向导表单态（localStorage 记住上次选择） */
interface WizardForm {
  projectId: string;
  platforms: string[];
}

function loadForm(): WizardForm {
  try {
    const raw = localStorage.getItem(WIZARD_KEY);
    if (raw === null) return { projectId: "", platforms: ["android"] };
    const parsed = JSON.parse(raw) as Partial<WizardForm>;
    const platforms = Array.isArray(parsed.platforms)
      ? parsed.platforms.filter((p): p is string => typeof p === "string" && p !== "")
      : [];
    return {
      projectId: typeof parsed.projectId === "string" ? parsed.projectId : "",
      platforms: platforms.length > 0 ? platforms : ["android"],
    };
  } catch {
    return { projectId: "", platforms: ["android"] };
  }
}

function saveForm(f: WizardForm): void {
  try {
    localStorage.setItem(WIZARD_KEY, JSON.stringify(f));
  } catch {
    // 隐私模式等存储拒绝：记住选择是增强，不阻断
  }
}

interface ConfirmRequiredEvent {
  type: "confirm_required";
  id: string;
  question: string;
  choices: Array<{ value: string; label: string; recommended?: boolean }>;
}

/** 平台判定卡：dry-run 报告 → 步骤2 展示/改选 */
interface PlatformCard {
  platform: string;
  /** provider null / recommendation null → 未接热更，唯一方式整包，跳过选择 */
  skipChoice: boolean;
  recommendation: "ota" | "native" | "uncertain" | null;
  confidence: string | null;
  evidence: Array<{ path: string; rule: string; note?: string }>;
  /** 用户改选（null = 用推荐） */
  chosen: "ota" | "native" | null;
}

/** 执行期单任务聚合（progress/log 事件映射） */
interface ExecState {
  taskId: string;
  platform: string;
  stage: string;
  pct: number | undefined;
  progressMsg: string | undefined;
  logs: Array<{ level: string; msg: string }>;
  confirm: ConfirmRequiredEvent | null;
  confirmAnswered: boolean;
  /** 用户实际点击的 choice value（已确认态回显用它，而非 recommended） */
  confirmValue: string | undefined;
  result: { ok: boolean; summary: Record<string, unknown>; error?: string } | null;
}

interface TaskOutcome {
  ok: boolean;
  summary: Record<string, unknown>;
  error?: string;
}

type Phase = 1 | 2 | 3 | 4;

interface ReleaseState {
  phase: Phase;
  form: WizardForm;
  /** 步骤1 逐平台 dry-run（platform → report / error） */
  previews: Map<string, { report?: JudgementReport; error?: string }>;
  previewing: boolean;
  cards: PlatformCard[];
  /** 步骤3 顺序发队列（一期单平台顺序执行） */
  queue: string[];
  exec: ExecState | null;
  results: Map<string, TaskOutcome>;
  cancelled: boolean;
}

function freshState(): ReleaseState {
  return {
    phase: 1,
    form: loadForm(),
    previews: new Map(),
    previewing: false,
    cards: [],
    queue: [],
    exec: null,
    results: new Map(),
    cancelled: false,
  };
}

/** 模块级页面状态：renderRelease 被全页重渲反复调用，状态必须外提 */
let state = freshState();

/** 路由离开时复位（main.ts 调用）；执行中离开向导视作放弃订阅（任务照跑，事件丢弃） */
export function resetReleasePageState(): void {
  state = freshState();
  detachTaskTap();
}

/** 任务事件直通订阅句柄（模块级，跨重渲只装一次） */
let detachTap: (() => void) | undefined;

function ensureTaskTap(client: UiClient): void {
  if (detachTap !== undefined) return;
  const offTask = client.onTask((taskId, ev) => {
    const exec = state.exec;
    if (exec === null || exec.taskId !== taskId) return;
    applyTaskEvent(exec, ev);
    rerenderAll();
  });
  const offEnd = client.onTaskEnd((taskId, code) => {
    const exec = state.exec;
    if (exec === null || exec.taskId !== taskId) return;
    // result 事件缺位（崩溃/被杀）时以退出码收口
    if (exec.result === null) {
      exec.result = {
        ok: code === 0,
        summary: {},
        error: code === 0 ? undefined : `任务异常退出（code=${code}）`,
      };
    }
    settle(taskId, exec.result);
    rerenderAll();
  });
  detachTap = () => {
    offTask();
    offEnd();
    detachTap = undefined;
  };
}

function detachTaskTap(): void {
  detachTap?.();
  // 挂起的 runQueue 等待者收口（否则离开向导后 promise 永悬）
  for (const [id, resolve] of taskWaiters) {
    taskWaiters.delete(id);
    resolve({ ok: false, summary: {}, error: "已离开向导" });
  }
}

/** 任务终态 waiters（runQueue 挂起处 → task.end 收口） */
const taskWaiters = new Map<string, (r: TaskOutcome) => void>();

function settle(taskId: string, r: TaskOutcome): void {
  const w = taskWaiters.get(taskId);
  if (w === undefined) return;
  taskWaiters.delete(taskId);
  w(r);
}

function waitTaskEnd(client: UiClient, taskId: string): Promise<TaskOutcome> {
  // I-4 竞态：task.end 可能早于 REST 回填 taskId 到达——onTaskEnd 当时因 taskId 未回填丢弃，靠 UiClient 缓存收口
  const cached = client.taskEndCode(taskId);
  if (cached !== undefined) {
    return Promise.resolve(
      cached === 0
        ? { ok: true, summary: {} }
        : { ok: false, summary: {}, error: `任务异常退出（code=${cached}）` },
    );
  }
  const { promise, resolve } = Promise.withResolvers<TaskOutcome>();
  taskWaiters.set(taskId, resolve);
  return promise;
}

/** ---------- 事件 → ExecState ---------- */
function applyTaskEvent(exec: ExecState, ev: TaskEvent): void {
  switch (ev.type) {
    case "stage":
      exec.stage = typeof ev.stage === "string" ? ev.stage : "";
      break;
    case "judgement":
      exec.logs.push({
        level: "info",
        msg: `[判定] ${recLabel(
          typeof ev.recommendation === "string" ? ev.recommendation : null,
        )}（置信度 ${typeof ev.confidence === "string" ? ev.confidence : "—"}）`,
      });
      break;
    case "confirm_required":
      if (
        typeof ev.id === "string" &&
        typeof ev.question === "string" &&
        Array.isArray(ev.choices)
      ) {
        exec.confirm = {
          type: "confirm_required",
          id: ev.id,
          question: ev.question,
          choices: ev.choices.filter(
            (c): c is { value: string; label: string; recommended?: boolean } =>
              typeof c?.value === "string" && typeof c?.label === "string",
          ),
        };
        exec.confirmAnswered = false;
        exec.confirmValue = undefined;
      }
      break;
    case "progress":
      exec.stage = typeof ev.stage === "string" ? ev.stage : exec.stage;
      if (typeof ev.pct === "number") exec.pct = Math.max(0, Math.min(100, ev.pct));
      if (typeof ev.msg === "string") exec.progressMsg = ev.msg;
      break;
    case "log":
      exec.logs.push({
        level: typeof ev.level === "string" ? ev.level : "info",
        msg: typeof ev.msg === "string" ? ev.msg : "",
      });
      break;
    case "result": {
      const ok = ev.ok === true;
      exec.result = {
        ok,
        summary: (ev.summary as Record<string, unknown> | undefined) ?? {},
        error: typeof ev.error === "string" ? ev.error : undefined,
      };
      if (ok) exec.pct = 100;
      break;
    }
    default:
      break;
  }
}

/** ---------- 文案 ---------- */
function recLabel(rec: string | null): string {
  switch (rec) {
    case "ota":
      return "热更新";
    case "native":
      return "整包更新";
    case "uncertain":
      return "判定不确定";
    default:
      return "整包更新";
  }
}

function recClass(rec: string | null): string {
  switch (rec) {
    case "ota":
      return "c-wait";
    case "native":
      return "c-act";
    default:
      return "c-off";
  }
}

const STAGE_LABELS: Record<string, string> = {
  judge: "判定",
  publish: "发布热更",
  upload: "上传分发渠道",
};

function summaryText(summary: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof summary["versionName"] === "string" && summary["versionName"] !== "")
    parts.push(summary["versionName"]);
  if (typeof summary["channel"] === "string" && summary["channel"] !== "")
    parts.push(summary["channel"]);
  if (summary["mode"] === "ota") parts.push("热更新");
  else if (summary["mode"] === "native") parts.push("整包");
  return parts.join(" · ");
}

/** ---------- 步骤1：表单 + 预览 ---------- */
function previewBoxHtml(): string {
  if (state.previewing) {
    return `
      <div style="display:flex;align-items:center;gap:8px;color:var(--label-2);font-size:13px;padding:20px 0">
        <div class="spin"></div>
        正在分析所选平台自上个版本以来的改动…
      </div>`;
  }
  if (state.previews.size === 0) {
    return `
      <div style="font-size:13px;color:var(--label-2);padding:12px 0">
        选好项目与平台后点「预览改动」：对每个平台跑 <span class="mono">beta --dry-run</span> 判定（只读，不发布）。
      </div>`;
  }
  const rows = [...state.previews.entries()]
    .map(([plat, r]) => {
      if (r.error !== undefined)
        return `<div class="dry-row err"><b>${esc(platLabel(plat))}</b><span class="dry-msg">${esc(r.error)}</span></div>`;
      const rep = r.report!;
      return `<div class="dry-row"><b>${esc(platLabel(plat))}</b><span class="dry-msg">${esc(recLabel(rep.recommendation))}（${esc(rep.confidence ?? "—")}）· 证据 ${rep.evidence.length} 条</span></div>`;
    })
    .join("");
  const anyOk = [...state.previews.values()].some((r) => r.report !== undefined);
  return `
    <div class="dry-list">${rows}</div>
    <div style="margin-top:14px">
      <button class="btn btn-primary btn-lg" id="toStep2" ${anyOk ? "" : "disabled"}>下一步：确认方式</button>
    </div>`;
}

function wiz1Html(client: UiClient): string {
  const projects = client.state.projects;
  const projButtons = projects
    .map(
      (p) =>
        `<button class="seg${state.form.projectId === p.id ? " active" : ""}" data-proj="${esc(p.id)}">${esc(p.name)}</button>`,
    )
    .join("");
  const platButtons = PLATFORMS.map((p) => {
    const on = state.form.platforms.includes(p.key);
    return `<button class="seg${on ? " active" : ""}" data-plat="${p.key}">${p.label}${on ? " ✓" : ""}</button>`;
  }).join("");
  const canPreview =
    state.form.projectId !== "" && state.form.platforms.length > 0 && projects.length > 0;
  return `
    <div id="wiz1">
      <div class="group" style="padding:16px">
        <div class="wiz-config">
          <div class="wc-row">
            <span class="wc-label">项目</span>
            <div class="seg-wrap" id="projSeg">${
              projButtons ||
              '<span style="font-size:12px;color:var(--label-3)">暂无项目，先到总览添加</span>'
            }</div>
          </div>
          <div class="wc-row">
            <span class="wc-label">阶段</span>
            <div class="seg-wrap" id="phaseSeg">
              <button class="seg active">内测（beta）</button>
              <button class="seg" data-phase="release">正式（release）</button>
            </div>
          </div>
          <div class="wc-row">
            <span class="wc-label">平台</span>
            <div class="seg-wrap multi" id="platMulti">${platButtons}</div>
            <span class="wc-hint">可多选，多端同发（一期逐个任务顺序执行）</span>
          </div>
        </div>
        <div style="margin-top:12px">
          <button class="btn btn-primary" id="previewBtn" ${canPreview ? "" : "disabled"}>预览改动</button>
        </div>
        <div id="dryrunBox">${previewBoxHtml()}</div>
      </div>
    </div>`;
}

/** ---------- 步骤2：判定卡 ---------- */
function evidenceHtml(card: PlatformCard): string {
  if (card.evidence.length === 0)
    return `<div class="ev"><span>·</span><span>无改动证据（可能自上个版本以来无提交）</span></div>`;
  const shown = card.evidence.slice(0, 5);
  const rest = card.evidence.length - shown.length;
  return (
    shown
      .map(
        (e) => `
        <div class="ev"><span>·</span><span class="mono">${esc(e.path)}</span><span>${esc(e.rule)}${e.note ? `（${esc(e.note)}）` : ""}</span></div>`,
      )
      .join("") +
    (rest > 0 ? `<div class="ev"><span>·</span><span>… 等 ${rest} 条证据</span></div>` : "")
  );
}

function judgeCardHtml(card: PlatformCard): string {
  if (card.skipChoice) {
    return `
      <div class="group-title">${esc(platLabel(card.platform))} · 未开启热更新（自动跳过选择）</div>
      <div class="judge-card skip">
        <div class="judge-rec" style="margin:0">
          <span class="tag">更新方式</span>
          <span class="st c-off"><span class="dot d-off"></span>整包更新（唯一方式）</span>
          <span style="font-size:12px;color:var(--label-3)">未接入热更，直接进入整包流程</span>
        </div>
      </div>`;
  }
  const rec = card.recommendation;
  const chosen = card.chosen ?? (rec === "uncertain" ? "native" : (rec as "ota" | "native"));
  const otaBadge = rec === "ota" ? '<span class="rec-badge">建议</span>' : "";
  const nativeBadge = rec === "native" ? '<span class="rec-badge">建议</span>' : "";
  const uncertain = rec === "uncertain";
  return `
    <div class="group-title">${esc(platLabel(card.platform))} · 已开启热更新${uncertain ? " · 判定不确定" : ""}</div>
    <div class="judge-card" data-plat="${esc(card.platform)}">
      <div class="judge-rec">
        <span class="tag">建议的更新方式</span>
        <span class="st ${recClass(rec)}"><span class="dot ${recClass(rec).slice(2)}"></span>${esc(recLabel(rec))}</span>
        <span style="font-size:12px;color:var(--label-3)">置信度：${esc(card.confidence ?? "—")}</span>
      </div>
      <div class="choice-wrap">
        <button class="choice${chosen === "ota" ? " sel" : ""}" data-v="ota" data-plat="${esc(card.platform)}">
          <div class="ct">热更新 ${otaBadge}</div>
          <div class="cd">${rec === "ota" ? "只更新 JS 代码，测试设备直接收到，几分钟完成" : "本次含原生改动，热更可能无法覆盖（不推荐）"}</div>
        </button>
        <button class="choice${chosen === "native" ? " sel" : ""}" data-v="native" data-plat="${esc(card.platform)}">
          <div class="ct">整包更新 ${nativeBadge}</div>
          <div class="cd">需要升级版本号并重新构建安装包，走分发渠道</div>
        </button>
      </div>
      <div class="evidence">${evidenceHtml(card)}</div>
    </div>`;
}

function wiz2Html(): string {
  const multi = state.form.platforms.length > 1;
  return `
    <div id="wiz2">
      ${state.cards.map(judgeCardHtml).join("")}
      ${multi ? `<p class="note" style="margin-top:12px">已选 ${state.form.platforms.length} 个平台：一期按顺序逐个发起，前一平台完成后自动开始下一个。</p>` : ""}
      <div style="display:flex;gap:10px;margin-top:18px">
        <button class="btn btn-primary btn-lg" id="goExec">开始发版</button>
        <button class="btn btn-sec btn-lg" id="back1">上一步</button>
      </div>
    </div>`;
}

/** ---------- 步骤3：执行 ---------- */
function confirmHtml(exec: ExecState): string {
  const c = exec.confirm;
  if (c === null) return "";
  if (exec.confirmAnswered) {
    const chosen = c.choices.find((ch) => ch.value === exec.confirmValue) ?? c.choices[0];
    return `
      <div class="confirm-card answered" id="confirmCard">
        <div class="confirm-q">${esc(c.question)} <span style="color:var(--green);font-weight:600">已确认</span></div>
        <div class="row-sub" style="margin-top:6px">选择：${esc(chosen?.label ?? "")}</div>
      </div>`;
  }
  return `
    <div class="confirm-card" id="confirmCard">
      <div class="confirm-q">${esc(c.question)}</div>
      <div class="choice-wrap confirm-choices">
        ${c.choices
          .map(
            (ch) => `
          <button class="choice" data-confirm="${esc(ch.value)}">
            <div class="ct">${esc(ch.label)}${ch.recommended ? ' <span class="rec-badge">建议</span>' : ""}</div>
          </button>`,
          )
          .join("")}
      </div>
    </div>`;
}

function progressHtml(exec: ExecState): string {
  const pct = exec.pct ?? 0;
  const pctText = exec.pct === undefined ? "…" : `${Math.round(exec.pct)}%`;
  const cls = exec.result?.ok === true ? " ok" : exec.result?.ok === false ? " fail" : "";
  const stageLabel = STAGE_LABELS[exec.stage] ?? exec.stage;
  return `
    <div class="prog-row">
      <div class="prog-name">${esc(platLabel(exec.platform))} · ${esc(stageLabel || "准备中")}</div>
      <div class="prog-bar"><div class="prog-fill${cls}" style="width:${pct}%"></div></div>
      <div class="prog-pct">${pctText}</div>
    </div>
    ${exec.progressMsg !== undefined ? `<div class="prog-msg">${esc(exec.progressMsg)}</div>` : ""}`;
}

function logHtml(exec: ExecState): string {
  if (exec.logs.length === 0) return "";
  return `
    <div class="log" id="wizlog">
      <div class="log-head" id="logToggle" role="button" tabindex="0">
        <span>详细日志（${exec.logs.length}）</span><span class="log-arrow">展开</span>
      </div>
      <div class="log-body wizlog-body">
        ${exec.logs
          .map(
            (l) =>
              `<div class="log-line"><span class="lv ${esc(l.level)}">${esc(l.level)}</span>${esc(l.msg)}</div>`,
          )
          .join("")}
      </div>
    </div>`;
}

function wiz3Html(): string {
  const exec = state.exec;
  const waiting = state.queue
    .slice(exec === null ? 0 : 1)
    .filter((p) => p !== exec?.platform)
    .map((p) => esc(platLabel(p)))
    .join("、");
  return `
    <div id="wiz3">
      <div class="group" style="padding:8px 20px 16px">
        ${exec === null ? '<div class="state-box" style="padding:24px"><div class="spin"></div>正在发起任务…</div>' : progressHtml(exec)}
        ${exec !== null && exec.confirm !== null ? confirmHtml(exec) : ""}
        ${waiting !== "" ? `<div class="queue-note">待执行：${waiting}</div>` : ""}
      </div>
      ${exec === null ? "" : logHtml(exec)}
      <div style="margin-top:18px">
        <button class="btn btn-danger-ghost" id="cancelBtn">取消发版</button>
      </div>
    </div>`;
}

/** ---------- 步骤4：结果 ---------- */
function wiz4Html(client: UiClient): string {
  const projName =
    client.state.projects.find((p) => p.id === state.form.projectId)?.name ?? state.form.projectId;
  const entries = [...state.results.entries()];
  const allOk = entries.length > 0 && entries.every(([, r]) => r.ok);
  const title = state.cancelled ? "已取消发版" : allOk ? "已发版" : "部分平台失败";
  const firstOk = entries.find(([, r]) => r.ok);
  const sub =
    allOk && firstOk !== undefined
      ? `${esc(projName)} 内测 · <span class="mono">${esc(summaryText(firstOk[1].summary))}</span>`
      : esc(projName);
  return `
    <div id="wiz4">
      <div class="group" style="padding:28px;text-align:center">
        <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="${allOk && !state.cancelled ? "var(--green)" : "var(--red)"}" stroke-width="2" style="margin-bottom:10px">
          ${allOk && !state.cancelled ? '<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>' : '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>'}
        </svg>
        <div style="font-size:17px;font-weight:700">${title}</div>
        <div class="row-sub" style="margin-top:4px">${sub}</div>
      </div>
      ${entries
        .map(
          ([plat, r]) => `
        <div class="group"><div class="row">
          <div class="row-main">
            <div class="row-title">${esc(platLabel(plat))}</div>
            <div class="row-sub">${r.ok ? esc(summaryText(r.summary)) : esc(r.error ?? "失败")}</div>
          </div>
          <span class="st ${r.ok ? "c-ok" : "c-err"}"><span class="dot ${r.ok ? "d-ok" : "d-err"}"></span>${r.ok ? "完成" : "失败"}</span>
        </div></div>`,
        )
        .join("")}
      <div style="display:flex;gap:10px;justify-content:center;margin-top:16px">
        <button class="btn btn-primary" id="againBtn">再发一次</button>
        <button class="btn btn-sec" id="doneBtn">返回总览</button>
      </div>
    </div>`;
}

/** ---------- 主渲染 ---------- */
export function renderRelease(ctx: PageCtx): HTMLElement {
  const { client } = ctx;
  pageCtx = ctx;
  ensureTaskTap(client);
  const el = document.createElement("section");
  el.className = "page";
  el.id = "page-release";

  const stepTabs = ([1, 2, 3, 4] as const)
    .map((n) => {
      const names: Record<number, string> = { 1: "预览改动", 2: "确认方式", 3: "执行", 4: "完成" };
      const cls = n === state.phase ? " on" : n < state.phase ? " done" : "";
      const num = n < state.phase ? "✓" : String(n);
      return `<div class="wstep${cls}"><span class="n">${num}</span>${names[n]}</div>`;
    })
    .join("");

  el.innerHTML = `
    <h1>发版</h1>
    <p class="page-sub">内测（beta）全链路：预览改动 → 确认方式 → 执行 → 完成；正式（release）链路二期接入。</p>
    <div class="wiz-steps">${stepTabs}</div>
    ${state.phase === 1 ? wiz1Html(client) : ""}
    ${state.phase === 2 ? wiz2Html() : ""}
    ${state.phase === 3 ? wiz3Html() : ""}
    ${state.phase === 4 ? wiz4Html(client) : ""}
    <p class="note">取消 / 确认超时（10 分钟无响应自动取消）/ 部分渠道失败可在完成页单独重试。</p>`;

  bindStep1(el, ctx);
  bindStep2(el, ctx);
  bindStep3(el, ctx);
  bindStep4(el, ctx);
  return el;
}

/** ---------- 交互绑定 ---------- */
function bindStep1(el: HTMLElement, ctx: PageCtx): void {
  if (state.phase !== 1) return;
  el.querySelector("#projSeg")?.addEventListener("click", (e) => {
    const seg = (e.target as HTMLElement).closest("button[data-proj]");
    if (seg === null) return;
    state.form.projectId = (seg as HTMLElement).dataset.proj ?? "";
    saveForm(state.form);
    rerenderAll(ctx);
  });

  el.querySelector("#phaseSeg")?.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest('button[data-phase="release"]') === null) return;
    toast("正式（release）链路二期接入，当前为内测流程");
  });

  el.querySelector("#platMulti")?.addEventListener("click", (e) => {
    const seg = (e.target as HTMLElement).closest("button[data-plat]");
    if (seg === null) return;
    const plat = (seg as HTMLElement).dataset.plat ?? "";
    const has = state.form.platforms.includes(plat);
    if (has && state.form.platforms.length === 1) {
      toast("至少选择一个平台");
      return;
    }
    state.form.platforms = has
      ? state.form.platforms.filter((p) => p !== plat)
      : [...state.form.platforms, plat];
    saveForm(state.form);
    state.previews = new Map(); // 平台集变了，旧预览作废
    state.previewing = false; // 在途预览轮次作废（runPreview 按 token 自检）
    previewGen += 1;
    rerenderAll(ctx);
  });

  el.querySelector("#previewBtn")?.addEventListener("click", () => {
    void runPreview(ctx);
  });
  el.querySelector("#dryrunBox")?.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("#toStep2") === null) return;
    toStep2();
    rerenderAll(ctx);
  });
}

async function runPreview(ctx: PageCtx): Promise<void> {
  if (state.previewing || state.form.projectId === "") return;
  const gen = ++previewGen;
  state.previewing = true;
  state.previews = new Map();
  rerenderAll(ctx);
  for (const plat of state.form.platforms) {
    try {
      const report = await ctx.client.dryRun(state.form.projectId, plat);
      if (gen !== previewGen) return; // 平台集已变更：本轮结果丢弃
      state.previews.set(plat, { report });
    } catch (err) {
      if (gen !== previewGen) return;
      state.previews.set(plat, { error: err instanceof Error ? err.message : String(err) });
    }
    rerenderAll(ctx);
  }
  if (gen !== previewGen) return;
  state.previewing = false;
  rerenderAll(ctx);
}

/** 预览轮次令牌：平台集变更即作废在途结果 */
let previewGen = 0;

function toStep2(): void {
  // 预览失败的平台不产卡不执行（错误行留在步骤1，用户可重试或取消选择）
  state.cards = state.form.platforms
    .filter((plat) => state.previews.get(plat)?.report !== undefined)
    .map((plat) => {
      const report = state.previews.get(plat)!.report!;
      return {
        platform: plat,
        skipChoice: report.provider === null || report.recommendation === null,
        recommendation: report.recommendation,
        confidence: report.confidence,
        evidence: report.evidence,
        chosen: null,
      };
    });
  state.phase = 2;
}

function bindStep2(el: HTMLElement, ctx: PageCtx): void {
  if (state.phase !== 2) return;
  el.querySelectorAll<HTMLElement>(".choice[data-v]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const plat = btn.dataset.plat ?? "";
      const card = state.cards.find((c) => c.platform === plat);
      if (card === undefined) return;
      card.chosen = btn.dataset.v === "native" ? "native" : "ota";
      // 同卡内刷新选中态（不整页重渲）
      btn
        .closest(".choice-wrap")
        ?.querySelectorAll(".choice")
        .forEach((c) => {
          c.classList.remove("sel");
        });
      btn.classList.add("sel");
    });
  });
  el.querySelector("#back1")?.addEventListener("click", () => {
    state.phase = 1;
    rerenderAll(ctx);
  });
  el.querySelector("#goExec")?.addEventListener("click", () => {
    state.phase = 3;
    state.queue = state.cards.map((c) => c.platform);
    state.results = new Map();
    state.cancelled = false;
    state.exec = null;
    rerenderAll(ctx);
    void runQueue(ctx);
  });
}

/** CLI args：步骤2 改选 → --delivery 显式；未改选不带（CLI 交互确认推荐语义） */
function releaseArgsFor(platform: string): string[] | undefined {
  const card = state.cards.find((c) => c.platform === platform);
  if (card === undefined || card.chosen === null) return undefined;
  return ["--delivery", card.chosen];
}

async function runQueue(ctx: PageCtx): Promise<void> {
  while (state.queue.length > 0) {
    if (state.cancelled) break;
    const platform = state.queue[0]!;
    state.exec = {
      taskId: "",
      platform,
      stage: "",
      pct: undefined,
      progressMsg: undefined,
      logs: [],
      confirm: null,
      confirmAnswered: false,
      confirmValue: undefined,
      result: null,
    };
    rerenderAll(ctx);
    let outcome: TaskOutcome;
    try {
      const taskId = await ctx.client.startBeta(
        state.form.projectId,
        platform,
        releaseArgsFor(platform),
      );
      if (state.exec === null || state.exec.platform !== platform) {
        // 用户已离开/取消：任务照跑完但 UI 不再跟随
        continue;
      }
      state.exec.taskId = taskId;
      if (state.cancelled) {
        // REST 往返期间用户已点取消（当时 taskId 未回走了本地收口）：补杀真实任务
        ctx.client.cancel(taskId);
      }
      outcome = await waitTaskEnd(ctx.client, taskId);
    } catch (err) {
      outcome = { ok: false, summary: {}, error: err instanceof Error ? err.message : String(err) };
    }
    if (state.phase !== 3) return; // 离开向导（等待者已被 detach 收口）——不再写结果
    state.results.set(platform, outcome);
    state.queue = state.queue.slice(1);
    state.exec = null;
    if (!outcome.ok) break; // 失败即停：剩余平台不发起（结果页可重试）
    if (state.queue.length > 0) toast(`${platLabel(platform)} 已发版，开始下一个平台`);
    rerenderAll(ctx);
  }
  if (state.phase === 3) {
    state.phase = 4;
    // 发版结束通知（notifyRelease 开关）：系统通知失败静默（结果页即信息源）
    if (loadSettings().notifyRelease && state.results.size > 0) {
      const ok = [...state.results.values()].filter((r) => r.ok).length;
      const total = state.results.size;
      void ctx.host.notify(
        state.cancelled ? "发版已取消" : ok === total ? "发版完成" : "发版有失败",
        state.cancelled ? "队列已停止" : `${ok}/${total} 个平台成功`,
      );
    }
    rerenderAll(ctx);
  }
}

function bindStep3(el: HTMLElement, ctx: PageCtx): void {
  if (state.phase !== 3) return;
  el.querySelector("#cancelBtn")?.addEventListener("click", () => {
    const exec = state.exec;
    state.cancelled = true;
    if (exec !== null && exec.taskId !== "") {
      ctx.client.cancel(exec.taskId);
      // 同步收口本地等待者：不等服务端 task.end 往返（迟到时 settle 已无 waiter，幂等）
      if (exec.result === null) {
        exec.result = { ok: false, summary: {}, error: "已取消" };
      }
      settle(exec.taskId, exec.result);
      toast("已请求取消");
    } else {
      state.queue = [];
      if (exec !== null) settleLocal();
      state.phase = 4;
      rerenderAll(ctx);
    }
  });
  el.querySelector("#wizlog")?.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("#logToggle") === null) return;
    const log = el.querySelector("#wizlog");
    log?.classList.toggle("open");
    const arrow = log?.querySelector(".log-arrow");
    if (arrow !== null && arrow !== undefined)
      arrow.textContent = log?.classList.contains("open") ? "收起" : "展开";
  });
  el.querySelector("#confirmCard")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button[data-confirm]");
    if (btn === null) return;
    const exec = state.exec;
    if (exec === null || exec.confirm === null || exec.confirmAnswered) return;
    const value = (btn as HTMLElement).dataset.confirm ?? "";
    ctx.client.confirm(exec.taskId, exec.confirm.id, value);
    exec.confirmAnswered = true;
    exec.confirmValue = value;
    rerenderAll(ctx);
  });
}

/** 未发起任务时取消：直接收口当前 exec（无 taskId 可 settle） */
function settleLocal(): void {
  const exec = state.exec;
  if (exec === null) return;
  exec.result = { ok: false, summary: {}, error: "已取消" };
  state.results.set(exec.platform, exec.result);
}

function bindStep4(el: HTMLElement, ctx: PageCtx): void {
  if (state.phase !== 4) return;
  el.querySelector("#againBtn")?.addEventListener("click", () => {
    resetReleasePageState();
    rerenderAll(ctx);
  });
  el.querySelector("#doneBtn")?.addEventListener("click", () => {
    ctx.navigate("#/overview");
  });
}

/** ---------- 渲染辅助 ---------- */

/** 本页 ctx（rerenderAll 闭包外需要；每次 renderRelease 刷新） */
let pageCtx: PageCtx | undefined;

function onReleasePage(): boolean {
  return location.hash.startsWith("#/release");
}

function rerenderAll(ctx?: PageCtx): void {
  const active = ctx ?? pageCtx;
  if (active === undefined) return;
  if (!onReleasePage()) return;
  const content = document.getElementById("content");
  if (content === null) return;
  const next = renderRelease(active);
  // 同标记不替换（与 main.ts render 同款守卫）：任务事件高频重渲不 detach DOM
  const current = content.firstElementChild;
  if (current === null || current.outerHTML !== next.outerHTML) content.replaceChildren(next);
}
