import { classify, type ChannelSnapshot } from "../api.js";
import { esc, relTime, toast } from "../util.js";
import type { PageCtx } from "./overview.js";

/** 当前筛选存活于模块级：跨重渲染保持用户选择 */
let filter = "all";

const FILTERS: Array<{ key: string; label: string }> = [
  { key: "all", label: "全部渠道" },
  { key: "ok", label: "已上架" },
  { key: "wait", label: "审核中" },
  { key: "err", label: "被拒" },
];

function channelRow(ch: ChannelSnapshot): string {
  const st = classify(ch.state);
  const expanded =
    filter === "all" &&
    (ch.state === "rejected" || ch.reason !== undefined || ch.error !== undefined) &&
    expandedKey === `${projectId}\t${ch.channel}`;
  const detail =
    ch.reason !== undefined || ch.error !== undefined ? `<span class="chev">▾</span>` : "";
  return `
    <div class="row clickable" data-ch="${esc(ch.channel)}" role="button" tabindex="0">
      <div class="row-main">
        <div class="row-title">${esc(ch.channel)} <span style="font-weight:400;color:var(--label-3);font-size:12px">${esc(ch.platform)}</span></div>
        ${ch.reason !== undefined || ch.error !== undefined ? `<div class="row-sub" style="display:none"></div>` : ""}
      </div>
      <span class="st c-${st.key}"><span class="dot d-${st.key}"></span>${esc(st.label)}</span>
      <span class="fresh">${esc(relTime(Date.parse(ch.fetchedAt) || Date.now()))}</span>
      ${detail}
    </div>
    ${expanded ? rejectDetail(ch) : ""}`;
}

function rejectDetail(ch: ChannelSnapshot): string {
  const text = ch.reason ?? ch.error ?? "";
  return `
    <div class="row detail" style="background:rgba(255,59,48,.05);cursor:default">
      <div class="row-sub" style="margin:0;color:var(--label)">${esc(text)}</div>
      <button class="btn btn-sec" data-copy="${esc(text)}" style="margin-left:auto;padding:4px 12px;font-size:12px">复制原因</button>
    </div>`;
}

/** 项目详情：摘要卡筛选 + 渠道列表 + 被拒展开 */
export function renderProject(ctx: PageCtx, id: string): HTMLElement {
  const { client } = ctx;
  projectId = id;
  const el = document.createElement("section");
  el.className = "page";
  el.id = "page-project";

  const proj = client.state.projects.find((p) => p.id === id);
  const snap = client.state.snapshot(id);

  if (proj === undefined) {
    el.innerHTML = `
      <div class="state-box"><div class="big">？</div><div>项目不存在或已被移除</div>
      <div class="act"><button class="btn btn-sec" id="backOv">返回总览</button></div></div>`;
    el.querySelector("#backOv")?.addEventListener("click", () => ctx.navigate("#/overview"));
    return el;
  }

  const counts = client.state.counts(id);
  const nums: Record<string, number> = {
    all: counts.total,
    ok: counts.ok,
    wait: counts.wait,
    err: counts.err,
  };

  const cards = FILTERS.map(
    (f) => `
      <div class="sum-card${filter === f.key ? " selected" : ""}" data-filter="${f.key}" role="button" tabindex="0">
        <div class="sum-num${f.key === "all" ? "" : ` c-${f.key}`}">${nums[f.key] ?? 0}</div>
        <div class="sum-label">${f.label}</div>
      </div>`,
  ).join("");

  let listHtml: string;
  if (snap === undefined) {
    listHtml = `<div class="state-box"><div class="spin"></div>正在获取渠道状态…</div>`;
  } else if (!snap.ok) {
    listHtml = `<div class="state-box"><div class="big">!</div><div>工程状态查不到（CLI 校验失败或依赖未安装）</div>
      <div class="row-sub" style="margin-top:6px">终端运行 <span class="mono">applift doctor</span> 排查</div></div>`;
  } else {
    const items = snap.channels.filter(
      (ch) => filter === "all" || classify(ch.state).key === filter,
    );
    listHtml =
      items.length === 0
        ? `<div class="state-box"><div class="big">—</div><div>没有匹配该筛选的渠道</div></div>`
        : `<div class="group" id="statusList">${items.map((ch) => channelRow(ch)).join("")}</div>`;
  }

  el.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
      <button class="btn btn-sec" id="backOv" style="padding:5px 12px">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="vertical-align:-2px"><path d="M15 18l-6-6 6-6"/></svg>
        总览
      </button>
      <button class="btn btn-primary" id="goRelease" style="padding:6px 14px">发版</button>
    </div>
    <h1 style="display:flex;align-items:center;gap:10px">${esc(proj.name)}</h1>
    <p class="page-sub mono">${esc(proj.path)} · 更新于 ${snap === undefined ? "—" : esc(relTime(Date.parse(snap.fetchedAt) || Date.now()))}</p>
    <div class="summary" id="summary">${cards}</div>
    ${listHtml}
    <p class="note">行内展开可看被拒原因。</p>`;

  el.querySelector("#backOv")?.addEventListener("click", () => ctx.navigate("#/overview"));
  el.querySelector("#goRelease")?.addEventListener("click", () => ctx.navigate("#/release"));

  el.querySelector("#summary")?.addEventListener("click", (e) => {
    const card = (e.target as HTMLElement).closest(".sum-card") as HTMLElement | null;
    if (card === null) return;
    filter = card.dataset.filter ?? "all";
    const fresh = renderProject(ctx, id);
    el.replaceWith(fresh);
  });

  el.querySelector("#statusList")?.addEventListener("click", (e) => {
    const copyBtn = (e.target as HTMLElement).closest("[data-copy]");
    if (copyBtn !== null) {
      void navigator.clipboard?.writeText(copyBtn.getAttribute("data-copy") ?? "");
      toast("已复制");
      return;
    }
    const row = (e.target as HTMLElement).closest(".row.clickable") as HTMLElement | null;
    if (row === null) return;
    const chName = row.dataset.ch ?? "";
    const ch = snap?.channels.find((c) => c.channel === chName);
    if (ch === undefined || (ch.reason === undefined && ch.error === undefined)) return;
    expandedKey = expandedKey === `${id}\t${chName}` ? undefined : `${id}\t${chName}`;
    const fresh = renderProject(ctx, id);
    el.replaceWith(fresh);
  });

  return el;
}

let projectId = "";
/** 被拒展开行 key：projectId \t channel；切换路由/项目时复位 */
let expandedKey: string | undefined;
export function resetProjectPageState(): void {
  filter = "all";
  expandedKey = undefined;
}
