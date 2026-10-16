import { describe, expect, it } from "vitest";
import type {
  Channel,
  ChannelContext,
  ReleasePlanEntry,
  ReviewStatus,
  StageResult,
  SubmitResult,
} from "./channel.js";
import { DefaultChannelRegistry, registry } from "./registry.js";

/** 最小渠道替身：registry 只关心 id/label，行为方法给确定值 */
function stubChannel(id: string): Channel {
  return {
    id,
    label: `${id}-label`,
    capabilities: { stage: true, submit: true, scheduled: false, status: false },
    plan: async (_ctx: ChannelContext): Promise<ReleasePlanEntry> => ({
      channel: id,
      platform: "android",
      artifactVersion: "1.0.0",
      action: "stage+submit",
      afterApproval: "auto-publish",
    }),
    stage: async (): Promise<StageResult> => ({ ok: true }),
    submit: async (): Promise<SubmitResult> => ({ ok: true }),
    status: async (): Promise<ReviewStatus> => ({ state: "unknown" }),
  };
}

describe("DefaultChannelRegistry", () => {
  it("注册后 get 返回同一实例", () => {
    const reg = new DefaultChannelRegistry();
    const huawei = stubChannel("huawei");
    reg.register(huawei);
    expect(reg.get("huawei")).toBe(huawei);
  });

  it("get 未注册的 id 返回 undefined", () => {
    const reg = new DefaultChannelRegistry();
    expect(reg.get("nonexistent")).toBeUndefined();
  });

  it("重复注册抛错并包含渠道 id，且不覆盖首个注册", () => {
    const reg = new DefaultChannelRegistry();
    const first = stubChannel("huawei");
    const second = stubChannel("huawei");
    reg.register(first);
    expect(() => reg.register(second)).toThrow("渠道重复注册: huawei");
    expect(reg.get("huawei")).toBe(first);
  });

  it("all 返回全部已注册渠道（快照副本，保持注册顺序）", () => {
    const reg = new DefaultChannelRegistry();
    const huawei = stubChannel("huawei");
    const oppo = stubChannel("oppo");
    reg.register(huawei);
    reg.register(oppo);
    const all = reg.all();
    expect(all).toEqual([huawei, oppo]);
    // 返回数组是副本：外部 push 不污染注册表
    all.push(stubChannel("outside"));
    expect(reg.all()).toHaveLength(2);
  });
});

describe("全局默认 registry", () => {
  it("导出的单例是 DefaultChannelRegistry 实例", () => {
    expect(registry).toBeInstanceOf(DefaultChannelRegistry);
  });
});
