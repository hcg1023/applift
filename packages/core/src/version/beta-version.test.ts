/**
 * beta 策略纯函数：三端能力矩阵 + 派生规则。
 * 契约：官方不支持的组合必须抛错（不静默降级），派生结果必须过平台段数校验。
 */
import { describe, expect, it } from "vitest";
import { BetaVersionConfigSchema, VersionConfigSchema } from "../config/schema.js";
import {
  assertBetaVersionSupported,
  betaVersionName,
  checkVersionNameShape,
  DEFAULT_BETA_VERSION_CONFIG,
} from "./beta-version.js";

describe("betaVersionName：offset", () => {
  it("默认 patch+1000：4.0.0 → 4.0.1000（三段纯数字，三端全通）", () => {
    for (const platform of ["ios", "android", "harmony"])
      expect(betaVersionName({ base: "4.0.0", platform })).toBe("4.0.1000");
  });

  it("patch 偏移随 base 走：4.0.1 → 4.0.1001，不会与 4.0.0 的测试号撞车", () => {
    expect(betaVersionName({ base: "4.0.1", platform: "harmony" })).toBe("4.0.1001");
    expect(betaVersionName({ base: "4.1.0", platform: "harmony" })).toBe("4.1.1000");
  });

  it("delta 可配；segment=major 兼容旧偏移行为（4.0.0 → 1004.0.0）", () => {
    expect(
      betaVersionName({
        base: "4.0.0",
        platform: "harmony",
        config: { mode: "offset", segment: "major", delta: 1000 },
      }),
    ).toBe("1004.0.0");
    expect(
      betaVersionName({
        base: "4.0.0",
        platform: "harmony",
        config: { mode: "offset", segment: "patch", delta: 100 },
      }),
    ).toBe("4.0.100");
  });

  it("base 非 X.Y.Z → 显式报错（不猜）", () => {
    expect(() => betaVersionName({ base: "4.0", platform: "harmony" })).toThrow(/不是 X\.Y\.Z/);
    expect(() => betaVersionName({ base: "v4.0.0", platform: "harmony" })).toThrow(/不是 X\.Y\.Z/);
  });

  it("派生结果超平台段数上限 → 报错（iOS 最多三段）", () => {
    // 4.0.0.1 这种四段形态只在 base 自身四段时出现，此处用 delta 造一个非法段数场景不现实，
    // 直接校验 checkVersionNameShape 的边界
    expect(checkVersionNameShape("4.0.0.1", "ios")).toMatch(/最多 3 段/);
    expect(checkVersionNameShape("4.0.0.1", "harmony")).toBeNull();
  });

  it("prerelease 后缀在 reject 平台（ios）→ checkVersionNameShape 直调同样拦截", () => {
    expect(checkVersionNameShape("4.0.0-beta.1", "ios")).toMatch(/不支持 prerelease/);
    expect(checkVersionNameShape("4.0.0-beta.1", "android")).toBeNull();
  });

  it("裸 { mode: 'offset' }（无 segment/delta）→ 运行时默认 patch+1000（不经 schema 也要稳）", () => {
    expect(
      betaVersionName({ base: "4.0.0", platform: "harmony", config: { mode: "offset" } }),
    ).toBe("4.0.1000");
  });
});

describe("betaVersionName：suffix", () => {
  const suffix = { mode: "suffix" as const };

  it("默认模板 {base}-beta；Android 允许（侧载与商店都不校验）", () => {
    expect(betaVersionName({ base: "4.0.0", platform: "android", config: suffix })).toBe(
      "4.0.0-beta",
    );
  });

  it("模板注入额外段使派生结果超平台段数上限 → 派生时抛错（harmony 允许 suffix 但最多四段）", () => {
    expect(() =>
      betaVersionName({
        base: "4.0.0",
        platform: "harmony",
        config: { mode: "suffix", template: "{base}.999.9" },
      }),
    ).toThrow(/最多 4 段/);
  });

  it("模板含 {n} → 明确不支持（避免承诺一个不存在的 --beta-index 旗标）", () => {
    const cfg = { mode: "suffix" as const, template: "{base}-beta.{n}" };
    expect(() => betaVersionName({ base: "4.0.0", platform: "android", config: cfg })).toThrow(
      /不支持 \{n\}/,
    );
  });

  it("模板只替换 {base}，其余字符原样保留", () => {
    expect(
      betaVersionName({
        base: "4.0.0",
        platform: "android",
        config: { mode: "suffix", template: "{base}-nightly" },
      }),
    ).toBe("4.0.0-nightly");
  });

  it("iOS 硬拒（TestFlight/App Store 只收 1–3 段整数）—— 报错带修复建议", () => {
    expect(() => betaVersionName({ base: "4.0.0", platform: "ios", config: suffix })).toThrow(
      /不支持 prerelease[\s\S]*mode=offset/,
    );
  });

  it("harmony 构建期放行，但不阻断（只告警）", () => {
    expect(betaVersionName({ base: "4.0.0", platform: "harmony", config: suffix })).toBe(
      "4.0.0-beta",
    );
    expect(
      assertBetaVersionSupported({ base: "4.0.0", platform: "harmony", config: suffix }),
    ).toEqual([expect.stringContaining("mode=suffix")]);
  });
});

