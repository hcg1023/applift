import { describe, expect, it } from "vitest";
import { ProjectConfigSchema, StoresSchema } from "./schema.js";

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
