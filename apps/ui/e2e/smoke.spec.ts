import { expect, test } from "@playwright/test";

test("连接正常：断连横幅与顶栏 pill 隐藏", async ({ page }) => {
  await page.goto("/#/overview");
  await expect(page.locator(".ov-card[data-id]").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("#connBanner")).toBeHidden();
  await expect(page.locator("#connPill")).toBeHidden();
});

test("总览 → 详情 → 被拒展开 → 设置 clamp", async ({ page }) => {
  await page.goto("/#/overview");

  // 项目卡出现（REST 项目表 + WS 快照补发）
  const card = page.locator(".ov-card[data-id]").first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.locator(".ov-name")).toHaveText("stub-project");
  await expect(card.locator(".oc b").first()).not.toHaveText("0");

  // 动态时间线：翻转渠道最终产生 FeedEvent
  await expect(page.locator("#ovFeed .tl-item", { hasText: "oppo" })).toBeVisible({
    timeout: 20_000,
  });

  // 点进详情
  await card.click();
  await expect(page).toHaveURL(/#\/project\//);
  await expect(page.locator("#page-project h1")).toHaveText("stub-project");
  const rows = page.locator("#statusList .row.clickable");
  await expect(rows.filter({ hasText: "asc" })).toBeVisible();
  await expect(rows.filter({ hasText: "xiaomi" })).toContainText("审核中");
  await expect(rows.filter({ hasText: "honor" })).toContainText("被拒");

  // 被拒行展开原因
  await rows.filter({ hasText: "honor" }).click();
  await expect(page.locator(".row.detail")).toContainText("隐私权限用途说明不完整");

  // 返回总览
  await page.locator("#backOv").click();
  await expect(page).toHaveURL(/#\/overview$/);

  // 设置：前台间隔降到 1 分钟后再减 → clamp 提示
  await page.locator('.nav-item[data-nav="settings"]').click();
  await expect(page).toHaveURL(/#\/settings$/);
  const fg = page.locator('.stepper[data-key="fg"]');
  await expect(fg.locator(".val")).toHaveText("5 分钟");
  for (let i = 0; i < 4; i += 1) await fg.locator('button[data-dir="-1"]').click();
  await expect(fg.locator(".val")).toHaveText("1 分钟");
  await fg.locator('button[data-dir="-1"]').click();
  await expect(page.locator("#toast")).toHaveText("已是最短间隔：1 分钟");
  await expect(fg.locator(".val")).toHaveText("1 分钟");

  // 外观切换
  await page.locator('.seg[data-th="light"]').click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("添加项目：服务端目录浏览器点选可用（webui 路径）", async ({ page }) => {
  await page.goto("/#/overview");
  await page.locator("#addProject").click();
  const dlg = page.locator("#addProjectDlg");
  await expect(dlg).toBeVisible();

  // 起始根（e2e 服务 HOME 隔离到临时目录）→ 列出 stub-project 且带 applift 工程标记
  const row = dlg.locator(".fs-row[data-name='stub-project']");
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row.locator(".fs-badge")).toHaveText("applift 工程");

  // 点入下一层 → 面包屑出现并可回跳
  await row.locator(".fs-name").click();
  const crumb = dlg.locator("#fsCrumb button", { hasText: "stub-project" });
  await expect(crumb).toBeVisible();

  // 手输路径备选入口
  await dlg.locator('button[data-tab="manual"]').click();
  await expect(dlg.locator("#manualPath")).toBeVisible();

  await dlg.locator("button[aria-label='关闭']").click();
  await expect(dlg).toBeHidden();
});