describe("betaVersionName：app-id", () => {
  it("版本名与正式一致（隔离交给两个 pushy 应用记录）", () => {
    for (const platform of ["ios", "android", "harmony"])
      expect(betaVersionName({ base: "4.0.0", platform, config: { mode: "app-id" } })).toBe(
        "4.0.0",
      );
  });

  it("app-id 模式无告警（不依赖版本名）", () => {
    expect(
      assertBetaVersionSupported({ base: "4.0.0", platform: "ios", config: { mode: "app-id" } }),
    ).toEqual([]);
  });
});

describe("参数防御", () => {
  it("delta 非正整数 → 报错（直接构造 provider 时绕过 schema 也能拦住）", () => {
    expect(() =>
      betaVersionName({
        base: "4.0.0",
        platform: "harmony",
        config: { mode: "offset", segment: "patch", delta: 0 },
      }),
    ).toThrow(/delta 必须是正整数/);
  });

  it("平台名撞原型键（constructor）→ 当作未知平台，不崩也不误判为 iOS", () => {
    expect(
      betaVersionName({ base: "4.0.0", platform: "constructor", config: { mode: "suffix" } }),
    ).toBe("4.0.0-beta");
  });
});

describe("BetaVersionConfigSchema（配置解析：默认补齐 + 非法值拒绝）", () => {
  it("三形态解析：offset 补 segment=patch/delta=1000，suffix 补 template，app-id 原样", () => {
    expect(BetaVersionConfigSchema.parse({ mode: "offset" })).toEqual({
      mode: "offset",
      segment: "patch",
      delta: 1000,
    });
    expect(BetaVersionConfigSchema.parse({ mode: "suffix" })).toEqual({
      mode: "suffix",
      template: "{base}-beta",
    });
    expect(BetaVersionConfigSchema.parse({ mode: "app-id" })).toEqual({ mode: "app-id" });
  });

  it("非法值报错：mode 未知 / delta=0 / segment 非法", () => {
    expect(() => BetaVersionConfigSchema.parse({ mode: "nope" })).toThrow();
    expect(() =>
      BetaVersionConfigSchema.parse({ mode: "offset", segment: "patch", delta: 0 }),
    ).toThrow();
    expect(() => BetaVersionConfigSchema.parse({ mode: "offset", segment: "minor" })).toThrow();
  });

  it("schema default 与 DEFAULT_BETA_VERSION_CONFIG 一致（配置缺省与运行时默认不漂移）", () => {
    expect(VersionConfigSchema.parse({}).beta).toEqual(DEFAULT_BETA_VERSION_CONFIG);
  });

  it("未知平台不设限（native-* 等自定义平台不误报）", () => {
    expect(checkVersionNameShape("1.2.3.4", "native-desktop")).toBeNull();
    expect(
      betaVersionName({ base: "1.2.3", platform: "native-desktop", config: { mode: "suffix" } }),
    ).toBe("1.2.3-beta");
  });

  it("iOS suffix 在 assertBetaVersionSupported 里同样是硬错（不只在派生时拦）", () => {
    expect(() =>
      assertBetaVersionSupported({ base: "4.0.0", platform: "ios", config: { mode: "suffix" } }),
    ).toThrow(/mode=offset/);
  });

  it("app-id 模式不校验平台（版本名不动，无平台能力问题）", () => {
    expect(
      assertBetaVersionSupported({ base: "4.0.0", platform: "ios", config: { mode: "app-id" } }),
    ).toEqual([]);
  });

  it("未知平台（native-*）在 assertBetaVersionSupported 里同样直通", () => {
    expect(
      assertBetaVersionSupported({
        base: "4.0.0",
        platform: "native-desktop",
        config: { mode: "suffix" },
      }),
    ).toEqual([]);
  });
});
