import { expect, test } from "@playwright/test";

/**
 * 发版向导四步全链路（桩 CLI）：
 * 1 预览（dry-run 逐平台判定）→ 2 确认方式（推荐徽章/改选/未开热更跳过卡）→
 * 3 执行（confirm_required 确认卡回写 → progress → result）→ 4 完成。
 * 另覆盖：取消路径（hang 桩 + task.cancel）。
 */

test("四步状态机走完：预览 → 确认方式 → 执行（confirm 回写）→ 完成", async ({ page }) => {
  await page.goto("/#/release");

  // 步骤1：选项目 + 平台 android+ios+harmony（默认 android）→ 预览
  await expect(page.locator("#wiz1")).toBeVisible();
  await page.locator("#projSeg .seg", { hasText: "stub-project" }).click();
  await expect(page.locator("#projSeg .seg.active")).toHaveText(/stub-project/);
  await page.locator('#platMulti button[data-plat="ios"]').click();
  await page.locator('#platMulti button[data-plat="harmony"]').click();
  await page.locator("#previewBtn").click();

  // 逐平台 dry-run 结果出现（android ota / ios native / harmony 未接热更）
  await expect(page.locator(".dry-row", { hasText: "Android" })).toContainText("热更新");
  await expect(page.locator(".dry-row", { hasText: "iOS" })).toContainText("整包更新");
  await expect(page.locator(".dry-row", { hasText: "鸿蒙" })).toContainText("整包更新");

  // 正式阶段 toast（二期）
  await page.locator('#phaseSeg button[data-phase="release"]').click();
  await expect(page.locator("#toast")).toContainText("二期");

  // 下一步
  await page.locator("#toStep2").click();
  await expect(page.locator("#wiz2")).toBeVisible();

  // 步骤2：android 判定卡（推荐徽章）+ ios 改选 radio + harmony 跳过卡
  const androidCard = page.locator(".judge-card[data-plat='android']");
  await expect(androidCard.locator(".choice.sel .ct")).toContainText("热更新");
  await expect(androidCard.locator(".choice .rec-badge").first()).toBeVisible();
  await expect(
    androidCard.locator(".evidence .ev", { hasText: "src/screens/TaskList.tsx" }),
  ).toBeVisible();

  // iOS：判定 native → 整包卡选中并带建议徽章；改选热更
  const iosCard = page.locator(".judge-card[data-plat='ios']");
  await expect(iosCard.locator(".choice.sel .ct")).toContainText("整包更新");
  await iosCard.locator("button.choice[data-v='ota']").click();
  await expect(iosCard.locator("button.choice[data-v='ota']")).toHaveClass(/sel/);

  // 鸿蒙：跳过卡（无 choice）
  await expect(page.locator(".judge-card.skip")).toContainText("未接入热更");

  // 多平台顺序发标注
  await expect(page.locator("#wiz2 .note")).toContainText("3 个平台");

  // 开始发版 → 步骤3
  await page.locator("#goExec").click();
  await expect(page.locator("#wiz3")).toBeVisible();

  // hello/judgement 到达后 confirm_required 确认卡出现（android）
  const confirmCard = page.locator("#confirmCard");
  await expect(confirmCard).toBeVisible({ timeout: 15_000 });
  await expect(confirmCard.locator(".confirm-q")).toHaveText("投递方式");
  await expect(confirmCard.locator("button[data-confirm='ota'] .rec-badge")).toBeVisible();

  // 折叠日志先展开断言（judgement 行已到；confirm 后流程立即推进不宜再点）
  await page.locator("#logToggle").click();
  await expect(page.locator(".log-body .log-line").first()).toBeVisible();

  // 点「热更」→ 回写 {t:confirm,...,value:"ota"}；已确认态回显用户点击项（F4）
  await confirmCard.locator("button[data-confirm='ota']").click();
  await expect(confirmCard).toContainText("已确认");
  await expect(confirmCard).toContainText("选择：热更（推荐：是）");

  // progress 行存在（事件映射：stage/pct 由桩序列驱动，结果行在步骤4断言）
  await expect(page.locator(".prog-row")).toBeVisible({ timeout: 15_000 });

  // ios 顺序自动发起（桩失败路径：judgement native → 上传失败，无 confirm）
  await expect(page.locator(".prog-row", { hasText: "iOS" })).toBeVisible({ timeout: 30_000 });

  // 失败即停：ios 失败后 harmony 不发起（F2）——步骤4 部分平台失败，仅两行结果
  await expect(page.locator("#wiz4")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("#wiz4")).toContainText("部分平台失败");
  await expect(page.locator("#wiz4 .row .st.c-ok")).toHaveCount(1);
  await expect(page.locator("#wiz4 .row .st.c-err")).toHaveCount(1);
  await expect(page.locator("#wiz4 .row-sub", { hasText: "凭据过期" })).toBeVisible();
  // 鸿蒙未执行：结果页无鸿蒙行
  await expect(page.locator("#wiz4 .row-title", { hasText: "鸿蒙" })).toHaveCount(0);
});

test("取消路径：任务挂起 → 取消发版 → task.cancel → 终止收口", async ({ page }) => {
  await page.goto("/#/release");
  // full 模式桩发完 confirm_required 后挂住等 stdin——任务挂起期间取消：
  // taskId 已回 → ws kill → task.end(143) → 「任务异常退出」收口进结果页
  await page.locator("#projSeg .seg", { hasText: "stub-project" }).click();
  await page.locator("#previewBtn").click();

  await expect(page.locator(".dry-row", { hasText: "Android" })).toBeVisible({ timeout: 15_000 });
  await page.locator("#toStep2").click();
  await page.locator("#goExec").click();
  await expect(page.locator("#wiz3")).toBeVisible();

  // hello 到达即有取消按钮可用（taskId 未回前也有兜底分支）
  await page.waitForTimeout(1500);
  await page.locator("#cancelBtn").click();

  // 取消后到达步骤4（已取消态；hang 桩被 kill 或本地收口）
  await expect(page.locator("#wiz4")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("#wiz4")).toContainText(/已取消|失败/);
});
