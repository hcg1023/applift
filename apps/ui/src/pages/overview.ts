import { classify, type UiClient } from "../api.js";
import type { HostAdapter } from "../host.js";
import { esc, loadSettings, relTime, toast } from "../util.js";

export interface PageCtx {
  client: UiClient;
  navigate: (hash: string) => void;
  /** 宿主能力（webui 降级实现；Tauri 壳注入 native） */
  host: HostAdapter;
}

/** 项目图标底色：按名称稳定散列到一组渐变 */
const GRADIENTS = [
  "linear-gradient(135deg, #5e5ce6, #007aff)",
  "linear-gradient(135deg, #ff9500, #ff375f)",
  "linear-gradient(135deg, #30d158, #00c7be)",
  "linear-gradient(135deg, #bf5af2, #ff375f)",
  "linear-gradient(135deg, #0a84ff, #5e5ce6)",
];

function iconStyle(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 997;
  return GRADIENTS[h % GRADIENTS.length]!;
}

function latestText(client: UiClient, projectId: string): string {
  const ev = client.state.latestFor(projectId);
  if (ev === undefined) return "暂无动态";
  return `${ev.channel} ${classify(ev.from).label} → ${classify(ev.to).label} · ${relTime(ev.ts)}`;
}

function openMenu(anchor: HTMLElement, ctx: PageCtx, id: string, name: string): void {
  document.querySelector(".ov-menu-pop")?.remove();
  const pop = document.createElement("div");
  pop.className = "ov-menu-pop";
  pop.innerHTML = `
    <button data-act="recheck">重新检查</button>
    <button data-act="remove" class="danger">移除项目</button>`;
  const rect = anchor.getBoundingClientRect();
  pop.style.left = `${rect.left}px`;
  pop.style.top = `${rect.bottom + 4}px`;
  pop.addEventListener("click", async (e) => {
    const act = (e.target as HTMLElement).dataset.act;
    pop.remove();
    if (act === "remove") {
      if (!window.confirm(`移除项目「${name}」？不影响工程文件，仅从监控列表删除。`)) return;
      try {
        await ctx.client.removeProject(id);
        toast(`已移除 ${name}`);
      } catch (err) {
        toast(`移除失败：${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (act === "recheck") {
      // 服务端真话：当前档位实际轮询间隔（前台/后台随连接态切换；连接后亦有即时刷新）
      try {
        const h = await ctx.client.health();
        const min = Math.max(1, Math.round((h.refreshIntervalMs ?? 300_000) / 60_000));
        toast(`状态由服务端自动刷新（当前每 ${min} 分钟一轮，页面打开/刷新即即时刷新）`);
      } catch {
        toast("状态由服务端自动刷新，页面打开/刷新即即时刷新");
      }
    }
  });
  document.body.appendChild(pop);
  const close = (e: MouseEvent) => {
    if (!pop.contains(e.target as Node)) {
      pop.remove();
      document.removeEventListener("click", close, true);
    }
  };
  document.addEventListener("click", close, true);
}

/** 总览：项目卡网格 + 动态时间线（过滤 chips） */
export function renderOverview(ctx: PageCtx): HTMLElement {
  const { client } = ctx;
  const el = document.createElement("section");
  el.className = "page";
  el.id = "page-overview";

  const projects = client.state.projects;
  const hasSnapshot =
    projects.length > 0 && projects.every((p) => client.state.snapshot(p.id) !== undefined);
  const loading = projects.length === 0 && client.state.feed.length === 0;

  const cards = projects
    .map((p) => {
      const snap = client.state.snapshot(p.id);
      if (snap === undefined) {
        return `
          <div class="ov-card" data-id="${esc(p.id)}">
            <div class="ov-head">
              <span class="proj-icon" style="background:${iconStyle(p.name)}">${esc(p.name.slice(0, 1))}</span>
              <div class="ov-name">${esc(p.name)}</div>
            </div>
            <div class="ov-counts"><span class="oc">状态加载中…</span></div>
          </div>`;
      }
      if (!snap.ok) {
        return `
          <div class="ov-card unavailable" data-id="${esc(p.id)}">
            <div class="ov-head">
              <span class="proj-icon" style="background:linear-gradient(135deg,#8e8e93,#636366)">${esc(p.name.slice(0, 1))}</span>
              <div class="ov-name">${esc(p.name)}</div>
              <span class="st c-off" style="font-size:11.5px"><span class="dot d-off"></span>不可用</span>
            </div>
            <div class="row-sub" style="margin:10px 0 0">工程状态查不到（CLI 校验失败或依赖未安装）。</div>
          </div>`;
      }
      const c = client.state.counts(p.id);
      const badge =
        c.err > 0
          ? `<span class="st c-err" style="font-size:11.5px"><span class="dot d-err"></span>${c.err} 被拒</span>`
          : c.wait > 0
            ? `<span class="st c-wait" style="font-size:11.5px"><span class="dot d-wait"></span>${c.wait} 审核中</span>`
            : c.ok > 0
              ? `<span class="st c-ok" style="font-size:11.5px"><span class="dot d-ok"></span>全部正常</span>`
              : "";
      return `
        <div class="ov-card" data-id="${esc(p.id)}">
          <div class="ov-head">
            <span class="proj-icon" style="background:${iconStyle(p.name)}">${esc(p.name.slice(0, 1))}</span>
            <div class="ov-name">${esc(p.name)}</div>
            ${badge}
            <button class="ov-menu" title="项目操作" aria-label="项目操作">⋯</button>
          </div>
          <div class="ov-counts">
            <span class="oc"><b class="c-ok">${c.ok}</b>已上架</span>
            <span class="oc"><b class="c-wait">${c.wait}</b>审核中</span>
            <span class="oc"><b class="c-err">${c.err}</b>被拒</span>
          </div>
          <div class="ov-latest">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
            ${esc(latestText(client, p.id))}
          </div>
        </div>`;
    })
    .join("");

  const chips = client.state.projects
    .map(
      (p) =>
        `<button class="seg${feedFilter === p.id ? " active" : ""}" data-pf="${esc(p.id)}">${esc(p.name)}</button>`,
    )
    .join("");

  const feedItems = client.state.feed
    .filter((e) => feedFilter === "all" || e.projectId === feedFilter)
    .map((e) => {
      const proj = client.state.projects.find((p) => p.id === e.projectId);
      const to = classify(e.to);
      return `
        <div class="tl-item ${to.key === "ok" ? "ok" : to.key === "err" ? "err" : "info"}" data-proj="${esc(e.projectId)}">
          <div class="tl-time">${esc(proj?.name ?? e.projectId)} · ${relTime(e.ts)}</div>
          <div class="tl-txt"><b>${esc(e.channel)}</b> ${esc(classify(e.from).label)} → ${esc(to.label)}</div>
        </div>`;
    })
    .join("");

  el.innerHTML = `
    <h1>总览</h1>
    <p class="page-sub">所有项目的渠道状态与最新变化</p>
    ${hasSnapshot && client.state.projects.some((p) => client.state.unavailable(p.id)) ? unavailableBanner : ""}
    <div class="ov-grid">
      ${cards}
      <button class="ov-card add" id="addProject">
        <div class="ov-add-plus">＋</div>
        <div class="ov-add-txt">添加项目</div>
      </button>
    </div>
    <div class="ov-feed-head">
      <h2>动态</h2>
      <div class="seg-wrap" id="feedFilter" style="margin-left:auto">
        <button class="seg${feedFilter === "all" ? " active" : ""}" data-pf="all">全部</button>
        ${chips}
      </div>
    </div>
    ${loading ? loadingBox : `<div class="tl" id="ovFeed">${feedItems || emptyFeedBox}</div>`}
    <p class="note">项目卡片点进去是渠道明细；动态默认显示全部项目，可按项目过滤。</p>`;

  el.querySelector("#addProject")?.addEventListener("click", async () => {
    // HostAdapter：宿主有原生目录选择器则先弹选择（webui 恒 null → 直接手输路径）
    const picked = await ctx.host.pickDirectory();
    const path = picked ?? window.prompt("输入工程目录路径（需含 applift.config.ts）：");
    if (path === null || path.trim() === "") return;
    try {
      await client.addProject(path.trim());
      toast("项目已添加");
    } catch (err) {
      toast(`添加失败：${err instanceof Error ? err.message : String(err)}`);
    }
  });

  el.querySelector("#feedFilter")?.addEventListener("click", (e) => {
    const pf = (e.target as HTMLElement).dataset.pf;
    if (pf === undefined) return;
    feedFilter = pf;
    renderFeedOnly(el, ctx);
    el.querySelectorAll("#feedFilter .seg").forEach((s) => {
      s.classList.toggle("active", (s as HTMLElement).dataset.pf === pf);
    });
  });

  el.querySelectorAll(".ov-card[data-id]").forEach((card) => {
    const id = (card as HTMLElement).dataset.id ?? "";
    const proj = client.state.projects.find((p) => p.id === id);
    card.addEventListener("click", (e) => {
      const menuBtn = (e.target as HTMLElement).closest(".ov-menu") as HTMLElement | null;
      if (menuBtn !== null) {
        openMenu(menuBtn, ctx, id, proj?.name ?? id);
        return;
      }
      if (client.state.unavailable(id)) {
        toast("按提示修复后点「重新检查」");
        return;
      }
      ctx.navigate(`#/project/${id}`);
    });
  });

  return el;
}

const unavailableBanner = `
  <div class="banner">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
    <span>有项目状态查不到。在终端运行 <span class="cmd">applift doctor</span> 排查后自动恢复。</span>
  </div>`;

const loadingBox = `
  <div class="state-box">
    <div class="spin"></div>
    正在获取项目与渠道状态…
  </div>`;

const emptyFeedBox = `<div class="state-box" style="padding:32px 24px"><div class="big">—</div><div>暂无动态；渠道状态发生变化会出现在这里</div></div>`;

/** 过滤态存活于模块级：跨重渲染保持用户选择 */
let feedFilter = "all";

/** 离开总览时复位动态过滤（原型 nav 语义：过滤不跨导航保留） */
export function resetOverviewPageState(): void {
  feedFilter = "all";
}

function renderFeedOnly(el: HTMLElement, ctx: PageCtx): void {
  const feed = el.querySelector("#ovFeed");
  if (feed === null) return;
  const items = ctx.client.state.feed
    .filter((e) => feedFilter === "all" || e.projectId === feedFilter)
    .map((e) => {
      const proj = ctx.client.state.projects.find((p) => p.id === e.projectId);
      return `
        <div class="tl-item ${classify(e.to).key === "ok" ? "ok" : classify(e.to).key === "err" ? "err" : "info"}" data-proj="${esc(e.projectId)}">
          <div class="tl-time">${esc(proj?.name ?? e.projectId)} · ${relTime(e.ts)}</div>
          <div class="tl-txt"><b>${esc(e.channel)}</b> ${esc(classify(e.from).label)} → ${esc(classify(e.to).label)}</div>
        </div>`;
    })
    .join("");
  feed.innerHTML = items || emptyFeedBox;
}
