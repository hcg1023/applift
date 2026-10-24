import { describe, expect, it } from "vitest";
import { BetaConfigSchema, ProjectConfigSchema, StoresSchema } from "./schema.js";

describe("StoresSchema 规范化", () => {
  it("① 对象写法原样保留（向后兼容）", () => {
    expect(StoresSchema.parse({ huawei: { appId: "x" }, oppo: {} })).toEqual({
      huawei: { appId: "x" },
      oppo: {},
    });
  });

  it("② 数组写法 → 无配置渠道 record", () => {
    expect(StoresSchema.parse(["oppo", "vivo"])).toEqual({ oppo: {}, vivo: {} });
  });

  it("③ 字符串值 → { appId: 值 }", () => {
    expect(StoresSchema.parse({ huawei: "10xxx" })).toEqual({ huawei: { appId: "10xxx" } });
  });

  it("三种写法混合", () => {
    expect(
      StoresSchema.parse({
        huawei: { appId: "1000123", pkgName: "com.x" },
        honor: "10yyy",
        vivo: {},
      }),
    ).toEqual({
      huawei: { appId: "1000123", pkgName: "com.x" },
      honor: { appId: "10yyy" },
      vivo: {},
    });
  });

  it("未提供 → 默认空对象", () => {
    expect(StoresSchema.parse(undefined)).toEqual({});
    expect(StoresSchema.parse({})).toEqual({});
  });

  it("非法写法报错（数字数组/嵌套对象值）", () => {
    expect(StoresSchema.safeParse([1, 2]).success).toBe(false);
    expect(StoresSchema.safeParse({ huawei: { appId: 123 } }).success).toBe(false);
    expect(StoresSchema.safeParse("huawei").success).toBe(false);
  });

  it("④ 混排数组：字符串渠道 + { 渠道: appId 简写 } 元素 → 后者归一为 { appId }", () => {
    expect(StoresSchema.parse(["huawei", { yyb: "30001" }, "vivo"])).toEqual({
      huawei: {},
      yyb: { appId: "30001" },
      vivo: {},
    });
  });
});

describe("ProjectConfigSchema 平台段", () => {
  it("README 最小配置合法：android/harmony/ios 的标识字段全可缺省（detectBundleIds 自动推导）", () => {
    const cfg = ProjectConfigSchema.parse({
      android: { stores: ["huawei", { yyb: "appId值" }] },
      harmony: {},
      ios: {},
    });
    expect(cfg.android?.pkgName).toBeUndefined();
    expect(Object.keys(cfg.android?.stores ?? {})).toEqual(["huawei", "yyb"]);
    expect(cfg.harmony?.bundleName).toBeUndefined();
    expect(cfg.ios?.scheme).toBeUndefined();
  });
});

describe("ProjectConfigSchema android.stores 集成", () => {
  const base = { android: { pkgName: "com.example.app" } };

  it("项目级：数组写法规范化", () => {
    const config = ProjectConfigSchema.parse({
      ...base,
      android: { ...base.android, stores: ["oppo", "vivo"] },
    });
    expect(config.android?.stores).toEqual({ oppo: {}, vivo: {} });
  });

  it("项目级：混合写法规范化", () => {
    const config = ProjectConfigSchema.parse({
      ...base,
      android: {
        ...base.android,
        stores: { huawei: "1000123", yyb: { appId: "a", pkgName: "p" } },
      },
    });
    expect(config.android?.stores).toEqual({
      huawei: { appId: "1000123" },
      yyb: { appId: "a", pkgName: "p" },
    });
  });

  it("项目级：未写 stores → 默认空对象（向后兼容）", () => {
    const config = ProjectConfigSchema.parse(base);
    expect(config.profile).toBe("default");
    expect(config.android?.stores).toEqual({});
  });

  it("项目级：原有对象写法不变（向后兼容回归）", () => {
    const config = ProjectConfigSchema.parse({
      ...base,
      android: { ...base.android, stores: { huawei: { appId: "1000123" } } },
    });
    expect(config.android?.stores.huawei?.appId).toBe("1000123");
  });
});

describe("BetaConfigSchema（beta 多渠道）", () => {
  it("全空 → beta 可整体缺省，各渠道缺省值正确（pgyer.platforms=['android']、agc submit=false、testType=3）", () => {
    const config = ProjectConfigSchema.parse({});
    expect(config.beta).toBeUndefined();

    const beta = BetaConfigSchema.parse({ pgyer: {}, agc: {} });
    expect(beta.pgyer?.platforms).toEqual(["android"]);
    expect(beta.agc?.submit).toBe(false);
    expect(beta.agc?.testType).toBe(3);
    expect(beta.testflight).toBeUndefined();
  });

  it("完整配置解析", () => {
    const config = ProjectConfigSchema.parse({
      beta: {
        pgyer: { platforms: ["android", "ios"], installPassword: "1234" },
        agc: { submit: true, group: "内测组", testType: 4 },
        testflight: { note: "TF 备注" },
      },
    });
    expect(config.beta?.pgyer?.platforms).toEqual(["android", "ios"]);
    expect(config.beta?.pgyer?.installPassword).toBe("1234");
    // cleanup 默认 true（AGC 测试版本自动清理）——显式关时才是 false
    expect(config.beta?.agc).toEqual({
      submit: true,
      group: "内测组",
      testType: 4,
      cleanup: true,
    });
    expect(config.beta?.testflight?.note).toBe("TF 备注");
  });

  it("非法值报错（platforms 枚举 / testType 枚举 / submit 非布尔）", () => {
    expect(BetaConfigSchema.safeParse({ pgyer: { platforms: ["windows"] } }).success).toBe(false);
    expect(BetaConfigSchema.safeParse({ agc: { testType: 5 } }).success).toBe(false);
    expect(BetaConfigSchema.safeParse({ agc: { submit: "yes" } }).success).toBe(false);
  });
});

describe("StoresSchema 混排数组单键约束", () => {
  it("对象元素多键 → safeParse 失败且 issue 消息含单键指引（可被人话化层消费）", () => {
    const r = StoresSchema.safeParse(["huawei", { a: "1", b: "2" }]);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message ?? "").toContain("单键");
  });
});
