import { useEffect, useReducer, useRef, useState } from "react";
import type { JudgementReport, TaskEvent, UiClient } from "../api.js";
import { loadSettings, toast } from "../util.js";
import { usePageCtx } from "../state.js";

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

/** ---------- 事件 → ExecState（纯函数，组件外定义） ---------- */
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

/** 确认卡：待答（选项按钮）↔ 已答（回显用户点击项） */
export function ConfirmCard({
  exec,
  onAnswer,
}: {
  exec: ExecState;
  onAnswer: (v: string) => void;
}) {
  const c = exec.confirm;
  if (c === null) return null;
  if (exec.confirmAnswered) {
    const chosen = c.choices.find((ch) => ch.value === exec.confirmValue) ?? c.choices[0];
    return (
      <div className="confirm-card answered" id="confirmCard">
        <div className="confirm-q">
          {c.question} <span style={{ color: "var(--green)", fontWeight: 600 }}>已确认</span>
        </div>
        <div className="row-sub" style={{ marginTop: "6px" }}>
          选择：{chosen?.label ?? ""}
        </div>
      </div>
    );
  }
  return (
    <div className="confirm-card" id="confirmCard">
      <div className="confirm-q">{c.question}</div>
      <div className="choice-wrap confirm-choices">
        {c.choices.map((ch) => (
          <button
            key={ch.value}
            className="choice"
            data-confirm={ch.value}
            onClick={() => onAnswer(ch.value)}
          >
            <div className="ct">
              {ch.label}
              {ch.recommended ? <span className="rec-badge">建议</span> : null}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

/** 步骤2 判定卡（含未接热更跳过态） */
function JudgeCard({
  card,
  onChoose,
}: {
  card: PlatformCard;
  onChoose: (v: "ota" | "native") => void;
}) {
  if (card.skipChoice) {
    return (
      <>
        <div className="group-title">{platLabel(card.platform)} · 未开启热更新（自动跳过选择）</div>
        <div className="judge-card skip">
          <div className="judge-rec" style={{ margin: 0 }}>
            <span className="tag">更新方式</span>
            <span className="st c-off">
              <span className="dot d-off" />
              整包更新（唯一方式）
            </span>
            <span style={{ fontSize: "12px", color: "var(--label-3)" }}>
              未接入热更，直接进入整包流程
            </span>
          </div>
        </div>
      </>
    );
  }
  const rec = card.recommendation;
  const chosen = card.chosen ?? (rec === "uncertain" ? "native" : (rec as "ota" | "native"));
  return (
    <>
      <div className="group-title">
        {platLabel(card.platform)} · 已开启热更新{rec === "uncertain" ? " · 判定不确定" : ""}
      </div>
      <div className="judge-card" data-plat={card.platform}>
        <div className="judge-rec">
          <span className="tag">建议的更新方式</span>
          <span className={`st ${recClass(rec)}`}>
            <span className={`dot ${recClass(rec).slice(2)}`} />
            {recLabel(rec)}
          </span>
          <span style={{ fontSize: "12px", color: "var(--label-3)" }}>
            置信度：{card.confidence ?? "—"}
          </span>
        </div>
        <div className="choice-wrap">
          <button
            className={`choice${chosen === "ota" ? " sel" : ""}`}
            data-v="ota"
            data-plat={card.platform}
            onClick={() => onChoose("ota")}
          >
            <div className="ct">
              热更新 {rec === "ota" ? <span className="rec-badge">建议</span> : null}
            </div>
            <div className="cd">
              {rec === "ota"
                ? "只更新 JS 代码，测试设备直接收到，几分钟完成"
                : "本次含原生改动，热更可能无法覆盖（不推荐）"}
            </div>
          </button>
          <button
            className={`choice${chosen === "native" ? " sel" : ""}`}
            data-v="native"
            data-plat={card.platform}
            onClick={() => onChoose("native")}
          >
            <div className="ct">
              整包更新 {rec === "native" ? <span className="rec-badge">建议</span> : null}
            </div>
            <div className="cd">需要升级版本号并重新构建安装包，走分发渠道</div>
          </button>
        </div>
        <div className="evidence">
          {card.evidence.length === 0 ? (
            <div className="ev">
              <span>·</span>
              <span>无改动证据（可能自上个版本以来无提交）</span>
            </div>
          ) : (
            <>
              {card.evidence.slice(0, 5).map((e, i) => (
                <div className="ev" key={i}>
                  <span>·</span>
                  <span className="mono">{e.path}</span>
                  <span>
                    {e.rule}
                    {e.note ? `（${e.note}）` : ""}
                  </span>
                </div>
              ))}
              {card.evidence.length > 5 ? (
                <div className="ev">
                  <span>·</span>
                  <span>… 等 {card.evidence.length - 5} 条证据</span>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </>
  );
}

/** 发版向导：四步状态机（预览 → 确认方式 → 执行 → 完成） */
export default function ReleasePage() {
  const { client, navigate, host } = usePageCtx();
  const [, force] = useReducer((n: number) => n + 1, 0);
  /** 向导可变状态（异步流程跨 await 读写，ref 承载 + force 重渲） */
  const stateRef = useRef<ReleaseState>(freshState());
  /** 预览轮次令牌：平台集变更即作废在途结果 */
  const previewGen = useRef(0);
  /** 任务终态 waiters（runQueue 挂起处 → task.end 收口） */
  const taskWaiters = useRef(new Map<string, (r: TaskOutcome) => void>());
  const [logOpen, setLogOpen] = useState(false);

  const settle = (taskId: string, r: TaskOutcome): void => {
    const w = taskWaiters.current.get(taskId);
    if (w === undefined) return;
    taskWaiters.current.delete(taskId);
    w(r);
  };

  const waitTaskEnd = (c: UiClient, taskId: string): Promise<TaskOutcome> => {
    // I-4 竞态：task.end 可能早于 REST 回填 taskId 到达——onTaskEnd 当时因 taskId 未回填丢弃，靠 UiClient 缓存收口
    const cached = c.taskEndCode(taskId);
    if (cached !== undefined) {
      return Promise.resolve(
        cached === 0
          ? { ok: true, summary: {} }
          : { ok: false, summary: {}, error: `任务异常退出（code=${cached}）` },
      );
    }
    const { promise, resolve } = Promise.withResolvers<TaskOutcome>();
    taskWaiters.current.set(taskId, resolve);
    return promise;
  };

  /** 任务事件直通订阅：挂载装一次，卸载收口（= vanilla resetReleasePageState） */
  useEffect(() => {
    const offTask = client.onTask((taskId, ev) => {
      const exec = stateRef.current.exec;
      if (exec === null || exec.taskId !== taskId) return;
      applyTaskEvent(exec, ev);
      force();
    });
    const offEnd = client.onTaskEnd((taskId, code) => {
      const exec = stateRef.current.exec;
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
      force();
    });
    return () => {
      offTask();
      offEnd();
      // 挂起的 runQueue 等待者收口（否则离开向导后 promise 永悬）+ 状态复位（runQueue 据此退出）
      for (const [id, resolve] of taskWaiters.current) {
        taskWaiters.current.delete(id);
        resolve({ ok: false, summary: {}, error: "已离开向导" });
      }
      stateRef.current = freshState();
    };
  }, [client]);

  /** 默认选中：无记住选择（首次/失效）且项目列表到达 → 选第一个（发版页初始化即有上下文） */
  useEffect(() => {
    const state = stateRef.current;
    const first = client.state.projects[0];
    if (first === undefined) return;
    if (state.form.projectId === "" || client.state.projects.every((p) => p.id !== state.form.projectId)) {
      state.form.projectId = first.id;
      saveForm(state.form);
      force();
    }
  }, [client, client.state.projects]);

  /** ---------- 步骤1 交互 ---------- */
  const onPickProject = (projectId: string) => {
    const state = stateRef.current;
    state.form.projectId = projectId;
    saveForm(state.form);
    force();
  };

  const onPickPhaseRelease = () => {
    toast("正式（release）链路二期接入，当前为内测流程");
  };

  const onTogglePlatform = (plat: string) => {
    const state = stateRef.current;
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
    previewGen.current += 1;
    force();
  };

  const runPreview = async (): Promise<void> => {
    if (stateRef.current.previewing || stateRef.current.form.projectId === "") return;
    const gen = ++previewGen.current;
    stateRef.current.previewing = true;
    stateRef.current.previews = new Map();
    force();
    for (const plat of stateRef.current.form.platforms) {
      try {
        const report = await client.dryRun(stateRef.current.form.projectId, plat);
        if (gen !== previewGen.current) return; // 平台集已变更：本轮结果丢弃
        stateRef.current.previews.set(plat, { report });
      } catch (err) {
        if (gen !== previewGen.current) return;
        stateRef.current.previews.set(plat, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      force();
    }
    if (gen !== previewGen.current) return;
    stateRef.current.previewing = false;
    force();
  };

  const toStep2 = (): void => {
    const state = stateRef.current;
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
    force();
  };

  /** ---------- 步骤3 队列 ---------- */
  const releaseArgsFor = (platform: string): string[] | undefined => {
    const card = stateRef.current.cards.find((c) => c.platform === platform);
    if (card === undefined || card.chosen === null) return undefined;
    return ["--delivery", card.chosen];
  };

  const runQueue = async (): Promise<void> => {
    while (stateRef.current.queue.length > 0) {
      if (stateRef.current.cancelled) break;
      const platform = stateRef.current.queue[0]!;
      stateRef.current.exec = {
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
      force();
      let outcome: TaskOutcome;
      try {
        const taskId = await client.startBeta(
          stateRef.current.form.projectId,
          platform,
          releaseArgsFor(platform),
        );
        if (stateRef.current.exec === null || stateRef.current.exec.platform !== platform) {
          // 用户已离开/取消：任务照跑完但 UI 不再跟随
          continue;
        }
        stateRef.current.exec.taskId = taskId;
        if (stateRef.current.cancelled) {
          // REST 往返期间用户已点取消（当时 taskId 未回走了本地收口）：补杀真实任务
          client.cancel(taskId);
        }
        outcome = await waitTaskEnd(client, taskId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // 发起失败（如同项目同平台重复任务 409）：明确 toast，错误同时进结果卡
        toast(msg);
        outcome = { ok: false, summary: {}, error: msg };
      }
      if (stateRef.current.phase !== 3) return; // 离开向导（等待者已被卸载收口）——不再写结果
      stateRef.current.results.set(platform, outcome);
      stateRef.current.queue = stateRef.current.queue.slice(1);
      stateRef.current.exec = null;
      if (!outcome.ok) break; // 失败即停：剩余平台不发起（结果页可重试）
      if (stateRef.current.queue.length > 0) toast(`${platLabel(platform)} 已发版，开始下一个平台`);
      force();
    }
    if (stateRef.current.phase === 3) {
      stateRef.current.phase = 4;
      // 发版结束通知（notifyRelease 开关）：系统通知失败静默（结果页即信息源）
      if (loadSettings().notifyRelease && stateRef.current.results.size > 0) {
        const ok = [...stateRef.current.results.values()].filter((r) => r.ok).length;
        const total = stateRef.current.results.size;
        void host.notify(
          stateRef.current.cancelled ? "发版已取消" : ok === total ? "发版完成" : "发版有失败",
          stateRef.current.cancelled ? "队列已停止" : `${ok}/${total} 个平台成功`,
        );
      }
      force();
    }
  };

  /** ---------- 步骤2/3/4 交互 ---------- */
  const onChooseDelivery = (platform: string, v: "ota" | "native") => {
    const card = stateRef.current.cards.find((c) => c.platform === platform);
    if (card === undefined) return;
    card.chosen = v;
    force();
  };

  const onGoExec = () => {
    const state = stateRef.current;
    state.phase = 3;
    state.queue = state.cards.map((c) => c.platform);
    state.results = new Map();
    state.cancelled = false;
    state.exec = null;
    setLogOpen(false);
    force();
    void runQueue();
  };

  const onConfirmAnswer = (value: string) => {
    const exec = stateRef.current.exec;
    if (exec === null || exec.confirm === null || exec.confirmAnswered) return;
    client.confirm(exec.taskId, exec.confirm.id, value);
    exec.confirmAnswered = true;
    exec.confirmValue = value;
    force();
  };

  const onCancel = () => {
    const state = stateRef.current;
    const exec = state.exec;
    state.cancelled = true;
    if (exec !== null && exec.taskId !== "") {
      client.cancel(exec.taskId);
      // 同步收口本地等待者：不等服务端 task.end 往返（迟到时 settle 已无 waiter，幂等）
      if (exec.result === null) {
        exec.result = { ok: false, summary: {}, error: "已取消" };
      }
      settle(exec.taskId, exec.result);
      toast("已请求取消");
    } else {
      // 未发起任务时取消：直接收口当前 exec（无 taskId 可 settle）
      state.queue = [];
      if (exec !== null) {
        exec.result = { ok: false, summary: {}, error: "已取消" };
        state.results.set(exec.platform, exec.result);
      }
      state.phase = 4;
      force();
    }
  };

  const onAgain = () => {
    stateRef.current = freshState();
    setLogOpen(false);
    force();
  };

  /** ---------- 渲染 ---------- */
  const state = stateRef.current;
  const projects = client.state.projects;

  const stepTabs = ([1, 2, 3, 4] as const).map((n) => {
    const names: Record<number, string> = { 1: "预览改动", 2: "确认方式", 3: "执行", 4: "完成" };
    const cls = n === state.phase ? " on" : n < state.phase ? " done" : "";
    const num = n < state.phase ? "✓" : String(n);
    return (
      <div key={n} className={`wstep${cls}`}>
        <span className="n">{num}</span>
        {names[n]}
      </div>
    );
  });

  /** 步骤1：预览框 */
  let previewBox: React.ReactNode;
  if (state.previewing) {
    previewBox = (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          color: "var(--label-2)",
          fontSize: 13,
          padding: "20px 0",
        }}
      >
        <div className="spin" />
        正在分析所选平台自上个版本以来的改动…
      </div>
    );
  } else if (state.previews.size === 0) {
    previewBox = (
      <div style={{ fontSize: 13, color: "var(--label-2)", padding: "12px 0" }}>
        选好项目与平台后点「预览改动」：对每个平台跑 <span className="mono">beta --dry-run</span>{" "}
        判定（只读，不发布）。
      </div>
    );
  } else {
    const anyOk = [...state.previews.values()].some((r) => r.report !== undefined);
    previewBox = (
      <>
        <div className="dry-list">
          {[...state.previews.entries()].map(([plat, r]) =>
            r.error !== undefined ? (
              <div key={plat} className="dry-row err">
                <b>{platLabel(plat)}</b>
                <span className="dry-msg">{r.error}</span>
              </div>
            ) : (
              <div key={plat} className="dry-row">
                <b>{platLabel(plat)}</b>
                <span className="dry-msg">
                  {recLabel(r.report!.recommendation)}（{r.report!.confidence ?? "—"}）· 证据{" "}
                  {r.report!.evidence.length} 条
                </span>
              </div>
            ),
          )}
        </div>
        <div style={{ marginTop: 14 }}>
          <button
            className="btn btn-primary btn-lg"
            id="toStep2"
            disabled={!anyOk}
            onClick={toStep2}
          >
            下一步：确认方式
          </button>
        </div>
      </>
    );
  }

  const exec = state.exec;
  const waiting =
    exec === null
      ? state.queue.map((p) => platLabel(p)).join("、")
      : state.queue
          .slice(1)
          .filter((p) => p !== exec.platform)
          .map((p) => platLabel(p))
          .join("、");

  return (
    <section className="page" id="page-release">
      <h1>发版</h1>
      <p className="page-sub">
        内测（beta）全链路：预览改动 → 确认方式 → 执行 → 完成；正式（release）链路二期接入。
      </p>
      <div className="wiz-steps">{stepTabs}</div>

      {state.phase === 1 ? (
        <div id="wiz1">
          <div className="group" style={{ padding: 16 }}>
            <div className="wiz-config">
              <div className="wc-row">
                <span className="wc-label">项目</span>
                <div className="seg-wrap" id="projSeg">
                  {projects.length > 0 ? (
                    projects.map((p) => (
                      <button
                        key={p.id}
                        className={`seg${state.form.projectId === p.id ? " active" : ""}`}
                        data-proj={p.id}
                        onClick={() => onPickProject(p.id)}
                      >
                        {p.name}
                      </button>
                    ))
                  ) : (
                    <span style={{ fontSize: 12, color: "var(--label-3)" }}>
                      暂无项目，先到总览添加
                    </span>
                  )}
                </div>
              </div>
              <div className="wc-row">
                <span className="wc-label">阶段</span>
                <div className="seg-wrap" id="phaseSeg">
                  <button className="seg active">内测（beta）</button>
                  <button className="seg" data-phase="release" onClick={onPickPhaseRelease}>
                    正式（release）
                  </button>
                </div>
              </div>
              <div className="wc-row">
                <span className="wc-label">平台</span>
                <div className="seg-wrap multi" id="platMulti">
                  {PLATFORMS.map((p) => {
                    const on = state.form.platforms.includes(p.key);
                    return (
                      <button
                        key={p.key}
                        className={`seg${on ? " active" : ""}`}
                        data-plat={p.key}
                        onClick={() => onTogglePlatform(p.key)}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                <span className="wc-hint">可多选，多端同发（一期逐个任务顺序执行）</span>
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <button
                className="btn btn-primary"
                id="previewBtn"
                disabled={
                  !(
                    state.form.projectId !== "" &&
                    state.form.platforms.length > 0 &&
                    projects.length > 0
                  )
                }
                onClick={() => void runPreview()}
              >
                预览改动
              </button>
            </div>
            <div id="dryrunBox">{previewBox}</div>
          </div>
        </div>
      ) : null}

      {state.phase === 2 ? (
        <div id="wiz2">
          {state.cards.map((card) => (
            <JudgeCard
              key={card.platform}
              card={card}
              onChoose={(v) => onChooseDelivery(card.platform, v)}
            />
          ))}
          {state.form.platforms.length > 1 ? (
            <p className="note" style={{ marginTop: 12 }}>
              已选 {state.form.platforms.length}{" "}
              个平台：一期按顺序逐个发起，前一平台完成后自动开始下一个。
            </p>
          ) : null}
          <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
            <button className="btn btn-primary btn-lg" id="goExec" onClick={onGoExec}>
              开始发版
            </button>
            <button
              className="btn btn-sec btn-lg"
              id="back1"
              onClick={() => {
                stateRef.current.phase = 1;
                force();
              }}
            >
              上一步
            </button>
          </div>
        </div>
      ) : null}

      {state.phase === 3 ? (
        <div id="wiz3">
          <div className="group" style={{ padding: "8px 20px 16px" }}>
            {exec === null ? (
              <div className="state-box" style={{ padding: 24 }}>
                <div className="spin" />
                正在发起任务…
              </div>
            ) : (
              <>
                <div className="prog-row">
                  <div className="prog-name">
                    {platLabel(exec.platform)} ·{" "}
                    {STAGE_LABELS[exec.stage] ?? (exec.stage || "准备中")}
                  </div>
                  <div className="prog-bar">
                    <div
                      className={`prog-fill${
                        exec.result?.ok === true ? " ok" : exec.result?.ok === false ? " fail" : ""
                      }`}
                      style={{ width: `${exec.pct ?? 0}%` }}
                    />
                  </div>
                  <div className="prog-pct">
                    {exec.pct === undefined ? "…" : `${Math.round(exec.pct)}%`}
                  </div>
                </div>
                {exec.progressMsg !== undefined ? (
                  <div className="prog-msg">{exec.progressMsg}</div>
                ) : null}
                {exec.confirm !== null ? (
                  <ConfirmCard exec={exec} onAnswer={onConfirmAnswer} />
                ) : null}
              </>
            )}
            {waiting !== "" ? <div className="queue-note">待执行：{waiting}</div> : null}
          </div>
          {exec !== null && exec.logs.length > 0 ? (
            <div className={`log${logOpen ? " open" : ""}`} id="wizlog">
              <div
                className="log-head"
                id="logToggle"
                role="button"
                tabIndex={0}
                onClick={() => setLogOpen((v) => !v)}
              >
                <span>详细日志（{exec.logs.length}）</span>
                <span className="log-arrow">{logOpen ? "收起" : "展开"}</span>
              </div>
              <div className="log-body wizlog-body">
                {exec.logs.map((l, i) => (
                  <div className="log-line" key={i}>
                    <span className={`lv ${l.level}`}>{l.level}</span>
                    {l.msg}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <div style={{ marginTop: 18 }}>
            <button className="btn btn-danger-ghost" id="cancelBtn" onClick={onCancel}>
              取消发版
            </button>
          </div>
        </div>
      ) : null}

      {state.phase === 4 ? (
        <div id="wiz4">
          {(() => {
            const projName =
              projects.find((p) => p.id === state.form.projectId)?.name ?? state.form.projectId;
            const entries = [...state.results.entries()];
            const allOk = entries.length > 0 && entries.every(([, r]) => r.ok);
            const title = state.cancelled ? "已取消发版" : allOk ? "已发版" : "部分平台失败";
            const firstOk = entries.find(([, r]) => r.ok);
            return (
              <>
                <div className="group" style={{ padding: 28, textAlign: "center" }}>
                  <svg
                    width="46"
                    height="46"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke={allOk && !state.cancelled ? "var(--green)" : "var(--red)"}
                    strokeWidth="2"
                    style={{ marginBottom: 10 }}
                  >
                    {allOk && !state.cancelled ? (
                      <>
                        <circle cx="12" cy="12" r="10" />
                        <path d="m8 12 3 3 5-6" />
                      </>
                    ) : (
                      <>
                        <circle cx="12" cy="12" r="10" />
                        <path d="M12 8v4M12 16h.01" />
                      </>
                    )}
                  </svg>
                  <div style={{ fontSize: 17, fontWeight: 700 }}>{title}</div>
                  <div className="row-sub" style={{ marginTop: 4 }}>
                    {allOk && firstOk !== undefined ? (
                      <>
                        {projName} 内测 ·{" "}
                        <span className="mono">{summaryText(firstOk[1].summary)}</span>
                      </>
                    ) : (
                      projName
                    )}
                  </div>
                </div>
                {entries.map(([plat, r]) => (
                  <div className="group" key={plat}>
                    <div className="row">
                      <div className="row-main">
                        <div className="row-title">{platLabel(plat)}</div>
                        <div className="row-sub">
                          {r.ok ? summaryText(r.summary) : (r.error ?? "失败")}
                        </div>
                      </div>
                      <span className={`st ${r.ok ? "c-ok" : "c-err"}`}>
                        <span className={`dot ${r.ok ? "d-ok" : "d-err"}`} />
                        {r.ok ? "完成" : "失败"}
                      </span>
                    </div>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 16 }}>
                  <button className="btn btn-primary" id="againBtn" onClick={onAgain}>
                    再发一次
                  </button>
                  <button
                    className="btn btn-sec"
                    id="doneBtn"
                    onClick={() => navigate("#/overview")}
                  >
                    返回总览
                  </button>
                </div>
              </>
            );
          })()}
        </div>
      ) : null}

      <p className="note">
        取消 / 确认超时（10 分钟无响应自动取消）/ 部分渠道失败可在完成页单独重试。
      </p>
    </section>
  );
}
